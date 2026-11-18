/**
 * 派活前的**出口预检**（2026-11-16）。
 *
 * 背景：沙箱容器起来**不等于**它通讯得了。两条出口都是**独立容器**：
 *   · 出口① `SANDBOX_EGRESS_PROXY_URL`（默认 `doubulea-egress:3128`）—— 沙箱在 internal 网上
 *     没有公网路由，**没有它模型调用必然失败**；
 *   · 出口② `SANDBOX_BACKEND_URL`（macOS/Windows 上是 `doubulea-sandbox-relay:<port>`）—— 容器
 *     够不到宿主后端，**没有它 MCP 工具与知识库内置工具一个都注册不上**。
 *
 * 这两个容器被 `--restart unless-stopped` 拉起，但**手工 `docker stop` / 宿主重启后 daemon 判定
 * 不重启 / OOM 杀掉**时它们会是 `Exited`。此时容器本身照样能建起来（镜像、卷、网络都没问题），
 * 症状只在容器里出现：`[mcp-bridge] 拉取 MCP 工具清单失败 … fetch failed`、模型调用失败 ——
 * 用户看到的是"会话起来了但什么都不能用"，而真正的原因在宿主上的两个基础设施容器。
 *
 * ⇒ 在**建容器之前**用 Docker 自身的状态回答一个问题："这一轮派活有没有可能通讯？"
 * 判据与 `nodeBootstrap.ts#inspectNode` 的自检项（`egress` / `egressReachable` / `relay`）同源，
 * 但这里**只查这两个出口**：镜像缺失、工作区目录这类问题在 `ensureSandbox` 后面各有更准的
 * 报错（且 toolkit 缺镜像时还有"回退本机旧 tag"的合法路径，拿整份 `ready` 做闸会误杀）。
 *
 * ⚠️ **只认本机 Docker 容器名**：URL 的 host 不是本机容器（IP / 外部域名 / `host.docker.internal`）
 * 时**不判**（宿主视角证明不了容器视角，硬判会制造假故障），返回 `unverified` 交给调用方记日志。
 * ⚠️ **不做缓存**：两次 `inspect` 走的是本机 docker.sock（毫秒级），而"用户刚 `pnpm relay:up`
 * 就重发"必须立刻生效 —— 缓存只会把已修好的环境继续报错几十秒。
 */

import { getLogger } from '../infra/logger.js'
import { describeDockerFailure, getDocker, isDockerNotFound } from './docker.js'
import { SANDBOX_NETWORK_NAME } from './network.js'

/** 预检结论（失败时 `message` 直接给用户看：说清是哪条出口、观察到什么、下一步做什么） */
export type SandboxOutboundCheck =
  | {
      ok: true
      /** 无法从宿主验证的出口（非本机容器名）—— 只用于日志，不参与判定 */
      unverified: string[]
    }
  | { ok: false; message: string }

/**
 * 平台**默认**的基础设施容器名（与 `infra/scripts/egress-up.sh` / `relay-up.sh` /
 * `nodeBootstrap.ts` 同名）。
 *
 * 用它们回答一个 inspect 回答不了的问题：地址的 host 是个**名字**但本机查不到容器 ⇒
 * 是"被 `docker rm` 掉了"还是"根本不是本机容器（外部代理 / 别的主机）"？默认名一定属于前者
 * （沙箱网是 `internal`，外部主机名在容器里本来就解析不了）⇒ 明确失败，别放行。
 * ⚠️ 运维用 `--name` 改过名字时不在此列：那种情况宿主视角证明不了容器视角，只记 `unverified`。
 */
const KNOWN_CONTAINER_NAMES = new Set(['doubulea-egress', 'doubulea-sandbox-relay'])

interface ContainerState {
  running: boolean
  status: string
  exitCode: number
  oomKilled: boolean
  finishedAt: string
  networks: string[]
}

/**
 * 按**容器名**查状态；名字不是本机容器 ⇒ `undefined`（= 无法验证，不是失败）。
 *
 * 用 `getContainer(name)` 而不是列全部容器再匹配：Docker 的名字解析与 `docker inspect <name>`
 * 同一套规则，且 404 就是"这个名字不属于本机任何容器"。
 */
async function inspectNamedContainer(name: string): Promise<ContainerState | undefined> {
  try {
    const info = await getDocker().getContainer(name).inspect()
    return {
      running: info.State?.Running === true,
      status: info.State?.Status ?? 'unknown',
      exitCode: typeof info.State?.ExitCode === 'number' ? info.State.ExitCode : 0,
      oomKilled: info.State?.OOMKilled === true,
      finishedAt: info.State?.FinishedAt ?? '',
      networks: Object.keys(info.NetworkSettings?.Networks ?? {}),
    }
  } catch (error) {
    if (isDockerNotFound(error)) return undefined
    throw error
  }
}

