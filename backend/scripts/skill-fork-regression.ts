#!/usr/bin/env node
/**
 * skill-fork-regression.ts —— P1-24c-5（Fork + fast-forward）的**无 DB / 无 S3 / 无上游**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend skill-fork:regression`
 *      （⚠️ 改过 `shared/src` 要先 `pnpm build:shared`；本档 import 的是构建产物）
 *
 * 守的是这几条：
 *  ① 契约：fork body / upstream diff / sync-upstream（只接受 FAST_FORWARD）/ promote 结果；
 *  ② 纯函数：副本命名（重名顺延 + 截断）、「无本地改动」是内容判据（entry 只比正文）；
 *  ③ 源码接线：三条端点 + promote、CAS `fromVersion`、本地改动 409、上游可见性、先 S3 后 DB；
 *  ④ 交互：提示卡 `FORK` 可用、列表/详情用「复制为我的 Skill」话术、覆写 promote 可用；
 *  ⑤ 边界：本批只覆盖 Fork / fast-forward；THREE_WAY 与 Proposal 属 c-6（已另档）；
 *  ⑥ i18n：`skillFork.*` 中英齐平、en 无汉字、`app.m326~m329` 齐全。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SKILL_ERROR_CODES,
  SKILL_NAME_MAX_CHARS,
  forkSkillBodySchema,
  promoteSkillOverrideResultSchema,
  skillItemSchema,
  skillUpstreamDiffSchema,
  syncSkillUpstreamBodySchema,
  en,
  zh,
} from '@doubulea/shared'

import {
  SKILL_FORK_NAME_SUFFIX,
  forkedSkillName,
  skillContentMatches,
} from '../src/services/skillForkModel.js'

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

const skillItem = {
  id: UUID(1),
  name: '报表导出（副本）',
  slug: 'report-export-copy',
  description: '导出报表',
  runtime: 'INLINE' as const,
  version: 2,
  visibility: 'PRIVATE' as const,
  sourceType: 'MANUAL' as const,
  requiresBins: [],
  createdBy: UUID(2),
  creatorName: 'member',
  canEdit: true,
  parentSkillId: UUID(3),
  parentVersion: 3,
  parentName: '报表导出',
  parentAvailable: true,
  parentDeleted: false,
  parentLatestVersion: 5,
  sourceConversationId: null,
  sourceMessageIds: [],
  sourceAvailable: false,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
}

console.log('\n① 契约')
{
  check('fork body 可省略 parentVersion', forkSkillBodySchema.safeParse({}).success)
  check('fork body 接受已存在版本号', forkSkillBodySchema.parse({ parentVersion: 3 }).parentVersion === 3)
  check('fork body 拒绝 0', !forkSkillBodySchema.safeParse({ parentVersion: 0 }).success)

  const sync = syncSkillUpstreamBodySchema.parse({ fromVersion: 3 })
  check('sync 缺省 strategy = FAST_FORWARD', sync.strategy === 'FAST_FORWARD')
  check('sync 接受 THREE_WAY / MANUAL（c-6；必须带 resolutions）', syncSkillUpstreamBodySchema.safeParse({ fromVersion: 3, strategy: 'THREE_WAY', resolutions: [] }).success && syncSkillUpstreamBodySchema.safeParse({ fromVersion: 3, strategy: 'MANUAL', resolutions: [{ anchor: 'section:步骤', choice: 'UPSTREAM' }] }).success)
  check('sync 要求 fromVersion', !syncSkillUpstreamBodySchema.safeParse({}).success)

  const diff = skillUpstreamDiffSchema.parse({
    skillId: UUID(1),
    parentSkillId: UUID(3),
    parentName: '报表导出',
    parentSlug: 'report-export',
    parentAvailable: true,
    parentDeleted: false,
    syncedVersion: 3,
    upstreamVersion: 5,
    upToDate: false,
    hasLocalChanges: false,
    comparable: true,
    canFastForward: true,
    diff: null,
  })
  check('上游差异可表达「可 fast-forward」', diff.canFastForward && diff.syncedVersion === 3)
  check('上游差异可表达来源已删除', skillUpstreamDiffSchema.parse({ ...diff, parentAvailable: false, parentDeleted: true, upstreamVersion: null }).parentDeleted)

  const item = skillItemSchema.parse(skillItem)
  check('SkillItem 带来源名 / 上游版本', item.parentName === '报表导出' && item.parentLatestVersion === 5)
  const legacy = skillItemSchema.parse({ ...skillItem, parentName: undefined, parentAvailable: undefined, parentDeleted: undefined, parentLatestVersion: undefined })
  check('旧投影缺省为「无来源信息」', legacy.parentName === null && legacy.parentAvailable === false && legacy.parentLatestVersion === null)

  const promoted = promoteSkillOverrideResultSchema.parse({ skill: item, overrideDeleted: true })
  check('promote 结果能表达覆写是否已删', promoted.overrideDeleted && promoted.skill.parentSkillId === UUID(3))
  check('新子码走 data.code', SKILL_ERROR_CODES.FORK_REQUIRED === 'SKILL_FORK_REQUIRED' && SKILL_ERROR_CODES.UPSTREAM_LOCAL_CHANGES === 'SKILL_UPSTREAM_LOCAL_CHANGES')
}

console.log('\n② 纯函数：副本命名与内容判据')
{
  const first = forkedSkillName('报表导出')
  check('副本名 = 原名 + （副本）', first === `报表导出${SKILL_FORK_NAME_SUFFIX}`)
  check('重名顺延「（副本 2）」', forkedSkillName('报表导出', 2) === '报表导出（副本 2）')
  const long = forkedSkillName('x'.repeat(SKILL_NAME_MAX_CHARS + 50))
  check('超长名字截断到上限', [...long].length <= SKILL_NAME_MAX_CHARS)
  check('截断保留副本后缀', long.endsWith(SKILL_FORK_NAME_SUFFIX))

  const baseFiles = [
    { path: 'SKILL.md', sha256: 'entry-base' },
    { path: 'references/api.md', sha256: 'same' },
  ]
  const forkFiles = [
    { path: 'SKILL.md', sha256: 'entry-fork-different-frontmatter' },
    { path: 'references/api.md', sha256: 'same' },
  ]
  check('SKILL.md 只比正文（frontmatter 不同不算改动）', skillContentMatches({ baseBody: '# 步骤\n', forkBody: '# 步骤\n', baseFiles, forkFiles }))
  check('正文变化算本地改动', !skillContentMatches({ baseBody: '# 步骤\n', forkBody: '# 步骤\n多一步\n', baseFiles, forkFiles }))
  check('非入口文件 sha 变化算本地改动', !skillContentMatches({
    baseBody: '# 步骤\n',
    forkBody: '# 步骤\n',
    baseFiles,
    forkFiles: [forkFiles[0]!, { path: 'references/api.md', sha256: 'changed' }],
  }))
  check('多文件算本地改动', !skillContentMatches({
    baseBody: '# 步骤\n',
    forkBody: '# 步骤\n',
    baseFiles,
    forkFiles: [...forkFiles, { path: 'scripts/new.py', sha256: 'new' }],
  }))
  check('CRLF 归一后逐字相等不算改动', skillContentMatches({ baseBody: '# a\r\nb', forkBody: '# a\nb', baseFiles, forkFiles }))
}

console.log('\n③ 源码接线（端点 / CAS / 拒绝覆盖 / 顺序）')
{
  const service = read('backend/src/services/skillFork.service.ts')
  const routes = read('backend/src/routes/skills.ts')
  const conversations = read('backend/src/routes/conversations.ts')
  const draftTools = read('backend/src/orchestrator/skillDraftTools.ts')
  const model = read('backend/src/services/skillForkModel.ts')

  check('fork / upstream-diff / sync-upstream 三条端点', routes.includes("'/api/skills/:id/fork'") && routes.includes("'/api/skills/:id/upstream-diff'") && routes.includes("'/api/skills/:id/sync-upstream'"))
  check('promote 端点已注册', conversations.includes("'/api/conversations/:id/skill-overrides/:overrideId/promote'"))
  check('fork 复制可见版本（requireSkill view）', service.includes("requireSkill(sourceId, viewer, 'view')"))
  check('fork 写入 parentSkillId / parentVersion', service.includes('parentSkillId: source.id') && service.includes('parentVersion,'))
  check('sync 的 fromVersion 是 CAS', service.includes('fork.parentVersion !== body.fromVersion') && service.includes('SKILL_ERROR_CODES.VERSION_CONFLICT'))
  check('有本地改动 / 基准不可读 ⇒ 409 拒绝', service.includes('SKILL_ERROR_CODES.UPSTREAM_LOCAL_CHANGES') && service.includes('comparison.comparable') && service.includes('comparison.matches'))
  check('不静默覆盖：先判内容一致才写', service.indexOf('compareForkWithBase(fork, parent.id)') < service.indexOf('writeVersionObjects(fork.id, nextVersion'))
  check('上游已删除 / 不可见 ⇒ 拒绝同步', service.includes("parent.deletedAt !== null || !canViewSkill(parent, viewer)"))
  check('先 S3、后 DB；失败回收', service.includes('const written = await writeVersionObjects') && service.includes('await removeKeysQuietly(written)'))
  check('fast-forward 更新 parentVersion', service.includes('parentVersion: parent.version'))
  check('promote 先建副本、再删覆写', service.indexOf('createForkedSkill({') < service.indexOf('conversationSkillOverride.delete'))
  check('promote 删除失败保留覆写（overrideDeleted=false）', service.includes('overrideDeleted = false'))
  check('内容判据仍在（无本地改动）', model.includes('无本地改动') && service.includes('compareForkWithBase(fork, parent.id)'))
  check('三方合并入口已接上（c-6）', service.includes('mergeSkillThreeWay') && service.includes("body.strategy === 'FAST_FORWARD'"))
  check('FOREIGN 提示卡放开 FORK', draftTools.includes('canFork: true'))

  const schema = read('backend/prisma/schema.prisma')
  check('SkillProposal 表随 c-6 建好', schema.includes('model SkillProposal') && schema.includes('enum SkillProposalStatus'))
}

console.log('\n④ 前端话术与入口')
{
  const list = read('frontend/src/pages/skills/SkillListPage.tsx')
  const detail = read('frontend/src/pages/skills/SkillDetailPage.tsx')
  const notice = read('frontend/src/features/chat/SkillDraftNoticeStack.tsx')
  const panel = read('frontend/src/features/chat/SkillOverridePanel.tsx')
  const modal = read('frontend/src/features/skills/UpstreamDiffModal.tsx')
  const api = read('frontend/src/api/skills.ts')

  check('列表：副本徽标 + 上游差异入口', list.includes("t('skillFork.badge')") && list.includes('UpstreamDiffModal') && list.includes("t('skillFork.viewUpstream')"))
  check('列表 / 详情使用「复制为我的 Skill」而非 Fork', list.includes("t('skillFork.copy')") && detail.includes("t('skillFork.copy')"))
  check('详情：来源 / 基于版本 / 上游状态', detail.includes("skillFork.sourceLine") && detail.includes("skillFork.statusUpstream"))
  check('提示卡 FORK 动作可用', notice.includes('notice.canFork') && notice.includes('onFork(notice)'))
  check('覆写面板的「另存为我的 Skill」已启用', panel.includes('usePromoteConversationSkillOverride') && !panel.includes("disabled>\n                    {t('skillOverride.promote')}"))
  check('同步按钮只在 canFastForward 时出现', modal.includes('data?.canFastForward === true') && modal.includes("t('skillFork.sync')"))
  check('前端请求不走客户端内容（只 fromVersion）', api.includes('/sync-upstream') && api.includes('SyncSkillUpstreamBody') && !api.includes('storageKey'))
}

console.log('\n⑤ i18n')
{
  const keys = Object.keys(zh).filter((key) => key.startsWith('skillFork.'))
  check('skillFork.* 已登记（≥ 30 条）', keys.length >= 30, `实际 ${String(keys.length)}`)
  check('en 与 zh 键齐平且无汉字', keys.every((key) => key in en && !/[\u4e00-\u9fff]/u.test(en[key as keyof typeof en] ?? '')))
  check('app.m326~m329 中英齐平', ['app.m326', 'app.m327', 'app.m328', 'app.m329'].every((key) => key in zh && key in en))
  check('反驳「Fork」直接出现在用户文案里', !keys.some((key) => /\bFork\b/u.test(zh[key as keyof typeof zh] ?? '')))
}

console.log(`\n结果：${String(passed)} 通过 / ${String(failed)} 失败`)
if (failed > 0) process.exit(1)