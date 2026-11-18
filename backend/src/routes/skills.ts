/**
 * Skill 管理面路由（P1-24a-2）
 *
 * 依据：`docs/子方案/Skill能力.md` §5.1（API 清单）+ §5.3（权限）、`docs/02-后端设计.md` §三（`skills` 表）、
 *       `shared/src/skill.ts`（契约与投影）、`services/skillAsset.service.ts`（编排）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 十四条端点（**全部只需登录**；改 / 删 / 导入 / 转移 / fork / 同步由服务层行级判定 = 所属人或 ADMIN）
 * ─────────────────────────────────────────────────────────────────────
 *   GET    /api/skills                            列表（`offset/limit/query`）
 *   GET    /api/skills/:id                        详情（文件索引 + 版本 + 变更记录 + 引用数）
 *   PATCH  /api/skills/:id                        改元数据（名称 / 描述 / 可见范围）
 *   DELETE /api/skills/:id                        软删（被 Agent 绑定 ⇒ 409）
 *   POST   /api/skills                            新建（multipart：`file` = zip + 可选 runtime/name/description/visibility）
 *   POST   /api/skills/:id/import                 重新导入（multipart，同上；生成新版本）
 *   POST   /api/skills/:id/transfer               转移所属人（`{ toUserId }`）
 *   GET    /api/skills/:id/file?path=&version=    单文件预览（JSON）或下载（`download=1`，**字节流**）
 *   GET    /api/skills/:id/file/raw?path=&version= 预览用原始字节（inline；HTML/SVG 带 CSP）
 *   GET    /api/skills/:id/file/render?path=&version= DOCX / XLSX 渲染成 HTML（inline）
 *   GET    /api/skills/:id/download?version=      整包 zip 下载（与上传同形态）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与 `03` §二 路由表的**两处口径订正**（已回写文档）
 * ─────────────────────────────────────────────────────────────────────
 * · **`POST /api/skills` 接管"新建 + 导入"**：原设计把"手工建"与"zip 导入"分两条路，
 *   但本批**内容只能来自 zip**（`PATCH` 不接 markdown / files）⇒ 手工建出来的会是一个
 *   "只有元数据、没有 `SKILL.md`"的空壳，绑上去之后 `load_skill` 必然失败。故两者合一。
 * · **整包下载复用工作区的零依赖 zip 写入器**（`workspace/zip.ts#buildZip`），
 *   不再要求逐个文件下载；单文件出口仍保留给接口/审计使用。
 *
 * 文件上传的两条与文档上传同款：`bodyLimit` 放宽到 `UPLOAD_BODY_LIMIT`；
 * 用 `request.parts()` 逐项消费（字段顺序由客户端决定），`truncated` 一律 413。
 */

