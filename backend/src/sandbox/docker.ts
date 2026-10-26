/**
 * Docker 客户端（dockerode）—— 沙箱的**唯一**出口（P0-3-2）
 *
 * 依据：`docs/02-后端设计.md` §一（"容器调度：dockerode（Docker SDK）"）、§七（TaskAgent 编排）、
 *      `docs/子方案/沙箱与引擎集成.md` §四（容器与网络）、§九（生命周期与自愈）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件只做"跟 Docker 说话"，不做任何策略
 * ─────────────────────────────────────────────────────────────────────
 * 谁该活、什么时候回收、排队位次怎么算 —— 全在 `manager.ts` / `reaper.ts` / `queue.ts`。
 * 这里只有薄薄一层：连上守护进程、列对象、建对象、删对象、在容器里执行一条命令
 * （P0-3-7 的 `execInSandbox`），以及**把 Docker 的报错翻译成人话**。
 * 这样做的收益很实际：上面那些策略模块因此可以只依赖"接口形状"，不必知道 dockerode 的类型。
 *
 * ⚠️ 两处刻意的取舍：
 *   · **连接目标不引入新环境变量**：dockerode/docker-modem 自己认 `DOCKER_HOST`，默认
 *     `unix:///var/run/docker.sock`（本机是 OrbStack 的符号链接）。本机 `docker` CLI 不在
 *     非交互 shell 的 PATH 里（要补 `~/.orbstack/bin`），而我们**不 shell out**、只走 socket
 *     ⇒ 那个 PATH 问题与本模块无关。
 *   · **`describeDockerFailure()` 会点破"八成是 Docker 没起"**：本机沙箱化的 shell 里
 *     `docker` 命令找不到，人第一反应是"没装"，真因多半是守护进程没跑（OrbStack 图标是灰的）。
 *     报错文案直接说这一句，比 `connect ENOENT` 省一轮排查。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import Docker from 'dockerode'

import { getLogger } from '../infra/logger.js'
import { config } from '../config.js'
import { SANDBOX_LLM_ENV, sandboxFilter, sandboxFilterFor } from './spec.js'

let client: Docker | undefined

/** Docker 的 404（"没有这个东西"）错误码 —— 与"连不上守护进程"必须分开处理 */
const DOCKER_NOT_FOUND = 404

/**
 * 取（必要时创建）客户端单例。
 *
 * ⚠️ `new Docker()` **不会**立刻拨号（它是懒的，第一次调用才发请求）⇒ import 本模块零副作用，
 * 与 `infra/redis.ts` 的 `lazyConnect` 同款纪律：配置校验失败 / `--check-config` 这类路径
 * 不该因为"顺手 import 了沙箱模块"就去连 Docker。
 */
export function getDocker(): Docker {
  client ??= new Docker({ timeout: 10_000 })
  return client
}

/** 关掉客户端（**只在测试里需要**：dockerode 没有连接池，正常退出什么都不用做） */
export function resetDocker(): void {
  client = undefined
}

/** 判断一个错误是不是 Docker 的"对象不存在"（404） */
export function isDockerNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    (error as { statusCode?: unknown }).statusCode === DOCKER_NOT_FOUND
  )
}

/**
 * 把 Docker 的报错翻译成"能照着做点什么"的一句话。
 *
 * 三类分开（同一手法见 `infra/redis.ts#describeRedisFailure`：**根因常常不在错误消息上**）：
 *   · 404 —— 对象不在了（容器被手工删、卷被 prune 掉）：正常业务情形，调用方按"不存在"处理；
 *   · `ENOENT` / `ECONNREFUSED` / `EACCES` on socket —— **守护进程没起或 socket 不可读**，
 *     这是本机最常见的一种，文案要点破"先看 OrbStack/Docker Desktop 起没起"；
 *   · 其余（镜像不存在、参数被拒…）—— 原样带上，Docker 的 message 通常已经足够具体。
 */
export function describeDockerFailure(error: unknown): string {
  if (isDockerNotFound(error)) return '对象不存在（404）'
  const raw = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES' || /connect ENOENT/u.test(raw)) {
    return (
      `连不上 Docker 守护进程（${raw}）：先确认 OrbStack / Docker Desktop 正在运行，` +
      '以及当前用户能读写 /var/run/docker.sock'
    )
  }
  return raw
}

