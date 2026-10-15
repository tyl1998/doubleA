/**
 * 产物路由（P0-3-9 列表 + 下载；**P0-3-10 增 `/content` 预览**）
 *
 * 依据：`docs/02-后端设计.md` §4.8（`/api/conversations/:id/artifacts`、
 *      `/api/artifacts/:id/download`、`/api/artifacts/:id/content`）+ §四（信封 / offset-limit 分页）
 *      + §4.9（不套信封的端点）+ `docs/子方案/文件预览.md` §三/§四（两条出口、后端代理、
 *      归属校验、响应头分派）+ §五/§六（五种格式与六条安全判据）
 *      + `docs/06-实施计划.md` §五 P0-3-9 / P0-3-10 行
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
 * ⚠️ **不套信封**的端点在产物族里有**三条**（`02` §4.9 的"恰好两个"自 P0-3-10 起读作"三个"；
 * P1-16 加 `/render` 后为**四个**，见 `子方案④` 版本记录）：
 * ─────────────────────────────────────────────────────────────────────
 * 文档下载、产物下载、产物预览（`/content`）、**产物渲染预览（`/render`，P1-16）**。
 * 成功 = **字节流 / HTML**；失败（404 / 400 / 500）= **标准 JSON 信封** ⇒ 客户端按**响应形状**
 * （`content-type` 是不是 `application/json`）分支，不按状态码（P0-1-35 已定案，前端
 * `api/client.ts#requestBlob` 就是这个）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 下载与预览是**两条出口**，不是一个端点加一个参数（`子方案④` §三 1）
 * ─────────────────────────────────────────────────────────────────────
 * `attachment`（下载）= "别解释它、存下来"；`inline`（预览）= "当文档渲染它、并且必须带上隔离头"。
 * 两者绑定的**隔离强度不同**，把它们合成 `?disposition=` 会把安全策略变成调用方可选的参数
 * ⇒ 由 **URL** 决定的策略才是可审计的策略。两条共用同一个取流函数（`openArtifactSource`）
 * 与同一条归属判据，差的只有 {@link previewHeadersFor} 那一组响应头。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import type { Readable } from 'node:stream'

import {
  AppError,
  artifactIdParamsSchema,
  ARTIFACT_PREVIEW_MAX_INLINE_BYTES,
  batchDeleteArtifactsBodySchema,
  conversationIdParamsSchema,
  listArtifactsQuerySchema,
  listMyArtifactsQuerySchema,
  ok,
  previewKindOf,
  type ArtifactIdParams,
  type BatchDeleteArtifactsBody,
  type ConversationIdParams,
  type ListArtifactsQuery,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { getLogger } from '../infra/logger.js'
import { requireAuthContext } from '../plugins/session.js'
import {
  artifactDownloadContentType,
  deleteArtifact,
  deleteArtifacts,
  listArtifacts,
  listMyArtifacts,
  openArtifactSource,
} from '../services/artifact.service.js'
import { renderDocxToHtml } from '../services/docxPreview.js'
import { buildContentDisposition } from '../services/document.service.js'
import { HTML_PREVIEW_CSP, previewHeadersFor } from '../services/previewHeaders.js'
import { parseXlsx, renderXlsxToHtml } from '../services/xlsxPreview.js'

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
 * 把一个流读进内存（**带上限**）—— `/render` 出口专用。
 *
 * ⚠️ 为什么要有上限：转换（mammoth）必须拿到完整 buffer，而无上限地读一个 50MB 的产物会让
 * 一个预览请求吃掉 50MB 堆。上限取 `ARTIFACT_PREVIEW_MAX_INLINE_BYTES`（与前端同一个闸门常量，
 * 前后端同源）—— 超了直接抛 400，而不是先读进来再说。
 */
