/**
 * 沙箱的「名字 · 标签 · 创建规格」（P0-3-2）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §四 1（会话即容器 / label 契约）、§四 2（资源与文件系统）、
 *      §九 1（具名卷，`docker rm` 必须带 `-v`）、§二（数值常量总表）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件：**这里全是纯函数**
 * ─────────────────────────────────────────────────────────────────────
 * 本文件**不 import `dockerode`、不 import `config`、不碰 Redis**（只用 `import type` 拿它的类型，
 * 编译后被抹掉）—— 于是"标签怎么拼、容器名怎么算、孤儿怎么判、该给容器哪些环境变量"这些
 * **唯一判据**可以在不连 Docker、不连库的情况下逐条比对（同一手法见 `orchestrator/semaphore.ts`
 * 与 `pipeline/chunk/`）。带副作用的动作（真建容器 / 真删卷 / 解密 Key）在 `docker.ts`、
 * `manager.ts`、`llm.ts`。
 *
 * ⚠️ P0-3-4 起本文件有了**唯一一个值 import**（`@doubulea/shared` 的 `DEFAULT_UPSTREAM_PROTOCOL`，
 * 用于 LLM 协议 → pi api 名的回落）。它仍然是纯函数文件（无 IO、不读配置），但"零 import"
 * 这句话不再逐字成立 —— 记在这里免得下一个人以为这里忽然允许引业务模块了。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ label 是"这东西是不是我们的"的**唯一判据**（`子方案③` §四 1 原文）
 * ─────────────────────────────────────────────────────────────────────
 * `sandboxes` 表**不是**归属判据：后端崩在「容器已建、行还没写」之间时，表里没有它、而 label 在。
 * 于是：
 *   · **label 回答"是不是我们的"** ⇒ 对账器（`reaper.ts`）列容器/卷**只按这组 label 列**；
 *   · **表回答"该不该活着"**（`RUNNING` / 宽限期内的 `CREATING`）⇒ 对账器再拿它做第二问。
 * 两个问题都要问，但**不能互相替代** —— 漏打一个 label 就等于清道夫看不见它（§四 1 原话）。
 */

import { DEFAULT_UPSTREAM_PROTOCOL, type UpstreamProtocol } from '@doubulea/shared'

import type Docker from 'dockerode'

/** 角色标签的键：值恒为 {@link SANDBOX_ROLE}（`doubulea.role=sandbox`） */
export const SANDBOX_LABEL_ROLE = 'doubulea.role'
/** 会话标签的键：值 = `conversations.id`（UUID）。**对账器按它把容器/卷归到会话上** */
export const SANDBOX_LABEL_CONVERSATION = 'doubulea.conversation'
/**
 * 模型标签的键：值 = `agents.model_id`（UUID）。
 *
 * ★ P0-3-4 新增，用途只有一个：**复用容器前判"里面那份 Key/端点还是不是这一轮的"**。
 * 同一会话的多轮消息复用同一个容器（§四 1），而 Agent 的模型**可以被改**
 * （`PATCH /api/agents/:id`）—— 模型一改，容器环境里的 Key、baseUrl、模型名就全是旧的，
 * 而 `sandboxes` 表与 Docker 都不会报任何错（症状：改了模型，下一轮还在用旧的调，账单与
 * 回答都不是你以为的那家）。
 *
 * ⚠️ 与 {@link SANDBOX_LABEL_STARTED_AT} 一样，它**不参与对账判据**（"该不该活着"仍只看
 * {@link keepSandboxObject}）；缺这个标签的容器**不算孤儿**，但要**重建**（见 `manager.ts`）——
 * 判据读不出来时"重建"是唯一安全的选择，与对账器"标签读不出来也删"同一条推理。
 */
export const SANDBOX_LABEL_MODEL = 'doubulea.model'
/**
 * 启动时刻标签的键：值 = ISO 字符串。
 * ⚠️ 它**不是**空闲回收的判据 —— 判据是库里的 `sandboxes.last_active_at`（"最后一次**引擎事件**"，
 * 见 `schema.prisma` 的 Sandbox 注释）。这个标签只用于排障（`docker inspect` 时人眼能看出
 * "这个容器是哪一轮起的"），写在这里是为了避免下一个人误以为它参与判定。
 */