/** `Exited (137)，结束于 2026-11-02T03:21:xxZ` 这种"能对上现场"的一句话 */
function describeState(state: ContainerState): string {
  const parts = [`状态 ${state.status === 'exited' ? 'Exited' : state.status}`]
  if (state.status !== 'running') {
    parts.push(`ExitCode ${String(state.exitCode)}${state.oomKilled ? '，OOMKilled' : ''}`)
  }
  if (state.finishedAt !== '' && !state.finishedAt.startsWith('0001-')) {
    parts.push(`结束于 ${state.finishedAt}`)
  }
  return parts.join('，')
}

interface EndpointInput {
  /** 用户文案里的那条出口（`出口①（egress 代理）`） */
  label: string
  url: string
  /** 这条出口断了会导致什么（写进错误卡） */
  consequence: string
  /** 怎么修（写进错误卡） */
  fix: string
}

type EndpointResult = { ok: true; verified: boolean } | { ok: false; message: string }

async function checkEndpoint(input: EndpointInput): Promise<EndpointResult> {
  let host: string
  try {
    host = new URL(input.url).hostname
  } catch {
    return { ok: false, message: `${input.label}的地址不是合法 URL：${input.url}` }
  }

  const state = await inspectNamedContainer(host)
  if (state === undefined) {
    // 默认名查不到 = 容器被删了（DNS 里也不会有它 ⇒ 容器里就是 `EAI_AGAIN`）。自定义名放行到日志。
    if (KNOWN_CONTAINER_NAMES.has(host)) {
      return {
        ok: false,
        message:
          `${input.label}不可用：本机没有名为 ${host} 的容器（可能被 docker rm 掉了）。` +
          `${input.consequence} ⇒ 本轮不启动沙箱。${input.fix}后重发这一轮。`,
      }
    }
    return { ok: true, verified: false }
  }

  if (!state.running) {
    return {
      ok: false,
      message:
        `${input.label}不可用：容器 ${host} 未运行（${describeState(state)}）。` +
        `${input.consequence} ⇒ 本轮不启动沙箱。${input.fix}后重发这一轮。`,
    }
  }

  if (!state.networks.includes(SANDBOX_NETWORK_NAME)) {
    return {
      ok: false,
      message:
        `${input.label}不可用：容器 ${host} 没接入沙箱网 ${SANDBOX_NETWORK_NAME}` +
        `（当前：${state.networks.join(' + ') || '无'}）。` +
        `${input.consequence} ⇒ 本轮不启动沙箱。${input.fix}后重发这一轮。`,
    }
  }

  return { ok: true, verified: true }
}

/**
 * 预检两条出口。失败即返回**可展示**的原因；Docker 自身不可达也在这里如实报（不装成功）。
 *
 * @param input.egressProxyUrl `config.sandbox.egressProxyUrl`（调用方已保证非空）
 * @param input.backendUrl     `config.sandbox.backendUrl`（空 = 默认走沙箱网网关 + 本进程 listener）
 */
export async function checkSandboxOutbound(input: {
  egressProxyUrl: string
  backendUrl: string | undefined
}): Promise<SandboxOutboundCheck> {
  const unverified: string[] = []
  try {
    const egress = await checkEndpoint({
      label: '出口①（egress 代理）',
      url: input.egressProxyUrl,
      consequence: '沙箱挂在 internal 网络上、没有公网路由，没有它必然调不到模型池',
      fix: '先执行 `pnpm egress:up`（或在 /admin/sandbox-instances 点「一键初始化」）',
    })
    if (!egress.ok) return { ok: false, message: egress.message }
    if (!egress.verified) unverified.push(`出口①（${input.egressProxyUrl} 不是本机容器名）`)

    // 出口②：只有显式配置时才可能是个中转容器。默认形态（网关地址 + 本进程 listener）不需要查。
    if (input.backendUrl !== undefined) {
      const backend = await checkEndpoint({
        label: '出口②（后端中转）',
        url: input.backendUrl,
        consequence: '容器够不到宿主后端，MCP 工具与知识库内置工具都注册不上，模型调用也会失败',
        fix: '先执行 `pnpm relay:up`（或在 /admin/sandbox-instances 点「一键初始化」）',
      })
      if (!backend.ok) return { ok: false, message: backend.message }
      if (!backend.verified) unverified.push(`出口②（${input.backendUrl} 不是本机容器名）`)
    }
  } catch (error) {
    return { ok: false, message: `沙箱出口预检失败：${describeDockerFailure(error)}` }
  }

  if (unverified.length > 0) {
    getLogger().debug({ unverified }, '出口预检跳过（地址不是本机 Docker 容器名，宿主视角无法验证）')
  }
  return { ok: true, unverified }
}