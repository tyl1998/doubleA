/**
 * Fastify 实例装配（P0-1-4 起，P0-1-6 加入会话）
 *
 * 依据：`docs/02-后端设计.md` §一（Fastify）、§四（信封）、§五（SSE 前提）、
 *      §十（安全：Cookie 会话 → CORS 不能反射任意来源）、§十三（request id 贯穿）
 *
 * 本文件**只装配、不监听**：`buildApp()` 返回一个已注册好插件与路由的实例，
 * 由 `index.ts` 负责 `listen` 与优雅退出，验证脚本则可以直接 `app.inject()` 打请求
 * （不需要占端口，也不会污染本机端口避让的那套约定）。
 *
 * 装配顺序有依赖，不要随意调换：
 *   错误处理 + 校验器 → 请求上下文钩子 → 会话（Cookie/鉴权装饰器）→ CORS → 路由
 */

import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify'

import { config } from './config.js'
import { enterRequestContext, genReqId, logger } from './infra/logger.js'
import { installErrorHandler } from './plugins/errorHandler.js'
import { installPasswordChangeGate, installSession } from './plugins/session.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerArtifactRoutes } from './routes/artifacts.js'
import { registerConversationRoutes } from './routes/conversations.js'
import { registerDocumentRoutes } from './routes/documents.js'
import { registerFileRoutes } from './routes/files.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerKnowledgeBaseRoutes } from './routes/knowledgeBases.js'
import { registerMcpCredentialRoutes } from './routes/mcpCredentials.js'
import { registerMcpServerRoutes } from './routes/mcpServers.js'
import { registerModelRoutes } from './routes/models.js'
import { registerModelProviderRoutes } from './routes/modelProviders.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerUsageRoutes } from './routes/usage.js'
import { registerUserRoutes } from './routes/users.js'

/**
 * 监听地址：容器/内网部署要能从他机访问（`02` §十二），故不锁 `127.0.0.1`。
 * 本机开发若不希望暴露到局域网，用 `HOST=127.0.0.1`（P0-1-4 暂不加变量，先写死默认值）。
 */
export const DEFAULT_HOST = '0.0.0.0'

/**
 * JSON/普通端点的请求体上限（= Fastify 默认的 1MB）。
 *
 * 为什么不写进配置：`02` §十一 的变量清单里只有 `UPLOAD_BODY_LIMIT`（上传上限），
 * 没有"普通端点上限"这一项 —— 这里取框架默认值就是最小惊讶的选择，
 * 而"谁需要更大"这件事本身就该是一个**显式的路由级决定**（目前只有上传路由需要）。
 */
