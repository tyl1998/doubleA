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
import { resolveSandboxLlm, type SandboxLlmResult } from './llm.js'
import {
  claimSandboxQueueHead,
  enqueueSandboxQueue,
  leaveSandboxQueue,
  pruneSandboxQueue,
  sandboxQueueDepth,
  sandboxQueuePosition,
} from './queue.js'
import { createSlotRegistry } from './registry.js'
import { ensureSandboxNetwork, type SandboxNetwork } from './network.js'
import {
  buildSandboxContainerSpec,
  isNonRootImageUser,
  piRpcArgv,
  readSandboxLabels,
  SANDBOX_AGENT_HOME,
  sandboxEgressEnv,
  sandboxProxyEnv,
  workVolumeName,
  workspaceMediationEnv,
} from './spec.js'
import { gitCredentialEnv, gitCredentialFiles, gitCredentialTarEntries } from './gitCredential.js'
import { buildTar } from './tar.js'
import { bindSandboxToken, revokeSandboxToken } from './token.js'
import { clearSandboxMcpMap } from './mcpMap.js'
import { clearSandboxOwner, registerSandboxOwner } from './owner.js'
import { ensureWorkspace } from '../workspace/service.js'
import { startWorkspaceWatcher } from '../workspace/watcher.js'
import { decryptUserGitCredentials } from '../services/gitCredential.service.js'

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
  /**
   * 这一轮用的**模型不可用**（P0-3-4）—— 模型没配 Key、模型/Provider 已停用或被删。
   *
   * 为什么单独一个码而不是并进 `NOT_CONFIGURED`：两者的**修法完全不同**
   * （一个是"管理员去把 SANDBOX_IMAGE / 代理配上"，一个是"用户去模型池/智能体页改一改"），
   * 而编排层要按码选文案。与 P0-2 的 `NEED_CREDENTIAL` 是同一族判断：
   * "缺凭据"值得一个独立的码，因为它指向一个具体的、用户能自己完成的动作。
   */
  | 'MODEL_NOT_AVAILABLE'
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

  // ★ 出口① 的前置（P0-3-3）：容器在**专用 internal bridge** 上，**没有公网路由** ⇒
  //   没有 egress 代理就必然调不到模型池。**在这里拦住**，而不是让容器建起来再在容器里失败 ——
  //   同一个判据见 P0-2-9 的"被拦下的危险调用不发 RUNNING 卡"（不为必然失败的调用付交互成本），
  //   以及 `resolveChatTarget()` 没 Key 直接 424。
  const proxyUrl = config.sandbox.egressProxyUrl
  if (proxyUrl === undefined) {
    return fail(
      'NOT_CONFIGURED',
      '未配置 SANDBOX_EGRESS_PROXY_URL：容器挂在专用 internal bridge 上、没有公网路由，' +
        '没有 egress 代理就必然调不到模型池。把沙箱出公网的代理地址（只放行模型池 baseURL）配好再派活。',
    )
  }

  // 网络的这三件事**也属于校验**（顺序即正确性，文件头顺序问题 2）：它们失败时我们还什么都没建。
  // 网络是共享基础设施，`ensureSandboxNetwork()` 幂等（并发最多多建一次）。
  let network: SandboxNetwork
  try {
    network = await ensureSandboxNetwork()
  } catch (error) {
    return fail('CREATE_FAILED', toUserFacingReason(error))
  }
  const runtime: SandboxRuntime = {
    network,
    proxyUrl,
    // 「容器眼里的后端地址」**只有一个来源**：显式配置，或由 bridge 网关地址 + 回调端口算出。
    // **不猜、不兜底**（`06` §六 27）—— 猜错的症状是容器里那次 fetch 永远超时。
    backendUrl: config.sandbox.backendUrl ?? `http://${network.gateway}:${config.sandbox.callbackPort}`,
  }

  // ② 校验排在删除之前：会话必须存在且 ACTIVE。⚠️ 已结束（Agent 被软删后转只读）的会话
  //    不该再起容器 —— 它连新消息都不该收。
  //    ★ 同时把 `agent.model_id` 一起取出来（P0-3-4）：容器要用的 Key/地址/模型名全靠它解析，
  //    而"两次查询之间模型被改掉"这个窗口没必要存在 —— 一次往返把两问都答了。
  const conversation = await getPrisma().conversation.findUnique({
    where: { id: conversationId },
    // ★ P0-3-9b 起多取两列（`userId` / `agentId`）：per-container 代理令牌的**身份**就是它们
    //   （`{conversationId, userId, agentId}` ⇒ `sandbox/token.ts`）。为什么在这一条查询里一起取：
    //   令牌要在**建容器之前**写好（容器一起来扩展就会拿它拉工具清单），而现在这里已经是
    //   "建容器之前唯一一次读会话"的位置 —— 再加一条查询只会多一个"两次读之间会话/Agent 变了"的窗口。
    select: { status: true, userId: true, agentId: true, agent: { select: { modelId: true } } },
  })
  if (conversation === null) return fail('CONVERSATION_NOT_FOUND', '会话不存在')
  if (conversation.status !== 'ACTIVE') return fail('CONVERSATION_NOT_FOUND', '会话已结束（只读）')

  // ★ P0-3-4 第二道校验：解析这一轮要注入容器的 LLM 目标。
  //   位置是刻意的 —— 与上面两条配置校验一样**排在"动容器"之前**：
  //   模型不可用时，容器根本不该被建出来（建了它也只能在容器里失败，而容器内的失败只会以
  //   一条含糊的 stderr 出现，见 `子方案③` §六 3）。这里失败还**没占名额**、没有副作用。
  //   ⚠️ 返回值含明文 Key ⇒ **只往下传给 `buildSandboxContainerSpec`**，不 log（见 `llm.ts` 文件头）。
  const llm = await resolveSandboxLlm(conversation.agent.modelId)
  if (!llm.ok) return fail(llm.code, llm.message)

  // ① 复用：账本说有 RUNNING 行 **且容器还在跑**（账本会撒谎，Docker 不会）。
  //    ★ P0-3-8 收紧：判据从"容器存在"改成"容器**在跑**"—— pi 是容器主进程 ⇒ 引擎退出 =
  //    容器退出，而 `inspect` 对退出的容器照样成功 ⇒ 只判"存在"会把一具尸体当可复用沙箱
  //    （`attach` 必败，用户每重发一次就再吃一次 UPSTREAM_ERROR，与"系统会自行重建"的
  //    文案矛盾）。停了 = 回收重建；**不做** `docker start` 复活（那是 `子方案③` §九 4
  //    刻意不做的档位 2「会话级续跑」）。
  const running = await getPrisma().sandbox.findFirst({
    where: { conversationId, status: 'RUNNING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, containerId: true, image: true, createdAt: true },
  })
  if (running !== null && running.containerId !== null) {
    const state = await docker.inspectSandboxContainerState(running.containerId)
    if (state === 'running') {
      // ★ P0-3-4：复用之前必须确认"容器里那套 LLM 目标还是这一轮的"。
      //   容器环境变量是**建的时候**注入的，而模型可以被改（`PATCH /api/agents/:id`）——
      //   不比对的话，改了模型之后同一会话的下一轮**继续用旧的 Key 与旧的模型名**调，
      //   而 Docker 与账本都不会报错（症状：账单与回答都不是你以为的那家）。
      //   判据用标签 `doubulea.model`（只存 id，不存 Key）；**读不出来就当不一致** ——
      //   这与对账器"标签读不出来也删"是同一条推理：读不出来时"重建"是唯一安全的动作。
      const labels = readSandboxLabels(await docker.inspectSandboxContainerLabels(running.containerId))
      if (labels?.modelId !== llm.modelId) {
        getLogger().info(
          { conversationId, containerId: running.containerId, was: labels?.modelId, now: llm.modelId },
          '复用沙箱前发现模型已变（或容器没有模型标签）⇒ 回收重建',
        )
        await recycleSandbox(conversationId, 'model-changed')
      } else {
        if (!slots.tryAdd(conversationId) && !slots.has(conversationId)) {
          // 只可能是"别的会话把名额占满了"（单实例下正常不该发生）⇒ 以容器为准放行 + 留痕。
          // 不在这里报错：把矛盾暴露出来，但不让一个已经存在的容器变成不可用。
          getLogger().warn(
            { conversationId, size: slots.size, limit: slots.limit },
            '复用已有沙箱时名额册已满：计数与容器实际数短暂不一致（按"容器为准"继续）',
          )
        }
        // ★ P1-14：复用路径也要确认目录仍指向本实例（目录可能已过 TTL 而容器还活着）。
        //   `SET NX` 不会抢走别的实例的目录；单实例下恒为同一值。
        await registerSandboxOwner(conversationId)
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
    } else {
      // 容器没了（手工删 / 宿主清理 / 崩过）或已退出（引擎死了 ⇒ pi 是主进程、容器跟着退）
      // ⇒ 先把账面收干净，再走新建。两种 reason 只进日志（见 `recycleSandbox` 的参数注释），
      // 但**值得分开**：`engine-exited` 指向"上一轮引擎故障"，`container-missing` 指向"外部动了 Docker"。
      await recycleSandbox(conversationId, state === 'stopped' ? 'engine-exited' : 'container-missing')
    }
  }

  if (!(await tryAcquireSlotNow(conversationId))) {
    const position = await enqueueSandboxQueue(conversationId)
    options.onQueued?.(position)
    const waited = await waitForSlot(conversationId, options)
    if (!waited.ok) return waited
  }

  // ★ P1-14 §六 1：**抢锁之后、建容器之前**写会话→实例目录（`SET NX`，先到先得）。
  //   此刻 `chat.active:{id}` 已由编排层持有 ⇒ 并发首个 `/chat` 只可能有一个赢家；
  //   写在这里把"网关查不到 owner"的窗口压到最小（窗口内的误投由那把锁兜底）。
  await registerSandboxOwner(conversationId)

  try {
    return {
      ok: true,
      sandbox: await createSandbox(conversationId, image, runtime, llm, {
        userId: conversation.userId,
        agentId: conversation.agentId,
      }),
    }
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
/**
 * 建一个沙箱所需的**运行期参数**（P0-3-3 新增）。
 * 三个值都在 `ensureSandbox()` 里解析完（那里是"校验排在删除之前"的落点），
 * 传进来只是为了不让 `createSandbox` 重新读一遍配置/再问一次 Docker。
 */
interface SandboxRuntime {
  /** 专用 internal bridge（见 `network.ts`） */
  network: SandboxNetwork
  /** 出口①：容器出公网唯一可能的路（`HTTP(S)_PROXY` 的值） */
  proxyUrl: string
  /** 出口②：容器眼里的后端沙箱代理地址（也写进容器 env，桥扩展 P0-3-9b 用它） */
  backendUrl: string
}

async function createSandbox(
  conversationId: string,
  image: string,
  runtime: SandboxRuntime,
  llm: Extract<SandboxLlmResult, { ok: true }>,
  owner: { userId: string; agentId: string },
): Promise<SandboxHandle> {
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
    data: {
      conversationId,
      status: 'CREATING',
      image,
      // ★ P1-14：本实例**显式写入**归属列（同 `createdAt`/`lastActiveAt` 的纪律：不用 DB 默认值）。
      //   对账的三处查询都带 `instanceId = self`，这一列就是"每实例只清自己"的判据。
      instanceId: config.sandbox.instanceId,
      lastActiveAt: startedAt,
      createdAt: startedAt,
    },
    select: { id: true, createdAt: true },
  })

  let containerId: string | undefined
  try {
    // 镜像缺失的文案在这里就换成"先 pnpm sandbox:build"（否则会用一句 Docker 原文糊过去）
    await docker.ensureImage(image)
    // ★ "非 root" 是**镜像**属性（`docker create` 参数里没有这一项）⇒ 唯一能守住它的地方就是这里。
    //   镜像被换成一个以 root 跑的镜像时**什么都不会报错**，只有这里的断言拦得住（P0-3-3）。
    const imageUser = await docker.inspectImageUser(image)
    if (!isNonRootImageUser(imageUser)) {
      throw new Error(
        `沙箱镜像 ${image} 不是以非 root 用户运行（Config.User = ${imageUser ?? '（未声明 = root）'}）。` +
          '--cap-drop ALL 对 root 进程的意义要小得多 ⇒ 拒绝启动。请用 pnpm sandbox:build 重建镜像。',
      )
    }
    /**
     * ★ P1-9：工作区从**具名卷**改成**宿主 bind mount**（`{WORKSPACE_ROOT}/{conversationId}` → `/work`）。
     * 这样容器里的 pi 与浏览器侧编辑的是**同一批字节**（Code 模式的核心）。
     *
     * ⚠️ 三件顺序上的事：
     *   ① 目录**必须在这里建好**（`ensureWorkspaceDir`）：Docker bind 不会替我们建源目录，
     *      源不存在时它**静默**建一个空的 0600 目录并挂进去（症状：容器里 `/work` 是空的、
     *      宿主上却找不到你写的文件）；
     *   ② 属主对齐（`alignAgentOwnership`，以 root 运行时才 chown 到 `SANDBOX_AGENT_UID`）；
     *   ③ **不再建具名卷**（`createSandboxVolume` 本批退役）——旧的补偿/回收路径仍会尝试删卷，
     *      那是幂等的空操作（`removeSandboxVolume` 吞 404），留给历史遗留卷。
     *
     * ★ P1-9 · R3：走 `ensureWorkspace` 而不是裸建目录 —— 它额外带**冷备恢复**
     *   （目录缺失/为空时从 S3 按最新版本重建）⇒ 换机 / 宿主重建后的首轮派活前自动 rehydrate。
     */
    const { rootPath: workspacePath } = await ensureWorkspace(conversationId)
    // ★ P1-9 · P3：本会话是否开了 Code 模式 ⇒ 决定是否给容器注入 `DOUBULEA_WORKSPACE_MEDIATION=1`
    //   （pi 的 read/write/edit 走版本中介）。持久列，派活时读一次即可（容器即会话）。
    const conversationRow = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { codeMode: true },
    })
    const codeMode = conversationRow?.codeMode ?? false
    /**
     * ★ P1-9 · R11：解密该用户的 git 凭据（明文**只在本进程与容器注入物里出现**，见服务文件头 ②）。
     *    env 必须在 `buildSandboxContainerSpec` 之前定（`Env` 建容器时定死），
     *    文件在容器起来后 `putArchive`（tmpfs `$HOME/.ssh`）。两条都只做**一次**（每次建容器）。
     */
    const gitCredentials = await decryptUserGitCredentials(owner.userId)
    const gitEnv = gitCredentialEnv(gitCredentials)
    const gitFiles = gitCredentialFiles(gitCredentials)
    // ★ 开始监听这个会话的工作区：捕获**未中介写**（agent 的 `bash`、宿主手工改）并补版本/事件。
    // ⚠️ 监听寿命**跟随工作区、不随容器回收而停**（§八）⇒ 这里只启动，回收路径不 stop；
    //    进程退出时由 `index.ts` 统一 `stopAllWorkspaceWatchers()`。
    startWorkspaceWatcher(conversationId)
    /**
     * ★ P0-3-9b：签发 per-container 代理令牌。
     *
     * **位置是正确性的一部分** —— 必须在建/启容器**之前**：
     * 容器一起来，pi 就加载桥扩展、扩展立刻拿 `SANDBOX_TOKEN` 去拉工具清单
     * （`GET /api/sandbox/mcp/tools`）⇒ 令牌晚一步写好，容器第一次拉清单就是 401，
     * 而扩展那边看起来像"后端不可达"（§六 27 的"服务间地址不做兜底"同族）。
     * 反过来放早了也不好：这里已经过了全部校验（镜像 / 模型 / 卷），失败概率最低。
     */
    const token = await bindSandboxToken({ conversationId, userId: owner.userId, agentId: owner.agentId })
    containerId = await docker.createSandboxContainer(
      buildSandboxContainerSpec({
        image,
        conversationId,
        volumeName,
        // ★ P1-9：Code 模式工作区 = 宿主 bind mount（人与 agent 同字节）；见上方注释
        workspacePath,
        startedAt,
        // ★ 模型 id 进标签（P0-3-4）：**复用前比对的唯一判据**（`ensureSandbox` 里那一段）。
        //   为什么不用 `sandboxes` 表存：表里的行是"账本"，而模型变更是**容器属性**的问题 ——
        //   要在"谁占着这个容器"这个问题上有一个跟着容器走的答案（同 label 族的其余三问）。
        modelId: llm.modelId,
        network: runtime.network.name,
        limits: config.sandbox.limits,
        /**
         * ★ P0-3-5：覆盖镜像 CMD —— 引擎要以 **rpc 模式 + 我们这一轮的 provider/模型** 启动
         * （`--provider doubulea --model <上游模型名>` + `--no-approve`，见 `spec.ts#piRpcArgv`）。
         * ⚠️ 用的是 `llm.modelName`（**上游**模型名）而不是 `llm.modelId`（`agents.model_id` 的 UUID）：
         * 前者才是 pi 认的那个 id，后者只进标签。
         */
        cmd: piRpcArgv(llm.modelName),
        // 出口①/②（`sandboxEgressEnv`）+ LLM 目标（`sandboxLlmEnv`，含**明文 Key**）
        // + MCP 代理令牌与超时（`sandboxProxyEnv`，含**令牌明文**，P0-3-9b）拼成一份 Env。
        // ⚠️ 后两者只在**这里**被消费，别顺手把它们塞进日志（见各自函数的注释）。
        env: {
          ...sandboxEgressEnv({ proxyUrl: runtime.proxyUrl, backendUrl: runtime.backendUrl }),
          ...llm.env,
          ...sandboxProxyEnv({ token, proxyTimeoutSec: config.sandbox.proxyTimeoutSec }),
          // ★ P1-9 · P3：Code 模式才注入（普通会话一个都不加，扩展默认关闭）
          ...workspaceMediationEnv(codeMode),
          // ★ P1-9 · R11：该用户的 git 凭据 env（HTTPS token 只在 env；SSH 另走 putArchive 落盘）
          ...gitEnv,
        },
      }),
    )
    await docker.startSandboxContainer(containerId)
    /**
     * ★ P1-9 · R11：把 SSH 私钥 / `known_hosts` 解到容器 tmpfs `$HOME/.ssh`（`putArchive`，§7.3）。
     * ⚠️ 只解到 **tmpfs**（`/home/agent`，容器回收即消失），**绝不写 `/work`**（会进 S3 冷备 / 产物）。
     * ⚠️ 失败只 **warn**（不让"凭据没注进去"变成"容器建不出来"）：后端一切正常、只是 agent 的
     *    `git clone` 会退回系统默认身份 —— 这类"能继续干活"的降级不该把整轮派活打死。
     */
    if (gitFiles.length > 0) {
      const archive = buildTar(gitCredentialTarEntries(gitFiles))
      await docker
        .putArchive(containerId, SANDBOX_AGENT_HOME, archive)
        .catch((injectError: unknown) => {
          getLogger().warn(
            { err: injectError, conversationId, fileCount: gitFiles.length },
            'git 凭据注入容器失败（容器仍可用，agent 的 git 将退回系统默认身份）',
          )
        })
    }
    const updated = await prisma.sandbox.updateMany({
      where: { id: row.id, status: 'CREATING' },
      data: { containerId, status: 'RUNNING' },
    })
    if (updated.count === 0) {
      // CAS 失败 = 有人在我创建的同时把这个会话收了（回收器只可能对非活体行动手，所以这是异常）
      throw new Error('容器已启动，但账本行已不是 CREATING（并发回收？）')
    }
    getLogger().info(
      {
        conversationId,
        sandboxId: row.id,
        containerId,
        image,
        slots: `${slots.size}/${slots.limit}`,
        // ★ P1-9 · R11：这一轮容器是在哪套出网策略下起的（`*` = 全放行）—— 排障 git clone 走不通时看它
        egressAllowHosts: config.sandbox.egressAllowHosts,
      },
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
    // ★ P0-3-9b：容器没建成 ⇒ 令牌一起撤掉（否则 Redis 里留着一条"能冒充这个会话去调后端"
    //   的凭据，而它对应的容器从来没存在过）。幂等、失败只 warn：没绑过就是一次空 `del`。
    await revokeSandboxToken(conversationId)
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
  // ★ P1-14 §三 3：**只回收 `instanceId === self` 的行**（宁可报错也不动别人的容器）。
  //   多机下对账/空闲回收都可能扫到"别人的会话"，而本机没有它的容器 ⇒ 误删账本行会把
  //   "B 上还在跑的沙箱"标成 RECYCLED（同 §三 3 的 `container-missing` 错杀）。
  // 本实例从未建过这个会话的容器 ⇒ **整段回收都不做**（连令牌/别名映射也不动 ——
  // 它们可能属于持有该会话的那台实例）。这条比"按行过滤"更靠前，因为下面的
  // `revokeSandboxToken`/`clearSandboxMcpMap`/`clearSandboxOwner` 是**无条件**的。
  const anyOwned = await prisma.sandbox.count({
    where: { conversationId, instanceId: config.sandbox.instanceId },
  })
  if (anyOwned === 0) {
    getLogger().debug({ conversationId, reason }, '该会话在本实例没有沙箱账本 ⇒ 回收不做（P1-14：不跨机清理）')
    return false
  }
  const rows = await prisma.sandbox.findMany({
    where: { conversationId, status: { in: ['CREATING', 'RUNNING'] }, instanceId: config.sandbox.instanceId },
    select: { id: true, containerId: true, status: true },
  })

  let changed = false
  for (const row of rows) {
    if (row.containerId !== null) {
      await docker.removeSandboxContainer(row.containerId)
      changed = true
    }
    // ★ 第二步必须显式删具名卷：`docker rm -v` 删不掉它（P0-3-2 实测，见文件头顺序问题 3）
    // ⚠️ **P1-9 起工作区是宿主 bind mount、不再有具名卷** ⇒ 这一段通常一次都不命中（空集合）；
    //    它对**历史遗留卷**仍然有效。★ Code 模式的关键：**回收容器绝不删工作区目录**（§八：
    //    工作区不再跟容器同生共死），目录的寿命由 workspace reaper 按保留期单独收口。
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

  // ★ P0-3-9b：容器收了 ⇒ 它那只**代理令牌**与**别名映射**必须一起消失。
  //   令牌留着 = 一条"能冒充这个会话去调后端、并用该会话发起者 MCP 凭据"的凭据，
  //   而它对应的容器已经不存在了 —— 这类残留不该靠 TTL 兜底（TTL 有 12 小时）。
  //   ⚠️ **无条件调用**（不看 `changed`）：回收路径本身是幂等的，"没有可回收的对象"
  //   恰恰是"令牌可能悬空"的那种状态（容器被人手工删掉、账本行已被清）。
  //   ⚠️ 两者都幂等、失败只 warn（各自模块内部处理），不会把"回收"变成"抛出"。
  await revokeSandboxToken(conversationId)
  await clearSandboxMcpMap(conversationId)
  // ★ P1-14 §六 4：回收成功后 `DEL sandbox:owner:{id}`（失败留给 TTL）。
  //   清目录后新的一轮 `/chat` 可自由落在任意实例并重新登记 —— 这是"owner 宕机降级"的兑现点。
  await clearSandboxOwner(conversationId)

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
    where: {
      conversationId: { in: [...conversationIds] },
      status: { in: ['CREATING', 'RUNNING'] },
      // ★ P1-14：只收本实例名下的行（跨机清理不存在）
      instanceId: config.sandbox.instanceId,
    },
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