export const SANDBOX_LABEL_STARTED_AT = 'doubulea.startedAt'

/** 角色标签的值 */
export const SANDBOX_ROLE = 'sandbox'

/** 容器内工作目录 = work 卷的挂载点（`子方案③` §四 2：产物唯一落点） */
export const SANDBOX_WORK_DIR = '/work'

/**
 * 非 root 用户的 HOME（镜像里 `useradd --create-home` 建的）。
 *
 * ⚠️ P0-3-3 为什么要给它挂一个 tmpfs：rootfs 只读（`ReadonlyRootfs: true`）⇒ `/home/agent`
 * 变得不可写，而 python / node 工具链都会往 HOME 里写东西（缓存、`~/.config`）。镜像里
 * `--create-home` 的注释早就写明"rootfs 只读时靠 tmpfs，见 P0-3-3"，这里就是那一步。
 * ⚠️ **挂 tmpfs 会盖住镜像目录的属主** ⇒ 必须显式给 `uid`/`gid`，否则新目录是 `root:root`，
 * 以 `agent` 身份跑起来的容器**写自己的 HOME 会 EACCES**（P0-3-3 实测到的第一版形态）。
 */
export const SANDBOX_AGENT_HOME = '/home/agent'

/**
 * 镜像内 `agent` 用户的 uid/gid。
 *
 * ⚠️ 这是**镜像与运行时之间的契约**（不是随手写的 magic number）：`infra/sandbox/base/Dockerfile`
 * 用 `useradd --uid 10001` 把 uid **钉死**，理由见那里的注释（具名卷的属主靠它）。
 * 两处必须一致 —— 改了 Dockerfile 就要改这里，否则上面那条 tmpfs 的属主会指错人。
 */
export const SANDBOX_AGENT_UID = 10001

/** 具名卷名前缀。⚠️ 名字必须**唯一且可推导**（少一次"这卷是谁的"的考古，`子方案③` §九 1） */
export const WORK_VOLUME_PREFIX = 'doubulea-work-'

/** UUID 形态检查（只用来校验 label 里的会话 id 是不是我们写进去的那种；不做 RFC 全量校验） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** 一个沙箱对象（容器或卷）身上那组标签 */
export interface SandboxLabels {
  conversationId: string
  startedAt: string
  /**
   * 这一轮模型（`agents.model_id`）。见 {@link SANDBOX_LABEL_MODEL}。
   * 可选：P0-3-4 之前建的容器与**所有卷**都没有这个标签（卷不带模型语义）。
   */
  modelId?: string
}

/** 拼出容器/卷要打的那组标签（容器与卷**用同一组**：对账器可以拿同一个谓词处理两者） */
export function sandboxLabels(input: { conversationId: string; startedAt: Date; modelId?: string }): Record<string, string> {
  const labels: Record<string, string> = {
    [SANDBOX_LABEL_ROLE]: SANDBOX_ROLE,
    [SANDBOX_LABEL_CONVERSATION]: input.conversationId,
    [SANDBOX_LABEL_STARTED_AT]: input.startedAt.toISOString(),
  }
  // 空串按"没有"处理（`docker` 的标签值可以为空串，但空串读回来在语义上与缺失等价 ⇒
  // 别在标签里制造两种"没有"）
  if (input.modelId !== undefined && input.modelId !== '') labels[SANDBOX_LABEL_MODEL] = input.modelId
  return labels
}

/** work 卷名：`doubulea-work-<conversationId>`（一个会话一个卷名 —— 回收后重建时复用同名卷） */
export function workVolumeName(conversationId: string): string {
  return `${WORK_VOLUME_PREFIX}${conversationId}`
}

/**
 * `listContainers` / `listVolumes` 的过滤条件：**只列我们的**。
 * 一处定义、两处使用（容器与卷），免得"容器按 label 列、卷按名字前缀列"这种两套判据悄悄分叉。
 */
export function sandboxFilter(): { label: string[] } {
  return { label: [`${SANDBOX_LABEL_ROLE}=${SANDBOX_ROLE}`] }
}

