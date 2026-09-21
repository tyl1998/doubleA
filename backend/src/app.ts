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
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify'

import { config } from './config.js'
import { enterRequestContext, genReqId, logger } from './infra/logger.js'
import { installErrorHandler } from './plugins/errorHandler.js'
import { installPasswordChangeGate, installSession } from './plugins/session.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerUserRoutes } from './routes/users.js'

/**
 * 监听地址：容器/内网部署要能从他机访问（`02` §十二），故不锁 `127.0.0.1`。
 * 本机开发若不希望暴露到局域网，用 `HOST=127.0.0.1`（P0-1-4 暂不加变量，先写死默认值）。
 */
export const DEFAULT_HOST = '0.0.0.0'

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
    // 上传（P0-1-16 的 multipart）要走 100MB 级 body，全局上限必须 ≥ UPLOAD_BODY_LIMIT，
    // 否则 Fastify 默认的 1MB 会先把大文件拒掉。副作用是 JSON 端点也放宽到同一上限 ——
    // 待 P0-1-16 落地时改为「上传路由单独放宽、其余端点收紧」，见 issue_fix 记录。
    bodyLimit: config.limits.uploadBodyLimitBytes,
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

  // ⑦ 路由（`/api/auth/*` 从 P0-1-7 起、`/api/users/*` 从 P0-1-8 起；业务路由按批次逐个加）
  registerHealthRoutes(app)
  registerAuthRoutes(app)
  registerUserRoutes(app)

  return app
}
