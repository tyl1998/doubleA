/**
 * 沙箱专用 bridge 网络（P0-3-3）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §四 3（网络：两条白名单，其余默认拒绝）、
 *      `docs/02-后端设计.md` §十（安全：专用 internal bridge，不用默认 bridge）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么必须是一个**我们自己的、internal 的** bridge
 * ─────────────────────────────────────────────────────────────────────
 * 沙箱容器**必须**能出网（引擎要调 LLM），所以 `network=none` 不成立。但"能出网"不等于
 * "能随便出网"，于是有两条路：
 *   · **默认 `bridge`** —— 容器能摸到宿主**所有监听端口**（13000 公网口、PG 15432、
 *     Redis 16379、MinIO 19000…）。那是比"能出公网"更严重的暴露面；
 *   · **自己的 bridge + `Internal: true`** —— 该网络**没有到公网的路由**，容器只可能
 *     ① 经 egress 代理出公网（`HTTP(S)_PROXY`，见 `spec.ts#sandboxEgressEnv`）
 *     ② 到 Docker 宿主上的后端沙箱代理 listener（出口②）。
 *     其余一律不通 —— 这才是真的"白名单两出口"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 三条实测（P0-3-3，真 Docker 29.4.0 / OrbStack；不许靠推演）
 * ─────────────────────────────────────────────────────────────────────
 * 1. **公网确实不可达**：容器内 `fetch(https://…)` 得 `EAI_AGAIN`（连 DNS 都不通），
 *    到 macOS 宿主的地址是 `ENETUNREACH`。
 * 2. ★ **到 Docker 宿主**（= 该 bridge 的**网关地址**）**可达**：在网关地址上起一个 listener，
 *    容器内 `fetch(http://<网关>:<port>)` 得 **200**。⇒ "出口② 绑在专用 bridge 的网关地址上"
 *    这条设计**成立**。
 * 3. ⚠️ **但 macOS 上那个"宿主"是 OrbStack 的 Linux VM，不是 macOS**：后端跑在 macOS 上时
 *    容器**够不着它**（`ENETUNREACH`）。生产（后端与 Docker 同宿主）没有这个问题；
 *    本机 dev 要把 `SANDBOX_BACKEND_URL` 显式指到一个与沙箱网络双宿的中转（见 `config.ts`）。
 *    —— 这条差异写在这里，是为了让下一个人在 macOS 上第一次跑 P0-3-9b 时**先看这里**，
 *    而不是去怀疑 token 校验或路由注册。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 网络是**共享基础设施**，不是每会话资源
 * ─────────────────────────────────────────────────────────────────────
 * 它由本模块**幂等创建**、从不删除（10 个容器共用一张网，删它等于把在跑的容器一起弄坏）。
 * 归属判据与容器/卷**同一处原则**：**标签**（`doubulea.role=sandbox-network`）。
 * ⚠️ 名字已存在但**不是我们建的**（缺标签）⇒ **大声失败**，绝不挂上去：
 * 把沙箱接进一个来路不明的网段 = 让它们跟别人的容器同网，那比"没有隔离"更糟。
 */

import { getLogger } from '../infra/logger.js'
import { createSandboxNetwork, describeDockerFailure, inspectSandboxNetwork } from './docker.js'

/** 角色标签的键（与容器/卷**同一个键**：`doubulea.role`） */
export const SANDBOX_NETWORK_LABEL_ROLE = 'doubulea.role'

/** 角色标签在**网络**上的值（容器/卷用的是 `sandbox`，网络用 `sandbox-network`，刻意区分） */
export const SANDBOX_NETWORK_ROLE = 'sandbox-network'

/**
 * 专用 bridge 的名字（**代码常量**，不是 env）。
 *
 * 为什么不进 env：它更像 `WORK_VOLUME_PREFIX` 那类"名字的构造约定"而不是"随部署变化的量" ——
 * 一张网管本机全部沙箱，没有"每个环境一个名字"的需求；而多一个 env 就多一处"改了没生效"
 * （真正的运维差异在 `SANDBOX_BACKEND_URL` / `SANDBOX_LISTEN_HOST` 那两项上，见 `config.ts`）。
 */
export const SANDBOX_NETWORK_NAME = 'doubulea-sandbox'

/**
 * 专用 bridge 的网段。
 *
 * ⚠️ **写死而不是让 Docker 自己挑**：网关地址是"容器眼里的后端地址"，而它是从这块网段算出来的
 * ⇒ 让它随机，`SANDBOX_BACKEND_URL` 的默认值就会随每次重建而变（排障时最难对上的那类差异）。
 * 选 `172.31.240.0/24`：远离 Docker 默认的 `172.17.0.0/16` 与本机常见网段（172.31 是 RFC1918
 * 里的私有段，被占用的概率低）。真撞上时 `docker network create` 会**当场报错**，不静默。
 */
export const SANDBOX_NETWORK_SUBNET = '172.31.240.0/24'

/** 一张可用的沙箱网络 */
export interface SandboxNetwork {
  name: string
  id: string
  /** 容器眼里的"宿主"地址 = 出口② 的默认落点（见文件头实测 2/3） */
  gateway: string
  /** 这一轮是**新建**的（true）还是复用了已有的（false）—— 只有日志与验收关心 */
  created: boolean
}

