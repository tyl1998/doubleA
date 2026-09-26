/**
 * 沙箱生命周期（P0-3-2）—— 「会话即容器」的记账与增删
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §四 1（会话即容器 + label + `sandboxes` 落库）、
 *      §九 1（具名卷与磁盘账本）、§九 2（孤儿回收器是必需项）、§九 3（配额作用域 = 单实例）、
 *      `docs/02-后端设计.md` §七 第 1~2 步（并发上限 10 / 满则 queued 排队 / dockerode 建容器）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件负责的三件事（第四件"回收器"在 `reaper.ts`）
 * ─────────────────────────────────────────────────────────────────────
 *   ① `ensureSandbox()` —— 拿到一个**能用的**沙箱：复用已有的，或（排队后）新建一个；
 *   ② `recycleSandbox()` —— 把一个沙箱彻底收掉（容器 + 具名卷 + 账本 + 名额）；
 *   ③ `touchSandbox()` —— `sandboxes.last_active_at` 的**唯一写入口**（引擎事件调它，P0-3-5 接上）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 四个顺序问题（每一个做错都**不报错**，只是行为不对）
 * ─────────────────────────────────────────────────────────────────────
 * 1. **行先落、容器后建**（`CREATING` → 容器 → `RUNNING`，见 `createSandbox`）。
 *    反过来（先建容器再插行）会把"容器已建、行还没写"的窗口**主动制造出来** ——
 *    那个窗口里的容器只能靠 label 找到，而"找得到"与"管得住"是两回事。
 *    代价是 `container_id` 必须可空，这是刻意的（见 `schema.prisma` 的 Sandbox 注释）。
 * 2. **校验排在删除之前**（`ensureSandbox` 先查会话与镜像，再动容器）。同族教训见
 *    P0-1-23 的"整体替换"批次：先清后校验会在失败路径上**删光旧数据再报错**。
 * 3. **回收必须两步**（容器 `rm -v` → 具名卷显式 `volume rm`）。P0-3-2 实测：
 *    `docker rm -v` **删不掉具名卷**，指望它顺手清干净会得到"账本说回收了、卷还堆着"。
 * 4. **名额只在两个时刻变动**：拿到（`ensureSandbox` 成功）与回收（`recycleSandbox` / 对账器）。
 *    失败路径上必须**把名额还回去**（`createSandbox` 抛错后），否则每次创建失败漏一个槽位 ——
 *    症状是"跑了一阵之后明明没人在用却在排队"，且**重启才恢复**（因为名额是进程内的）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本批**没有任何入口能创建沙箱**
 * ─────────────────────────────────────────────────────────────────────
 * TaskAgent 的 `/chat` 属 P0-3-5/6（要引擎桥才谈得上"派活"）⇒ 本文件此刻的调用方只有对账器。
 * 这不是缺陷，是批次切分：`ensureSandbox()` 的形状由 `02` §七 与子方案③ 定死，
 * 下一批接的是"谁来调它"，不是"它长什么样"。
 */

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import * as docker from './docker.js'
import {
  claimSandboxQueueHead,
  enqueueSandboxQueue,
  leaveSandboxQueue,
  pruneSandboxQueue,
  sandboxQueueDepth,
  sandboxQueuePosition,
} from './queue.js'
import { createSlotRegistry } from './registry.js'
import { buildSandboxContainerSpec, sandboxLabels, workVolumeName } from './spec.js'

/**
 * 排队等待的轮询间隔（**代码常量**，不进 env）。
 *
 * 为什么不进参数总表：它不是"行为窗口"（那种要能注入小值才验得了，如空闲回收的 30min），
 * 而是**轮询粒度** —— 改它只改变"位次更新与拿名额的及时性"（250ms 对人眼已经够），
 * 不改变任何语义。参数总表里 `PI_RPC_STDIO_MAX_BYTES` 是同一条取舍。
 */
const SLOT_POLL_INTERVAL_MS = 250

/**
 * 名额册（进程内，作用域 = 本实例）。
 * ⚠️ 它是**模块级单例**：容量必须只有一份，别在函数里现造（那样每轮都会"有名额"）。
 */
const slots = createSlotRegistry(config.concurrency.sandbox)

/** 一个可用的沙箱（交付给编排层的句柄） */
export interface SandboxHandle {
  /** `sandboxes.id` */
  sandboxId: string
  conversationId: string
  containerId: string
  volumeName: string
  image: string
  createdAt: Date
  /** 这一轮是**复用**了已有容器（true）还是新建的（false）—— 只有日志与验收关心 */
  reused: boolean
}

