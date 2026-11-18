/**
 * Skill 更新建议审核路由（P1-24c-6；`docs/子方案/会话生成Skill.md` §10.13 / §10.17）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 六条端点（全部只需登录；行级 ACL 在服务层）
 * ─────────────────────────────────────────────────────────────────────
 *   GET  /api/skill-proposals?mine=1&status=&offset=&limit=   我提交的「我的建议」
 *   GET  /api/skill-proposals/pending-review-count             待我审核总数（导航 / 列表徽标）
 *   GET  /api/skill-proposals/:id                             详情（正文 + diff + 三方冲突预览）
 *   POST /api/skill-proposals/:id/accept                      通过（默认 REQUIRE_BASE；THREE_WAY 带 resolutions）
 *   POST /api/skill-proposals/:id/reject                      打回（理由必填；状态 NEEDS_REBASE，可重新提交）
 *   POST /api/skill-proposals/:id/close                       提交者撤回
 *
 * ⚠️ 通过 / 打回都要求目标 `canEditSkill`（所属人或 ADMIN）：**提交者不能自审自批**；
 *    详情允许提交者本人读取（否则提案人看不到自己提案的状态）。
 */

import {
  acceptSkillProposalBodySchema,
  closeSkillProposalBodySchema,
  listSkillProposalsQuerySchema,
  ok,
  reviewSkillProposalBodySchema,
  skillProposalIdParamsSchema,
  type AcceptSkillProposalBody,
  type CloseSkillProposalBody,
  type ListSkillProposalsQuery,
  type ReviewSkillProposalBody,
  type SkillProposalIdParams,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireAuthContext } from '../plugins/session.js'
import type { SkillViewer } from '../services/skill.service.js'
import {
  acceptSkillProposal,
  closeSkillProposal,
  countPendingSkillProposalsForReview,
  getSkillProposal,
  listMySkillProposals,
  rejectSkillProposal,
} from '../services/skillProposal.service.js'

function viewerOf(request: FastifyRequest): SkillViewer {
  const auth = requireAuthContext(request)
  return { id: auth.user.id, role: auth.user.role }
}

export function registerSkillProposalRoutes(app: FastifyInstance): void {
  /** 我的建议（本批只支持 `mine=1`；`mine=0` 400） */
  app.get<{ Querystring: ListSkillProposalsQuery }>(
    '/api/skill-proposals',
    { preHandler: app.requireAuth, schema: { querystring: listSkillProposalsQuerySchema } },
    async (request) => ok(await listMySkillProposals(request.query, viewerOf(request))),
  )

  /** 待我审核总数（导航 / Skills 列表徽标；只回数字） */
  app.get('/api/skill-proposals/pending-review-count', { preHandler: app.requireAuth }, async (request) =>
    ok({ count: await countPendingSkillProposalsForReview(viewerOf(request)) }),
  )

  /** 详情（提交者 / 目标所属人 / ADMIN） */
  app.get<{ Params: SkillProposalIdParams }>(
    '/api/skill-proposals/:id',
    { preHandler: app.requireAuth, schema: { params: skillProposalIdParamsSchema } },
    async (request) => ok(await getSkillProposal(request.params.id, viewerOf(request))),
  )

  /** 接受（幂等；`REQUIRE_BASE` 冲突 409 / `THREE_WAY` 缺 resolutions 400） */
  app.post<{ Params: SkillProposalIdParams; Body: AcceptSkillProposalBody }>(
    '/api/skill-proposals/:id/accept',
    {
      preHandler: app.requireAuth,
      schema: { params: skillProposalIdParamsSchema, body: acceptSkillProposalBodySchema },
    },
    async (request) => ok(await acceptSkillProposal(request.params.id, request.body, viewerOf(request))),
  )

  /** 打回（理由必填；状态 NEEDS_REBASE，提交者可修改草稿后重新提交） */
  app.post<{ Params: SkillProposalIdParams; Body: ReviewSkillProposalBody }>(
    '/api/skill-proposals/:id/reject',
    {
      preHandler: app.requireAuth,
      schema: { params: skillProposalIdParamsSchema, body: reviewSkillProposalBodySchema },
    },
    async (request) => ok(await rejectSkillProposal(request.params.id, request.body, viewerOf(request))),
  )

  /** 撤回（提交者 / ADMIN；PENDING / NEEDS_REBASE） */
  app.post<{ Params: SkillProposalIdParams; Body: CloseSkillProposalBody }>(
    '/api/skill-proposals/:id/close',
    {
      preHandler: app.requireAuth,
      schema: { params: skillProposalIdParamsSchema, body: closeSkillProposalBodySchema },
    },
    async (request) => ok(await closeSkillProposal(request.params.id, request.body, viewerOf(request))),
  )

  }