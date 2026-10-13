/**
 * 路由网关出口（P1-14 §三 6）
 *
 * 独立的进程入口在 `main.ts`（`pnpm router:start` → `node dist/backend/src/router/main.js`）；
 * 这里只导出可复用的零件，便于**不起进程**地核对分类与选择逻辑（回归脚本）。
 */

export { buildRouterApp, splitHostPort, UPSTREAM_COOLDOWN_MS, type RouterDeps } from './gateway.js'
export { loadRouterConfig, parseUpstream, type RouterConfig, type RouterConfigResult } from './config.js'
