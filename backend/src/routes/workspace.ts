/**
 * 工作区路由（P1-9 · P1）—— 人侧的树 / 读 / 写（CAS）/ 建 / 移 / 删
 *
 * 依据：`docs/子方案/Code模式工作区.md` §六 1（工作区 API，挂在**公网会话路由**，不是容器 listener）、
 *      §七 1 第 ③ 层（乐观 CAS）、§九（路径安全 / 越权 / 配额）、§十一（参数总表）；
 *      `docs/02-后端设计.md` §3.3（端点表）+ §四（信封 / 错误码）+ §4.9（不套信封的端点）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 权限：**仅本人**（会话 → `conversations.user_id`），ADMIN 无后门
 * ─────────────────────────────────────────────────────────────────────
 * 与会话 / 产物 / 任务同族。判据落在服务层查询 `where`（`assertWorkspaceOwner`），别人的会话与
 * 不存在的 id 一样是 **404**。路由层只挂 `requireAuth`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 多机下本章全部路由必须**粘性**（`子方案` §十六 A）
 * ─────────────────────────────────────────────────────────────────────
 * 工作区字节在**宿主本地盘**（非 PG/S3）⇒ 不能轮询到任意实例，否则会落到没有该工作区的机器上（丢改）。
 * 含将来的 `GET .../workspace/events`（SSE，watcher 进程内）。本批只有 P1 的六条同步路由。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ `/workspace/file/raw` 是本仓**第四个**不套信封的端点（字节流 / 失败才信封）
 * ─────────────────────────────────────────────────────────────────────
 * 与产物下载 / 预览同款：成功 = 字节流；失败 = 标准 JSON 信封 ⇒ 客户端按**响应形状**
 * （`content-type` 是不是 `application/json`）分支。它给二进制 / 大文件一个字节出口
 * （文本走 `GET .../file` 的 JSON 内联）。
 */