/** 加上会话维度（回收某个会话时用它，避免误删同名的别的东西） */
export function sandboxFilterFor(conversationId: string): { label: string[] } {
  return { label: [`${SANDBOX_LABEL_ROLE}=${SANDBOX_ROLE}`, `${SANDBOX_LABEL_CONVERSATION}=${conversationId}`] }
}

/**
 * 从对象的标签里解出"它是谁的"。
 *
 * 返回 `undefined` 的两种情形**必须分开对待**（对账器会按"不认识的也删"处理，理由见那里）：
 *   · 角色标签不对/缺失 ⇒ 这压根不是本轮 label 体系的东西；
 *   · 会话标签缺失或不是 UUID ⇒ 打标签的代码有 bug（或有人手工 `docker run` 打了一半标签）⇒
 *     **它仍然是 `doubulea.role=sandbox`，仍然会占着磁盘与名额** ⇒ 必须能删得掉，
 *     否则就成了"看得见、判不了、删不了"的永久残留。
 */
export function readSandboxLabels(labels: Readonly<Record<string, string>> | undefined): SandboxLabels | undefined {
  if (labels === undefined) return undefined
  if (labels[SANDBOX_LABEL_ROLE] !== SANDBOX_ROLE) return undefined
  const conversationId = labels[SANDBOX_LABEL_CONVERSATION]
  if (conversationId === undefined || !UUID_RE.test(conversationId)) return undefined
  const modelId = labels[SANDBOX_LABEL_MODEL]
  return {
    conversationId,
    startedAt: labels[SANDBOX_LABEL_STARTED_AT] ?? '',
    // 空串归 undefined：**"缺这个标签"与"标签是空串"必须是一种情形**（见 `sandboxLabels`）
    ...(modelId === undefined || modelId === '' ? {} : { modelId }),
  }
}

/**
 * 「这个对象该不该留着」—— 对账器的**唯一判据**，容器与卷共用。
 *
 * @param labels 从对象上读出来的标签（`readSandboxLabels` 的结果）
 * @param liveConversationIds 「本轮活着的会话」集合 = **会话存在且 ACTIVE** ∩
 *        （有 `RUNNING` 行 ∪ 有宽限期内的 `CREATING` 行）。集合怎么算见 `reaper.ts`。
 *
 * 三档结论：
 *   · 标签读不出来 ⇒ **不保留**（见 `readSandboxLabels` 的第二种情形）；
 *   · 标签可读、会话不在活集合里 ⇒ **不保留**（会话被删 / Agent 被软删 / 账本里没有活体行）；
 *   · 在活集合里 ⇒ 保留（空闲的那一批由 `reapIdleSandboxes()` 按 `last_active_at` 另行处理）。
 */
export function keepSandboxObject(labels: SandboxLabels | undefined, liveConversationIds: ReadonlySet<string>): boolean {
  if (labels === undefined) return false
  return liveConversationIds.has(labels.conversationId)
}

/** 造创建参数需要的输入（`config` 由调用方注入，本文件不读配置） */
export interface SandboxContainerSpecInput {
  image: string
  conversationId: string
  volumeName: string
  startedAt: Date
  /**
   * 这一轮模型（`agents.model_id`，P0-3-4）⇒ 写进标签 {@link SANDBOX_LABEL_MODEL}。
   * 可选是为了让纯函数核对与"手工起容器"两种调用都不必构造一个假 UUID。
   */
  modelId?: string
  /** 专用 internal bridge 的**名字**（`sandbox/network.ts` 保证它存在且是我们的） */
  network: string
  /** 资源限额（值来自 `config.sandbox.limits`） */
  limits: { memMb: number; cpu: number; pids: number; tmpfsMb: number }
  /** 容器环境变量（出口①/② 的地址、代理与 **LLM 目标** 都从这里进去，见 `sandboxEgressEnv` / `sandboxLlmEnv`） */
  env: Record<string, string>
}