import { appMsg,
  AppError,
  listSkillsQuerySchema,
  ok,
  createSkillProposalDraftBodySchema,
  forkSkillBodySchema,
  listSkillProposalsQuerySchema,
  submitSkillProposalBodySchema,
  skillDownloadQuerySchema,
  skillFileQuerySchema,
  skillIdParamsSchema,
  skillUpstreamDiffQuerySchema,
  syncSkillUpstreamBodySchema,
  saveSkillFromDraftBodySchema,
  saveSkillRevisionFromDraftBodySchema,
  transferAssetBodySchema,
  updateSkillBodySchema,
  type CreateSkillProposalDraftBody,
  type ForkSkillBody,
  type ListSkillProposalsQuery,
  type ListSkillsQuery,
  type SubmitSkillProposalBody,
  type SkillDownloadQuery,
  type SaveSkillFromDraftBody,
  type SaveSkillRevisionFromDraftBody,
  type SkillFileQuery,
  type SkillIdParams,
  type SkillUpstreamDiffQuery,
  type SyncSkillUpstreamBody,
  type TransferAssetBody,
  type UpdateSkillBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { config } from '../config.js'
import { requireAuthContext } from '../plugins/session.js'
import { buildContentDisposition } from '../services/document.service.js'
import { HTML_PREVIEW_CSP, previewHeadersFor } from '../services/previewHeaders.js'
import type { SkillViewer } from '../services/skill.service.js'
import {
  getSkill,
  importSkillPackage,
  listSkills,
  openSkillArchiveSource,
  openSkillFileRawSource,
  openSkillFileSource,
  previewSkillFile,
  removeSkill,
  renderSkillFileHtml,
  transferSkill,
  updateSkill,
  type ImportSkillInput,
} from '../services/skillAsset.service.js'
import {
  listSkillChangesForSkill,
  listSkillVersionsForSkill,
  saveSkillFromDraft,
  saveSkillRevisionFromDraft,
} from '../services/skillDraft.service.js'
import {
  forkSkill,
  getSkillUpstreamDiff,
  syncSkillUpstream,
} from '../services/skillFork.service.js'
import {
  createProposalDraftFromFork,
  listSkillProposalsForTarget,
  submitSkillProposal,
} from '../services/skillProposal.service.js'

/** 取调用者（`id` + `role`）—— 服务层按行级 ACL 判权 */
function viewerOf(request: FastifyRequest): SkillViewer {
  const auth = requireAuthContext(request)
  return { id: auth.user.id, role: auth.user.role }
}

/** 构造 413（与文档 / 附件上传同款；`errorHandler` 对框架错误优先用 `statusCode`） */
function fileTooLarge(fileName: string | undefined): Error {
  const error = new Error(`文件超过上传上限（${config.limits.uploadBodyLimitRaw}）：${fileName ?? '未命名文件'}`)
  Object.assign(error, { statusCode: 413, code: 'FST_REQ_FILE_TOO_LARGE' })
  return error
}

/** `runtime` 表单字段（缺省 = 由包内 frontmatter 决定；非法值 400） */
function parseRuntime(raw: string | undefined): 'INLINE' | 'SANDBOX' | undefined {
  const value = (raw ?? '').trim().toUpperCase()
  if (value === '') return undefined
  if (value === 'INLINE' || value === 'SANDBOX') return value
  throw AppError.validation(appMsg('validation.skill.runtimeAllowed', { allowed: 'INLINE / SANDBOX' }))
}

/**
 * 从 multipart 请求里取 zip + 可选元数据字段（新建与重新导入共用，**逐字一致**）。
 *
 * 用 `request.parts()` 而不是 `request.file()`：字段与文件的顺序由客户端决定（见 `routes/documents.ts`）。
 */
async function readSkillUpload(request: FastifyRequest): Promise<ImportSkillInput> {
  let zip: Buffer | undefined
  const fields = new Map<string, string>()

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const bytes = await part.toBuffer()
      if (part.file.truncated) throw fileTooLarge(part.filename)
      if (zip !== undefined) throw AppError.validation(appMsg('app.m100'))
      zip = bytes
      continue
    }
    const value = String(part.value)
    // 只有这几个键有意义（其余字段忽略而不是报错：表单将来加个 `note` 不该打回整包）
    if (
      part.fieldname === 'runtime' ||
      part.fieldname === 'name' ||
      part.fieldname === 'description' ||
      part.fieldname === 'visibility'
    ) {
      fields.set(part.fieldname, value)
    }
  }

  if (zip === undefined) throw AppError.validation(appMsg('app.m100'))
  if (zip.length === 0) throw AppError.validation(appMsg('app.m010', { p0: 'SKILL.md 压缩包' }))
  return {
    zip,
    runtime: parseRuntime(fields.get('runtime')),
    name: fields.get('name'),
    description: fields.get('description'),
    visibility: fields.get('visibility'),
  }
}