/** 拿不到沙箱的原因（**枚举**而不是自由文本：编排层要按它决定回什么事件，见 `02` §5.1） */
export type SandboxAcquireFailure =
  /** 没配 `SANDBOX_IMAGE`（镜像还没建，或 .env 没填） */
  | 'NOT_CONFIGURED'
  /** 会话不存在 / 已结束（只读） */
  | 'CONVERSATION_NOT_FOUND'
  /** 等名额超时（= 排队项 TTL 到期） */
  | 'QUEUE_TIMEOUT'
  /** 等待期间被取消（用户点了停止 / 流断了） */
  | 'ABORTED'
  /** 建容器失败（镜像缺失、卷建不出来、Docker 不可达…）—— `message` 是给人看的原因 */
  | 'CREATE_FAILED'

export type SandboxAcquireResult =
  | { ok: true; sandbox: SandboxHandle }
  | { ok: false; code: SandboxAcquireFailure; message: string }

export interface AcquireSandboxOptions {
  /** 取消信号（SSE 层的停止信号 / 客户端断开都会触发它） */
  signal?: AbortSignal
  /** 位次变化时回调。前端那张 `queued` 卡靠它更新（`shared` 里"1 = 下一个"） */
  onQueued?: (position: number) => void
}

// ───────────────────────────── 对外：拿沙箱 ─────────────────────────────

/**
 * 拿到一个能用的沙箱（复用 or 新建；满则排队）。
 *
 * 三条分界线：
 *   · **复用不占名额**（同一会话的多轮消息复用同一个容器，`子方案③` §四 1）；
 *   · **队列非空时不允许直通**（否则后来者插队，FIFO 破功 —— 见 `tryAcquireSlotNow`）；
 *   · **失败一律把名额还回去**（见文件头顺序问题 4）。
 */