/**
 * 容器环境变量里的出网配置（**纯函数**，`子方案③` §四 3 的两条出口）。
 *
 * | 键 | 值 | 干什么 |
 * |----|----|--------|
 * | `HTTP_PROXY` / `HTTPS_PROXY` | `SANDBOX_EGRESS_PROXY_URL` | 出口①：容器在**内部网络**上没有公网路由 ⇒ 出公网**只可能**经这个代理 |
 * | `NO_PROXY` | 后端沙箱代理的 `host:port` 与 `hostname` | 出口②：容器 → 后端是**内网**，**绝不能**被塞进代理（否则它要先去公网绕一圈，且代理白名单里也没有它） |
 * | `SANDBOX_BACKEND_URL` | 同上地址 | 桥扩展（P0-3-9b）用它发 `POST /api/sandbox/mcp/call` |
 *
 * ⚠️ **只写大写形态**：pi 侧是 `undici.EnvHttpProxyAgent`，包内文档与实现都只认
 * `HTTP_PROXY` / `HTTPS_PROXY`（`docs/environment-variables.md`），pi 自己的 `httpProxy`
 * 设置项也是 `??=` 到这两个大写键上。同时写一份小写只会造出"两个真相"。
 */
export function sandboxEgressEnv(input: { proxyUrl: string; backendUrl: string }): Record<string, string> {
  const backend = new URL(input.backendUrl)
  return {
    HTTP_PROXY: input.proxyUrl,
    HTTPS_PROXY: input.proxyUrl,
    // 两种写法都给：一个带端口、一个不带（不同实现的匹配粒度不同，且两者都由同一个 URL 派生，不构成"两个真相"）
    NO_PROXY: `${backend.host},${backend.hostname}`,
    SANDBOX_BACKEND_URL: input.backendUrl,
  }
}

// ───────────────────────────── LLM 注入（P0-3-4）─────────────────────────────

/**
 * 注入给容器的 LLM 目标（**容器内 `gen-models.mjs` 读的就是这几个名字**，是一份跨边界契约）。
 *
 * | 变量 | 谁用 | 说明 |
 * |------|------|------|
 * | `DOUBULEA_LLM_API_KEY` | 只被 `models.json` 以 `${...}` **引用** | ★ 明文只在容器环境里，**绝不落盘**（见下） |
 * | `DOUBULEA_LLM_BASE_URL` | `models.json` 的 `baseUrl` | 已按 pi 的语义归一（见 {@link piBaseUrlFor}） |
 * | `DOUBULEA_LLM_API` | `models.json` 的 `api` | pi 的 api 名（见 {@link piApiForProtocol}） |
 * | `DOUBULEA_LLM_MODEL` | `models.json` 的 `models[].id` | 上游 model id |
 * | `DOUBULEA_LLM_PROVIDER` | `models.json` 的 provider 键 | P0-3-5 用它拼 `--model <provider>/<model>` |
 * | `DOUBULEA_LLM_LABEL` | `models.json` 的 `models[].name` | 显示名（可选） |
 *
 * ⚠️ 名字统一加 `DOUBULEA_` 前缀是刻意的：pi 自己有一套 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
 * 之类的**按 provider 名**取的变量，用了那些名字就等于把"我们注入的 Key"悄悄变成了
 * "pi 认为它是 OpenAI 官方凭据" —— 而我们的 baseUrl 明明是自定义模型池
 * （多一个来源就多一条"到底哪份 Key 生效"的歧义）。
 */
export const SANDBOX_LLM_ENV = {
  apiKey: 'DOUBULEA_LLM_API_KEY',
  baseUrl: 'DOUBULEA_LLM_BASE_URL',
  api: 'DOUBULEA_LLM_API',
  model: 'DOUBULEA_LLM_MODEL',
  provider: 'DOUBULEA_LLM_PROVIDER',
  label: 'DOUBULEA_LLM_LABEL',
} as const

/**
 * `models.json` 里的 provider 键（固定值，不随会话变）。
 *
 * 它同时是 **P0-3-5 拼 `--model` 时的那一半**：`--model doubulea/<上游模型名>`。
 * 固定一个而不是"每个 Provider 一个"：一个会话只有一个模型（`conversations.agent_id` →
 * `agents.model_id`），多注册几个 provider 只会让"这一轮到底用哪个"变成一个要读配置才知道的问题。
 */
