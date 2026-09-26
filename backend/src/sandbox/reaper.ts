/**
 * 沙箱对账器（回收器）—— 启动对账 + 周期回收 + 空闲回收（P0-3-2）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §九 2（★ **孤儿回收器不是优化，是必需项**）、
 *      §九 1（两个最经典的静默泄漏）、§九 4（三种"高可用"档位 —— P0 只做**进程级自愈**）、
 *      `docs/02-后端设计.md` §七 第 5 步（"空闲 30min 回收；孤儿回收器（后端启动 + 周期，
 *      按 label 扫容器与卷）是必需项，不是优化"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么必需（不做的话症状是"玄学"）
 * ─────────────────────────────────────────────────────────────────────
 * **后端崩一次就必然留下容器**（容器是 Docker 的对象，不随我们的进程消失）。没有清道夫，
 * 它们会一直占着槽位不释放 ⇒ **10 个并发名额被静默吃掉**，用户看到的是
 * "**明明没人用却在排队**"（§九 2 原话）。这是本仓最容易被当成玄学的一处。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 启动对账与周期对账**判据不同**（这是本文件唯一的"设计取舍"）
 * ─────────────────────────────────────────────────────────────────────
 * · **启动对账（`reconcileOnBoot`）清掉全部**带 label 的容器与卷 —— 理由不是"省磁盘"，
 *   而是**引擎是后端进程的子进程**（P0-3-5 的 `pi --mode rpc` 桥接）。进程一死，容器里的
 *   引擎就没有对话者了：那是一个"活着但没人能跟它说话"的容器，复用它会得到一句
 *   "发消息没反应"。所以重启后**一律重建**，而不是复用 —— 这同时与 §九 4 的
 *   "不恢复运行中的沙箱…用户刷新看到历史，直接重发"逐字一致。
 *   顺带一个免费的收益：名额册是进程内的，启动时它天然为空 ⇒ "清空容器"让**账面与实际**
 *   在重启后自动一致（这条是选"进程内计数"的主要理由之一，见 `registry.ts`）。
 * · **周期对账（`reapOrphans`）只清"没有对应活会话的"** —— 因为运行期里活着的容器
 *   正在被用户使用，判死它的唯一合法理由是"它对应的会话没了"（会话被删 / Agent 被软删
 *   ⇒ 会话转 `FINISHED` 只读）。空闲的那一批由 `reapIdleSandboxes()` 按 `last_active_at` 另行处理。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 判据只有一处：**label**（`子方案③` §四 1）
 * ─────────────────────────────────────────────────────────────────────
 * 本文件列对象**只按 label**（`spec.sandboxFilter()`），表只用来回答"它该不该活着"。
 * 两次判断合成一条 `liveConversationIds` 集合（见 `collectLiveConversations`），容器与卷共用它 ——
 * 给容器一套判据、给卷另一套，迟早会分叉出一个"容器删了卷留着"的稳定泄漏。
 */

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import * as docker from './docker.js'
import { markSandboxRowsRecycled, recycleSandbox, releaseSandboxSlot } from './manager.js'
import { clearSandboxQueue, pruneSandboxQueue } from './queue.js'
import { keepSandboxObject, readSandboxLabels } from './spec.js'

/** 一轮对账的账目（日志与验收都读它；"没干任何事"也必须能看出来，否则无法区分"对账跑过但没事"与"对账根本没跑"） */
export interface ReapReport {
  /** 扫到的我们的容器数（**不是**全机容器数 —— 只算带 label 的） */
  containers: number
  /** 扫到的我们的卷数 */
  volumes: number
  removedContainers: number
  removedVolumes: number
  /** 删除失败的个数（每个都有 warn；不算致命，下一轮还会试） */
  removalFailures: number
  /** 被标 `FAILED` 的过期 `CREATING` 行数 */
  staleCreatingRows: number
  /** 被收账成 `RECYCLED` 的账本行数 */
  rowsRecycled: number
  /** 清掉的过期排队项数 */
  queuePruned: number
}