export async function ensureSandbox(
  conversationId: string,
  options: AcquireSandboxOptions = {},
): Promise<SandboxAcquireResult> {
  const image = config.sandbox.image
  if (image === undefined) {
    return fail(
      'NOT_CONFIGURED',
      '未配置 SANDBOX_IMAGE。先构建镜像（pnpm sandbox:build），再把它打印的两行写进 infra/.env',
    )
  }

  // ② 校验排在删除之前：会话必须存在且 ACTIVE。⚠️ 已结束（Agent 被软删后转只读）的会话
  //    不该再起容器 —— 它连新消息都不该收。
  const conversation = await getPrisma().conversation.findUnique({
    where: { id: conversationId },
    select: { status: true },
  })
  if (conversation === null) return fail('CONVERSATION_NOT_FOUND', '会话不存在')
  if (conversation.status !== 'ACTIVE') return fail('CONVERSATION_NOT_FOUND', '会话已结束（只读）')

  // ① 复用：账本说有 RUNNING 行 **且容器真的还在**（账本会撒谎，Docker 不会）
  const running = await getPrisma().sandbox.findFirst({
    where: { conversationId, status: 'RUNNING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, containerId: true, image: true, createdAt: true },
  })
  if (running !== null && running.containerId !== null) {
    if (await docker.sandboxContainerExists(running.containerId)) {
      if (!slots.tryAdd(conversationId) && !slots.has(conversationId)) {
        // 只可能是"别的会话把名额占满了"（单实例下正常不该发生）⇒ 以容器为准放行 + 留痕。
        // 不在这里报错：把矛盾暴露出来，但不让一个已经存在的容器变成不可用。
        getLogger().warn(
          { conversationId, size: slots.size, limit: slots.limit },
          '复用已有沙箱时名额册已满：计数与容器实际数短暂不一致（按"容器为准"继续）',
        )
      }
      return {
        ok: true,
        sandbox: {
          sandboxId: running.id,
          conversationId,
          containerId: running.containerId,
          volumeName: workVolumeName(conversationId),
          image: running.image,
          createdAt: running.createdAt,
          reused: true,
        },
      }
    }
    // 容器没了（被手工删 / 宿主清理 / 崩过）⇒ 先把账面收干净，再走新建
    await recycleSandbox(conversationId, 'container-missing')
  }

  if (!(await tryAcquireSlotNow(conversationId))) {
    const position = await enqueueSandboxQueue(conversationId)
    options.onQueued?.(position)
    const waited = await waitForSlot(conversationId, options)
    if (!waited.ok) return waited
  }

  try {
    return { ok: true, sandbox: await createSandbox(conversationId, image) }
  } catch (error) {
    // ★ 名额必须还回去：不还的话每失败一次漏一个槽位，且**重启才恢复**（名额是进程内的）
    slots.remove(conversationId)
    const message = error instanceof Error ? error.message : String(error)
    return fail('CREATE_FAILED', message)
  }
}

/**
 * 试着**立刻**拿一个名额（不进队）。
 *
 * 两个条件，**顺序与原子性都是正确性的一部分**：
 *   ① **队里没人**（`depth === 0`）—— 否则"明明有人在等，新人却直接拿走名额"，FIFO 破功。
 *      这是本函数唯一的 `await`；
 *   ② `slots.tryAdd()` —— **与 ① 之间没有 await** ⇒ 单线程下这一段是原子的，不会超发名额。
 *      （放一个 await 进来就会变成"两人都看到还有名额"的经典竞态。）
 */
async function tryAcquireSlotNow(conversationId: string): Promise<boolean> {
  const depth = await sandboxQueueDepth()
  if (depth > 0) return false
  return slots.tryAdd(conversationId)
}

/** 排队等待的结果：成功就一个 `ok`（句柄由调用方在拿完名额之后新建），失败必带原因 */
type SlotWaitResult = { ok: true } | { ok: false; code: SandboxAcquireFailure; message: string }

/** 排队等待名额：轮询位次 + 认领队首。超时由**队列项自己的 TTL** 判定（见 `queue.ts` 文件头） */
async function waitForSlot(conversationId: string, options: AcquireSandboxOptions): Promise<SlotWaitResult> {
  let lastReported: number | null = null
  try {
    for (;;) {
      if (options.signal?.aborted === true) return failWait('ABORTED', '等待沙箱名额期间被取消')
      await sleep(SLOT_POLL_INTERVAL_MS)
      // 顺手清过期项：它同时是"我是不是已经超时了"的判据（自己那条被清掉 ⇒ 下面查到 null）
      await pruneSandboxQueue()
      const position = await sandboxQueuePosition(conversationId)
      if (position === null) {
        return failWait(
          'QUEUE_TIMEOUT',
          `排队等待超过 ${config.sandbox.queueTtlSec} 秒仍未拿到沙箱名额（当前并发上限 ${slots.limit}）`,
        )
      }
      if (position !== lastReported) {
        lastReported = position
        options.onQueued?.(position)
      }
      // 只有队首才可能拿到名额；`slots.size < limit` 是一次廉价预判（真正的判据是 tryAdd 的返回值）
      if (position === 1 && slots.size < slots.limit && (await claimSandboxQueueHead(conversationId))) {
        if (slots.tryAdd(conversationId)) return { ok: true }
        // 认领成功却拿不到名额（只可能被"队列外的直通路径"抢走）⇒ 回队尾继续等。
        // 直接放弃会让这一轮变成"排到了却说没名额"的假失败。
        lastReported = await enqueueSandboxQueue(conversationId)
        options.onQueued?.(lastReported)
      }
    }
  } finally {
    // 无论从哪条路出去（拿到名额 / 超时 / 取消 / 抛错）都不该把自己留在队里：
    // 留下的孤儿排队项会让后来者**永远排在第二位**（`子方案③` §九 2 的症状）
    await leaveSandboxQueue(conversationId).catch((error: unknown) => {
      getLogger().warn({ err: error, conversationId }, '离开沙箱排队时出错（已忽略：TTL 会兜底）')
    })
  }
}

// ───────────────────────────── 内部：建与收 ─────────────────────────────

/**
 * 真建一个沙箱。**行先落、容器后建**（文件头顺序问题 1）。
 *
 * 失败路径要做三件补偿（顺序：容器 → 卷 → 账本）：
 *   删掉刚建的容器（若建成功过）、删掉刚建的卷、把行标 `FAILED` 并写上**给人看的原因**。
 * 补偿本身失败只 warn —— 把那半个对象留给对账器（它按 label 找得到），
 * 而不是让"清理失败"盖掉"创建失败"这个真正要说的事。
 */
async function createSandbox(conversationId: string, image: string): Promise<SandboxHandle> {
  const prisma = getPrisma()
  const startedAt = new Date()
  const volumeName = workVolumeName(conversationId)

  // ⚠️ `createdAt` / `lastActiveAt` **都必须由 JS 侧显式写入**，不能用 DB 侧的 `@default(now())`。
  //    原因（P0-3-2 实测）：本机 PG 容器的会话时区不是 UTC（`infra/.env` 的 `TZ=Asia/Shanghai`
  //    传给了 PG），而 `@prisma/adapter-pg` 读写 `timestamptz` 各偏一个时区偏移且**往返恒等**
  //    ⇒ 凡「JS 侧时间」与「DB 侧生成时间」进同一个比较的地方，整体偏 8 小时（`docs/02` 已知问题）。
  //    沙箱的两处判据（`reapOrphans` 的宽限期、`collectLiveConversations` 的活体窗口）都是
  //    JS 侧边界，所以这两列必须落在 JS 侧空间里 —— 否则 `SANDBOX_CREATE_GRACE_SEC` 实际会
  //    被放大成 `grace + 8h`（症状：崩在半途的 `CREATING` 行 8 小时内不会被判死）。
  const row = await prisma.sandbox.create({
    data: { conversationId, status: 'CREATING', image, lastActiveAt: startedAt, createdAt: startedAt },
    select: { id: true, createdAt: true },
  })

  let containerId: string | undefined
  try {
    // 镜像缺失的文案在这里就换成"先 pnpm sandbox:build"（否则会用一句 Docker 原文糊过去）
    await docker.ensureImage(image)
    await docker.createSandboxVolume({
      name: volumeName,
      labels: sandboxLabels({ conversationId, startedAt }),
    })
    containerId = await docker.createSandboxContainer(
      buildSandboxContainerSpec({ image, conversationId, volumeName, startedAt }),
    )
    await docker.startSandboxContainer(containerId)
    const updated = await prisma.sandbox.updateMany({
      where: { id: row.id, status: 'CREATING' },
      data: { containerId, status: 'RUNNING' },
    })
    if (updated.count === 0) {
      // CAS 失败 = 有人在我创建的同时把这个会话收了（回收器只可能对非活体行动手，所以这是异常）
      throw new Error('容器已启动，但账本行已不是 CREATING（并发回收？）')
    }
    getLogger().info(
      { conversationId, sandboxId: row.id, containerId, image, slots: `${slots.size}/${slots.limit}` },
      '沙箱容器已就绪',
    )
    return { sandboxId: row.id, conversationId, containerId, volumeName, image, createdAt: row.createdAt, reused: false }
  } catch (error) {
    const reason = toUserFacingReason(error)
    if (containerId !== undefined) {
      await docker.removeSandboxContainer(containerId).catch((cleanupError: unknown) => {
        getLogger().warn({ err: cleanupError, containerId }, '创建失败后删容器失败（留给对账器）')
      })
    }
    await docker.removeSandboxVolume(volumeName).catch((cleanupError: unknown) => {
      getLogger().warn({ err: cleanupError, volumeName }, '创建失败后删卷失败（留给对账器）')
    })
    await prisma.sandbox
      .updateMany({ where: { id: row.id, status: 'CREATING' }, data: { status: 'FAILED', errorMsg: reason } })
      .catch((markError: unknown) => {
        getLogger().warn({ err: markError, sandboxId: row.id }, '创建失败后标 FAILED 失败（留给对账器）')
      })
    getLogger().error({ err: error, conversationId, image }, '创建沙箱容器失败')
    throw new Error(reason, { cause: error })
  }
}

/**
 * 收掉一个沙箱：容器 → 具名卷 → 账本 → 名额。
 *
 * @param reason 只进日志（`RECYCLED` 行不记原因：原因有四种，用一列文本混装它们只会让读的人猜；
 *        要追原因看日志，那里有 conversationId 与 reason）
 * @returns 这一轮**真的动了东西**吗（对账器用它统计"回收了几个"；重复调用返回 false）
 *
 * 幂等：容器/卷已经不在了（`removeSandbox*` 内部吞 404）、账本行已经 `RECYCLED`、名额已经不在 ——
 * 三种情形都走同一条路。回收路径必须幂等，因为**对账器与空闲回收器会重复走到同一个对象**。
 */
export async function recycleSandbox(conversationId: string, reason: string): Promise<boolean> {
  const prisma = getPrisma()
  const rows = await prisma.sandbox.findMany({
    where: { conversationId, status: { in: ['CREATING', 'RUNNING'] } },
    select: { id: true, containerId: true, status: true },
  })

  let changed = false
  for (const row of rows) {
    if (row.containerId !== null) {
      await docker.removeSandboxContainer(row.containerId)
      changed = true
    }
    // ★ 第二步必须显式删具名卷：`docker rm -v` 删不掉它（P0-3-2 实测，见文件头顺序问题 3）
    for (const volume of await docker.listVolumesOf(conversationId)) {
      if (volume.Name !== undefined) {
        await docker.removeSandboxVolume(volume.Name)
        changed = true
      }
    }
    // 账本 CAS（只从"活着"的状态前进；已经 RECYCLED/FAILED 的行一个字都不动）
    const updated = await prisma.sandbox.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'RECYCLED' },
    })
    changed = changed || updated.count > 0
  }

  if (slots.remove(conversationId)) changed = true
  if (changed) {
    getLogger().info({ conversationId, reason, rows: rows.length, slots: `${slots.size}/${slots.limit}` }, '沙箱已回收')
  } else {
    getLogger().debug({ conversationId, reason }, '沙箱回收：没有可回收的对象（幂等路径）')
  }
  return changed
}

