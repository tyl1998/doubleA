/**
 * mcp-bridge —— 沙箱内的 **MCP 桥扩展**（预烘焙进 base 层）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §七（MCP 走后端代理）、§六 1（`backend/src/sandbox/bridge.ts`
 * 是它的对端）。
 *
 * ⚠️ **本文件在 P0-3-1 只预烘焙一个空壳，真正的实现归 P0-3-9b。**
 *    之所以现在就把它放进镜像，是因为 base 层的内容清单（§五 1）里点了它的名，而"扩展能不能被
 *    pi 加载"这件事**只有进镜像才知道**（extensions 目录的位置、jiti 转译、非 root 下的读权限）。
 *    ⇒ 本批证明的是**加载路径**通，不是功能可用。
 *
 * ── P0-3-9b 要在这里补的三件事（§七 3~5，别在别处另起一份）────────────────
 *   ① `session_start` 时 `GET {SANDBOX_BACKEND_URL}/api/sandbox/mcp/tools`
 *      （头：`X-Sandbox-Token: ${SANDBOX_TOKEN}`）拉**已重命名**的工具清单 `mcp_<alias>_<toolName>`；
 *   ② 用 `pi.registerTool()` 把每个工具注册进去，`execute()` 里 `POST /api/sandbox/mcp/call`
 *      （体：`{ serverAlias, toolName, arguments }`）—— **凭据不进容器**，这里只有 token + 内网地址；
 *   ③ 危险调用的确认**不在这里做**：判定与确认卡都在代理端点（后端侧，§七 5），
 *      扩展只负责等待那一次 POST 的响应（超时值见 §二 的 `SANDBOX_PROXY_TIMEOUT_SEC`）。
 *      ⚠️ 工具清单拉不到、token 不认、后端不可达 —— 一律**显式失败**，不要静默降级成"没有工具"
 *      （§四 3 / `06` §六 27：服务间地址不做兜底）。
 *
 * ── 两条上游约束（`docs/extensions.md`，写在这里免得 9b 重新踩）────────────
 *   · 工厂函数里**不许**起进程/socket/定时器：有些调用（`pi --version`、`pi list`）会加载扩展
 *     但**不启动会话**。长生命周期的东西要从 `session_start` 起、在 `session_shutdown` 里幂等收。
 *   · 扩展跑在 pi 进程里、权限相同 ⇒ 它能看见凭据与文件。本扩展刻意**不读任何凭据文件**
 *     （agent-dir 里根本没有 `auth.json`，见 base/Dockerfile 第 5 节）。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function mcpBridge(pi: ExtensionAPI): void {
  pi.on('session_start', () => {
    // 只报个到。它的用途是让 P0-3-5 的冒烟能回答"扩展到底加载上没有"——
    // 引擎的 stderr 不进 SSE、只进后端日志（§六 3 最后一行），所以这行只会出现在容器日志里。
    process.stderr.write('[mcp-bridge] extension loaded (MCP tool registration lands in P0-3-9b)\n')
  })
}