export const SANDBOX_PI_PROVIDER_ID = 'doubulea'

/**
 * 我方协议枚举 → **pi 的 api 名**（`models.json` 的 `api` 字段）。
 *
 * ⚠️ 这是这张映射表的**唯一落点**：容器里那个生成器（`infra/sandbox/base/gen-models.mjs`）
 * **刻意不认识我方协议枚举** —— 后端把翻译做完再传进去，于是"协议"这件事只在一处有真相，
 * 容器侧只是拼串。加第四个协议时改这里 + pi 的 api 名（若它有）。
 *
 * 三个值的依据是 pi 的 `@earendil-works/pi-ai` 包内实现
 * （`dist/api/{openai-completions,openai-responses,anthropic-messages}.js`）——
 * **三协议都支持** ⇒ `子方案③` §十三 待决 1（"Pi 对 `OPENAI_RESPONSES` 的支持面"）就此关闭，
 * 不需要加任何"该协议不支持任务型 Agent"的收窄判定。
 */
const PI_API_BY_PROTOCOL: Readonly<Record<UpstreamProtocol, string>> = {
  OPENAI_COMPAT: 'openai-completions',
  OPENAI_RESPONSES: 'openai-responses',
  ANTHROPIC_MESSAGES: 'anthropic-messages',
}

/** 协议 → pi 的 api 名。未知/缺省回落到默认协议（与 `llm/protocol.ts#protocolOf` 同一口径） */
export function piApiForProtocol(protocol: UpstreamProtocol | null | undefined): string {
  return PI_API_BY_PROTOCOL[protocol ?? DEFAULT_UPSTREAM_PROTOCOL]
}

/**
 * 把**我方的 baseUrl** 换成**pi 能用的 baseUrl**（纯函数）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 两个客户端对 baseUrl 的约定**差一个 `/v1`** —— 这是本批最容易静默出错的地方
 * ─────────────────────────────────────────────────────────────────────
 * 我方是**字符串拼接**（`llm/client.ts`：`${baseUrl}${protocol.chatPath}`），而三协议各自的
 * `chatPath` 是 `/chat/completions` / `/responses` / `/messages` ⇒ **我方契约要求 baseUrl
 * 自带 `/v1`**（`https://api.openai.com/v1`）。
 *
 * pi 走的是**官方 SDK**（源码级确认：`dist/api/*.js` 里是 `new OpenAI({ baseURL })` /
 * `new Anthropic({ baseURL })`）：
 *   · OpenAI SDK：`{baseURL}/chat/completions` ⇒ 与**我方一致**（同样要带 `/v1`）；
 *   · Anthropic SDK：`{baseURL}/v1/messages` ⇒ **SDK 自己加 `/v1`**！
 *     ⇒ 把我方那份 `https://api.anthropic.com/v1` 直接递过去会变成
 *     `https://api.anthropic.com/v1/v1/messages`（一个 404，且报错只会说"端点不存在"）。
 *
 * 所以这里对 `ANTHROPIC_MESSAGES` **去掉尾部的 `/v1`**（只去这一层；`/anthropic/v1` 这种
 * 带前缀的网关地址照样成立）。`LlmTarget.baseUrl` 已经是"去尾斜杠"的形态（见其定义），
 * 这里仍再判一次 `/v1` 是为了让本函数**单独可读**（不看上游也说得清）。
 *
 * ⚠️ 这条差异**已实测**（`06` §五 P0-3-4 的实测记录）：假上游分别收到
 * `POST /v1/chat/completions` 与 `POST /v1/messages` ⇒ 两个 SDK 的拼接口径与上面一致。
 */
export function piBaseUrlFor(protocol: UpstreamProtocol | null | undefined, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/u, '')
  if ((protocol ?? DEFAULT_UPSTREAM_PROTOCOL) !== 'ANTHROPIC_MESSAGES') return trimmed
  return trimmed.replace(/\/v1$/u, '')
}