/** 启动对账的账目（比周期多一项"整表清空的排队项"） */
export interface ReconcileReport extends ReapReport {
  /** 启动时整表清空的排队项数（队列项对应的是前端那条流，重启后它们全是孤儿） */
  queueCleared: number
  /** 被标 `FAILED` 的 `CREATING` 行（**启动时全部算过期**：此刻不可能有在飞的创建） */
  danglingCreatingRows: number
  /** 被收账成 `RECYCLED` 的 `RUNNING` 行 */
  runningRowsRecycled: number
  /** Docker 守护进程版本（写进启动日志，"沙箱到底接没接上 Docker"一眼可判） */
  dockerVersion: string
}

/** 对账器的运行态（日志与将来的探活用） */
export interface ReaperStats {
  running: boolean
  intervalSec: number
  /** 上一轮开始的时刻（epoch ms）；从未跑过为 undefined */
  lastRunAt?: number
  lastReport?: ReapReport
}

let timer: NodeJS.Timeout | undefined
let ticking: Promise<void> | undefined
let lastRunAt: number | undefined
let lastReport: ReapReport | undefined
/** 「Docker 不可达」是否已告警（避开"每分钟刷一条同样的 warn"） */
let dockerDownNotified = false

// ───────────────────────────── 启动对账 ─────────────────────────────

/**
 * 启动时的对账（`index.ts` 在 `listen` 成功之后调用一次）。
 *
 * ⚠️ 三条纪律：
 *   ① **失败绝不影响后端启动**：Docker 没起、镜像没建、socket 不可读 —— 都只 warn。
 *      沙箱是可选能力，不该让"整个后端起不来"（本机跑前端时常见 Docker 是关着的）。
 *   ② **未配置镜像就整体跳过**：没配 `SANDBOX_IMAGE` 说明镜像还没构建 ⇒ 不可能有我们的容器，
 *      此时去连 Docker 只是白白制造噪声（也让"没装 Docker 的人"每次启动都吃一条 warn）。
 *   ③ **只 warn 不 exit**：与 `config.ts` 的"缺必填项就 exit 1"**刻意相反** ——
 *      配置缺失是"服务不该跑"，Docker 不可达是"这项能力暂时不可用"。
 */
export async function reconcileOnBoot(): Promise<ReconcileReport | undefined> {
  if (config.sandbox.image === undefined) {
    getLogger().info(
      '未配置 SANDBOX_IMAGE ⇒ 跳过沙箱启动对账（镜像未构建时不可能有遗留容器；构建后见 README「构建沙箱镜像」）',
    )
    return
  }
  const dockerVersion = await reachableDockerVersion()
  if (dockerVersion === undefined) return undefined

  const report: ReconcileReport = {
    ...emptyReport(),
    dockerVersion,
    queueCleared: 0,
    runningRowsRecycled: 0,
    danglingCreatingRows: 0,
  }
  try {
    const { containers, volumes } = await docker.listSandboxObjects()
    report.containers = containers.length
    report.volumes = volumes.length

    // ① 容器与卷：**全部清掉**（理由见文件头"启动对账与周期对账判据不同"）
    for (const container of containers) {
      try {
        await docker.removeSandboxContainer(container.Id)
        report.removedContainers += 1
      } catch (error) {
        report.removalFailures += 1
        getLogger().warn({ err: error, containerId: container.Id }, '启动对账：删容器失败（下一轮会再试）')
      }
    }
    for (const volume of volumes) {
      if (volume.Name === undefined) continue
      try {
        await docker.removeSandboxVolume(volume.Name)
        report.removedVolumes += 1
      } catch (error) {
        report.removalFailures += 1
        getLogger().warn({ err: error, volumeName: volume.Name }, '启动对账：删卷失败（下一轮会再试）')
      }
    }

    // ② 队列整表清空（**只在这里做**：运行期清空会连正常排队的等待者一起清掉）
    report.queueCleared = await clearSandboxQueue()

    // ③ 账本回落：容器已被我们全清 ⇒ 所有"活着"的行都不再对应真实对象
    const prisma = getPrisma()
    const running = await prisma.sandbox.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'RECYCLED' },
    })
    report.runningRowsRecycled = running.count
    const creating = await prisma.sandbox.updateMany({
      where: { status: 'CREATING' },
      data: { status: 'FAILED', errorMsg: '创建未完成（后端已重启，容器已随启动对账清掉）' },
    })
    report.danglingCreatingRows = creating.count
  } catch (error) {
    // 对账自己炸了也要让后端起来：留下 warn 与半份账目（比"什么都没说"强）
    getLogger().warn({ err: error, report }, '启动对账中途出错（后端照常启动，下一轮周期对账会继续）')
  }

  getLogger().info(
    {
      dockerVersion,
      containers: `${report.removedContainers}/${report.containers}`,
      volumes: `${report.removedVolumes}/${report.volumes}`,
      queueCleared: report.queueCleared,
      runningRowsRecycled: report.runningRowsRecycled,
      danglingCreatingRows: report.danglingCreatingRows,
      removalFailures: report.removalFailures,
      idleTtlMin: config.sandbox.idleTtlMin,
      concurrency: config.concurrency.sandbox,
    },
    `沙箱启动对账完成（Docker ${dockerVersion}）：清理遗留容器与卷；` +
      '⚠️ 本进程重启会让容器内引擎失去对话者 ⇒ 一律重建，不复用',
  )
  return report
}

