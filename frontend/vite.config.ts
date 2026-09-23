import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 从模块 id 里取 npm 包名；不是依赖返回 `null`（见下方 `manualChunks` 的第 ① 条实现口径）。
 *
 * 取**最后一个** `node_modules/` 之后的段：pnpm 的路径形如
 * `…/node_modules/.pnpm/antd@5.29.3_react@18.3.1/node_modules/antd/es/button/index.js`，
 * 从第一个 `node_modules/` 后面取会得到 `.pnpm`。
 */
function packageNameOf(id: string): string | null {
  const normalized = id.replaceAll('\\', '/')
  const marker = normalized.lastIndexOf('node_modules/')
  if (marker === -1) return null
  const segments = normalized.slice(marker + 'node_modules/'.length).split('/')
  const head = segments[0]
  if (head === undefined || head === '') return null
  if (head.startsWith('@')) {
    const scope = segments[1]
    return scope === undefined || scope === '' ? null : `${head}/${scope}`
  }
  return head
}

/** 几乎不随本项目改动的基础运行时（换版本才动） */
const REACT_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-router',
  'react-router-dom',
  'react-is',
  'prop-types',
  'scheduler',
  '@remix-run/router',
])

/**
 * antd 核心。
 *
 * ⚠️ 只放 `antd` 自己，**不放它的依赖**（`@ant-design/*` / `rc-*` / `dayjs` / `classnames` /
 * `@babel/runtime`）—— 那些留在 `vendor` 或 `rc` 里。理由是实测出来的：把 `rc-*` 和
 * `@ant-design/*` 一起并进来，这块会到 843 kB（顶掉 vite 的 500 kB 线）；而只要有两个块
 * **互相** import（比如 `vendor` 里某个包 import 了 `dayjs`、`antd` 又 import 它），
 * rollup 就会打印 `Circular chunk` 警告 —— 用一条新警告换掉旧警告等于没做。
 * 归类口诀：**一个包只放一处，且"谁 import 谁"必须单向**。
 */
const ANTD_PACKAGES = new Set(['antd'])

/** P0-1-32 引入的 Markdown 渲染链（react-markdown + remark-gfm + micromark/hast 那几串） */
const MARKDOWN_PACKAGES = new Set([
  'react-markdown',
  'remark-gfm',
  'remark-parse',
  'remark-rehype',
  'hast-util-to-jsx-runtime',
])

/** 数据层（服务端状态 + 客户端 UI 状态） */
const STATE_PACKAGES = new Set(['@tanstack/react-query', 'zustand', 'use-sync-external-store'])

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
    rollupOptions: {
      output: {
        /**
         * 分包（P0-1-36 补上 P0-1-32~35 一路带着的那条尾巴）。
         *
         * ── 为什么要分：三条互不相同的理由 ──
         * ① **告警**：单块从 P0-1-32 的 1.2 MB 一路涨到 P0-1-35 的 1413.78 kB（gzip 445 kB），
         *    已越过 vite 的 500 kB 告警线。一直不管，这条告警就会变成"每次构建都有的噪音"
         *    —— 那时候真出现一个意外的巨型依赖，也没人能从输出里看出来。
         * ② **缓存**：本项目改得最勤的是 `pages/` 与 `features/`（每批都在动），而 react / antd
         *    几乎不动。分成独立 chunk 后，改一个页面不会让浏览器重新下载整包 antd。
         * ③ **并行**：多个 chunk 可以并行下载，比一个 1.4 MB 的串行文件更快到首屏。
         *
         * ── 分组结果（实测，P0-1-36 构建输出） ──
         *   · `react`    167.84 kB（gzip  54.55）—— react / react-dom / react-router-dom 及其伴生包；
         *   · `antd`     450.77 kB（gzip 125.61）—— antd 本体；
         *   · `rc`       393.57 kB（gzip 135.11）—— rc-* / @rc-component/* / @ant-design/*；
         *   · `markdown` 114.35 kB（gzip  32.76）—— P0-1-32 引入的 react-markdown + remark/micromark；
         *   · `state`      3.06 kB（gzip   1.45）—— @tanstack/react-query + zustand；
         *   · `vendor`   162.75 kB（gzip  48.20）—— 其余依赖（dayjs / @babel/runtime / classnames…）；
         *   · 主 chunk（应用代码 + `@doubulea/shared`）168.04 kB。
         * 最大块 450.77 kB < 500 kB ⇒ **构建输出零告警**（这也是本次的目标，见下）。
         *
         * ── ⚠️ 两条踩出来的规矩（别改回去） ──
         * ① **`antd` 与 `rc-*`+`@ant-design/*` 分块，但 `rc-*` 与 `@ant-design/*` 必须同块**。
         *    并成一块会到 843 kB（顶掉 500 kB 线）；而把 `@ant-design/*` 拆到 `vendor` 会立刻得到
         *    `Circular chunk: antd -> vendor -> antd`（`@ant-design/cssinjs-utils` 依赖 `rc-util`）。
         *    循环 chunk 不是错误（rollup 会处理），但它**每次都打印一条警告** ——
         *    用一条新警告换掉旧警告等于没做，所以这里的判据是"**谁 import 谁必须单向**"。
         * ② 取包名要用**最后一个** `node_modules/` 之后的段 —— pnpm 的路径是
         *    `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/…`；从第一个 `node_modules/` 后面
         *    取会得到 `.pnpm`，于是所有依赖都被判成同一类：分包**静默失效**、只剩一个巨型 chunk，
         *    而构建照样成功（症状是"改了配置但数字一点没变"）。
         *
         * 只要 `id` 不带 `node_modules` 段就返回 `undefined`（留在主 chunk）：`@doubulea/shared`
         * 走 alias 指向 `../shared/src/index.ts`，因此自然落在主 chunk —— 这正是想要的
         * （它是本项目自己的契约，跟着应用一起变）。
         */
        manualChunks(id: string) {
          const pkg = packageNameOf(id)
          if (pkg === null) return undefined
          if (REACT_PACKAGES.has(pkg)) return 'react'
          if (MARKDOWN_PACKAGES.has(pkg) || pkg.startsWith('micromark') || pkg.startsWith('mdast-')) return 'markdown'
          if (STATE_PACKAGES.has(pkg)) return 'state'
          if (ANTD_PACKAGES.has(pkg)) return 'antd'
          // `@ant-design/*` 与 `rc-*` **必须同块**：`@ant-design/cssinjs-utils` 依赖 `rc-util`，
          // 分开两块会立刻得到 `Circular chunk: antd -> vendor -> antd`（实测）
          if (pkg.startsWith('rc-') || pkg.startsWith('@rc-component/') || pkg.startsWith('@ant-design/')) {
            return 'rc'
          }
          return 'vendor'
        },
      },
    },
  },
})