/** {@link sandboxLlmEnv} 的输入（结构化的最小集：刻意不收 `LlmTarget`，免得纯函数文件依赖上层类型） */
export interface SandboxLlmInput {
  /** 上游 model id（进 `models[].id`） */
  modelName: string
  /** 显示名（进 `models[].name`，可选） */
  label?: string
  /** 上游协议（决定 `api` 与 baseUrl 的归一，见 {@link piBaseUrlFor}） */
  protocol?: UpstreamProtocol
  baseUrl: string
  /** 明文 Key —— ⚠️ 调用方**不得**把它写进任何日志（见文件尾那段） */
  apiKey: string
}

/**
 * LLM 目标的容器环境变量（**纯函数**，`子方案③` §五 3）。
 *
 * ★ 这一组 env 与 {@link sandboxEgressEnv} 合起来就是"容器凭什么能调模型"的全部答案：
 * 出口① 让它到得了模型池（`HTTP(S)_PROXY`），这组告诉它**调谁、用哪个模型、拿什么凭据**。
 *
 * ⚠️ **返回值里含明文 Key** ⇒ 调用方（`manager.ts`）只许把它交给 `buildSandboxContainerSpec`，
 * **不许打日志、不许落库、不许拼进错误消息**。这条不是洁癖：Key 一旦进日志，
 * 就与 `02` §九 的"密钥零下发"不变式冲突，而日志的保留期通常比会话长得多。
 */
export function sandboxLlmEnv(input: SandboxLlmInput): Record<string, string> {
  const env: Record<string, string> = {
    [SANDBOX_LLM_ENV.apiKey]: input.apiKey,
    [SANDBOX_LLM_ENV.baseUrl]: piBaseUrlFor(input.protocol, input.baseUrl),
    [SANDBOX_LLM_ENV.api]: piApiForProtocol(input.protocol),
    [SANDBOX_LLM_ENV.model]: input.modelName,
    [SANDBOX_LLM_ENV.provider]: SANDBOX_PI_PROVIDER_ID,
  }
  if (input.label !== undefined && input.label !== '') env[SANDBOX_LLM_ENV.label] = input.label
  return env
}

/**
 * 镜像跑的是不是**非 root 用户**（"非 root"是**镜像**属性，不在 `docker create` 的参数里）。
 *
 * ⚠️ 为什么要在建容器前看一眼：`--cap-drop ALL` 对 root 进程的意义要小得多，而"镜像被换成
 * 一个以 root 跑的镜像"这件事**不会报任何错** —— 容器照样起来、照样能干活，只有
 * `docker inspect` 里的 `Config.User` 变了。这正是本仓最怕的那类"看起来配了、其实没配"。
 * 认 `agent` 这类用户名与 `10001` 这类数字 uid 两种写法（Dockerfile 用的是后者）。
 */
export function isNonRootImageUser(user: string | undefined): boolean {
  // ⚠️ 只看 `user[:group]` 的**前半段**：`root:root` / `0:0` 都是 root，
  //    而"只判整串等不等于 root"会让 `root:root` 判成非 root（写这条时实际踩到过）。
  const name = (user ?? '').split(':')[0]?.trim() ?? ''
  if (name === '') return false
  return name !== 'root' && !/^0+$/u.test(name)
}