const JSON_BODY_LIMIT_BYTES = 1024 * 1024

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // 复用 P0-1-3 的 pino 实例：Fastify 的 req.log 会成为它的 child，
    // 日志格式/脱敏规则/JSON 结构全部一致（`02` §十三）
    // ⚠️ 这里必须把 pino 实例断言成 FastifyBaseLogger：Fastify 会按传入实例的类型参数化整个
    //    FastifyInstance（变成 FastifyInstance<…, pino.Logger>），于是 `FastifyInstance` 这个
    //    默认泛型在插件/路由签名里就都对不上了。运行期两者兼容（pino 自带 child/level/各日志方法），
    //    差别只在类型层面的 `msgPrefix` 等细节。
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // 请求 id：优先透传上游的 x-request-id，没有则新生成（`02` §十三：三方日志可对齐）
    genReqId: (request) => genReqId(request),
    // 日志控制器：两件事都在这里定
    //   · 关掉 Fastify 默认的 incoming/request-completed 两条日志，改用下方 onResponse 那条
    //     （带 durationMs、且尊重路由级 logLevel，如 /health 设为 warn 就不打点）
    //   · `request.log` 的 requestId 字段名与业务代码 `getLogger()`（ALS 注入）保持一致
    // ⚠️ 必须用 `logController` 而不是顶层的 `disableRequestLogging` / `requestIdLogLabel`：
    //    后两者在 v5 已废弃，启动时会打印 FastifyDeprecation 警告（FSTDEP023/024）。
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    // 上传（P0-1-16 的 multipart）要走 100MB 级 body，但**只有上传路由**需要那么大。
    // 全局上限收到 JSON 的 1MB（Fastify 的默认值），上传路由在**路由级**放宽到
    // `UPLOAD_BODY_LIMIT`（见 `routes/documents.ts`）—— 这条"按需放宽"是 P0-1-4 埋下的
    // 待办（当时注释写着"待 P0-1-16 落地时改为上传路由单独放宽、其余端点收紧"）。
    // 副作用说明：路由未被匹配到时（404）仍按全局上限走，故一个超大 body 打向不存在的
    // 路径会得到 413 而不是 404 —— 两种都是 4xx，且这张"面"比"任意端点都能吃 100MB"小得多。
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    // 部署形态是「网关 → 后端」（`02` §十二），信任 X-Forwarded-* 才能拿到真实客户端 IP
    trustProxy: true,
  })

  // ① 校验器 + 错误出口（必须在注册路由之前；它同时也挂 404 兜底）
  installErrorHandler(app)

  // ② 请求上下文：把 requestId 装进 AsyncLocalStorage，
  //    之后 handler / 服务层 / SSE 流内调 getLogger() 都自动带上（`02` §十三）
  app.addHook('onRequest', (request, reply, done) => {
    enterRequestContext(request)
    // 响应头回带 requestId：前端报错日志能与后端日志直接对齐（不依赖网关）
    void reply.header('x-request-id', request.id)
    done()
  })

  // ③ 会话：`@fastify/cookie`（onRequest 解析 Cookie）+ `requireAuth`/`requireAdmin` 装饰器 +
  //    `request.auth`（`02` §十 安全设计）。必须在路由前装好 —— 路由的 preHandler 直接用装饰器。
  installSession(app)

  // ④ 首登强制改密闸门（P0-1-7；`02` §4.1 注记）：根级 preHandler，拦「除 /auth/{login,logout,me,password}
  //    之外的所有 /api/**」。挂在根上是刻意的 —— 逐个业务路由去挂迟早会漏一个，而漏掉的就是缺口。
  installPasswordChangeGate(app)

  // ⑤ 访问日志：默认那两条（incoming/request completed）已关掉，这里只留一条带耗时的，
  //    用 request.log 是为了尊重路由级 logLevel（如 /health 设为 warn，不打点也不刷屏）
  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      { method: request.method, url: request.url, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) },
      '请求完成',
    )
    done()
  })

  // ⑥ CORS：Cookie 会话 + 前后端分域部署（`02` §十、`06` §二·补）
  //    - 显式白名单（CORS_ORIGINS）；未配置时反射请求 Origin（开发期便利，生产由 config 告警）
  //    - credentials 必须为 true，否则跨域下浏览器不带 Cookie
  void app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    // 预检结果缓存 10 分钟（减少 OPTIONS 往返；P1 若加自定义头需同步 allowedHeaders）
    maxAge: 600,
  })

  // ⑦ multipart（P0-1-16 的文档上传）。
  //    · 该插件用 `fastify-plugin` 包装 ⇒ 装饰器（`request.file()`）落在**根**实例上，
  //      本文件里直接注册的路由都能用（否则会被封装作用域挡住，这是最容易踩的一次）。
  //    · `files: 1`：本接口只接一个文件；给 2 个文件时插件抛 `FST_FILES_LIMIT`（413），
  //      比"静默只取第一个、剩下不消费导致连接悬挂"好得多。
  //    · `fileSize`：与路由级 `bodyLimit` 双保险 —— 前者管**流式**（分块传输、没有
  //      Content-Length 时 Fastify 的 bodyLimit 拦不住），后者管声明了长度的常规请求。
  void app.register(multipart, {
    limits: {
      fileSize: config.limits.uploadBodyLimitBytes,
      files: 1,
      fields: 8,
      parts: 16,
    },
  })

  // ⑦ 路由（`/api/auth/*` P0-1-7、`/api/users/*` P0-1-8、`/api/model-providers/*` P0-1-10；
  //    其余业务路由按批次逐个加）
  registerHealthRoutes(app)
  registerAuthRoutes(app)
  registerUserRoutes(app)
  registerModelProviderRoutes(app)
  registerModelRoutes(app)
  // ⑧ 知识库（P0-1-15）。注意权限是**登录即可**（`03` §25：`/knowledge` 的权限列是「登录」，
  //    与 `/admin/*` 不同）—— 路由内部一个 `requireAdmin` 都没有，这是刻意的。
  registerKnowledgeBaseRoutes(app)
  // ⑨ 知识库文档（P0-1-16）。权限与知识库一致（登录即可），上传走 multipart。
  //    端点数按批次增长：本批只有上传；reupload/retry/delete 在 P0-1-19，列表/下载在 P0-1-21。
  registerDocumentRoutes(app)
  // ⑩ 智能体（P0-1-22）。权限**不是 ADMIN**：全员可建可看可用，编删由服务层按
  //     `01` 决策 18（创建者 + ADMIN）做成**行级**判定 —— 路由只挂 `requireAuth`，
  //    一个 `requireAdmin` 都没有（与模型池那一族刻意相反，理由见 routes/agents.ts 文件头）。
  registerAgentRoutes(app)
  // ⑪ 会话（P0-1-25）。权限是**仅创建者本人**（`conversations.user_id`）—— 与会话相关的一切
  //    都只挂 `requireAuth`，判据落在服务层查询的 `where` 里（连 ADMIN 也不开后门，
  //    理由见 routes/conversations.ts 文件头）。注意其中一条挂在前缀 `/api/agents/:id/conversations`
  //    （某智能体的会话列表）—— 它读的是 conversations 表，故归属本文件而不是 routes/agents.ts。
  //    P0-1-26 起同一个文件里多了 `POST /:id/chat`（SSE，走 `orchestrator/sse.ts`：
  //    互斥锁 + 心跳 + 停止信号；**handler 内会 hijack 响应**，故它不返回信封）
  //    与 `POST /:id/stop`（写停止信号）。
  registerConversationRoutes(app)
  // ⑫ MCP server 注册（P0-2-2）。权限是**登录即可**（`06` §4.2 的第五族，最接近知识库）——
  //    这里一个 `requireAdmin` 都没有，且路由/服务层都**刻意不做**"只有创建者能改删"的收窄
  //    （`mcp_servers.created_by` 只作**留痕**，理由见 routes/mcpServers.ts 文件头）。
  registerMcpServerRoutes(app)
  // ⑬ MCP **用户级凭据**（P0-2-4）。同样是"登录即可"，但收窄**不在角色上、在 `user_id` 上**：
  //    只能读写自己的那一份，ADMIN 也没有后门（`06` §4.2 的第四族，与 conversations 同源）。
  //    ⚠️ 它与隔壁 ⑫ **并排**注册、权限却不同族 —— 差别写在 routes/mcpCredentials.ts 文件头。
  registerMcpCredentialRoutes(app)
  // ⑭ 产物（P0-3-9）：列表挂在 `/api/conversations/:id/artifacts`（产物属会话）、下载挂在
  //    `/api/artifacts/:id/download`，两条**刻意同一个文件**（共用一条归属判据，理由见
  //    routes/artifacts.ts 文件头）。权限是**仅本人**（产物 → 会话 → `conversations.user_id`），
  //    与知识库文档下载那条"登录即可"**刻意不同** —— 照抄它就漏掉归属校验。
  //    ⚠️ 下载是本仓**第三个**不套信封的端点（字节流 / 失败才信封），客户端按响应形状分支。
  registerArtifactRoutes(app)
  // ⑮ 文件附件（P1-4）：上传（multipart）/ 取内容（字节流）。上传登录即可，
  //    取内容是**仅本人**（`files.uploader_id`）—— 与会话/产物同族。
  registerFileRoutes(app)
  // ⑯ 任务中心（P1-6，2026-10-09 需求变更：**定时任务**）：`/api/tasks` 五条（列表 / 建 / 改 /
  //    删 / 立即执行）。权限与会话同族（**仅本人**，`scheduled_tasks.user_id`）；
  //    到点自动派活的后台调度器是**进程级组件**，归 `index.ts` 生命周期，不在这里注册。
  registerTaskRoutes(app)

  // ⑰ 用量统计（P1-7）：`GET /api/usage/summary`（**仅 ADMIN**，`(A)` 族）。
  //    数据源 `usage_records`（P0-3-12 上线、P1-7 起 ChatBot 也写）。它是平台级报表，
  //    与"会话/产物/任务仅本人"刻意相反 —— 普通用户看自己的 token 走消息历史。
  registerUsageRoutes(app)

  return app
}