/** 删一个容器对象（对账器用：它拿到的可能是**没有账本行**的容器，见文件头顺序问题 1 的反面） */
export async function destroySandboxContainer(containerId: string): Promise<void> {
  await docker.removeSandboxContainer(containerId)
}

/** 删一个卷对象（对账器用：按名字，不按会话） */
export async function destroySandboxVolume(name: string): Promise<void> {
  await docker.removeSandboxVolume(name)
}

/** 把若干会话的"活着"的行标成 RECYCLED（对账器清完对象后收账用） */
export async function markSandboxRowsRecycled(conversationIds: readonly string[]): Promise<number> {
  if (conversationIds.length === 0) return 0
  const updated = await getPrisma().sandbox.updateMany({
    where: { conversationId: { in: [...conversationIds] }, status: { in: ['CREATING', 'RUNNING'] } },
    data: { status: 'RECYCLED' },
  })
  return updated.count
}

/** 释放名额（对账器收了某个会话的容器后调它；不在册返回 false） */
export function releaseSandboxSlot(conversationId: string): boolean {
  return slots.remove(conversationId)
}

// ───────────────────────────── 对外：活动时间与观测 ─────────────────────────────

/**
 * 刷新 `last_active_at`（**唯一写入口**）。
 *
 * 调用时机：引擎每产生一个事件（P0-3-5 的桥接层）。判据是"最后一次**引擎事件**的时间"，
 * 不是 CPU 占用（`子方案③` §二）—— 一个跑了 30 分钟但只输出了一次的容器仍然是活跃的。
 *
 * @returns 命中了 `RUNNING` 行返回 `true`；没有（会话没在跑）返回 `false` ——
 *          **不抛错**：桥接层在收尾路径上也会调它，那时容器可能刚被回收掉。
 */
