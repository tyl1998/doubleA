import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 前端构建配置
 *
 * 关键约定（docs/06 §二·补「构建与部署分离约定」）：
 * - 产物是**纯静态**（输出 `frontend/dist`），部署时不需要 Node 运行时。
 * - 后端地址通过 `VITE_API_BASE_URL` 在**构建期**注入；运行期也可走同源反代（网关按路径分流）。
 * - 开发期用 proxy 把 `/api` 转到后端，避免跨域。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // ⚠️ 必须显式 alias，原因见根 tsconfig.base.json 的注释：
      // 本机 pnpm 12.4.2 无法创建目录符号链接（Windows 开发者模式限制，且失败时静默），
      // backend|frontend/node_modules/@doubulea/shared 是**空目录**，
      // 故 Rollup 解析不到该包。TS 侧由根 tsconfig 的 paths 解决，打包侧由此处解决。
      // 指向 shared 源码：Vite 会把它一并编译进产物（符合「编译期内联、运行期零耦合」的定位）。
      '@doubulea/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // ⚠️ **固定端口，不顺延**（`strictPort`）。
    //
    // 为什么不顺延：vite 默认 5173，本机 5173 常被另一个项目（`apitest-server`）占着，
    // 于是 vite 会**静默**顺延到 5174 ⇒ 同一个仓库在两台机器/两次启动上跑在不同端口，
    // 而这句话没人会注意：文档、CORS 白名单、验收脚本里写死的那一个就成了"有时候对"。
    // 端口被占时**直接起不来并报错**，比"看起来起来了、其实在别的端口"好排查得多。
    //
    // 为什么钉 5174 而不是回到 vite 默认的 5173：5173 是本机另一个项目的常用端口
    // （`docs/06` §七 待决事项 6、`issue_fix/问题记录-macOS环境适配.md` 坑 6），
    // 钉在它上面等于每次都要先关掉别人。5174 是本仓文档/`docs/02` 的 `CORS_ORIGINS` 示例
    // 一直沿用的值，钉住它就不再需要"顺延"这个中间态。
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        // ⚠️ 默认值 3000 是「通用约定」，**不是**本机后端。本机（2026-09-21）3000 被另一个项目的
        //    node 占着，本项目后端在 13000（`infra/.env` 的 BACKEND_PORT）→ 开发时必须显式传：
        //      VITE_DEV_PROXY_TARGET=http://127.0.0.1:13000 pnpm dev:frontend
        //    忘了传的症状是**静默串到陌生服务**：/api 返 404/502 或别人的响应，看起来像后端没写对。
        //    验证：curl --noproxy '*' http://localhost:5174/api/auth/me 应得本项目 401 信封。
        target: process.env.VITE_DEV_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
      // ⚠️ `/health` **不带 `/api` 前缀**（`docs/02` §四 的端点表），所以它**不在上面那条规则里**。
      //    漏了它的症状很安静：请求打到 vite 自己身上、SPA 兜底回了 `index.html`（HTTP 200），
      //    前端 `response.json()` 解析失败 ⇒ 登录页的识别板永远显示"服务信息未取到"，
      //    而**网络面板里那条请求是绿的**（P0-1-30 实测踩到）。
      //    生产期由网关按路径分流，需保证 `/health` 同样指向后端；否则该面板降级为"未取到"。
      '/health': {
        target: process.env.VITE_DEV_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
})