async function readStreamCapped(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > maxBytes) throw AppError.validation('文件较大，无法在线渲染预览，请下载查看')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
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
   * 会话产物（`GET /api/artifacts`，**跨会话汇总本人全部产物**）。
   *
   * 「删了会话之后产物还在」的唯一出口也在这里：删会话只把产物行的 `conversation_id` 置空
   * （`TaskAgent记忆与产物` 块 3），产物行本身保留 ⇒ 仍会出现在本列表里。
   *
   * 判据是 `user_id = me`（产物行自建行起带归属用户，`conversationId` 置空后它仍是
   * "这是**我的**"的唯一答案）—— 与"产物 → 会话 → 本人"那条老判据**刻意不同**：
   * 跨会话清单没有单一的会话可 join。别人的产物仍然查不到（`where` 里带 `userId`）。
   *
   * ⚠️ **静态段与参数段的关系**：`/api/artifacts` 与 `/api/artifacts/:id/download`
   * 同前缀 —— 本集合路由无路径参数，`:id` 那两条有 uuid 校验，互不干扰。
   */
  app.get<{ Querystring: ListArtifactsQuery }>(
    '/api/artifacts',
    { preHandler: app.requireAuth, schema: { querystring: listMyArtifactsQuerySchema } },
    async (request) => ok(await listMyArtifacts(userIdOf(request), request.query)),
  )

  /**
   * 删除产物（`DELETE /api/artifacts/:id`，仅本人；**会话产物列表的删除动作**）。
   *
   * 真删除：S3 对象与 `artifacts` 行一并移除（与保留期清理同款顺序：先删对象、成功才删行）。
   * 归属判据在服务层的 `where`（`userId = me`）⇒ 别人的产物与不存在的 id 都是 **404**。
   *
   * ⚠️ 与"删除会话"刻意不同：删会话只把产物行 `conversation_id` 置空、产物转历史保留；
   * 本端点才是"用户明确不要这条产物"的出口。
   */
  app.delete<{ Params: ArtifactIdParams }>(
    '/api/artifacts/:id',
    { preHandler: app.requireAuth, schema: { params: artifactIdParamsSchema } },
    async (request) => {
      await deleteArtifact({ artifactId: request.params.id, userId: userIdOf(request) })
      return ok(null)
    },
  )

  /**
   * 批量删除产物（`POST /api/artifacts/batch-delete`，仅本人；**会话产物列表的批量删除动作**）。
   *
   * 与上面那条单条删除**同一条判据、同一套顺序**（真删除：先删对象、成功才删行），只是把
   * "一个 id"换成"一组 id"（`body.ids`）。**用 POST 而不是带 body 的 DELETE**：见
   * `shared#batchDeleteArtifactsBodySchema`（一部分代理会丢掉 DELETE 的 body，那样就是
   * "删了 0 个却报成功"的静默失败）。
   *
   * ⚠️ ids 里混进别人的产物 / 不存在的 id **被静默忽略**（不是 404）：批量操作不该被一条
   * 越权或脏数据卡死整批；真正删掉的条数由响应的 `deleted` 如实回报。
   *
   * ⚠️ 与"删除会话"刻意不同（同单条删除）：删会话只把产物行 `conversation_id` 置空、
   * 产物转历史保留；本端点才是"用户明确不要这些产物"的出口。
   */
  app.post<{ Body: BatchDeleteArtifactsBody }>(
    '/api/artifacts/batch-delete',
    { preHandler: app.requireAuth, schema: { body: batchDeleteArtifactsBodySchema } },
    async (request) => {
      const deleted = await deleteArtifacts({
        artifactIds: request.body.ids,
        userId: userIdOf(request),
      })
      return ok({ deleted })
    },
  )

  /**
   * 下载产物（`02` §4.8 + `子方案④` §三）：`attachment` + **字节流**，是**后端代理**不是签名 URL。
   *
   * 四个头各有理由：
   *   · `Content-Disposition: attachment` + RFC 6266/5987 **双写**（`01` §四 明文要求下载强制
   *     `attachment`；中文名靠 `filename*`，CR/LF 与引号/路径分隔符由
   *     {@link buildContentDisposition} 剔除 —— 那既是**响应头注入**防护，也把容器内的相对路径
   *     （`out/report.csv`）变成客户端能存的单个文件名）；
   *   · `Content-Type` 取自 `artifacts.mime`（见 {@link artifactDownloadContentType}）；
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
        .header('content-type', artifactDownloadContentType(source.mime))
        .header('content-length', String(source.contentLength))
        .header('content-disposition', buildContentDisposition(source.fileName))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(source.body)
    },
  )

  /**
   * 预览产物（`02` §4.8 + `子方案④` §三/§四；**P0-3-10**）：`inline` + **字节流**，同样是后端代理。
   *
   * ★ **与 `/download` 的关系**：同一个取流函数、同一条归属判据、同样不套信封，
   * 差别**只**在 {@link previewHeadersFor} 那一组头（形态 + 隔离头 + `Content-Type` 的收窄）。
   * ⇒ 别在这里另写一个"取对象"的实现（`06` P0-3-9 详规传下来的口径）。
   *
   * 五个头各自承担什么：
   *   · `Content-Type`：**按形态分派**（`text` 一律压成 `text/plain`、HTML/SVG 补 `charset`、
   *     `none` 回 `octet-stream`）—— 它的**唯一来源仍是 `artifacts.mime`**，只是按判据收窄；
   *   · `Content-Security-Policy: sandbox …`：**只有 HTML/SVG 那一路有**；
   *   · `Content-Disposition: inline`：⭐ **这一条是"预览"这个出口的定义** —— 套用 `01` §四
   *     "下载强制 `attachment`"会把预览整条废掉（`<iframe>`/`<img>` 取到的是一份"另存为"的响应）；
   *     两句话说的是**两个出口**（`子方案④` §六 判据 ⑥）；
   *   · `X-Content-Type-Options: nosniff`：**每一路都要有**；
   *   · `Cache-Control: private, no-store`：与下载同款理由（代理 URL 不带时效，靠"登录 + 归属"守住）。
   *
   * ⚠️ 前端**只在体积闸门通过时**才会打这个端点（闸门常量在 `shared`，前后端同源），
   * 但 URL 可以手敲 ⇒ 本端点不做体积判断（"大文件请求预览"只是慢，不是错）。
   * ⚠️ 不支持 Range（同 `/download`）⇒ 大 PDF 整份下载后才显示。
   */
  app.get<{ Params: ArtifactIdParams }>(
    '/api/artifacts/:id/content',
    { preHandler: app.requireAuth, schema: { params: artifactIdParamsSchema } },
    async (request, reply) => {
      const source = await openArtifactSource({
        artifactId: request.params.id,
        userId: userIdOf(request),
      })
      const headers = previewHeadersFor(source.mime)
      reply
        .header('content-type', headers.contentType)
        .header('content-length', String(source.contentLength))
        .header('content-disposition', buildContentDisposition(source.fileName, { disposition: headers.disposition }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
      // ⚠️ CSP **只**给 HTML/SVG 那一路（PDF 加了会渲染不出来 —— 见 previewHeadersFor 的要点 ②）
      if (headers.csp !== null) reply.header('content-security-policy', headers.csp)
      return reply.send(source.body)
    },
  )

  /**
   * 渲染预览（P1-16）—— **OOXML 专用**（DOCX / XLSX）：服务端把二进制字节转成 HTML，再按 HTML 那套隔离头回。
   *
   * ★ **为什么是独立出口，而不是塞进 `/content`**：`/content` 是**字节代理** ——
   * 它的 `Content-Type` **唯一来源是 `artifacts.mime`**（判据 ⑤）。DOCX / XLSX 的原始字节是二进制 OOXML，
   * 把它们当 `text/html` 直出是错的、也不安全。所以"取原始字节"（`/content`）与"渲染成 HTML"
   * （本出口，`Content-Type` 来自**渲染产物**而非原始 mime）**必须是两条 URL**
   * （与 §三 1"两条出口不是一个端点加参数"同一条纪律）。
   *
   * ★ 转换器按形态分派（`previewKindOf`）：`docx` → `renderDocxToHtml`（mammoth）；
   * `xlsx` → `renderXlsxToHtml(parseXlsx(...))`（手写零依赖读取器）。两者产出的都是 HTML 文档。
   *
   * ★ 前端**只对 `previewKindOf(mime) ∈ {docx, xlsx}` 的产物**打这个端点（`artifactRenderUrl`），
   * 但 URL 可以手敲 ⇒ 这里按 mime **自己再判一次**：不是这两种形态一律 400。
   *
   * 归属判据复用 {@link openArtifactSource}（与下载 / 预览**同一条**，别人的产物 404）；
   * 隔离头复用 {@link HTML_PREVIEW_CSP}（文件头第 ① 条：响应头才是第一道，iframe 属性只是第二道）。
   */
  app.get<{ Params: ArtifactIdParams }>(
    '/api/artifacts/:id/render',
    { preHandler: app.requireAuth, schema: { params: artifactIdParamsSchema } },
    async (request, reply) => {
      const source = await openArtifactSource({
        artifactId: request.params.id,
        userId: userIdOf(request),
      })
      const kind = previewKindOf(source.mime)
      if (kind !== 'docx' && kind !== 'xlsx') {
        throw AppError.validation('该类型的产物没有在线渲染预览')
      }
      if (source.contentLength > ARTIFACT_PREVIEW_MAX_INLINE_BYTES) {
        throw AppError.validation('文件较大，无法在线渲染预览，请下载查看')
      }

      const bytes = await readStreamCapped(source.body, ARTIFACT_PREVIEW_MAX_INLINE_BYTES)
      let html: string
      try {
        html =
          kind === 'xlsx'
            ? renderXlsxToHtml(parseXlsx(bytes), source.fileName)
            : await renderDocxToHtml(bytes, source.fileName)
      } catch (error) {
        // 走到这里基本是"不是合法 OOXML"（损坏 / 改名 / 截断）。文案要覆盖"其实不是该格式"这种可能，
        // 而不是笼统一句"渲染失败"（与 `pipeline/parse/docx.ts` 的文案口径一致）。
        if (error instanceof AppError) throw error
        getLogger().warn({ err: error, artifactId: source.artifactId, kind }, 'OOXML 渲染失败')
        throw AppError.validation('无法解析该 Office 文档（可能已损坏，或被改名的其它格式），请下载后用本地工具打开')
      }

      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', HTML_PREVIEW_CSP)
        .header('content-disposition', buildContentDisposition(source.fileName, { disposition: 'inline' }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(html)
    },
  )
}