// ───────────────────────────── 周期对账 ─────────────────────────────

/**
 * 孤儿回收：清掉"**没有对应活会话**"的容器与卷（§九 2）。
 *
 * @returns 账目；Docker 不可达或未配置镜像时返回 `undefined`（调用方据此跳过）
 *
 * 判死的**唯一**判据是 {@link collectLiveConversations} 那个集合，容器与卷共用它。
 * 特别地：**标签读不出来的对象也会被删**（`readSandboxLabels` 返回 undefined）——
 * 它们带着 `doubulea.role=sandbox`，占着磁盘与名额，却谁也认领不了；
 * 留着它们等于给自己留一份"看得见、判不了、删不了"的永久残留。
 */
export async function reapOrphans(): Promise<ReapReport | undefined> {
  if (config.sandbox.image === undefined) return undefined
  if ((await reachableDockerVersion()) === undefined) return undefined

  const prisma = getPrisma()
  const report = emptyReport()
  const graceSec = config.sandbox.createGraceSec

  // ① 过期的 `CREATING` 行先判死：它们对应的容器（如果有）随后会被判成孤儿，一轮内清干净。
  //    宽限期的意义：运行期里"正在建"的行**不能**被判死（那会把一次正常的创建打成孤儿）。
  //    ⚠️ 这里与 `collectLiveConversations` 都是**JS 侧**边界 ⇒ `sandboxes.created_at` 必须由
  //    JS 侧写入（见 `manager.ts#createSandbox` 的注释与 `docs/02` 的"已知问题：timestamptz 时区"）。
  const staleCutoff = new Date(Date.now() - graceSec * 1000)
  const stale = await prisma.sandbox.updateMany({
    where: { status: 'CREATING', createdAt: { lt: staleCutoff } },
    data: { status: 'FAILED', errorMsg: '创建未完成（超过宽限期未见容器就绪）' },
  })
  report.staleCreatingRows = stale.count

  // ② 活会话集合（必须在 ① 之后算 —— 否则刚被标死的那些还会被当成活的）
  const live = await collectLiveConversations(graceSec)

  // ③ 列我们的对象 → 逐个判死。**容器与卷用同一个谓词**（`keepSandboxObject`）
  const { containers, volumes } = await docker.listSandboxObjects()
  report.containers = containers.length
  report.volumes = volumes.length
  const touched = new Set<string>()

  for (const container of containers) {
    const labels = readSandboxLabels(container.Labels)
    if (keepSandboxObject(labels, live)) continue
    try {
      await docker.removeSandboxContainer(container.Id)
      report.removedContainers += 1
      if (labels !== undefined) touched.add(labels.conversationId)
    } catch (error) {
      report.removalFailures += 1
      getLogger().warn({ err: error, containerId: container.Id }, '孤儿回收：删容器失败（下一轮会再试）')
    }
  }

  for (const volume of volumes) {
    const labels = readSandboxLabels(volume.Labels)
    if (keepSandboxObject(labels, live)) continue
    if (volume.Name === undefined) continue
    try {
      await docker.removeSandboxVolume(volume.Name)
      report.removedVolumes += 1
      if (labels !== undefined) touched.add(labels.conversationId)
    } catch (error) {
      report.removalFailures += 1
      getLogger().warn({ err: error, volumeName: volume.Name }, '孤儿回收：删卷失败（下一轮会再试）')
    }
  }

  // ④ 收账：这些会话的对象已经没了 ⇒ 名额还回去、活体行标成 RECYCLED。
  //    ⚠️ 名额必须还：不还就是"槽位被静默吃掉"那一幕（文件头）。删失败的那些**不还**
  //    （对象还在，名额就该还占着）—— 所以 touched 只收**删成功**的会话。
  if (touched.size > 0) {
    for (const conversationId of touched) {
      // 只清名额，不再走一遍 recycleSandbox（对象刚被我们按名字删掉了，重复删只是多两次 404）
      releaseSandboxSlot(conversationId)
    }
    report.rowsRecycled = await markSandboxRowsRecycled([...touched])
  }

  // ⑤ 排队项：顺手清过期（队列项的 TTL 是它自己的 score + `SANDBOX_QUEUE_TTL_SEC`）
  report.queuePruned = await pruneSandboxQueue()

  logReap('孤儿回收', report)
  return report
}

