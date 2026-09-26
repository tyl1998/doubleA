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
 * 这里只有薄薄一层：连上守护进程、列对象、建对象、删对象，以及**把 Docker 的报错翻译成人话**。
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

import Docker from 'dockerode'

import { getLogger } from '../infra/logger.js'
import { sandboxFilter, sandboxFilterFor, type SandboxLabels } from './spec.js'

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

/** 容器还在不在（**唯一**判断方式：`inspect`；账本里的 `container_id` 不作数） */
export async function sandboxContainerExists(containerId: string): Promise<boolean> {
  try {
    await getDocker().getContainer(containerId).inspect()
    return true
  } catch (error) {
    if (isDockerNotFound(error)) return false
    throw new Error(describeDockerFailure(error), { cause: error })
  }
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
