/**
 * Skill 草稿路由（P1-24c-1；`docs/子方案/会话生成Skill.md` §六 / §八）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 七条端点（**全部只需登录**；归属由服务层判 = 草稿本人，ADMIN 也不能读他人草稿）
 * ─────────────────────────────────────────────────────────────────────
 *   POST   /api/skill-drafts                     新建（JSON：只收表单，**无文件**）
 *   GET    /api/skill-drafts/:draftId            读（续期）
 *   PUT    /api/skill-drafts/:draftId            自动保存（续期；不收 target / base / files）
 *   DELETE /api/skill-drafts/:draftId            丢弃
 *   POST   /api/skill-drafts/:draftId/files      上传单个文件（multipart：`file` + 可选 `path` + 可选 `replace`）
 *   GET    /api/skill-drafts/:draftId/files      单文件预览（`?path=`；文本全文 / 二进制元信息）
 *   DELETE /api/skill-drafts/:draftId/files      移除单个文件（`?path=`）
 *
 * ⚠️ **建草稿只收 JSON**：草稿文件走独立的上传端点，于是"一个请求既传 JSON 又传文件"的那种
 * 混合形态在这里不存在（`_data` / `request.file()` 的边界问题随之一并消失）。
 *
 * ⚠️ 保存入口不在这里（`POST /api/skills/from-draft` / `POST /api/skills/:id/revisions/from-draft`
 * 注册在 `routes/skills.ts`）：它们写的是 `skills` / `skill_files`，与「草稿」是两种资源。
 */

import {
  AppError,
  appMsg,
  createSkillDraftBodySchema,
  ok,
  skillDraftFileQuerySchema,
  skillDraftIdParamsSchema,
  updateSkillDraftBodySchema,
  type CreateSkillDraftBody,
  type SkillDraftFileQuery,
  type SkillDraftIdParams,
  type UpdateSkillDraftBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { config } from '../config.js'
import { requireAuthContext } from '../plugins/session.js'
import type { SkillViewer } from '../services/skill.service.js'
import {
  createSkillDraft,
  deleteSkillDraft,
  getSkillDraft,
  listSkillDrafts,
  previewSkillDraftFile,
  removeSkillDraftFile,
  updateSkillDraft,
  uploadSkillDraftFile,
} from '../services/skillDraft.service.js'

/** 取调用者（`id` + `role`）—— 服务层按草稿归属判权 */
function viewerOf(request: FastifyRequest): SkillViewer {
  const auth = requireAuthContext(request)
  return { id: auth.user.id, role: auth.user.role }
}

/** 构造 413（与文档 / 附件上传同款） */
function fileTooLarge(fileName: string | undefined): Error {
  const error = new Error(`文件超过上传上限（${config.limits.uploadBodyLimitRaw}）：${fileName ?? '未命名文件'}`)
  Object.assign(error, { statusCode: 413, code: 'FST_REQ_FILE_TOO_LARGE' })
  return error
}

/**
 * 从 multipart 请求里取出唯一那个文件 + 可选 `path` 字段。
 *
 * 用 `request.parts()` 逐项消费（字段顺序由客户端决定）；**多余的文件一律 400** ——
 * 静默取第一个会让"我明明传了两个"变成一个查不明白的问题。
 */
async function readDraftUpload(
  request: FastifyRequest,
): Promise<{ fileName: string; bytes: Buffer; path?: string; replace?: boolean }> {
  let file: { fileName: string; bytes: Buffer } | undefined
  let path: string | undefined
  let replace = false
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const bytes = await part.toBuffer()
      if (part.file.truncated) throw fileTooLarge(part.filename)
      if (file !== undefined) {
        throw AppError.validation(appMsg('app.m305', { p0: '一次只能上传一个文件' }), {
          code: 'SKILL_DRAFT_INVALID',
          reasons: ['一次只能上传一个文件'],
        })
      }
      file = { fileName: part.filename, bytes }
      continue
    }
    if (part.fieldname === 'path') path = String(part.value).trim()
    if (part.fieldname === 'replace') replace = String(part.value).trim() === '1'
  }
  if (file === undefined) {
    throw AppError.validation(appMsg('app.m305', { p0: '缺少文件（表单字段名 file）' }), {
      code: 'SKILL_DRAFT_INVALID',
      reasons: ['缺少文件'],
    })
  }
  if (file.bytes.length === 0) {
    throw AppError.validation(appMsg('app.m010', { p0: '草稿文件' }))
  }
  return {
    ...file,
    ...(path === undefined || path === '' ? {} : { path }),
    ...(replace ? { replace: true } : {}),
  }
}

