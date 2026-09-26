/**
 * 产物路由（P0-3-9）：**列表 + 下载**
 *
 * 依据：`docs/02-后端设计.md` §4.8（`/api/conversations/:id/artifacts` 与
 *      `/api/artifacts/:id/download`）+ §四（信封 / offset-limit 分页）+ §4.9（不套信封的端点）
 *      + `docs/子方案/文件预览.md` §三/§四（两条出口、后端代理、归属校验、响应头分派）
 *      + `docs/06-实施计划.md` §五 P0-3-9 行
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件里两条端点的**路径前缀不同**，但仍放在同一个文件
 * ─────────────────────────────────────────────────────────────────────
 * 列表挂在 `/api/conversations/:id/…`（产物属会话），下载挂在 `/api/artifacts/:id/…`
 * （一旦拿到 `artifactId`，归属就由服务层自己判）。这不是"前缀不一致"的疏漏 ——
 * `子方案④` §四 1 明写这两条**落在同一个路由文件**，且它们共用同一个服务层
 * （`services/artifact.service.ts`）与同一条归属判据；分开到两个文件，那句判据就会长出两份。
 * 与 `routes/conversations.ts` 没有冲突：Fastify 按**完整路径**匹配，两条路径不同。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 权限：**仅本人**（产物 → 会话 → `conversations.user_id`），ADMIN 也无后门
 * ─────────────────────────────────────────────────────────────────────
 * 与知识库文档下载（**登录即可**）刻意不同 —— 照抄它就漏掉归属校验，详见服务层文件头判据一。
 * 别人的资源一律 **404**（不是 403）。路由层只挂 `requireAuth`，判据在服务层的 `where` 里。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 下载是**第三个**不套信封的端点（`02` §4.9 的"恰好两个"自此读作"三个"）
 * ─────────────────────────────────────────────────────────────────────
 * 成功 = **字节流**；失败（404 / 500）= **标准 JSON 信封** ⇒ 客户端按**响应形状**
 * （`content-type` 是不是 `application/json`）分支，不按状态码（P0-1-35 已定案，前端
 * `api/client.ts#requestBlob` 就是这个）。三个不套信封的端点：文档下载、产物下载、
 * 以及 P0-3-10 的产物预览（`/content`）。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import {
  artifactIdParamsSchema,
  conversationIdParamsSchema,
  listArtifactsQuerySchema,
  ok,
  type ArtifactIdParams,
  type ConversationIdParams,
  type ListArtifactsQuery,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import { listArtifacts, openArtifactSource } from '../services/artifact.service.js'
import { buildContentDisposition } from '../services/document.service.js'

/**
 * 取调用者 —— **只取 `id`**（会话族不按角色判权，见 `conversation.service.ts` 文件头 ①）。
 *
 * 用 `requireAuthContext` 而不是自己判 `request.auth === null`：每条路由都挂了 `app.requireAuth`，
 * 那个分支永远不会触发；而它同时兜住"有人忘了挂 preHandler"这种真实的接线错误。
 */
function userIdOf(request: FastifyRequest): string {
  return requireAuthContext(request).user.id
}

/**
 * 下载响应的 `Content-Type`：唯一来源是 `artifacts.mime`（`子方案④` §四 2 判据 ⑤）。
 *
 * 为什么**不**一律 `application/octet-stream`：那样"下载得到的类型"与"预览用的类型"就变成
 * 两个来源，出现"列表里是 CSV、下载头说是二进制"这种分叉（且没有任何一层会报错）。
 * 空串（理论上不会出现：`artifactMimeOf` 恒回 `octet-stream`）按 `octet-stream` 兜底。
 *
 * ⚠️ 与预览那一路（`P0-3-10`）**刻意不同源的那半边**：预览会把文本类一律压成
 * `text/plain`（"把 URL 贴进地址栏看到的是源码"），下载则给真实类型 ——
 * 因为 `attachment` 已经决定了"浏览器不会解释它"。
 */
function downloadContentType(mime: string): string {
  return mime.trim() === '' ? 'application/octet-stream' : mime.trim()
}

export function registerArtifactRoutes(app: FastifyInstance): void {
  /**
   * 产物列表（`02` §4.8；`03` §4.4 的"产物面板"在刷新后的数据源 —— 事件流只给**这一轮**的）。
   *
   * ⚠️ **它是"刷新后产物还在"的唯一出口**：`artifact` 事件只在生成的那一刻发一次，
   * 刷新页面后历史消息里的 `content.artifacts` 只覆盖**那一轮** —— 而"这个会话一共产出过
   * 哪些文件"要问这张表（产物不随消息走：`02` §三 明写产物不跟会话删除走、只由保留期清理收口）。
   *
   * 排序 = `created_at desc`（最近产出的在最上），分页 = offset/limit（`02` §四：除消息外一律）。
   */
  app.get<{ Params: ConversationIdParams; Querystring: ListArtifactsQuery }>(
    '/api/conversations/:id/artifacts',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, querystring: listArtifactsQuerySchema },
    },
    async (request) => ok(await listArtifacts(request.params.id, request.query, { id: userIdOf(request) })),
  )

  /**
   * 下载产物（`02` §4.8 + `子方案④` §三）：`attachment` + **字节流**，是**后端代理**不是签名 URL。
   *
   * 四个头各有理由：
   *   · `Content-Disposition: attachment` + RFC 6266/5987 **双写**（`01` §四 明文要求下载强制
   *     `attachment`；中文名靠 `filename*`，CR/LF 与引号/路径分隔符由
   *     {@link buildContentDisposition} 剔除 —— 那既是**响应头注入**防护，也把容器内的相对路径
   *     （`out/report.csv`）变成客户端能存的单个文件名）；
   *   · `Content-Type` 取自 `artifacts.mime`（见 {@link downloadContentType}）；
   *   · `X-Content-Type-Options: nosniff`：**每一路都要有**（`子方案④` §四 2）—— 缺了它，浏览器
   *     可能对 `application/octet-stream` 做内容嗅探，把引擎产出的文件当 HTML 跑起来；
   *   · `Cache-Control: private, no-store`：代理形态的 URL **不带时效**，靠"登录 + 归属"守住
   *     ⇒ 缓存副本会让"登出后同一浏览器还能打开"成立，那正是"链接不可分享"的另一半。
   *
   * ⚠️ **不支持 Range**（`子方案④` §八 2）⇒ 大文件整份下载后才显示；产物单文件 ≤ `ARTIFACT_MAX_FILE_MB`。
   */
  app.get<{ Params: ArtifactIdParams }>(
    '/api/artifacts/:id/download',
    { preHandler: app.requireAuth, schema: { params: artifactIdParamsSchema } },
    async (request, reply) => {
      const source = await openArtifactSource({
        artifactId: request.params.id,
        userId: userIdOf(request),
      })
      return reply
        .header('content-type', downloadContentType(source.mime))
        .header('content-length', String(source.contentLength))
        .header('content-disposition', buildContentDisposition(source.fileName))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(source.body)
    },
  )
}
