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
 * ⚠️ **两条**都是不套信封的端点（`02` §4.9 的"恰好两个"自 P0-3-10 起读作"三个"：
 * ─────────────────────────────────────────────────────────────────────
 * 文档下载、产物下载、产物预览）
 * 成功 = **字节流**；失败（404 / 500）= **标准 JSON 信封** ⇒ 客户端按**响应形状**
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

import {
  artifactIdParamsSchema,
  conversationIdParamsSchema,
  listArtifactsQuerySchema,
  listMyArtifactsQuerySchema,
  ok,
  previewKindOf,
  type ArtifactIdParams,
  type ConversationIdParams,
  type ListArtifactsQuery,
  type PreviewKind,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import {
  artifactDownloadContentType,
  deleteArtifact,
  listArtifacts,
  listMyArtifacts,
  openArtifactSource,
} from '../services/artifact.service.js'
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
 * ★ HTML / SVG 的隔离头：`子方案④` §六 判据 ① 的**第一道**（iframe 属性只是第二道）。
 *
 * 为什么必须是**响应头**：iframe 的 `sandbox=""` 只在"被嵌进 iframe 时"生效 —— 用户在预览弹层里
 * 右键"在新标签页打开"、或直接把 `/content` 贴进地址栏，那份文档就**不在 iframe 里**了，
 * 此时唯一还在生效的就是这一行。CSP `sandbox` 对 standalone document 同样生效，
 * 而且它**不支持 `<meta>`**（MDN 明文）⇒ 只可能来自响应头 —— 这也是产物预览走**后端代理**
 * 而不是签名 URL 的那条决定性理由（签名 URL 的响应由对象存储直发，我们一个头都加不上）。
 *
 * `default-src 'none'` + `img-src data:` + `style-src 'unsafe-inline'`：
 * 不给脚本、不给网络（连同源的 `/api/...` 都不给，`default-src 'none'` 已经封死），
 * 只留内嵌图片与内联样式（HTML 产物里最常见、且无害的两种）。
 */
const HTML_PREVIEW_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"

/** 预览响应的 `Content-Disposition` 形态（`子方案④` §四 2 的最后一列） */
type PreviewDisposition = 'inline' | 'attachment'

/** 预览响应头里"随形态变化"的那三样（其余头两条端点完全一样） */
interface PreviewHeaders {
  contentType: string
  disposition: PreviewDisposition
  /** 只有 HTML/SVG 那一路有值（PDF **刻意不加**，见 {@link HTML_PREVIEW_CSP} 的对照说明） */
  csp: string | null
}

/** 取 `mime` 的主类型（`text/html; charset=utf-8` → `text/html`）—— 拼 `; charset=utf-8` 之前要先剥参数 */
function baseMimeOf(mime: string): string {
  const raw = mime.trim().toLowerCase()
  const semicolon = raw.indexOf(';')
  return (semicolon === -1 ? raw : raw.slice(0, semicolon)).trim()
}

/**
 * 预览响应的**响应头分派**：按 `artifacts.mime` 一处判据上不同的头（`子方案④` §四 2 的表）。
 *
 * 三条要点（都是"不写就会静默出错"的）：
 *
 *   ① ★ **`text` 一律回 `text/plain`**，不回它声明的类型：这样"有人把 `/content` URL 直接贴进
 *      地址栏"看到的是**源码**，而不是被浏览器当 `text/html` 渲染（前端取文本用 `fetch().text()`，
 *      与响应头无关，所以这个收窄对预览**没有代价**）；
 *   ② **PDF 刻意不加 CSP `sandbox`**：MDN 明确说 sandbox "prevents the execution of plugins"，
 *      而 PDF 的浏览器内置 viewer 属这一类 ⇒ 加了会**渲染不出来**（症状是空框或直接触发下载，
 *      看起来像"我们的 PDF 坏了"）。这一路的安全边界另写在 `子方案④` §五 6 —— 它是全方案
 *      **唯一一处把安全交给浏览器**的地方，写在此处而不是藏在代码注释里；
 *   ③ **`none`（zip / docx / 未知类型）当作下载处理**（`attachment` + `octet-stream`）：
 *      这个端点理论上不会被前端调用（前端不显示「预览」按钮），但 URL 是可以手敲的
 *      ⇒ 给它一份"不会被浏览器解释"的响应，而不是一份带 `inline` 的未知类型。
 */
function previewHeadersFor(mime: string): PreviewHeaders {
  const kind: PreviewKind = previewKindOf(mime)
  switch (kind) {
    case 'html':
      // SVG 归这一路（`previewKindOf` 已定案）：它是能带 `<script>` 的文档
      return { contentType: `${baseMimeOf(mime)}; charset=utf-8`, disposition: 'inline', csp: HTML_PREVIEW_CSP }
    case 'image':
      // `<img>` 上下文不执行脚本 ⇒ 不需要 CSP；但 `nosniff` 照样要（调用方统一加）
      return { contentType: baseMimeOf(mime), disposition: 'inline', csp: null }
    case 'pdf':
      return { contentType: 'application/pdf', disposition: 'inline', csp: null }
    case 'text':
      return { contentType: 'text/plain; charset=utf-8', disposition: 'inline', csp: null }
    default:
      return { contentType: 'application/octet-stream', disposition: 'attachment', csp: null }
  }
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
}