/**
 * 拿到（必要时创建）沙箱网络。**幂等**：并发调用最多多建一次，第二次会撞上 Docker 的
 * "名字已存在"并退化成 inspect（见下面 `createNetwork` 的分支）。
 *
 * ⚠️ **校验排在复用之前**：已存在的网络必须**既带我们的标签、又是 internal**。
 * 少判任何一条，"复用一个别人的网络"或"复用一个被改过隔离级别的网络"都会静默发生 ——
 * 而这两种情况下沙箱会**看起来一切正常**，实际暴露面完全不同。
 */
export async function ensureSandboxNetwork(): Promise<SandboxNetwork> {
  const existing = await inspectSandboxNetwork(SANDBOX_NETWORK_NAME)
  if (existing !== undefined) {
    assertOurs(existing)
    const gateway = readGateway(existing, 'inspect')
    return { name: SANDBOX_NETWORK_NAME, id: existing.Id ?? SANDBOX_NETWORK_NAME, gateway, created: false }
  }

  try {
    await createSandboxNetwork({
      name: SANDBOX_NETWORK_NAME,
      subnet: SANDBOX_NETWORK_SUBNET,
      labels: { [SANDBOX_NETWORK_LABEL_ROLE]: SANDBOX_NETWORK_ROLE },
    })
  } catch (error) {
    // 并发建网：另一个进程刚建好。**只在这一种原因上**退化成 inspect ——
    // 别的失败（网段撞车、驱动不支持 internal）必须原样抛出去，否则会变成"以为建好了"。
    const raced = await inspectSandboxNetwork(SANDBOX_NETWORK_NAME)
    if (raced === undefined) throw error
    getLogger().debug({ network: SANDBOX_NETWORK_NAME }, '沙箱网络已被并发创建（按已有处理）')
    assertOurs(raced)
    return {
      name: SANDBOX_NETWORK_NAME,
      id: raced.Id ?? SANDBOX_NETWORK_NAME,
      gateway: readGateway(raced, 'inspect'),
      created: false,
    }
  }

  const created = await inspectSandboxNetwork(SANDBOX_NETWORK_NAME)
  if (created === undefined) {
    // 建完立刻查不到 = 世界的形状不对（Docker 在撒谎或名字被换）。**不要兜底一个猜测的网关**：
    // 出口② 的地址猜错，症状是"容器里那个 fetch 永远超时"，谁也想不到是这里。
    throw new Error(`沙箱网络 ${SANDBOX_NETWORK_NAME} 创建后查不到（Docker 异常）`)
  }
  const gateway = readGateway(created, 'create')
  getLogger().info(
    { network: SANDBOX_NETWORK_NAME, subnet: SANDBOX_NETWORK_SUBNET, gateway },
    '沙箱专用 internal bridge 已创建（其余默认拒绝：公网只可能经 egress 代理，内网只有出口②）',
  )
  return { name: SANDBOX_NETWORK_NAME, id: created.Id ?? SANDBOX_NETWORK_NAME, gateway, created: true }
}

/** 读网关地址。读不到**不猜**（见 `ensureSandboxNetwork` 最后一段的注释） */
function readGateway(network: { IPAM?: { Config?: Array<{ Gateway?: string }> } }, phase: string): string {
  const gateway = network.IPAM?.Config?.[0]?.Gateway
  if (gateway === undefined || gateway === '') {
    throw new Error(
      `沙箱网络 ${SANDBOX_NETWORK_NAME}（${phase}）读不到网关地址：出口② 的地址由它派生，` +
        '读不到就不能猜（否则症状是"容器里那次 fetch 永远超时"）',
    )
  }
  return gateway
}

/** 已存在的网络必须是**我们建的**、且**隔离级别没被改过** */
function assertOurs(network: {
  Id?: string
  Internal?: boolean
  Labels?: Record<string, string> | null
  Driver?: string
}): void {
  const role = network.Labels?.[SANDBOX_NETWORK_LABEL_ROLE]
  if (role !== SANDBOX_NETWORK_ROLE) {
    throw new Error(
      `名为 ${SANDBOX_NETWORK_NAME} 的网络已存在，但它不是我们建的（缺少标签 ` +
        `${SANDBOX_NETWORK_LABEL_ROLE}=${SANDBOX_NETWORK_ROLE}，实际 ${role ?? '（无）'}）。` +
        '换一个名字或先删掉它 —— 把沙箱接进来路不明的网段，会让它和别人的容器同网。',
    )
  }
  if (network.Internal !== true) {
    throw new Error(
      `名为 ${SANDBOX_NETWORK_NAME} 的网络不是 internal（` +
        `docker network inspect ${SANDBOX_NETWORK_NAME} 看 Internal 字段）。` +
        '该字段**建后不可改** ⇒ 删掉重建：docker network rm ' +
        `${SANDBOX_NETWORK_NAME}（先确认没有在跑的沙箱容器）。`,
    )
  }
}

/** 诊断用：当前沙箱网络的简述（启动日志里打一行，"隔离到底有没有接上"一眼可判） */
export async function describeSandboxNetwork(): Promise<{
  reachable: boolean
  id?: string
  gateway?: string
  internal?: boolean
  error?: string
}> {
  try {
    const network = await inspectSandboxNetwork(SANDBOX_NETWORK_NAME)
    if (network === undefined) return { reachable: true, internal: undefined, id: undefined, gateway: undefined }
    return { reachable: true, id: network.Id, gateway: network.IPAM?.Config?.[0]?.Gateway, internal: network.Internal }
  } catch (error) {
    getLogger().debug({ err: error }, '沙箱网络 inspect 失败')
    return { reachable: false, error: describeDockerFailure(error) }
  }
}