export function registerSkillDraftRoutes(app: FastifyInstance): void {
  /** 新建草稿（JSON） */
  app.post<{ Body: CreateSkillDraftBody }>(
    '/api/skill-drafts',
    { preHandler: app.requireAuth, schema: { body: createSkillDraftBodySchema } },
    async (request) => {
      const body = request.body
      return ok(
        await createSkillDraft(
          {
            kind: body.kind,
            targetSkillId: body.targetSkillId,
            baseVersion: body.baseVersion,
            name: body.name,
            description: body.description,
            runtime: body.runtime,
            requiresBins: body.requiresBins,
            markdown: body.markdown,
            warnings: body.warnings,
          },
          viewerOf(request),
        ),
      )
    },
  )

  /** 我的草稿列表（提示卡关闭后的重新入口；不含正文） */
  app.get('/api/skill-drafts', { preHandler: app.requireAuth }, async (request) => ok(await listSkillDrafts(viewerOf(request))))

  /** 读草稿（续期） */
  app.get<{ Params: SkillDraftIdParams }>(
    '/api/skill-drafts/:draftId',
    { preHandler: app.requireAuth, schema: { params: skillDraftIdParamsSchema } },
    async (request) => ok(await getSkillDraft(request.params.draftId, viewerOf(request))),
  )

  /** 自动保存（续期；只改内容与元数据） */
  app.put<{ Params: SkillDraftIdParams; Body: UpdateSkillDraftBody }>(
    '/api/skill-drafts/:draftId',
    { preHandler: app.requireAuth, schema: { params: skillDraftIdParamsSchema, body: updateSkillDraftBodySchema } },
    async (request) => ok(await updateSkillDraft(request.params.draftId, request.body, viewerOf(request))),
  )

  /** 丢弃草稿 */
  app.delete<{ Params: SkillDraftIdParams }>(
    '/api/skill-drafts/:draftId',
    { preHandler: app.requireAuth, schema: { params: skillDraftIdParamsSchema } },
    async (request) => ok(await deleteSkillDraft(request.params.draftId, viewerOf(request))),
  )

  /** 上传单个草稿文件（multipart） */
  app.post<{ Params: SkillDraftIdParams }>(
    '/api/skill-drafts/:draftId/files',
    { preHandler: app.requireAuth, bodyLimit: config.limits.uploadBodyLimitBytes, schema: { params: skillDraftIdParamsSchema } },
    async (request) => ok(await uploadSkillDraftFile(request.params.draftId, await readDraftUpload(request), viewerOf(request))),
  )

  /** 单文件预览（文本全文 / 二进制元信息） */
  app.get<{ Params: SkillDraftIdParams; Querystring: SkillDraftFileQuery }>(
    '/api/skill-drafts/:draftId/files',
    { preHandler: app.requireAuth, schema: { params: skillDraftIdParamsSchema, querystring: skillDraftFileQuerySchema } },
    async (request) => ok(await previewSkillDraftFile(request.params.draftId, request.query.path, viewerOf(request))),
  )

  /** 移除单个草稿文件 */
  app.delete<{ Params: SkillDraftIdParams; Querystring: SkillDraftFileQuery }>(
    '/api/skill-drafts/:draftId/files',
    { preHandler: app.requireAuth, schema: { params: skillDraftIdParamsSchema, querystring: skillDraftFileQuerySchema } },
    async (request) => ok(await removeSkillDraftFile(request.params.draftId, request.query.path, viewerOf(request))),
  )
}