export async function touchSandbox(conversationId: string, at: Date = new Date()): Promise<boolean> {
  const updated = await getPrisma().sandbox.updateMany({
    where: { conversationId, status: 'RUNNING' },
    data: { lastActiveAt: at },
  })
  return updated.count > 0
}

/** 观测用快照（启动日志 / 对账日志 / 将来的 `GET /api/tasks`） */
export interface SandboxStats {
  /** 本实例此刻占着名额的会话数 */
  active: number
  limit: number
  /** 在册的会话 id（排查"名额被谁占着"用） */
  conversations: string[]
  /** 未配置镜像时为 undefined */
  image: string | undefined
  /** 空闲回收阈值（分钟） */
  idleTtlMin: number
}

/** 取名额册快照（**不发起任何 IO** —— 它能被日志与探活安全地反复调用） */
export function getSandboxStats(): SandboxStats {
  return {
    active: slots.size,
    limit: slots.limit,
    conversations: slots.conversations(),
    image: config.sandbox.image,
    idleTtlMin: config.sandbox.idleTtlMin,
  }
}

// ───────────────────────────── 小工具 ─────────────────────────────

function fail(code: SandboxAcquireFailure, message: string): SandboxAcquireResult {
  return { ok: false, code, message }
}

function failWait(code: SandboxAcquireFailure, message: string): SlotWaitResult {
  return { ok: false, code, message }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 把错误转成**给人看的一句话**（`02` §九 的纪律：连接串/存储键/堆栈只进日志）。
 * Docker 的报错在 `docker.ts` 里已经翻译过一轮（`describeDockerFailure`），这里只做截断。
 */
function toUserFacingReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const oneLine = raw.replace(/\s+/gu, ' ').trim()
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine
}
