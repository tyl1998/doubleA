/**
 * 沙箱代理 listener —— 出口②（P0-3-3）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §四 3（"出口② 落成独立 listener"）、
 *      `docs/02-后端设计.md` §4.10（沙箱代理端点：**不在公网 listener 上**）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 定案：**同进程内的第二个 Fastify 实例**（`子方案③` §十三 待决 5）
 * ─────────────────────────────────────────────────────────────────────
 * §四 3 给的退化方案是"同一实例 + iptables 只放行该端口 + token 校验"，两条都没选：
 *   · **退化的那个，安全性靠 iptables** —— 而 iptables 的生效与否在**本机（macOS）根本验不了**
 *     （Docker 跑在 VM 里），等于把"容器摸不到业务 API"这条关键判据押在一个我这边看不见的层上；
 *   · 第二个实例的成本其实只有"多一个 Fastify 对象"：不挂会话、不挂 CORS、不挂业务路由，
 *     `buildApp()` 那一整套（错误处理 + 首登闸门 + 会话 + 全部路由）**一行都不进这里**。
 * ⇒ **容器能调到的那个 listener 上只有 `/api/sandbox/*`** —— 自 **P0-3-9b** 起它上面真的挂着
 * 两个端点（`GET /api/sandbox/mcp/tools` 与 `POST /api/sandbox/mcp/call`，见 `proxy.ts`），
 * 登录、会话、管理端点**一个都不在它上面**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 绑定地址：默认**只绑专用 bridge 的网关地址**
 * ─────────────────────────────────────────────────────────────────────
 * 那是"容器眼里的宿主"（`network.ts` 实测 2），也是暴露面的最小化：业务 listener 在哪张网卡上
 * 听，与本 listener 无关（两个 socket，两套路由）。`SANDBOX_LISTEN_HOST` 只为一类部署存在 ——
 * **Docker 跑在 VM 里**（macOS）时后端不在 Docker 宿主上，中转容器得能连到我们（见 `config.ts`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 三处刻意的"不做"
 * ─────────────────────────────────────────────────────────────────────
 * ① **不在这里注册任何业务路由**：容器能调到的只有 `/api/sandbox/mcp/*` 两条
 *    （`registerSandboxProxyRoutes`，P0-3-9b 起）。所有**未注册**路径统一 404 + 统一信封 ——
 *    于是"容器把路径写错了"与"容器根本连不上"是两种可区分的现象（前者 404、后者连不上）。
 * ② **不让它的失败影响后端启动**：Docker 不可达 / 端口被占 / 网关读不到 ⇒ **warn + 记在
 *    `getSandboxListenerStats().error` 上**，后端照常服务其余功能（同 `00` 的纪律：探活端点
 *    自身恒 200，依赖状态进 body/日志）。理由很实际：本机没起 Docker 时不该连登录都用不了。
 * ③ **未配置 `SANDBOX_IMAGE` 时整个跳过**：与对账器（`reaper.ts`）逐字同款 ——
 *    没建镜像就没有沙箱，也就没有"容器要连回来"这件事。顺带避免"跑个前端也在宿主上凭空
 *    多出一张 Docker 网络"。
 */

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'

import { fail } from '@doubulea/shared'

import { config } from '../config.js'
import { logger as pinoLogger } from '../infra/logger.js'
import { describeSandboxNetwork, ensureSandboxNetwork } from './network.js'
import { registerSandboxProxyRoutes } from './proxy.js'

/** 沙箱代理 listener 的运行态（日志 / 排障 / 将来的 `/api/tasks` 用） */
export interface SandboxListenerStats {
  running: boolean
  /** 绑定地址（未启动时 = 解析失败或没解析） */
  host: string | undefined
  port: number
  /** 绑不上时的原因（**给人看**：端口被占 / Docker 不可达 / 网关读不到） */
  error: string | undefined
}

let instance: FastifyInstance | undefined
let lastError: string | undefined
let boundHost: string | undefined

/**
 * 起沙箱代理 listener。
 *
 * @returns 真的起来了吗（未配置镜像 / 绑不上都返回 `false`；原因见日志与 `getSandboxListenerStats`）
 */
export async function startSandboxListener(): Promise<boolean> {
  if (instance !== undefined) return true
  if (config.sandbox.image === undefined) {
    pinoLogger.info('未配置 SANDBOX_IMAGE ⇒ 不启动沙箱代理 listener（出口②，只服务于 MCP 代理）')
    return false
  }

  const port = config.sandbox.callbackPort
  try {
    const host = config.sandbox.listenHost ?? (await ensureSandboxNetwork()).gateway
    const app = Fastify({
      loggerInstance: pinoLogger as unknown as FastifyBaseLogger,
      // 沙箱端点的报文极小（就是一次工具调用），1MB 的框架默认值已经富余；
      // 收紧到 256KB 只是"这条通道不该被用来搬运文件"的一句声明。
      bodyLimit: 256 * 1024,
      // ⚠️ 不设 `trustProxy`：这一侧的客户端只可能是同 bridge 里的容器，没有反向代理。
      //    开了它只会让 `X-Forwarded-For` 变成可以随便伪造的东西（日志里出现假来源）。
      trustProxy: false,
    })
    // ★ P0-3-9b：把沙箱 MCP 代理的两个端点挂上（`proxy.ts`）。
    //   ⚠️ 只挂在这一个实例上 —— 公网 listener（`app.ts`）上没有它们，
    //   于是"容器能摸到业务 API"在结构上不成立，而不是靠 iptables（本机根本验不了 iptables）。
    registerSandboxProxyRoutes(app)
    // 统一信封的 404：路径写错（不是 `/api/sandbox/mcp/*` 里的那两条）应当是**看得懂的一句话**，
    // 而不是 Fastify 默认的 "Route GET:/api/sandbox/mcp/call not found"。
    app.setNotFoundHandler((request, reply) => {
      void reply
        .code(404)
        .send(fail('NOT_FOUND', `沙箱代理端点上没有 ${request.method} ${request.url}`))
    })
    await app.listen({ port, host })
    instance = app
    boundHost = host
    lastError = undefined
    pinoLogger.info(
      { host, port, network: await describeSandboxNetwork() },
      '沙箱代理 listener 已启动（出口②：只有专用 bridge 内的容器可达）',
    )
    return true
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    pinoLogger.warn(
      { err: error, port },
      `沙箱代理 listener 启动失败（后端其余功能不受影响；沙箱路径会连不上后端）：${lastError}`,
    )
    return false
  }
}

/** 停 listener（在飞请求不等待 —— 出口② 的请求都是短请求，且此刻容器已在回收路径上） */
export async function stopSandboxListener(): Promise<void> {
  const app = instance
  instance = undefined
  boundHost = undefined
  if (app === undefined) return
  try {
    await app.close()
  } catch (error) {
    pinoLogger.warn({ err: error }, '关闭沙箱代理 listener 时出错（继续退出）')
  }
}

/** 取运行态（**不发起 IO**，可被日志反复调用） */
export function getSandboxListenerStats(): SandboxListenerStats {
  return {
    running: instance !== undefined,
    host: boundHost,
    port: config.sandbox.callbackPort,
    error: lastError,
  }
}
