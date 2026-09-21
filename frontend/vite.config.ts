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
    port: 5173,
    proxy: {
      '/api': {
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