/**
 * 容器的创建参数（`docker create` 的等价物）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * P0-3-3：本函数就是**安全加固的唯一落点**（`子方案③` §四 2 / §四 3）
 * ─────────────────────────────────────────────────────────────────────
 * 每一项都在下面点名，且**都经过本机实测**（真 Docker 29.4.0 / OrbStack）：
 *
 * | 项 | 实测结论 |
 * |----|----------|
 * | `ReadonlyRootfs` | 容器内写 `/` 与 `/usr` 都是 `EROFS`；写 `/tmp`、`/work`、`$HOME` 正常 |
 * | `/tmp` tmpfs | `/proc/mounts` 里是 `tmpfs rw,nosuid,nodev,noexec,size=<n>k` |
 * | `$HOME` tmpfs | ⚠️ **必须带 `uid`/`gid`**：不带时新目录属 `root:root`，以 agent 跑起来的容器写自己 HOME 会 `EACCES` |
 * | `CapDrop: ['ALL']` | `/proc/self/status` 的 `CapEff` = `0000000000000000` |
 * | `SecurityOpt` | `no-new-privileges`（配合 cap-drop，setuid 类提权一并封掉） |
 * | `Memory` + `MemorySwap` | `cgroup memory.max` = 限额；**`MemorySwap` 必须等于 `Memory`**，否则 swap 让限额形同虚设 |
 * | `NanoCpus` | `--cpus` 的 API 形态（1.5 核 ⇒ 1_500_000_000） |
 * | `PidsLimit` | `cgroup pids.max` = 限额 |
 * | `NetworkMode` = 专用 internal bridge | 公网 `EAI_AGAIN`（不可达）；**到 Docker 宿主的网关地址可达**（200）⇒ 出口② 成立 |
 * | 非 root | `getuid() = 10001`（来自镜像 `USER agent`，建容器前由 `isNonRootImageUser` 再守一道） |
 *
 * ⚠️⚠️ **`StorageOpt`（`size=`）刻意不在这里** —— 三条实测理由，缺一条都不足以否掉它：
 *   ① 本机（OrbStack / APFS）守护进程**直接拒绝**：`--storage-opt is supported only for overlay
 *      over xfs with 'pquota' mount option` ⇒ 一旦写进 `HostConfig`，**建容器这一步就失败**；
 *   ② 即使换成 xfs + pquota，`size=` 管的是**容器的可写层**（overlay2 upperdir），
 *      而 `/work` 是**具名卷**（`/var/lib/docker/volumes/<name>/_data`），**不在它的管辖范围**；
 *   ③ 我们同时开着只读 rootfs ⇒ 可写层本来就不用。
 *   ⇒ `SANDBOX_WORK_VOLUME_MB` **不是硬配额、而是告警阈值**，由 `reaper.ts#auditWorkVolumes`
 *   周期性巡检并告警（`子方案③` §九 1 认可的降级方案："定期 du 巡检 + 超限告警 + 人工介入"）。
 */
