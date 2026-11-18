#!/usr/bin/env node
/**
 * skill-proposal-regression.ts —— P1-24c-6（Proposal + 三方合并）的**无 DB / 无 S3 / 无上游**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend skill-proposal:regression`
 *      （⚠️ 改过 `shared/src` 要先 `pnpm build:shared`；本档 import 的是构建产物）
 *
 * 守的是这几条：
 *  ① 契约：提案状态 / 列表 / 详情 / 提交 / 接受 / 拒绝 / 重做 / 撤回；
 *  ② 纯函数：三方合并（无重叠自动合并、两侧都改必须逐项选边、文件同样）；
 *  ③ 源码接线：表 / 端点 / 先 S3 后 DB / 服务端算 diff / REQUIRE_BASE 409 / 不能自审自批 /
 *     来源会话归属校验 / 草稿过期仍可审（提交时物化）；
 *  ④ 前端：提交入口 / 审核弹层 / 我的建议 / 不在用户文案里出现 "Proposal" / "Fork"；
 *  ⑤ i18n：`skillProposal.*` 与 `app.m332~m339` 中英齐平。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SKILL_PROPOSAL_STATUSES,
  acceptSkillProposalBodySchema,
  closeSkillProposalBodySchema,
  createSkillProposalDraftBodySchema,
  mergeSkillThreeWay,
  reviewSkillProposalBodySchema,
  skillProposalItemSchema,
  skillProposalListResultSchema,
  submitSkillProposalBodySchema,
  syncSkillUpstreamBodySchema,
  en,
  zh,
} from '@doubulea/shared'

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8')
const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const item = {
  id: UUID(1),
  targetSkillId: UUID(2),
  targetName: '报表导出',
  targetSlug: 'report-export',
  baseVersion: 3,
  status: 'PENDING' as const,
  changeSummary: '把导出前校验提前到字段映射之后',
  proposedBy: UUID(3),
  proposerName: 'member',
  changeCount: 3,
  fileCount: 2,
  sourceConversationId: null,
  sourceMessageCount: 0,
  reviewedBy: null,
  reviewerName: null,
  reviewedAt: null,
  reviewNote: null,
  acceptedVersion: null,
  createdAt: '2026-11-17T00:00:00.000Z',
}

console.log('\n① 契约')
{
  check('状态机五档', SKILL_PROPOSAL_STATUSES.join(',') === 'PENDING,ACCEPTED,REJECTED,NEEDS_REBASE,CLOSED')
  check('提案项可解析', skillProposalItemSchema.parse(item).baseVersion === 3)
  check('列表可表达待处理数', skillProposalListResultSchema.parse({ items: [item], total: 1, pendingCount: 1 }).pendingCount === 1)

  check('提交必须带 draftId', !submitSkillProposalBodySchema.safeParse({ baseVersion: 3, changeSummary: 'x' }).success)
  check('提交必须带变更说明', !submitSkillProposalBodySchema.safeParse({ draftId: UUID(1), baseVersion: 3, changeSummary: '' }).success)
  check('提交可带脱敏确认后的正文', submitSkillProposalBodySchema.safeParse({ draftId: UUID(1), baseVersion: 3, changeSummary: 'x', markdown: '# 正文' }).success)

  check('接受默认 REQUIRE_BASE', acceptSkillProposalBodySchema.parse({}).strategy === 'REQUIRE_BASE')
  check('THREE_WAY 必须显式带 resolutions（无冲突可传空数组）', acceptSkillProposalBodySchema.safeParse({ strategy: 'THREE_WAY', resolutions: [] }).success && !acceptSkillProposalBodySchema.safeParse({ strategy: 'THREE_WAY' }).success)
  check('THREE_WAY 带 resolutions 通过', acceptSkillProposalBodySchema.safeParse({ strategy: 'THREE_WAY', resolutions: [{ anchor: 'section:步骤', choice: 'PROPOSAL' }] }).success)
  check('拒绝必须给理由', !reviewSkillProposalBodySchema.safeParse({ note: '' }).success)
  check('撤回备注可选', closeSkillProposalBodySchema.safeParse({}).success)
  check('从副本建草稿可指定基准 / 说明', createSkillProposalDraftBodySchema.safeParse({ baseVersion: 3, changeSummary: '改一处' }).success)

  const syncThreeWay = syncSkillUpstreamBodySchema.safeParse({
    fromVersion: 3,
    strategy: 'THREE_WAY',
    resolutions: [{ anchor: 'file:references/api.md', choice: 'UPSTREAM' }],
  })
  check('副本同步接受 THREE_WAY + resolutions', syncThreeWay.success)
  check('副本同步 THREE_WAY 必须带 resolutions 字段', syncSkillUpstreamBodySchema.safeParse({ fromVersion: 3, strategy: 'THREE_WAY', resolutions: [] }).success && !syncSkillUpstreamBodySchema.safeParse({ fromVersion: 3, strategy: 'THREE_WAY' }).success)
}

console.log('\n② 三方合并纯函数')
{
  const base = '# 步骤\n第一步\n\n## 校验\n旧校验\n'
  const upstream = '# 步骤\n第一步\n\n## 校验\n上游新校验\n'
  const proposal = '# 步骤\n第一步\n\n## 校验\n我的新校验\n\n## 备注\n新增备注\n'

  const auto = mergeSkillThreeWay({
    baseMarkdown: base,
    upstreamMarkdown: upstream,
    proposalMarkdown: proposal,
    baseFiles: [{ path: 'references/a.md', sha256: 'a', size: 1, mime: 'text/markdown' }],
    upstreamFiles: [{ path: 'references/a.md', sha256: 'a', size: 1, mime: 'text/markdown' }],
    proposalFiles: [{ path: 'references/a.md', sha256: 'a', size: 1, mime: 'text/markdown' }],
  })
  check('两侧改同一段 ⇒ 冲突', !auto.ok && auto.conflicts.some((conflict) => conflict.anchor === 'section:校验'))

  const oneSide = mergeSkillThreeWay({
    baseMarkdown: base,
    upstreamMarkdown: upstream,
    proposalMarkdown: base,
    baseFiles: [],
    upstreamFiles: [],
    proposalFiles: [],
  })
  check('只有上游变 ⇒ 取上游', oneSide.ok && oneSide.markdown.includes('上游新校验'))

  const onlyMine = mergeSkillThreeWay({
    baseMarkdown: base,
    upstreamMarkdown: base,
    proposalMarkdown: proposal,
    baseFiles: [],
    upstreamFiles: [],
    proposalFiles: [],
  })
  check('只有我方变 ⇒ 保留我方并追加新段', onlyMine.ok && onlyMine.markdown.includes('我的新校验') && onlyMine.markdown.includes('## 备注'))

  const resolved = mergeSkillThreeWay({
    baseMarkdown: base,
    upstreamMarkdown: upstream,
    proposalMarkdown: proposal,
    baseFiles: [],
    upstreamFiles: [],
    proposalFiles: [],
    resolutions: [{ anchor: 'section:校验', choice: 'UPSTREAM' }],
  })
  check('逐项选边后可合并', resolved.ok && resolved.markdown.includes('上游新校验'))

  const fileConflict = mergeSkillThreeWay({
    baseMarkdown: base,
    upstreamMarkdown: base,
    proposalMarkdown: base,
    baseFiles: [{ path: 'scripts/run.py', sha256: 'base', size: 1, mime: 'text/x-python' }],
    upstreamFiles: [{ path: 'scripts/run.py', sha256: 'up', size: 1, mime: 'text/x-python' }],
    proposalFiles: [{ path: 'scripts/run.py', sha256: 'mine', size: 1, mime: 'text/x-python' }],
  })
  check('文件两侧都改 ⇒ 冲突锚点是 file:<path>', !fileConflict.ok && fileConflict.conflicts[0]?.anchor === 'file:scripts/run.py')

  const fileResolved = mergeSkillThreeWay({
    baseMarkdown: base,
    upstreamMarkdown: base,
    proposalMarkdown: base,
    baseFiles: [{ path: 'scripts/run.py', sha256: 'base', size: 1, mime: 'text/x-python' }],
    upstreamFiles: [{ path: 'scripts/run.py', sha256: 'up', size: 1, mime: 'text/x-python' }],
    proposalFiles: [{ path: 'scripts/run.py', sha256: 'mine', size: 1, mime: 'text/x-python' }],
    resolutions: [{ anchor: 'file:scripts/run.py', choice: 'PROPOSAL' }],
  })
  check('文件冲突可选我方的整份文件', fileResolved.ok && fileResolved.fileChoices[0]?.sha256 === 'mine')

  const oneSideFile = mergeSkillThreeWay({
    baseMarkdown: base,
    upstreamMarkdown: base,
    proposalMarkdown: base,
    baseFiles: [],
    upstreamFiles: [{ path: 'references/new.md', sha256: 'new', size: 1, mime: 'text/markdown' }],
    proposalFiles: [],
  })
  check('上游新增文件自动并入', oneSideFile.ok && oneSideFile.fileChoices[0]?.path === 'references/new.md')
}

console.log('\n③ 源码接线（表 / 端点 / 顺序 / 权限）')
{
  const schema = read('backend/prisma/schema.prisma')
  const service = read('backend/src/services/skillProposal.service.ts')
  const draftService = read('backend/src/services/skillDraft.service.ts')
  const forkService = read('backend/src/services/skillFork.service.ts')
  const routes = read('backend/src/routes/skills.ts')
  const proposalRoutes = read('backend/src/routes/skillProposals.ts')
  const app = read('backend/src/app.ts')

  check('SkillProposal / 状态枚举 / 反向关系', schema.includes('model SkillProposal') && schema.includes('enum SkillProposalStatus') && schema.includes('proposals SkillProposal[]'))
  check('提案物化前缀 = skill-proposals/{id}/', read('shared/src/skill.ts').includes('skill-proposals/${proposalId}/'))
  check('提交只收 draftId / baseVersion / 说明 / 审计位', service.includes('materializeSkillProposalDraft(body.draftId') && !service.includes('body.storageKey'))
  check('diff 由服务端算（computeSkillDiff）', service.includes('computeSkillDiff({'))
  check('先写 S3、后写 DB', service.indexOf('writeObjectsAtPrefix(prefix, draft.files)') < service.indexOf('db.skillProposal.create('))
  check('提交后保留草稿并记录审核状态（打回可重新提交）', service.includes('markSkillProposalSubmitted(body.draftId') && service.includes('assertSkillProposalDraftSubmittable(body.draftId'))
  check('已提交草稿只读 / 打回后可编辑', draftService.includes('DRAFT_LOCKED') && draftService.includes('markSkillProposalSubmitted') && draftService.includes('assertDraftEditable'))
  check('SkillItem 带待审核数 / 草稿带提交状态', read('shared/src/skill.ts').includes('pendingProposalCount') && read('shared/src/skill.ts').includes('skillDraftSubmissionSchema'))
  check('默认 REQUIRE_BASE 冲突 409', service.includes('PROPOSAL_BASE_CONFLICT'))
  check('THREE_WAY 冲突缺 resolutions ⇒ 400，并把提案置 NEEDS_REBASE', service.includes('PROPOSAL_RESOLUTIONS_REQUIRED') && service.includes("status: 'NEEDS_REBASE'"))
  check('接受要求目标 canEditSkill（不能自审自批）', service.includes("requireSkill(row.targetSkillId, viewer, 'edit')"))
  check('接受按完整内容落 vN+1 并记 PROPOSAL 来源', service.includes("source: 'PROPOSAL'") && service.includes('fromVersion: target.version'))
  check('接受失败不静默覆盖：CAS 旧版本', service.includes('where: { id: target.id, version: target.version, deletedAt: null }'))
  check('来源会话必须是提交者自己的', service.includes('where: { id: body.sourceConversationId, userId: viewer.id }'))
  check('副本同步已接三方合并', forkService.includes('mergeSkillThreeWay') && read('shared/src/skill.ts').includes("'FAST_FORWARD', 'THREE_WAY', 'MANUAL'"))
  check('三条 skills 侧端点已注册', routes.includes("'/api/skills/:id/proposal-draft'") && routes.includes("'/api/skills/:id/proposals'"))
  check('审核端点只有通过 / 打回，并带待审总数', proposalRoutes.includes("'/api/skill-proposals/:id/accept'") && proposalRoutes.includes("'/api/skill-proposals/:id/reject'") && !proposalRoutes.includes("'/api/skill-proposals/:id/request-changes'") && proposalRoutes.includes("'/api/skill-proposals/pending-review-count'") && app.includes('registerSkillProposalRoutes(app)'))
  check('草稿服务提供 PROPOSAL 物化与从副本建草稿', draftService.includes('materializeSkillProposalDraft') && draftService.includes('createSkillProposalDraftFromFork'))
  const conversationRoutes = read('backend/src/routes/conversations.ts')
  check(
    '从本会话覆写直接提建议（不 fork）',
    conversationRoutes.includes("'/api/conversations/:id/skill-overrides/:overrideId/proposal-draft'") &&
      service.includes('createProposalDraftFromOverride') &&
      service.includes('redactionCarried: true'),
  )
  check('覆写列表项带 canPropose（自己的 Skill 不给提建议入口）', read('shared/src/skill.ts').includes('canPropose'))
}

console.log('\n④ 前端入口与审核弹层')
{
  const detail = read('frontend/src/pages/skills/SkillDetailPage.tsx')
  const list = read('frontend/src/pages/skills/SkillListPage.tsx')
  const rail = read('frontend/src/features/chat/ConvRail.tsx')
  const api = read('frontend/src/api/skillProposals.ts')
  const modal = read('frontend/src/features/skills/SkillProposalReviewModal.tsx')
  const review = read('frontend/src/features/skills/SkillDraftReview.tsx')

  check('副本详情 / 列表有「提交更新建议」', detail.includes("t('skillProposal.submit')") && list.includes("t('skillProposal.submit')"))
  check('所属人有「更新建议」区 + 待处理数', detail.includes("t('skillProposal.ownerTitle')") && detail.includes('pendingCount'))
  check('Skills 列表行有「待审核」徽标', list.includes("t('skillProposal.pendingReviewBadge'") && list.includes('pendingProposalCount'))
  check('Skill 导航是直达入口且带待审徽标', rail.includes("'AG', 'KB', 'SK'") && rail.includes('convrail__nav-badge') && rail.includes('usePendingSkillReviewCount'))
  check('副本详情有「我的建议」区', detail.includes("t('skillProposal.mineTitle')") && detail.includes('mergedInto'))
  check('审核弹层只有通过 / 打回（打回需理由）', modal.includes('useAcceptSkillProposal') && modal.includes('useRejectSkillProposal') && !modal.includes('useRequestSkillProposalChanges') && !modal.includes('useCloseSkillProposal') && modal.includes("t('skillProposal.rejectNote')"))
  check('冲突逐项选边（Select + 三种保留策略）', modal.includes('CHANGE_CHOICES') && modal.includes('SkillMergeChoice'))
  check('前端不传 storageKey / 文件', api.includes('SubmitSkillProposalBody') && !api.includes('storageKey'))
  check('PROPOSAL 草稿保存走提交端点', review.includes("draft.kind === 'PROPOSAL'") && review.includes('useSubmitSkillProposal'))
  const overridePanel = read('frontend/src/features/chat/SkillOverridePanel.tsx')
  check(
    '覆写面板可「提交更新建议」（canPropose 控制）',
    overridePanel.includes("t('skillProposal.submit')") && overridePanel.includes('item.canPropose'),
  )
  check('内容原样搬运时沿用上次脱敏确认', review.includes('draft.redactionCarried'))
  check('用户文案不出现 Proposal / Fork', Object.keys(zh).filter((key) => key.startsWith('skillProposal.')).every((key) => !/\bProposal\b|\bFork\b/u.test(zh[key as keyof typeof zh] ?? '')))
}

console.log('\n⑤ i18n')
{
  const keys = Object.keys(zh).filter((key) => key.startsWith('skillProposal.'))
  check('skillProposal.* 已登记（≥ 40 条）', keys.length >= 40, `实际 ${String(keys.length)}`)
  check('en 与 zh 键齐平且无汉字', keys.every((key) => key in en && !/[\u4e00-\u9fff]/u.test(en[key as keyof typeof en] ?? '')))
  check('app.m332~m340 中英齐平', ['app.m332', 'app.m333', 'app.m334', 'app.m335', 'app.m336', 'app.m337', 'app.m338', 'app.m339', 'app.m340'].every((key) => key in zh && key in en))
  check('validation.skillProposal.* 中英齐平', Object.keys(zh).filter((key) => key.startsWith('validation.skillProposal.')).every((key) => key in en))
}

console.log(`\n结果：${String(passed)} 通过 / ${String(failed)} 失败`)
if (failed > 0) process.exit(1)