import { appMsg,
  AppError,
  conversationIdParamsSchema,
  ARTIFACT_PREVIEW_MAX_INLINE_BYTES,
  isWorkspaceTextMime,
  previewKindOf,
  normalizeWorkspacePath,
  ok,
  workspaceArtifactBodySchema,
  workspaceCreateFileBodySchema,
  workspaceChangesQuerySchema,
  workspaceEventsQuerySchema,
  workspaceFileDiffQuerySchema,
  workspaceMoveBodySchema,
  workspacePathQuerySchema,
  workspaceRevertBodySchema,
  workspaceWriteFileBodySchema,
  type ConversationIdParams,
  type WorkspaceArtifactBody,
  type WorkspaceChangesQuery,
  type WorkspaceCreateFileBody,
  type WorkspaceEventsQuery,
  type WorkspaceFileDiffQuery,
  type WorkspaceMoveBody,
  type WorkspacePathQuery,
  type WorkspaceRevertBody,
  type WorkspaceWriteFileBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { requireAuthContext } from '../plugins/session.js'
import { buildContentDisposition } from '../services/document.service.js'
import { renderDocxToHtml } from '../services/docxPreview.js'
import { HTML_PREVIEW_CSP, workspaceRawHeadersFor } from '../services/previewHeaders.js'
import { parseXlsx, renderXlsxToHtml } from '../services/xlsxPreview.js'
import { SSE_RESPONSE_HEADERS } from '../orchestrator/sse.js'
import { registerWorkspaceArtifact } from '../sandbox/index.js'
import {
  assertWorkspaceOwner,
  assertWorkspaceWriteRate,
  createWorkspaceFile,
  deleteWorkspaceDirectory,
  deleteWorkspaceFile,
  ensureWorkspace,
  getWorkspaceFileDiff,
  listWorkspaceChanges,
  listWorkspaceEventsAfter,
  listWorkspaceFiles,
  moveWorkspaceFile,
  openWorkspaceFileSource,
  readWorkspaceDirectoryZip,
  readWorkspaceFile,
  readWorkspaceGitRepos,
  readWorkspaceRetention,
  revertWorkspaceRound,
  serializeWorkspaceSseEvent,
  subscribeWorkspaceEvents,
  uploadWorkspaceFile,
  writeWorkspaceFile,
} from '../workspace/index.js'

/** 上传端点的文件字段（与附件 / 知识库上传同款，浏览器 `FormData` 用）；`dir` = 目标目录（可空 = 根） */
const WORKSPACE_UPLOAD_FILE_FIELD = 'file'
const WORKSPACE_UPLOAD_DIR_FIELD = 'dir'

/** 取调用者（会话族不按角色判权，只取 `id`；见 `routes/artifacts.ts#userIdOf`） */
function userIdOf(request: FastifyRequest): string {
  return requireAuthContext(request).user.id
}

/** 人侧写入统一以 `USER` 身份落痕（`actorId` = userId） */
function userAuthor(userId: string): { actor: 'USER'; actorId: string } {
  return { actor: 'USER', actorId: userId }
}

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  /** 文件树（DB 索引查询） */
  app.get<{ Params: ConversationIdParams }>(
    '/api/conversations/:id/workspace',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema } },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      return ok(await listWorkspaceFiles(request.params.id))
    },
  )

  /**
   * 工作区 **git 概况**（`GET /api/conversations/:id/workspace/git`，P1-9 · 补充）。
   *
   * 只回"有哪些仓库 + 各自在哪个分支"（**读 `.git/HEAD`，不调 git 二进制**，见 `workspace/git.ts`）。
   * `repos: []` = 这个工作区没有 git ⇒ 前端**不渲染**分支 chip（而不是显示一个空标签）。
   * 只读、不写库、不拿锁：失败一律按"没有 git"处理，不让面板因为这件事报错。
   */
  app.get<{ Params: ConversationIdParams }>(
    '/api/conversations/:id/workspace/git',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema } },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      return ok({ repos: await readWorkspaceGitRepos(request.params.id) })
    },
  )

  /**
   * 工作区**保留期与到期保护提示**（`GET /api/conversations/:id/workspace/retention`，2026-10-28）。
   *
   * ★ 2026-10-28（用户反馈「NGPOS 星礼包会话生成的 docx 没了」）：清理原来是**静默真删**，
   *   用户删完才发现。这条端点让面板能**提前**说清"这个工作区还有几天清理、有没有被保护"。
   *
   * 只读判据（与 `workspace/reaper` 的 `retentionGuard` 同一套）：
   *   · `expiresAt` = `workspaces.updated_at + retentionDays`（工作区**内容**最后一次变动的时刻起算）；
   *   · `protected` = 有未过期产物 / 有保护期内的用户手写 ⇒ 到期也**不会**被清；
   *   · `artifactCount` = 该会话仍在保留期内的产物数（交付物，不随工作区回收消失）。
   */
  app.get<{ Params: ConversationIdParams }>(
    '/api/conversations/:id/workspace/retention',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema } },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      return ok(await readWorkspaceRetention(request.params.id))
    },
  )

  /**
   * 轮末**变更集**（`GET /api/conversations/:id/workspace/changes?since=<iso>`，P4）。
   * 回 `[since, now]` 窗口内动过的路径各一条（最新状态），按时间倒序。`since` 缺省 = 全量。
   *
   * ★ P1-24 / 2026-10-28（用户定案「git 拉下来的不算」）：
   *   "clone / pull 的初始填充"由 **`listWorkspaceChanges` 在数据层**剔除
   *   （`excludeRepositoryImports: true`，判据 = `sandbox/gitArtifacts#filterGitCleanPaths`，
   *   与产物收集同源）。这里只做**转发**，不再自己跑一遍 git —— 两处各写一份迟早会分叉，
   *   而且原来那条 try/catch 一旦 git 失败就整份退回几千条，等于过滤没生效。
   */
  app.get<{ Params: ConversationIdParams; Querystring: WorkspaceChangesQuery }>(
    '/api/conversations/:id/workspace/changes',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, querystring: workspaceChangesQuerySchema },
    },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      return ok(
        await listWorkspaceChanges(request.params.id, request.query.since, {
          excludeRepositoryImports: true,
        }),
      )
    },
  )

  /**
   * 文件**行级差异**（`GET .../workspace/file/diff?path=…&baseVersion=…&stats=1`，P1-9 · 验收标记）。
   *
   * 「最近变更」里"哪个文件变了"之外的下一问：**改了什么**。旧字节取自历史字节存储（覆盖/删除前
   * 自动存档）；`stats=1` 只回 `+N −M` 计数（列表徽标用），不带逐行内容。
   */
  app.get<{ Params: ConversationIdParams; Querystring: WorkspaceFileDiffQuery }>(
    '/api/conversations/:id/workspace/file/diff',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, querystring: workspaceFileDiffQuerySchema },
    },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      const { path, baseVersion, stats, roundBase, toVersion } = request.query
      return ok(
        await getWorkspaceFileDiff(
          request.params.id,
          path,
          baseVersion,
          stats === 1,
          roundBase === 1,
          toVersion,
        ),
      )
    },
  )

  /**
   * 「撤销本轮」（`POST /api/conversations/:id/workspace/revert`，P4 · R2；2026-10-28 重做）。
   *
   * 把**这一段**（与「最近变更」同一段划分）内 agent 的写入按回滚点 CAS 回写。
   * **范围** `scope`：`AGENT_ONLY`（默认，只撤 agent 覆盖过的）/ `ALL`（含用户手写）/
   * `SELECTED`（逐条勾选 `paths`）。用户手写收尾的路径在默认范围下**故意不动**。
   * `dryRun=true` = 只算不写，并回 `preview`（会还原 / 会删除 / 会跳过 三栏）。
   */
  app.post<{ Params: ConversationIdParams; Body: WorkspaceRevertBody }>(
    '/api/conversations/:id/workspace/revert',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, body: workspaceRevertBodySchema },
    },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      const { since, until, dryRun, scope, paths } = request.body
      return ok(
        await revertWorkspaceRound(request.params.id, {
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
          ...(dryRun === undefined ? {} : { dryRun }),
          ...(scope === undefined ? {} : { scope }),
          ...(paths === undefined ? {} : { paths }),
        }),
      )
    },
  )

  /** 读文件（文本内联 `text`；二进制 / 大文件 `text: null`，改走 `/file/raw`） */
  app.get<{ Params: ConversationIdParams; Querystring: WorkspacePathQuery }>(
    '/api/conversations/:id/workspace/file',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema, querystring: workspacePathQuerySchema } },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      return ok(await readWorkspaceFile(request.params.id, request.query.path))
    },
  )

  /**
   * 读文件字节（二进制 / 大文件的出口）。
   * ⚠️ **不套信封**（见文件头）；响应头复用 `previewHeadersFor` 分派（HTML/SVG 带 CSP 隔离）。
   */
  app.get<{ Params: ConversationIdParams; Querystring: WorkspacePathQuery }>(
    '/api/conversations/:id/workspace/file/raw',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema, querystring: workspacePathQuerySchema } },
    async (request, reply) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      const source = await openWorkspaceFileSource(request.params.id, request.query.path)
      const headers = workspaceRawHeadersFor(source.mime, isWorkspaceTextMime(source.mime))
      reply
        .header('content-type', headers.contentType)
        .header('content-length', String(source.size))
        .header('content-disposition', buildContentDisposition(source.path, { disposition: headers.disposition }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
      if (headers.csp !== null) reply.header('content-security-policy', headers.csp)
      return reply.send(source.body)
    },
  )

  /**
   * 渲染预览（`GET .../workspace/file/render?path=`，2026-10-30）—— **OOXML 专用**（DOCX / XLSX）。
   *
   * ★ 与产物那条 `GET /api/artifacts/:id/render` 是同一件事、同一套转换器
   * （`renderDocxToHtml` / `renderXlsxToHtml`），只是取字节的来源不同：产物在 S3、工作区在宿主盘。
   *
   * ★ **为什么必须另开一条出口，而不是让 `/file/raw` 直接回 HTML**：`/raw` 是**字节代理**，
   * `Content-Type` 的唯一来源是索引里的 `mime`（二进制 OOXML）⇒ 把它当 `text/html` 直出不安全。
   * "取原始字节"与"渲染成 HTML"是两件事，必须是两条 URL（同产物预览那条的纪律）。
   *
   * ★ 前端只对 `previewKindOf(mime) ∈ {docx, xlsx}` 打这个端点，但 URL 可以手敲 ⇒ 按 mime
   * **自己再判一次**，不是这两种形态一律 400。体积闸门同样复用 `ARTIFACT_PREVIEW_MAX_INLINE_BYTES`
   * （与前端同一个常量，前后端同源）；`/raw` 没有这条闸门（它是流式的），这里必须先拦。
   */
  app.get<{ Params: ConversationIdParams; Querystring: WorkspacePathQuery }>(
    '/api/conversations/:id/workspace/file/render',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema, querystring: workspacePathQuerySchema } },
    async (request, reply) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      const source = await openWorkspaceFileSource(request.params.id, request.query.path)
      const kind = previewKindOf(source.mime)
      if (kind !== 'docx' && kind !== 'xlsx') {
        throw AppError.validation(appMsg('app.m090'))
      }
      if (source.size > ARTIFACT_PREVIEW_MAX_INLINE_BYTES) {
        throw AppError.validation(appMsg('app.m019'))
      }

      let html: string
      try {
        html =
          kind === 'xlsx'
            ? renderXlsxToHtml(parseXlsx(source.body), source.path)
            : await renderDocxToHtml(source.body, source.path)
      } catch (error) {
        // 走到这里基本是"不是合法 OOXML"（损坏 / 改名 / 截断）—— 与产物那条同口径。
        if (error instanceof AppError) throw error
        getLogger().warn({ err: error, path: source.path, kind }, '工作区 OOXML 渲染失败')
        throw AppError.validation(appMsg('app.m091'))
      }

      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', HTML_PREVIEW_CSP)
        .header('content-disposition', buildContentDisposition(source.path, { disposition: 'inline' }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(html)
    },
  )

  /**
   * 「按目录下载为 zip」（`GET .../workspace/dir/zip?path=`，2026-10-29）。
   *
   * 目录行右键用它：把该目录（含子孙）下的**已索引文件**打成 zip 一次下载。只读；依赖目录 /
   * 隐藏目录本就不在索引里，天然不进包。文件数超 `WORKSPACE_ZIP_MAX_FILES` ⇒ 413（`app.m284`）。
   * ⚠️ 与 `/file/raw` 同族：**不套信封**（成功 = 字节流；失败 = 标准 JSON 信封）。
   */
  app.get<{ Params: ConversationIdParams; Querystring: WorkspacePathQuery }>(
    '/api/conversations/:id/workspace/dir/zip',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema, querystring: workspacePathQuerySchema } },
    async (request, reply) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      const zip = await readWorkspaceDirectoryZip(request.params.id, request.query.path)
      reply
        .header('content-type', 'application/zip')
        .header('content-length', String(zip.body.byteLength))
        .header('content-disposition', buildContentDisposition(zip.fileName, { disposition: 'attachment' }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
      return reply.send(zip.body)
    },
  )

  /**
   * 保存文件（`baseVersion` CAS）。冲突返回 **409**（`AppError.conflict`，`data` 带 `currentVersion`）。
   */
  app.put<{ Params: ConversationIdParams; Querystring: WorkspacePathQuery; Body: WorkspaceWriteFileBody }>(
    '/api/conversations/:id/workspace/file',
    {
      preHandler: app.requireAuth,
      schema: {
        params: conversationIdParamsSchema,
        querystring: workspacePathQuerySchema,
        body: workspaceWriteFileBodySchema,
      },
    },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      await assertWorkspaceWriteRate(request.params.id)
      return ok(
        await writeWorkspaceFile(
          request.params.id,
          request.query.path,
          request.body.content,
          request.body.baseVersion,
          userAuthor(userId),
        ),
      )
    },
  )

  /** 新建文件（已存在即 409） */
  app.post<{ Params: ConversationIdParams; Body: WorkspaceCreateFileBody }>(
    '/api/conversations/:id/workspace/file',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema, body: workspaceCreateFileBodySchema } },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      await assertWorkspaceWriteRate(request.params.id)
      return ok(await createWorkspaceFile(request.params.id, request.body.path, request.body.content, userAuthor(userId)))
    },
  )

  /**
   * 上传文件到指定目录（`POST /api/conversations/:id/workspace/upload`，multipart）。
   *
   * 字段：`file`（唯一文件，字段名同附件 / 知识库）+ 可选 `dir`（目标目录，空 = 根）。
   * 落点 = `dir/<上传文件名>`（都由 `normalizeWorkspacePath` 归一化 + 越界判据）。
   * ⚠️ 与文本写接口**刻意不同**：这里允许二进制落地（`allowBinary`）—— 上传是显式意图，
   *    读取侧对二进制本就只读预览 / 下载（§九）。配额（单文件 / 文件数 / 总字节）照旧判定。
   */
  app.post<{ Params: ConversationIdParams }>(
    '/api/conversations/:id/workspace/upload',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema },
      bodyLimit: config.limits.uploadBodyLimitBytes,
    },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      await assertWorkspaceWriteRate(request.params.id)

      let uploaded: { fileName: string; bytes: Buffer } | undefined
      let dir = ''
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const bytes = await part.toBuffer()
          if (part.file.truncated) throw AppError.validation(appMsg('app.m110', { p0: part.filename || WORKSPACE_UPLOAD_FILE_FIELD }))
          if (uploaded !== undefined) throw AppError.validation(appMsg('app.m111'))
          uploaded = { fileName: part.filename, bytes }
        } else if (part.fieldname === WORKSPACE_UPLOAD_DIR_FIELD) {
          dir = String(part.value ?? '')
        }
      }
      if (uploaded === undefined) {
        throw AppError.validation(appMsg('app.m020', { p0: WORKSPACE_UPLOAD_FILE_FIELD }))
      }
      if (uploaded.bytes.length === 0) {
        throw AppError.validation(appMsg('app.m010', { p0: uploaded.fileName || '未命名文件' }))
      }
      // 文件名只取末段（浏览器选择目录上传时可能带相对路径），再与目标目录拼成工作区相对路径
      const baseName = uploaded.fileName.split(/[\\/]/u).filter((seg) => seg !== '').pop() ?? uploaded.fileName
      const target = normalizeWorkspacePath(dir === '' ? baseName : `${dir}/${baseName}`)
      if (target === null) throw AppError.validation(appMsg('app.m112'), { path: dir })
      return ok(await uploadWorkspaceFile(request.params.id, target, uploaded.bytes, userAuthor(userId)))
    },
  )

  /**
   * 「上传至平台」—— 把一个**工作区文件**登记成产物（`POST .../workspace/artifact`，2026-10-29）。
   *
   * ★ 为什么有这个端点：Code 模式下**不再自动收产物**（`taskAgent.ts` ⑦ 前面的产物块：
   *   agent 动过的文件已经由工作区面板完整呈现，"哪些算产物"在那边不好定义）。要让某个文件进
   *   产物面板 / 会话产物 / 可下载清单，得由人**显式**点一次（文件树右键）—— 那是唯一的口径。
   *
   * 只传路径：字节从**工作区**读（同一台实例、同一份 canonical 字节），不经浏览器重传一遍；
   * 若文件已被删 / 超过单文件上限 ⇒ 409 / 413 由服务层给出（见 `registerWorkspaceArtifact`）。
   */
  app.post<{ Params: ConversationIdParams; Body: WorkspaceArtifactBody }>(
    '/api/conversations/:id/workspace/artifact',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, body: workspaceArtifactBodySchema },
    },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      const conversationId = request.params.id
      const { path } = request.body
      // 产物是**会话归属**的：`user_id` 直接取会话 owner（与 `collectRoundArtifacts` 同源）
      const handle = await ensureWorkspace(conversationId)
      const item = await registerWorkspaceArtifact({
        conversationId,
        userId,
        rootPath: handle.rootPath,
        path,
      })
      if (item === null) {
        throw AppError.validation(appMsg('app.m113', { p0: path }))
      }
      return ok(item)
    },
  )

  /** 改名 / 移动（目标已存在即 409） */
  app.post<{ Params: ConversationIdParams; Body: WorkspaceMoveBody }>(
    '/api/conversations/:id/workspace/move',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema, body: workspaceMoveBodySchema } },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      return ok(await moveWorkspaceFile(request.params.id, request.body.from, request.body.to, userAuthor(userId)))
    },
  )

  /** 删除文件（软删 + 墓碑；幂等） */
  app.delete<{ Params: ConversationIdParams; Querystring: WorkspacePathQuery }>(
    '/api/conversations/:id/workspace/file',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema, querystring: workspacePathQuerySchema } },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      return ok(await deleteWorkspaceFile(request.params.id, request.query.path, userAuthor(userId)))
    },
  )

  /**
   * 删除**文件夹（递归）**：把该目录下所有已索引文件一次软删（墓碑 + 各一条 `deleted` 事件），
   * 再把目录整份落盘删除（含未索引残留）。空目录/不存在按幂等成功回 `deleted: 0`。
   * 目标若是**文件**则回 400（请用上面的单文件删除，前端只对目录行提供本操作）。
   */
  app.delete<{ Params: ConversationIdParams; Querystring: WorkspacePathQuery }>(
    '/api/conversations/:id/workspace/dir',
    { preHandler: app.requireAuth, schema: { params: conversationIdParamsSchema, querystring: workspacePathQuerySchema } },
    async (request) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      return ok(await deleteWorkspaceDirectory(request.params.id, request.query.path, userAuthor(userId)))
    },
  )

  /**
   * 工作区**事件流**（`GET /api/conversations/:id/workspace/events`，SSE，P1-9 · P3）。
   *
   * 把"这份工作区正在发生什么"实时推给浏览器（agent 写 / 人写 / watcher 捕获的 bash 写），
   * 前端据此刷新文件树与编辑器（§六 2）。三条约定与 `/stream` 同族：
   *   · **仅本人**（`assertWorkspaceOwner`，别人的会话与不存在同 404）—— 在 hijack **之前**判完；
   *   · **只读**：不写库、不拿锁，只是转发（+ ping 心跳）；
   *   · **迟到者补发**：`?after=<headVersion>` = 上次看到的序号 ⇒ 先回放缺的事件（§六 2 的断线重连）。
   *
   * ⚠️ 实时通道是**进程内**的（watcher 所在进程）⇒ 多机下本路由**必须粘性**（§十六 A）。
   */
  app.get<{ Params: ConversationIdParams; Querystring: WorkspaceEventsQuery }>(
    '/api/conversations/:id/workspace/events',
    {
      preHandler: app.requireAuth,
      schema: { params: conversationIdParamsSchema, querystring: workspaceEventsQuerySchema },
    },
    async (request, reply) => {
      const userId = userIdOf(request)
      await assertWorkspaceOwner(request.params.id, userId)
      const conversationId = request.params.id

      // 补发（在 hijack 之前落定；`after` 缺省 = 只订阅不补发）
      const replay = request.query.after === undefined ? [] : await listWorkspaceEventsAfter(conversationId, request.query.after)

      reply.hijack()
      reply.raw.writeHead(200, SSE_RESPONSE_HEADERS)
      reply.raw.flushHeaders()

      let closed = false
      const write = (event: unknown): void => {
        if (closed) return
        try {
          reply.raw.write(serializeWorkspaceSseEvent(event))
        } catch {
          closed = true
        }
      }
      for (const event of replay) write(event)
      const unsubscribe = subscribeWorkspaceEvents(conversationId, write)
      const ping = setInterval(() => {
        if (closed) return
        try {
          reply.raw.write(': ping\n\n')
        } catch {
          closed = true
        }
      }, config.limits.ssePingIntervalSec * 1000)
      ping.unref()

      const cleanup = (): void => {
        if (closed) return
        closed = true
        clearInterval(ping)
        unsubscribe()
      }
      reply.raw.once('close', cleanup)
      reply.raw.once('error', cleanup)
    },
  )
}