export function buildSandboxContainerSpec(input: SandboxContainerSpecInput): Docker.ContainerCreateOptions {
  const memBytes = input.limits.memMb * 1024 * 1024
  // `noexec` 只加在 /tmp 上：那条是设计（引擎与三方库的临时文件不该可执行）。
  // HOME 只要求"可写"，不加 noexec —— python 有些包会把 helper 脚本写进 HOME 再执行。
  const tmpfsOpts = `rw,nosuid,nodev,size=${input.limits.tmpfsMb}m`
  return {
    Image: input.image,
    Labels: sandboxLabels({ conversationId: input.conversationId, startedAt: input.startedAt, modelId: input.modelId }),
    WorkingDir: SANDBOX_WORK_DIR,
    // 出口①/② 的地址与代理（见 `sandboxEgressEnv`）+ LLM 目标（`sandboxLlmEnv`，P0-3-4，含明文 Key）
    Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
    // 引擎桥（P0-3-5）要往 stdin 写 JSONL；保持打开（见下方注释）
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: false,
    Tty: false,
    // ⚠️ Cmd 刻意不设：镜像里 `CMD ["--mode","rpc"]` 就是默认值（P0-3-1 把参数留在 CMD 正是为此）
    HostConfig: {
      AutoRemove: false,
      /**
       * ★ 本批从 `'none'` 换成**专用 internal bridge**（P0-3-2 的 `NetworkMode: 'none'` 是临时取值）。
       *
       * 为什么不是默认 `bridge`：默认 bridge 上容器能摸到宿主所有监听端口（13000 公网口、PG、
       * Redis、MinIO），那是比"能出公网"更严重的暴露面（§四 3）。
       * 为什么是 `internal`：`internal` 网络**没有到公网的路由** ⇒ "两条白名单出口"才是真的
       * （公网只有经代理那一条）。⚠️ 代价写在 `network.ts` 的注释里：容器也**到不了宿主以外的
       * 任何东西**，所以出口② 的地址必须是 Docker 宿主上的监听（实测成立）。
       */
      NetworkMode: input.network,
      /** 只读 rootfs：容器**不该能改自己**（§四 2）。写 `/` 实测 `EROFS` */
      ReadonlyRootfs: true,
      /** 沙箱内没有任何需要特权的能力（实测 `CapEff` = 0） */
      CapDrop: ['ALL'],
      /** 与 cap-drop 配套：堵掉 setuid/setgid 类提权（缺了它 cap-drop 的意义减半，§四 2） */
      SecurityOpt: ['no-new-privileges'],
      /** 内存为主限额（10 并发的真实瓶颈是内存，§二） */
      Memory: memBytes,
      /** ⚠️ 必须与 `Memory` 相等：不等时容器可以用 swap 越过内存上限，限额形同虚设 */
      MemorySwap: memBytes,
      /** `--cpus` 的 API 形态（10^9 分之一核）；CPU 为辅：只防单容器跑飞拖垮宿主 */
      NanoCpus: Math.round(input.limits.cpu * 1e9),
      /** 防 fork 炸弹；pandas / node 都要开子进程 ⇒ 别给小（§二） */
      PidsLimit: input.limits.pids,
      /**
       * 两个 tmpfs：`/tmp`（引擎的临时文件与 session 文件）与 `$HOME`（工具链的缓存）。
       * ⚠️ `/tmp` 的 `noexec` 是设计（§四 2）；`$HOME` 不带 `noexec`（python 会在那里写 helper 脚本再执行）。
       * ⚠️ `$HOME` 那条**必须给 uid/gid**：tmpfs 会盖住镜像目录的属主，不给就是 root:root
       * ⇒ agent 写不动自己的 HOME（P0-3-3 实测到的第一版形态）。
       */
      Tmpfs: {
        '/tmp': `rw,nosuid,nodev,noexec,size=${input.limits.tmpfsMb}m`,
        [SANDBOX_AGENT_HOME]: `${tmpfsOpts},uid=${SANDBOX_AGENT_UID},gid=${SANDBOX_AGENT_UID},mode=0755`,
      },
      // 具名卷 → `/work`。⚠️ 写在 `HostConfig.Mounts` 而不是 `Config.Binds`：
      // `--mount` 的语义更明确（不会像 `-v` 那样在宿主上"顺手"建出不存在的目录、
      // 也不会把名字里带 `/` 的东西解释成路径），且类型上就是它的家
      // （Docker inspect 里它也确实落在 `HostConfig.Mounts`）。
      Mounts: [
        {
          Type: 'volume',
          Source: input.volumeName,
          Target: SANDBOX_WORK_DIR,
          ReadOnly: false,
        },
      ],
      // ⚠️ P0-3-3 刻意**没有** StorageOpt：理由见函数头上方那段（实测三条）。work 卷的体量
      //    改由「周期巡检 + 超限告警」看着，不假装有硬配额。
    },
  }
}

// ───────────────────────────── work 卷的体量巡检 ─────────────────────────────

/** 一个卷的用量读数（`GET /system/df` 给的那几个字段里的三个） */
export interface VolumeUsage {
  name: string
  sizeBytes: number
  labels?: Readonly<Record<string, string>>
}

/**
 * 从 `GET /system/df` 的结果里挑出**超阈值**的沙箱工作卷。
 *
 * 为什么是"读数 + 纯函数"而不是直接写进 `reaper.ts`：这条判据（**标签是不是我们的** ∩
 * **体量是否越线**）要能在不连 Docker 的情况下逐条比对 —— 同一手法见本文件的标签族函数。
 *
 * ⚠️ 用**标签**判归属（`readSandboxLabels`），不用卷名前缀：与容器/卷的其余判据同一处
 * （"哪些是我们的"只能有一个答案）。名字前缀只是名字的构造约定。
 *
 * @param limitMb 告警阈值（= `SANDBOX_WORK_VOLUME_MB`，见 `buildSandboxContainerSpec` 上方那段：
 *        它**不是**硬配额，只是越线要出告警的那条线）
 */
export function findOversizedWorkVolumes(volumes: readonly VolumeUsage[], limitMb: number): VolumeUsage[] {
  const limitBytes = limitMb * 1024 * 1024
  return volumes.filter((volume) => readSandboxLabels(volume.labels) !== undefined && volume.sizeBytes > limitBytes)
}