export function registerSkillRoutes(app: FastifyInstance): void {
  /** 列表（登录即可；按"对我可见"过滤） */
  app.get<{ Querystring: ListSkillsQuery }>(
    '/api/skills',
    { preHandler: app.requireAuth, schema: { querystring: listSkillsQuerySchema } },
    async (request) => ok(await listSkills(request.query, viewerOf(request))),
  )

  /** 详情（登录即可；私有 Skill 对他人 404） */
  app.get<{ Params: SkillIdParams }>(
    '/api/skills/:id',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema } },
    async (request) => ok(await getSkill(request.params.id, viewerOf(request))),
  )

  /**
   * 新建（`POST /api/skills`，multipart）。成功返回 `{ skill, version, fileCount, created: true }`。
   *
   * ⚠️ **必须带 zip**：没有"只填元数据"的建法（内容只能来自包，见文件头）。
   */
  app.post(
    '/api/skills',
    { preHandler: app.requireAuth, bodyLimit: config.limits.uploadBodyLimitBytes },
    async (request) => ok(await importSkillPackage(await readSkillUpload(request), viewerOf(request))),
  )

  /**
   * 从草稿保存（`POST /api/skills/from-draft`，P1-24c-1）：**只收 `draftId` + 展示元数据**。
   *
   * `bindToAgentId` 是唯一的「顺带绑定」入口；绑定失败**不影响保存**（回 `bindError`）。
   * 客户端传 `files` / `storageKey` / `markdown` 会被 schema 忽略（zod 默认剥未知键），
   * 内容一律从服务端草稿读 —— 见 `shared/src/skill.ts` 草稿段口径 ①。
   */
  app.post<{ Body: SaveSkillFromDraftBody }>(
    '/api/skills/from-draft',
    { preHandler: app.requireAuth, schema: { body: saveSkillFromDraftBodySchema } },
    async (request) => ok(await saveSkillFromDraft(request.body, viewerOf(request))),
  )

  /**
   * 草稿落成新版本（`POST /api/skills/:id/revisions/from-draft`）。
   *
   * `fromVersion` 是 CAS：不等于当前版本 ⇒ 409 `SKILL_VERSION_CONFLICT`（不自动合并）。
   * **P1-24c-4 保存选项 ②**：可带 `pinAgentId` 把那个 Agent 固定到 `vN+1`；固定失败只回 `pinError`
   * （与 `bindError` 同一条纪律：版本已经写进去了，不该让用户以为没保存）。
   */
  app.post<{ Params: SkillIdParams; Body: SaveSkillRevisionFromDraftBody }>(
    '/api/skills/:id/revisions/from-draft',
    {
      preHandler: app.requireAuth,
      schema: { params: skillIdParamsSchema, body: saveSkillRevisionFromDraftBodySchema },
    },
    async (request) => ok(await saveSkillRevisionFromDraft(request.params.id, request.body, viewerOf(request))),
  )

  /**
   * 复制为我的 Skill（`POST /api/skills/:id/fork`，P1-24c-5）。
   *
   * 源 Skill 必须对调用者可见（私有他人的 ⇒ 404）；复制出的新行 `PRIVATE` + `parentSkillId/parentVersion`。
   * **不改上游**、不自动绑定；返回新副本的 `SkillItem`。
   */
  app.post<{ Params: SkillIdParams; Body: ForkSkillBody }>(
    '/api/skills/:id/fork',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema, body: forkSkillBodySchema } },
    async (request) => ok(await forkSkill(request.params.id, request.body, viewerOf(request))),
  )

  /** 副本的上游差异（只读；`parentAvailable=false` 时不读上游正文） */
  app.get<{ Params: SkillIdParams; Querystring: SkillUpstreamDiffQuery }>(
    '/api/skills/:id/upstream-diff',
    {
      preHandler: app.requireAuth,
      schema: { params: skillIdParamsSchema, querystring: skillUpstreamDiffQuerySchema },
    },
    async (request) => ok(await getSkillUpstreamDiff(request.params.id, request.query, viewerOf(request))),
  )

  /**
   * 同步上游（`POST /api/skills/:id/sync-upstream`，P1-24c-5）：**只允许 `FAST_FORWARD`**。
   *
   * 有本地改动 / 基准或上游正文已归档 ⇒ 409，**绝不静默覆盖副本**。
   * 三方合并（`THREE_WAY`）属 c-6；本批契约层只接受 `FAST_FORWARD`。
   */
  app.post<{ Params: SkillIdParams; Body: SyncSkillUpstreamBody }>(
    '/api/skills/:id/sync-upstream',
    {
      preHandler: app.requireAuth,
      schema: { params: skillIdParamsSchema, body: syncSkillUpstreamBodySchema },
    },
    async (request) => ok(await syncSkillUpstream(request.params.id, request.body, viewerOf(request))),
  )

  /**
   * 从副本建更新建议草稿（`POST /api/skills/:id/proposal-draft`，P1-24c-6；`id` = 副本）。
   *
   * 内容来自**副本当前版本**（不是上游）；返回 `SkillDraft`，前端跳到 `/skills/drafts/:draftId`
   * 用同一套审核组件补充说明 / 编辑，再由 `POST /api/skills/:id/proposals` 提交。
   */
  app.post<{ Params: SkillIdParams; Body: CreateSkillProposalDraftBody }>(
    '/api/skills/:id/proposal-draft',
    {
      preHandler: app.requireAuth,
      schema: { params: skillIdParamsSchema, body: createSkillProposalDraftBodySchema },
    },
    async (request) => ok(await createProposalDraftFromFork(request.params.id, request.body, viewerOf(request))),
  )

  /** 提交更新建议（`POST /api/skills/:id/proposals`；只收 `draftId` + 说明 + 审计位） */
  app.post<{ Params: SkillIdParams; Body: SubmitSkillProposalBody }>(
    '/api/skills/:id/proposals',
    {
      preHandler: app.requireAuth,
      schema: { params: skillIdParamsSchema, body: submitSkillProposalBodySchema },
    },
    async (request) => ok(await submitSkillProposal(request.params.id, request.body, viewerOf(request))),
  )

  /** 所属人 / ADMIN 的「更新建议」列表（目标必须可编辑） */
  app.get<{ Params: SkillIdParams; Querystring: ListSkillProposalsQuery }>(
    '/api/skills/:id/proposals',
    {
      preHandler: app.requireAuth,
      schema: { params: skillIdParamsSchema, querystring: listSkillProposalsQuerySchema },
    },
    async (request) => ok(await listSkillProposalsForTarget(request.params.id, request.query, viewerOf(request))),
  )

  /** 版本历史（只读；可见即可） */
  app.get<{ Params: SkillIdParams }>(
    '/api/skills/:id/versions',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema } },
    async (request) => ok(await listSkillVersionsForSkill(request.params.id, viewerOf(request))),
  )

  /** 变更记录（只读；可见即可） */
  app.get<{ Params: SkillIdParams }>(
    '/api/skills/:id/changes',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema } },
    async (request) => ok(await listSkillChangesForSkill(request.params.id, viewerOf(request))),
  )

  /** 重新导入（生成新版本；不覆盖旧对象） */
  app.post<{ Params: SkillIdParams }>(
    '/api/skills/:id/import',
    {
      preHandler: app.requireAuth,
      bodyLimit: config.limits.uploadBodyLimitBytes,
      schema: { params: skillIdParamsSchema },
    },
    async (request) =>
      ok(await importSkillPackage(await readSkillUpload(request), viewerOf(request), request.params.id)),
  )

  /** 改元数据（登录即可进入，行级判定：所属人或 ADMIN）。**不动文件、不升版本** */
  app.patch<{ Params: SkillIdParams; Body: UpdateSkillBody }>(
    '/api/skills/:id',
    {
      preHandler: app.requireAuth,
      schema: { params: skillIdParamsSchema, body: updateSkillBodySchema },
    },
    async (request) => ok(await updateSkill(request.params.id, request.body, viewerOf(request))),
  )

  /** 软删（行级判定；**被 Agent 绑定时 409**，不自动解绑） */
  app.delete<{ Params: SkillIdParams }>(
    '/api/skills/:id',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema } },
    async (request) => ok(await removeSkill(request.params.id, viewerOf(request))),
  )

  /** 转移所属人（所属人或 ADMIN）。`{ toUserId }`；接收方须为 ACTIVE 用户、不能转给自己 */
  app.post<{ Params: SkillIdParams; Body: TransferAssetBody }>(
    '/api/skills/:id/transfer',
    {
      preHandler: app.requireAuth,
      schema: { params: skillIdParamsSchema, body: transferAssetBodySchema },
    },
    async (request) => ok(await transferSkill(request.params.id, request.body.toUserId, viewerOf(request))),
  )

  /**
   * 单文件：预览（JSON）或下载（字节流）。
   *
   * `download=1` ⇒ 字节流（**本仓第二个不套统一信封的端点**，前端用 `requestBlob`）；
   * 否则 ⇒ `SkillFilePreview` 信封（文本按码点分页；二进制只回元信息）。
   */
  app.get<{ Params: SkillIdParams; Querystring: SkillFileQuery & { download?: string } }>(
    '/api/skills/:id/file',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema, querystring: skillFileQuerySchema.passthrough() } },
    async (request, reply) => {
      const viewer = viewerOf(request)
      const { path, version } = request.query
      if (request.query.download === '1' || request.query.download === 'true') {
        const source = await openSkillFileSource(request.params.id, { path, ...(version === undefined ? {} : { version }) }, viewer)
        return reply
          .header('content-type', source.contentType)
          .header('content-length', String(source.contentLength))
          .header('content-disposition', source.contentDisposition)
          .send(source.body)
      }
      return ok(await previewSkillFile(request.params.id, request.query, viewer))
    },
  )

  /**
   * 预览用原始字节（`/file/raw`）—— 图片 / PDF / HTML / SVG 由浏览器直连渲染。
   *
   * 响应头与产物 / 工作区字节出口同一套分派（`previewHeadersFor`）：HTML/SVG 带 CSP `sandbox`，
   * 其余 `nosniff` + `no-store`；`Content-Disposition` 用 `inline`（预览出口的定义）。
   */
  app.get<{ Params: SkillIdParams; Querystring: SkillFileQuery }>(
    '/api/skills/:id/file/raw',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema, querystring: skillFileQuerySchema } },
    async (request, reply) => {
      const source = await openSkillFileRawSource(request.params.id, request.query, viewerOf(request))
      const headers = previewHeadersFor(source.mime)
      reply
        .header('content-type', headers.contentType)
        .header('content-length', String(source.contentLength))
        .header('content-disposition', buildContentDisposition(source.fileName, { disposition: headers.disposition }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
      if (headers.csp !== null) reply.header('content-security-policy', headers.csp)
      return reply.send(source.body)
    },
  )

  /** DOCX / XLSX 渲染预览（二进制 OOXML → HTML，再按 HTML 那套隔离头回） */
  app.get<{ Params: SkillIdParams; Querystring: SkillFileQuery }>(
    '/api/skills/:id/file/render',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema, querystring: skillFileQuerySchema } },
    async (request, reply) => {
      const source = await renderSkillFileHtml(request.params.id, request.query, viewerOf(request))
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', HTML_PREVIEW_CSP)
        .header('content-disposition', buildContentDisposition(source.fileName, { disposition: 'inline' }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(source.html)
    },
  )

  /** 整包下载（zip，与上传同形态；`version` 缺省 = 当前版本） */
  app.get<{ Params: SkillIdParams; Querystring: SkillDownloadQuery }>(
    '/api/skills/:id/download',
    { preHandler: app.requireAuth, schema: { params: skillIdParamsSchema, querystring: skillDownloadQuerySchema } },
    async (request, reply) => {
      const source = await openSkillArchiveSource(request.params.id, request.query, viewerOf(request))
      return reply
        .header('content-type', 'application/zip')
        .header('content-length', String(source.body.byteLength))
        .header('content-disposition', buildContentDisposition(source.fileName, { disposition: 'attachment' }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(source.body)
    },
  )
}