/**
 * 空闲回收：`status=RUNNING` 且 `last_active_at` 超过 `SANDBOX_IDLE_TTL_MIN` 的沙箱收掉。
 *
 * ⚠️ 判据是 **`last_active_at`**（= 最后一次**引擎事件**的时间），不是 `created_at`、不是 CPU：
 * 一个连续跑了 40 分钟、期间一直在输出的事件流**不会**被回收（每来一个事件都会 `touchSandbox()`）。
 * 相反，一个建出来就没动静的容器会在 30 分钟后被收掉 —— 那正是我们要的语义。
 *
 * @returns 真的回收了几个（`recycleSandbox` 说"动了东西"才算）
 */
export async function reapIdleSandboxes(): Promise<number> {
  if (config.sandbox.image === undefined) return 0
  if ((await reachableDockerVersion()) === undefined) return 0

  const cutoff = new Date(Date.now() - config.sandbox.idleTtlMin * 60_000)
  const stale = await getPrisma().sandbox.findMany({
    where: { status: 'RUNNING', lastActiveAt: { lt: cutoff } },
    select: { conversationId: true, lastActiveAt: true },
  })
  if (stale.length === 0) return 0

  let reaped = 0
  for (const row of stale) {
    if (await recycleSandbox(row.conversationId, 'idle')) reaped += 1
  }
  getLogger().info(
    { candidates: stale.length, reaped, idleTtlMin: config.sandbox.idleTtlMin },
    '空闲沙箱回收完成',
  )
  return reaped
}

// ───────────────────────────── 周期任务的生命周期 ─────────────────────────────

/**
 * 启动周期对账器（**在 `listen` 成功之后**调，与流水线 worker 同款纪律：进程级后台组件
 * 不放进 `buildApp()`，否则所有 `app.inject` 式的契约验收都会顺带连 Docker）。
 *
 * @returns 真的启动了吗（未配置镜像时为 `false`，调用方可以据此少打一行日志）
 *
 * ⚠️ 两处工程细节：
 *   · `unref()` —— 定时器不该成为"进程退不掉"的原因（HTTP listener 才是保活的那个）；
 *   · **重入保护**：一轮对账可能比间隔还慢（Docker 卡住时），不保护就会同时在跑两轮，
 *     两轮各自"列对象 → 判死 → 删"，会互相把对方刚建的容器当成孤儿。这不是假想的并发 ——
 *     它是**周期性任务的标准坑**（同族：P0-1-17 的 worker 串行消费）。
 */
export function startSandboxReaper(): boolean {
  if (timer !== undefined) return false
  if (config.sandbox.image === undefined) {
    getLogger().info('未配置 SANDBOX_IMAGE ⇒ 不启动沙箱周期对账器')
    return false
  }
  const intervalMs = config.sandbox.reapIntervalSec * 1000
  timer = setInterval(runReapTick, intervalMs)
  timer.unref()
  getLogger().info(
    { intervalSec: config.sandbox.reapIntervalSec, idleTtlMin: config.sandbox.idleTtlMin },
    '沙箱周期对账器已启动（孤儿回收 + 空闲回收）',
  )
  return true
}