/** 探活：返回守护进程版本号。抛出的错误已过 {@link describeDockerFailure} */
export async function pingDocker(): Promise<string> {
  try {
    const info = await getDocker().version()
    return info.Version
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/**
 * docker **可执行文件**路径（shell out 时用；`getDocker()` 那条 dockerode 通道不受它影响）。
 *
 * 判据：配置值（`SANDBOX_DOCKER_BIN`，默认裸名 `docker`）> 宿主上几个常见绝对路径。
 *
 * 为什么需要：容器里 `SANDBOX_DOCKER_BIN` 指向命名卷里的二进制（绝对路径，必然可执行）；
 * 而宿主 dev（`pnpm dev`）下后端的进程 PATH 里**没有** `/usr/local/bin`（OrbStack / Docker
 * Desktop 的 CLI 装在那里）⇒ `execFile('docker', …)` / `spawn('docker', …)` 会以 `ENOENT`
 * 失败，症状是"镜像明明在、却说找不到 docker"。`infra/scripts/sandbox-build.mjs` 早有同款
 * 回落，这里对齐同一口径，并让自举与按需构建共用一处（免得两边各写一遍、改一处漏一处）。
 */
const DOCKER_BIN_CANDIDATES = [
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  path.join(homedir(), '.orbstack/bin/docker'),
  '/Applications/OrbStack.app/Contents/MacOS/xbin/docker',
]

let resolvedDockerBin: string | undefined

export function resolveDockerBin(): string {
  if (resolvedDockerBin !== undefined) return resolvedDockerBin
  const configured = config.sandbox.dockerBin
  // 绝对路径（容器里的卷内二进制）直接采用；否则当名字看，先在常见位置找一遍，找不到才交回 PATH
  resolvedDockerBin = configured.includes('/')
    ? configured
    : (DOCKER_BIN_CANDIDATES.find((candidate) => existsSync(candidate)) ?? configured)
  return resolvedDockerBin
}

/**
 * 给要 shell out docker 的子进程准备环境：把 docker 所在目录补进 `PATH`，并把绝对路径回填到
 * `DOCKER_BIN` / `SANDBOX_DOCKER_BIN`（两个运维脚本与 `sandbox-build.mjs` 都认这两个变量）。
 *
 * ⚠️ 只在解析出**绝对路径**时才回填：裸名进 `SANDBOX_DOCKER_BIN` 会被脚本的 `[ -x … ]` 判假，
 *    而 `dirname('docker')` 是 `.` —— 塞进 `PATH` 等于把当前目录当可执行目录，是安全问题。
 */
export function withDockerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bin = resolveDockerBin()
  if (!bin.includes('/')) return base
  const dir = path.dirname(bin)
  const entries = (base.PATH ?? '').split(':')
  return {
    ...base,
    DOCKER_BIN: bin,
    SANDBOX_DOCKER_BIN: bin,
    PATH: entries.includes(dir) ? (base.PATH ?? '') : `${dir}:${base.PATH ?? ''}`,
  }
}

/**
 * 列出**我们的**容器（含已停止的 —— `all: true`）。
 * ⚠️ `all: true` 不能省：对账器要清理的对象里就包括"起了然后自己退出了"的容器
 * （退出原因通常只是引擎没活干而 stdin EOF），漏掉它们就等于漏掉最主要的垃圾。
 */
export async function listSandboxContainers(): Promise<Docker.ContainerInfo[]> {
  try {
    return await getDocker().listContainers({ all: true, filters: sandboxFilter() })
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/** 列出**我们的**卷（`/work` 卷）。⚠️ 只列带 role 标签的 —— 归属判据与容器同一处 */
export async function listSandboxVolumes(): Promise<Docker.VolumeInspectInfo[]> {
  try {
    const result = await getDocker().listVolumes({ filters: sandboxFilter() })
    return result.Volumes ?? []
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/** 某个会话名下的卷（回收单个会话时用；一次调用就够，不必拉全量再过滤） */
export async function listVolumesOf(conversationId: string): Promise<Docker.VolumeInspectInfo[]> {
  try {
    const result = await getDocker().listVolumes({ filters: sandboxFilterFor(conversationId) })
    return result.Volumes ?? []
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/**
 * 确认镜像存在。
 *
 * 为什么要单独一步：`createContainer` 在镜像缺失时报的是
 * `No such image: doubulea/sandbox-toolkit:1`，而**同一句话**也出现在"tag 打错了"之外的好几种情形里；
 * 提前 inspect 一次能把文案换成"先跑 `pnpm sandbox:build`"。P0-3-1 的 README 就是这么教用户的。
 */
export async function ensureImage(image: string): Promise<void> {
  try {
    await getDocker().getImage(image).inspect()
  } catch (error) {
    if (isDockerNotFound(error)) {
      throw new Error(
        `沙箱镜像不存在：${image}。先构建：pnpm sandbox:build（本机内网需换源，见 README「构建沙箱镜像」）`,
        { cause: error },
      )
    }
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/**
 * 列出某个**仓库**下的镜像 ref（`repo:tag`）—— 用于探测"本机有哪些沙箱运行时"（P1-17a）。
 *
 * 口径：拉全量镜像再**在 JS 里按前缀过滤**（不依赖 Docker `reference` 过滤器的通配语义）。
 * 运行时 id / 层版本的解析在 `runtimeImages.ts`（纯函数），这里只管"把 ref 拿出来"。
 */
export async function listRuntimeImages(repo: string): Promise<string[]> {
  try {
    const images = await getDocker().listImages({})
    const prefix = `${repo}:`
    const refs: string[] = []
    for (const image of images) {
      for (const tag of image.RepoTags ?? []) if (tag.startsWith(prefix)) refs.push(tag)
    }
    return refs
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/**
 * 本机全部镜像的 `repo:tag`（P1-21 的"回退镜像存在性"判据用）。
 *
 * 与 {@link listRuntimeImages} 的差别只有"不按仓库前缀过滤"；`dangling`（`<none>:<none>` 之类）直接跳过。
 * ⚠️ Docker 不可达时**抛**（与 `listRuntimeImages` 同一口径，由调用方决定降级）。
 */
export async function listLocalImageRefs(): Promise<string[]> {
  try {
    const images = await getDocker().listImages({})
    const refs: string[] = []
    for (const image of images) {
      for (const tag of image.RepoTags ?? []) if (tag !== '<none>:<none>') refs.push(tag)
    }
    return refs
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/** 建具名卷（带 label —— 对账器靠它找回这个卷，见 `spec.ts` 文件头） */
export async function createSandboxVolume(input: {
  name: string
  labels: Record<string, string>
}): Promise<void> {
  try {
    // ⚠️ **故意不吞 409**："名字已存在"在正常路径上不该发生（一个会话同时只有一个容器），
    //    真发生了说明有并发创建 —— 那是必须暴露的问题，不是可以静默复用的情形。
    await getDocker().createVolume({ Name: input.name, Labels: input.labels })
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/** 建容器（不启动）。返回容器 id */
export async function createSandboxContainer(options: Docker.ContainerCreateOptions): Promise<string> {
  try {
    const container = await getDocker().createContainer(options)
    return container.id
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/** 启动容器（`create` 与 `start` 两步是 Docker API 的形状，不能合并） */
export async function startSandboxContainer(containerId: string): Promise<void> {
  try {
    await getDocker().getContainer(containerId).start()
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/** 复用判定要的容器状态（一次 `inspect` 拿全；`missing` = 404，是**业务答案**不是异常） */
export type SandboxContainerState = 'running' | 'stopped' | 'missing'

/**
 * 一个容器此刻的状态（P0-3-8：复用判定的唯一依据）。
 *
 * ★ 为什么"存在"不够、必须看**在不在跑**（本批收紧的原因）：pi 是容器主进程
 *   （镜像 `ENTRYPOINT` 是 `tini -- entrypoint.sh`、末尾 `exec pi`）⇒ **引擎退出 = 容器退出**，
 *   而 Docker 的 `inspect` 对"退出了的容器"**照样成功返回** ⇒ 只判"存在"会把一具尸体当成
 *   可复用的沙箱：`attach` 对已停止的容器必然失败 ⇒ 用户每重发一次就再吃一次
 *   `UPSTREAM_ERROR`，与错误文案里那句"系统会自行重建沙箱"自相矛盾（尸体不清，
 *   重建永远不会发生）。"停了 = 尸体 = 回收重建"也是 `子方案③` §九 4 的落法：
 *   档位 2（会话级续跑，`docker start` 复活引擎）**刻意不做**，这里不 `start` 就是它的执行点。
 *
 * 与 {@link inspectSandboxContainerLabels} 的分工：这个回答"它还顶不顶得住复用"
 * （`stopped` / `missing` 都是**业务答案**），那个回答"它身上写着什么"。
 */
export async function inspectSandboxContainerState(containerId: string): Promise<SandboxContainerState> {
  let info: Docker.ContainerInspectInfo
  try {
    info = await getDocker().getContainer(containerId).inspect()
  } catch (error) {
    if (isDockerNotFound(error)) return 'missing'
    throw new Error(describeDockerFailure(error), { cause: error })
  }
  return info.State?.Running === true ? 'running' : 'stopped'
}

/**
 * 读一个容器的**标签**（P0-3-4 新增：复用前比对"里面那套 LLM 目标还是不是这一轮的"）。
 *
 * 三种"没有标签"的路都归成 `undefined`：容器不存在（404）、`Config.Labels` 缺失、空对象。
 * **刻意不做区分**：调用方（`manager.ts` 的复用判定）对这三种的处理完全一样 —— 都当
 * "读不出模型 ⇒ 不一致 ⇒ 回收重建"，而"重建"在三种情形下都是安全动作。
 * 与 `inspectSandboxContainerState` 的分工：那个回答"它还顶不顶得住复用"
 * （`stopped` / `missing` 都是**业务答案**），这个回答"它身上写着什么"。
 */
export async function inspectSandboxContainerLabels(
  containerId: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    const info = await getDocker().getContainer(containerId).inspect()
    const labels = info.Config?.Labels
    if (labels === undefined || labels === null) return undefined
    return Object.keys(labels).length > 0 ? labels : undefined
  } catch (error) {
    if (isDockerNotFound(error)) return undefined
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/**
 * 读容器**注入进去的 LLM Key**（P0-3-5）。
 *
 * ⚠️ **唯一用途 = 脱敏**：引擎的 stderr 会进后端日志（`子方案③` §六 3："引擎 stderr 不进 SSE，
 * 进后端日志（脱敏）"），而上游 401 的响应体常把 `Authorization` 回显出来 —— 不抹掉就等于
 * 借日志把 Key 漏出去（与 `llm/upstream.ts#redactSecret` 是同一个教训）。
 *
 * 三条刻意的收窄，别照着放宽：
 *   ① **只读这一个键**（不是整个 `Config.Env`）：返回一个"装着所有环境变量"的对象，
 *      下一个人迟早会把它整个打进日志；
 *   ② 名字里带 `LlmApiKey`，让调用点一眼看出"手里这个字符串是凭据"；
 *   ③ 读不出来（404 / 没注入）返回 `undefined` 而**不抛** —— 脱敏是收尾路径上的尽力而为，
 *      不该因为"读不到 Key"把一次正常的关闭变成异常（同 `inspectSandboxContainerLabels`）。
 */
export async function readSandboxLlmApiKey(containerId: string): Promise<string | undefined> {
  try {
    const info = await getDocker().getContainer(containerId).inspect()
    const env = info.Config?.Env
    if (env === undefined || env === null) return undefined
    const prefix = `${SANDBOX_LLM_ENV.apiKey}=`
    const value = env.find((entry) => entry.startsWith(prefix))?.slice(prefix.length)
    return value !== undefined && value !== '' ? value : undefined
  } catch (error) {
    if (isDockerNotFound(error)) return undefined
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/**
 * 接上**容器主进程的 stdio**（P0-3-5）—— 引擎桥的底座。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么是 `attach` 而不是 `exec`（这一条决定了桥的整个形状）
 * ─────────────────────────────────────────────────────────────────────
 * 镜像的 `ENTRYPOINT` 是 `tini -- entrypoint.sh`，而脚本最后 `exec pi "$@"` ⇒ **pi 就是容器主进程**
 * （`infra/sandbox/base/Dockerfile` 的收尾注释："真正的引擎桥属 P0-3-5，那时由
 * `backend/src/sandbox` 覆盖 Cmd 传参"）。容器创建时给的 `OpenStdin: true` / `StdinOnce: false`
 * 就是为这条连接留的。
 *
 * 若改用 `exec` 再起一个 `pi --mode rpc`，容器里就会有**两个**引擎：主进程那个白等着
 * （而它才是"容器活着的理由"），我们连的那个死了容器还活着 —— 生命周期与 `子方案③` §四 1
 * "会话即容器"直接矛盾。`attach` 让"容器活着"与"引擎可对话"变成同一件事。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 两处必须做对，否则症状都指不到这里
 * ─────────────────────────────────────────────────────────────────────
 * ① **`hijack: true`**：走 Docker 的 `Connection: Upgrade`，拿回一条**裸 socket**（可读可写）。
 *    不带它拿到的是被包了一层的响应流，往上写命令不一定到得了容器 stdin。
 * ② **必须 `demuxStream`**：本仓容器的 `Tty` 是 **false**（P0-3-2 实测"不设 Tty 才起得来"），
 *    这种情况下 Docker 的 stdio 是 **8 字节头（流号 + 大端长度）+ 载荷** 的多路复用格式。
 *    不解复用直接读，JSONL 解析器收到的是带二进制头的乱码 —— 症状是"每条记录都解析失败"，
 *    而报错现场离真因（少了 demux）隔着两层。
 *
 * ⚠️ `detach()` **只拆我们的连接，不碰容器**：`StdinOnce: false` ⇒ 断开后容器 stdin 不关，
 * pi 原地等着下一次 attach（这正是"复用容器"能成立的前提）。要结束引擎请走
 * `manager.ts#recycleSandbox`（那才是"杀"）。
 */
/**
 * `attach()` 在 `hijack: true` 下实到手的是一条 `Duplex`（可读可写、可 `destroy`），
 * 但 `@types/dockerode` 只把它声明成 {@link NodeJS.ReadWriteStream} —— 那个接口**没有 `destroy`**。
 * 桥的 `detach()` 必须能拆掉这条连接，所以在这一处把类型收紧：
 * `destroy` 写成**必需**（不做 `any` 逃逸、也不退化成可选链）——
 * 真到不了 `destroy` 就说明 dockerode 换了返回形态，宁可当场炸掉，也别静默漏掉一条连接。
 */
export type AttachStream = NodeJS.ReadWriteStream & { destroy: () => void }

export interface SandboxStdio {
  /** 裸 attach 连接：写入即引擎 stdin；`detach()` 关它 */
  stream: AttachStream
  /** **已解复用**的协议输出（引擎 stdout）——只有它能喂 JSONL 解析器 */
  stdout: PassThrough
  /** **已解复用**的诊断输出（引擎 stderr）——只进日志，**绝不进 SSE** */
  stderr: PassThrough
  /** 拆连接（不关容器、不杀引擎） */
  detach: () => void
}

export async function attachSandboxStdio(containerId: string): Promise<SandboxStdio> {
  const container = getDocker().getContainer(containerId)
  let stream: AttachStream
  try {
    stream = (await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    })) as AttachStream
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  // `modem` 在类型上是 `any`（`@types/dockerode` 就没给它类型），这里用一次即可 ——
  // 它是 dockerode 官方推荐的解复用入口，自己手写那套 8 字节头解析没有任何好处。
  container.modem.demuxStream(stream, stdout, stderr)

  let detached = false
  const detach = (): void => {
    if (detached) return
    detached = true
    // 顺序：先断连接（它一断，解复用那侧的 'data' 就不会再来），再收两个 PassThrough。
    // 反过来写过一次就会踩到"流已结束但 demux 还在往上写"的 ERR_STREAM_WRITE_AFTER_END。
    try {
      stream.destroy()
    } catch {
      // 已经断了 ⇒ 目标状态已达成（`detach()` 会被桥的收尾路径与进程退出路径各调一次，必须幂等）
    }
    stdout.end()
    stderr.end()
  }

  return { stream, stdout, stderr, detach }
}

/**
 * 删容器。**`v: true` 恒开**（`子方案③` §九 1：不带它就会留下匿名卷，越堆越多，
 * 是 Docker 上"磁盘悄悄满"的头号原因）。
 *
 * ⚠️ 但要清楚它**删不掉我们的具名卷**（P0-3-2 实测：`docker rm -v` 之后
 * `docker volume ls --filter label=…` 里那个卷还在）—— 具名卷必须由 {@link removeSandboxVolume}
 * 显式删。这条实测结论是"回收必须两步走"的依据，别指望 `-v` 顺手清干净。
 *
 * `force: true`：容器可能正在跑（甚至卡在某个系统调用里），先 `stop` 再 `rm` 要多一次往返、
 * 且 `stop` 自带 10s 宽限；对一个我们马上要丢掉的一次性容器，直接 kill 才是对的。
 */
export async function removeSandboxContainer(containerId: string): Promise<void> {
  try {
    await getDocker().getContainer(containerId).remove({ force: true, v: true })
  } catch (error) {
    // 已经不在 ⇒ 目标状态已达成（回收路径必须幂等：对账器与 idle 回收器会重复调用）
    if (isDockerNotFound(error)) return
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/** 删具名卷（回收的第二步，见 {@link removeSandboxContainer} 注释） */
export async function removeSandboxVolume(name: string): Promise<void> {
  try {
    await getDocker().getVolume(name).remove()
  } catch (error) {
    if (isDockerNotFound(error)) return
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/**
 * 一次性拉齐"我们名下的所有对象"（对账用）。
 * 合成一次调用是刻意的：对账器要**对着同一时刻的快照**做判断，两次拉取之间建成的东西
 * 会被当成"凭空出现"而误判。
 */
export async function listSandboxObjects(): Promise<{
  containers: Docker.ContainerInfo[]
  volumes: Docker.VolumeInspectInfo[]
}> {
  const [containers, volumes] = await Promise.all([listSandboxContainers(), listSandboxVolumes()])
  return { containers, volumes }
}

/** 把 dockerode 的容器信息转成 {@link SandboxLabels} 能读的形状（`undefined` 归 undefined） */
export function labelsOfContainer(info: Docker.ContainerInfo): Readonly<Record<string, string>> | undefined {
  return info.Labels
}

/** 把 dockerode 的卷信息转成同一形状 */
export function labelsOfVolume(info: Docker.VolumeInspectInfo): Readonly<Record<string, string>> | undefined {
  return info.Labels
}

// ───────────────────────────── 网络（P0-3-3）─────────────────────────────

/**
 * 查一个网络（不存在返回 `undefined`，**不抛**）。
 *
 * ⚠️ 与 `sandboxContainerExists` 同一手法：把 404 当业务答案而不是异常 ——
 * "还没有这张网"是**正常路径**（第一次启动），不该让调用方用 try/catch 表达。
 */
export async function inspectSandboxNetwork(name: string): Promise<Docker.NetworkInspectInfo | undefined> {
  try {
    return await getDocker().getNetwork(name).inspect()
  } catch (error) {
    if (isDockerNotFound(error)) return undefined
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/**
 * 建**专用 internal bridge**（`子方案③` §四 3）。
 *
 * 三个参数都不可省：
 *   · `Internal: true` —— 这张网**没有到公网的路由**（"其余默认拒绝"的实体）。⚠️ **建后不可改**，
 *     所以 `network.ts` 在复用时也会拿它做一次断言；
 *   · `Subnet` —— 网关地址（= 出口② 的默认落点）由它决定，随机会让容器眼里的后端地址每次变
 *     （见 `network.ts` 的注释）；
 *   · `Labels` —— 归属判据（"这网是不是我们的"），与容器/卷同一处原则。
 *
 * ⚠️ 刻意**不吞** "名字已存在"的错：并发建网由 `network.ts` 显式处理（退化成 inspect），
 * 那种"退化"必须是有判断的，不能是这里的一句 catch-all。
 */
export async function createSandboxNetwork(input: {
  name: string
  subnet: string
  labels: Record<string, string>
}): Promise<void> {
  try {
    await getDocker().createNetwork({
      Name: input.name,
      Driver: 'bridge',
      Internal: true,
      Attachable: false,
      Labels: input.labels,
      IPAM: { Driver: 'default', Config: [{ Subnet: input.subnet }] },
    })
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

// ───────────────────────────── 用量读数（P0-3-3）─────────────────────────────

/** `GET /system/df` 里一个卷的三项（其余字段我们不用） */
export interface DockerVolumeUsage {
  name: string
  sizeBytes: number
  labels?: Readonly<Record<string, string>>
}

/**
 * 一次拿齐**所有**卷的体量（`GET /system/df`）。
 *
 * 为什么用它而不是"逐个卷 `du`"：`df` 是**一次调用**给全场（Docker 已经在算这些数了），
 * 而我们的降级方案（work 卷没有硬配额，见 `spec.ts` 上方那段）要**周期性**跑它 ——
 * 一次调用 vs N 个短命容器，成本差一个量级。
 *
 * ⚠️ 返回的是**全部**卷（包括别人的），归属过滤交给调用方（用标签，`spec.ts#findOversizedWorkVolumes`）：
 * 本文件只跟 Docker 说话，不做策略 —— 与 `listSandboxContainers` 的取舍一致（那里是 Docker
 * 的 filters 直接过滤，这里 `df` 没有 filters，只能在拿到之后筛）。
 * ⚠️ `df()` 在 `@types/dockerode` 里是 `Promise<any>`（上游没给类型）⇒ 在这里收一次窄，
 * 别把 `any` 漏给上面的策略层。
 */
export async function listVolumeUsage(): Promise<DockerVolumeUsage[]> {
  let raw: unknown
  try {
    raw = await getDocker().df()
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
  const volumes = (raw as { Volumes?: unknown } | undefined)?.Volumes
  if (!Array.isArray(volumes)) return []
  const result: DockerVolumeUsage[] = []
  for (const item of volumes as Array<{ Name?: unknown; UsageData?: { Size?: unknown } | null; Labels?: unknown }>) {
    if (typeof item?.Name !== 'string') continue
    const size = item.UsageData?.Size
    result.push({
      name: item.Name,
      sizeBytes: typeof size === 'number' && Number.isFinite(size) ? size : 0,
      labels: item.Labels === null || typeof item.Labels !== 'object' ? undefined : (item.Labels as Record<string, string>),
    })
  }
  return result
}

/**
 * 镜像的 `Config.User`（"非 root"是镜像属性，见 `spec.ts#isNonRootImageUser`）。
 * 返回 `undefined` 表示镜像没声明 USER（= 以 root 跑）。
 */
export async function inspectImageUser(image: string): Promise<string | undefined> {
  try {
    const info = await getDocker().getImage(image).inspect()
    const user = info.Config?.User
    if (typeof user !== 'string' || user === '') return undefined
    return user
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

// ───────────────────────────── 容器内执行（P0-3-7）─────────────────────────────

/** 一次 `docker exec` 的结果（`exitCode` 为 `null` = 没等到退出码就断了） */
export interface SandboxExecResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number | null
}

/**
 * 在沙箱容器里执行一条命令并**收全**它的输出（P0-3-7：产物扫描 `find` 与读文件 `cat`）。
 *
 * ⚠️ 三条刻意的形状约束：
 *   · **`cmd` 是字符串数组、不经过 shell**（Docker Exec 直接 `execve`）—— 产物路径来自
 *     `find` 的输出（引擎/模型间接控制文件名），拼进一条 `sh -c` 就是**注入**；
 *     数组形态 + `cat --` 从结构上把这条路堵死。
 *   · **必须 `demuxStream`**：本仓容器 `Tty:false`，输出是 8 字节头多路复用格式
 *     （同 {@link attachSandboxStdio} 的坑 ②）。
 *   · **必须带超时**：`docker exec` 没有内建时限，卡住的进程会把这个 await 挂成
 *     "一轮永远收不了尾"。超时即拆流并抛错（调用方 `artifacts.ts` 按整轮失败处理）。
 *
 * @throws Error 超时 / 建不了 exec / 流异常（`describeDockerFailure` 已翻过人话）
 */
export async function execInSandbox(
  containerId: string,
  cmd: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<SandboxExecResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const container = getDocker().getContainer(containerId)

  // dockerode 5 的形状：`container.exec(opts)` 建（返回带 start/inspect 的 Exec 实例）——
  // `@types/dockerode` 的过载签名与 `lib/container.js` 的实现一致（exec.create 是老版本文档的写法）
  const exec = await container.exec({
    Cmd: [...cmd],
    AttachStdout: true,
    AttachStderr: true,
  })
  const stream = (await exec.start({ stdin: false })) as NodeJS.ReadableStream

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  container.modem.demuxStream(stream, stdout, stderr)

  const chunks: Buffer[] = []
  const errChunks: Buffer[] = []
  let settled = false

  return await new Promise<SandboxExecResult>((resolve, reject) => {
    const finish = async (error?: unknown): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error !== undefined) {
        // 拆流（try/catch：流可能已自断，目标状态已达成）
        try {
          (stream as { destroy?: () => void }).destroy?.()
        } catch {
          /* 已断 */
        }
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      // 退出码要等流收完后再读（exec 的生命周期由容器侧的进程结束驱动）。
      // ⚠️ 个别环境（OrbStack 实测）流先关、ExitCode 稍后才可读 ⇒ 轮询一小段再取，
      //     拿不到就当 `null`（调用方按"非 0 退出"处理，安全侧）。
      let info: { Running?: boolean; ExitCode?: number | null } | null = null
      try {
        for (let i = 0; i < 20; i += 1) {
          info = await exec.inspect()
          if (info.Running !== true) break
          await sleep(50)
        }
      } catch {
        info = null
      }
      resolve({
        stdout: Buffer.concat(chunks),
        stderr: Buffer.concat(errChunks),
        exitCode: info !== null && typeof info.ExitCode === 'number' ? info.ExitCode : null,
      })
    }

    stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))
    stdout.on('error', finish)
    stderr.on('error', finish)
    // ⚠️ **完成信号必须看原始流，而不是 demux 出来的两个 PassThrough**：
    // docker-modem 的 `demuxStream` 只把 'data' 转发给输出，**不会**把源流的 'end'
    // 传给它们 ⇒ 等 stdout/stderr 的 'end' 会让每一条 exec 都挂满整个超时
    // （60s，实测症状是产物基线扫描"每次都恰好卡一分钟"）。
    stream.on('end', () => void finish())
    stream.on('close', () => void finish())
    stream.on('error', finish)

    const deadline = setTimeout(() => {
      void finish(new Error(`docker exec 超时（${timeoutMs}ms）：${cmd.join(' ')}`))
    }, timeoutMs)
    // 别让定时器卡住进程退出（与 reaper 的 `unref()` 同一条纪律）
    deadline.unref?.()
  })
}

/** 短眠（退出码轮询用；与 `manager.ts` 的 `sleep` 同款，不引依赖） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ───────────────────────────── 归档写入（P1-9 · R11）─────────────────────────────

/**
 * 把一个 **tar 归档**解到容器内的某个目录（`docker cp` 的 API 形态，`docker.ts:535` 早已列为待加原语）。
 *
 * ★ P1-9 · R11 是它的**第一个消费方**：把解密后的 git 凭据（私钥 + `known_hosts`）写进
 * 容器 tmpfs `$HOME/.ssh`（§7.3 明写"不另造写文件通道"）。
 *
 * ⚠️ 三条形状约束：
 *   · **归档由调用方构造**（`sandbox/tar.ts#buildTar`）：本函数不碰"里面是什么"，
 *     于是"注哪些文件、什么权限、谁的属主"这条判据只有一处（`sandbox/gitCredential.ts`）。
 *   · **`path` 是解包目标目录**（tar 里的相对路径落在它下面）：`putArchive` 不会替我们建
 *     目标目录之外的父层，故归档里要自带目录条目。
 *   · **`await` 到请求完成**：dockerode 的 modem 在响应结束才 resolve ⇒ 直接 await 即代表"已落盘"。
 *
 * @throws Error docker 报错（`describeDockerFailure` 已翻过人话）
 */
export async function putArchive(containerId: string, targetDir: string, archive: Buffer): Promise<void> {
  const container = getDocker().getContainer(containerId)
  try {
    await container.putArchive(archive, { path: targetDir })
  } catch (error) {
    throw new Error(describeDockerFailure(error), { cause: error })
  }
}

/** 诊断用：当前 Docker 的简述（启动日志里打一行，"沙箱到底有没有接上 Docker"一眼可判） */
export async function describeDocker(): Promise<{ reachable: boolean; version?: string; error?: string }> {
  try {
    const version = await pingDocker()
    return { reachable: true, version }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    getLogger().debug({ err: error }, 'Docker 探活失败')
    return { reachable: false, error: detail }
  }
}