/** 停周期对账器，并**等在飞的那一轮收尾**（它可能正在删容器 —— 中途放手会留下半个回收态） */
export async function stopSandboxReaper(): Promise<void> {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  const pending = ticking
  if (pending !== undefined) {
    try {
      await pending
    } catch (error) {
      getLogger().debug({ err: error }, '等待在飞的对账轮次时出错（进程正在退出，已忽略）')
    }
  }
}

/** 对账器运行态（日志/排障用） */
export function getSandboxReaperStats(): ReaperStats {
  return {
    running: timer !== undefined,
    intervalSec: config.sandbox.reapIntervalSec,
    lastRunAt,
    lastReport,
  }
}

function runReapTick(): void {
  if (ticking !== undefined) {
    getLogger().debug('上一轮沙箱对账还没跑完，跳过本轮（避免两轮互删）')
    return
  }
  ticking = (async () => {
    lastRunAt = Date.now()
    try {
      const orphans = await reapOrphans()
      if (orphans !== undefined) lastReport = orphans
      await reapIdleSandboxes()
    } catch (error) {
      // 一轮炸了不该让对账器停摆（下一轮继续）；但必须留 error 级痕迹
      getLogger().error({ err: error }, '沙箱周期对账出错（下一轮继续）')
    } finally {
      ticking = undefined
    }
  })()
}

// ───────────────────────────── 内部工具 ─────────────────────────────

/**
 * 「本轮活着的会话」= **会话存在且 `ACTIVE`** ∩ （有 `RUNNING` 行 ∪ 有宽限期内的 `CREATING` 行）。
 *
 * 两个集合交集而不是并集，都是刻意的：
 *   · **会话必须 ACTIVE** —— Agent 被软删后会话转 `FINISHED`（只读），那时不该再留着容器；
 *   · **账本必须有活体行** —— 这一半专治"容器已建、行还没写完"的崩溃窗口：那种容器
 *     谁也认领不了，留着只占资源。
 * 宽限期内的 `CREATING` 也算活体：它正是"正在建、还没到 RUNNING"的那一刻。
 */
async function collectLiveConversations(graceSec: number): Promise<Set<string>> {
  const prisma = getPrisma()
  const cutoff = new Date(Date.now() - graceSec * 1000)
  const rows = await prisma.sandbox.findMany({
    where: { OR: [{ status: 'RUNNING' }, { status: 'CREATING', createdAt: { gte: cutoff } }] },
    select: { conversationId: true },
    distinct: ['conversationId'],
  })
  if (rows.length === 0) return new Set()
  const active = await prisma.conversation.findMany({
    where: { id: { in: rows.map((row) => row.conversationId) }, status: 'ACTIVE' },
    select: { id: true },
  })
  return new Set(active.map((row) => row.id))
}

/**
 * Docker 可达性（**一轮只告警一次**）。
 * 与 `infra/redis.ts` 的 `downNotified` 同款：依赖宕机期间刷屏的 warn 会把别的信息挤掉。
 */
async function reachableDockerVersion(): Promise<string | undefined> {
  try {
    const version = await docker.pingDocker()
    if (dockerDownNotified) {
      dockerDownNotified = false
      getLogger().info({ version }, 'Docker 已恢复，沙箱对账继续')
    }
    return version
  } catch (error) {
    if (dockerDownNotified) {
      getLogger().debug({ err: error }, 'Docker 仍不可达（本轮已告警过）')
      return undefined
    }
    dockerDownNotified = true
    getLogger().warn({ err: error }, 'Docker 不可达：沙箱对账本轮跳过（后端其余功能不受影响）')
    return undefined
  }
}

function emptyReport(): ReapReport {
  return {
    containers: 0,
    volumes: 0,
    removedContainers: 0,
    removedVolumes: 0,
    removalFailures: 0,
    staleCreatingRows: 0,
    rowsRecycled: 0,
    queuePruned: 0,
  }
}

/** 无事可做时降到 debug（默认 60 秒一轮，每轮一条 info 会把日志冲掉） */
function logReap(scope: string, report: ReapReport): void {
  const changed =
    report.removedContainers +
      report.removedVolumes +
      report.staleCreatingRows +
      report.rowsRecycled +
      report.queuePruned >
    0
  if (!changed && report.removalFailures === 0) {
    getLogger().debug({ scope, ...report }, `${scope}：无变化`)
    return
  }
  getLogger().info({ scope, ...report }, `${scope}完成`)
}
