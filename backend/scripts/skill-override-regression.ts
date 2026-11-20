#!/usr/bin/env node
/**
 * skill-override-regression.ts —— P1-24c-4b（会话级 Skill 覆写）的**无 DB / 无 Redis / 无上游**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend skill-override:regression`
 *      （⚠️ 改过 `shared/src` 要先 `pnpm build:shared`；本档 import 的是构建产物）
 *
 * 守的是这几条：
 *  ① 解析优先级：会话覆写 → Agent 固定版本 → 最新版；`contentKey` / `version` / `overrideRevision`；
 *  ② fingerprint：`overrideRevision` 变化必须触发同步；manifest `path` 指到覆写目录；
 *  ③ 契约：覆写列表 / 详情 / 创建 / 替换（CAS）/ 草稿 `SESSION_OVERRIDE` 字段；
 *  ④ 源码接线：非本人 404、未绑定 400、inline+scripts 400、ChatBot 读覆写前缀且不写 last-loaded、
 *     skillSync 物化 `overrides/r{n}`、路由六条、promote 随 c-5 注册、前端只改本会话可用；
 *  ⑤ i18n：`skillOverride.*` zh / en 键齐平，en 无汉字。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SKILL_ERROR_CODES,
  SKILL_REVISION_INTENTS,
  conversationSkillOverrideItemSchema,
  createConversationSkillOverrideBodySchema,
  rebaseConversationSkillOverrideBodySchema,
  replaceConversationSkillOverrideBodySchema,
  requestSkillRevisionArgsSchema,
  resolveSkillSnapshot,
  skillDraftSchema,
  skillOverridePrefix,
  skillStoragePrefix,
  zh,
  en,
} from '@doubulea/shared'

import { buildSkillManifest, expectedFingerprintOf, skillOverrideDir, skillVersionDir } from '../src/sandbox/skillSync.js'

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

console.log('\n① 解析优先级与 contentKey')
{
  const base = {
    skillId: 's1',
    slug: 'report-export',
    runtime: 'INLINE' as const,
    currentVersion: 5,
    conversationId: 'c1',
  }
  const overridden = resolveSkillSnapshot({
    ...base,
    pinnedVersion: 4,
    override: { basedOnVersion: 3, revision: 2 },
  })
  check('覆写优先于固定版本与最新版', overridden.version === 3 && overridden.override && overridden.overrideRevision === 2)
  check('覆写 contentKey 指到 skill-overrides/{conversationId}/{skillId}/r{n}/', overridden.contentKey === skillOverridePrefix('c1', 's1', 2))
  check('覆写 contentKey 逐字稳定', overridden.contentKey === 'skill-overrides/c1/s1/r2/')

  const pinned = resolveSkillSnapshot({ ...base, pinnedVersion: 4 })
  check('无覆写：固定版本优先于最新版', pinned.version === 4 && !pinned.override && pinned.overrideRevision === null)
  check('无覆写 contentKey = skills/{id}/v{n}/', pinned.contentKey === skillStoragePrefix('s1', 4))
  const latest = resolveSkillSnapshot(base)
  check('无覆写且未固定 ⇒ 最新版', latest.version === 5 && latest.contentKey === 'skills/s1/v5/')
}

console.log('\n② fingerprint 与 manifest 路径')
{
  const entry = {
    id: 's1',
    slug: 'report-export',
    name: '报表导出',
    description: '导出报表',
    version: 3,
    runtime: 'SANDBOX' as const,
    requiresBins: [],
    overrideRevision: null as number | null,
    overrideStorageKey: null,
  }
  const plain = expectedFingerprintOf([entry])
  const r1 = expectedFingerprintOf([{ ...entry, overrideRevision: 1 }])
  const r2 = expectedFingerprintOf([{ ...entry, overrideRevision: 2 }])
  check('覆写 r1 与无覆写的指纹不同', plain !== r1)
  check('覆写 r1 与 r2 的指纹不同', r1 !== r2)

  const upstreamManifest = buildSkillManifest({ conversationId: 'c1', entries: [entry] })
  check('上游 manifest path = v3/report-export', upstreamManifest.skills[0]?.path === skillVersionDir(3, 'report-export'))
  check('上游 manifest override=false / null', upstreamManifest.skills[0]?.override === false && upstreamManifest.skills[0]?.overrideRevision === null)
  const overrideManifest = buildSkillManifest({ conversationId: 'c1', entries: [{ ...entry, overrideRevision: 2 }] })
  check('覆写 manifest path = overrides/r2/report-export', overrideManifest.skills[0]?.path === skillOverrideDir(2, 'report-export'))
  check('覆写 manifest override=true / r2', overrideManifest.skills[0]?.override === true && overrideManifest.skills[0]?.overrideRevision === 2)
  check('覆写不覆盖上游目录（路径前缀不同）', overrideManifest.skills[0]?.path.startsWith('overrides/') && upstreamManifest.skills[0]?.path.startsWith('v3/'))
  check('指纹仍随版本变化（上游 v3 → v4）', plain !== expectedFingerprintOf([{ ...entry, version: 4 }]))
}

console.log('\n③ 契约：覆写 / 草稿 / 工具参数')
{
  const item = conversationSkillOverrideItemSchema.parse({
    id: UUID(1),
    conversationId: UUID(2),
    skillId: UUID(3),
    skillName: '报表导出',
    skillSlug: 'report-export',
    basedOnVersion: 3,
    revision: 2,
    currentSkillVersion: 4,
    upstreamUpdated: true,
    changeSummary: '改了第 3 步',
    fileCount: 2,
    createdBy: UUID(4),
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
  })
  check('覆写列表项可解析且能表达"上游已更新"', item.upstreamUpdated && item.revision === 2)
  check('POST 覆写只收 draftId', createConversationSkillOverrideBodySchema.safeParse({ draftId: UUID(5) }).success)
  check('POST 覆写不接受 storageKey / files', !('storageKey' in createConversationSkillOverrideBodySchema.parse({ draftId: UUID(5) })))
  check('PUT 覆写要求 expectedRevision ≥ 1', replaceConversationSkillOverrideBodySchema.safeParse({ draftId: UUID(5), expectedRevision: 1 }).success)
  check('PUT 覆写拒绝 expectedRevision=0', !replaceConversationSkillOverrideBodySchema.safeParse({ draftId: UUID(5), expectedRevision: 0 }).success)
  check('rebased 的 expectedRevision 可缺省', rebaseConversationSkillOverrideBodySchema.safeParse({}).success)

  const draft = skillDraftSchema.parse({
    id: UUID(6),
    kind: 'SESSION_OVERRIDE',
    targetSkillId: UUID(3),
    baseVersion: 3,
    name: '报表导出',
    description: '导出报表',
    runtime: 'INLINE',
    requiresBins: [],
    markdown: '# x',
    files: [],
    warnings: [],
    redactions: [],
    source: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-16T01:00:00.000Z',
  })
  check('旧草稿可读（覆写字段缺省为 null）', draft.overrideConversationId === null && draft.expectedRevision === null)
  check('SESSION_OVERRIDE 草稿可带所属会话与期望 revision', skillDraftSchema.parse({
    ...draft,
    overrideConversationId: UUID(2),
    expectedRevision: 2,
  }).expectedRevision === 2)

  check('request_skill_revision.mode 只接受 UPSTREAM / OVERRIDE', SKILL_REVISION_INTENTS.join(',') === 'UPSTREAM,OVERRIDE')
  check('工具参数 mode=OVERRIDE 可解析', requestSkillRevisionArgsSchema.safeParse({ mode: 'OVERRIDE' }).success)
  check('工具参数 mode 缺省 = UPSTREAM（由服务层补）', requestSkillRevisionArgsSchema.parse({}).mode === undefined)
  check('工具参数拒绝未知 mode', !requestSkillRevisionArgsSchema.safeParse({ mode: 'FORK' }).success)

  check('错误子码走 data.code（不新增 ERROR_CODES）', SKILL_ERROR_CODES.OVERRIDE_CONFLICT === 'SKILL_OVERRIDE_CONFLICT' && SKILL_ERROR_CODES.OVERRIDE_NOT_BOUND === 'SKILL_OVERRIDE_NOT_BOUND')
}

console.log('\n④ 源码接线（判据 / 优先级 / 门禁）')
{
  const service = read('backend/src/services/skillOverride.service.ts')
  const draftService = read('backend/src/services/skillDraft.service.ts')
  const extract = read('backend/src/services/skillExtract.service.ts')
  const skillTools = read('backend/src/orchestrator/skillTools.ts')
  const chatBot = read('backend/src/orchestrator/chatBot.ts')
  const sync = read('backend/src/sandbox/skillSync.ts')
  const draftTools = read('backend/src/orchestrator/skillDraftTools.ts')
  const routes = read('backend/src/routes/conversations.ts')
  const notice = read('frontend/src/features/chat/SkillDraftNoticeStack.tsx')
  const panel = read('frontend/src/features/chat/SkillOverridePanel.tsx')
  const draftPage = read('frontend/src/features/skills/SkillDraftReview.tsx')

  check('非本人（含 ADMIN）⇒ 404：服务端 where 里带 userId', service.includes('where: { id: conversationId, userId: viewer.id }'))
  check('CAS 冲突 ⇒ 409 + SKILL_OVERRIDE_CONFLICT', service.includes('SKILL_ERROR_CODES.OVERRIDE_CONFLICT') && service.includes('current.revision !== input.expectedRevision'))
  check('未绑定 ⇒ 400 SKILL_OVERRIDE_NOT_BOUND', service.includes('SKILL_ERROR_CODES.OVERRIDE_NOT_BOUND') && extract.includes('SKILL_ERROR_CODES.OVERRIDE_NOT_BOUND'))
  check('inline Skill 覆写带 scripts ⇒ 400', service.includes("effectiveSkillRuntime(skill.runtime) === 'INLINE'") && service.includes('SKILL_ERROR_CODES.IMPORT_INVALID'))
  check('写 S3 先、DB 后（失败回收刚写的对象）', service.includes('const written = await writeOverrideObjects') && service.includes('await removeKeysQuietly(written)'))
  const stripped = createConversationSkillOverrideBodySchema.parse({ draftId: UUID(1), storageKey: 'x', files: [] }) as Record<string, unknown>
  check('storageKey / files 只由服务端生成（客户端字段被剥离）', service.includes('skillOverridePrefix(conversationId') && !('storageKey' in stripped) && !('files' in stripped))

  check('草稿：SESSION_OVERRIDE 支持所属会话 / 期望 revision', draftService.includes('overrideConversationId') && draftService.includes('expectedRevision'))
  check('草稿物化检查 inline + scripts', draftService.includes("effectiveSkillRuntime(target.runtime) === 'INLINE'") && draftService.includes('isSkillScriptPath'))
  check('抽取：intent=OVERRIDE 走非所属人分支', extract.includes("revisionBody.intent === 'OVERRIDE'") && extract.includes('requireOverrideTarget'))
  check('抽取：还原样复用纠正窗口', extract.includes('selectRevisionOrExtractMessages'))
  check('ChatBot 快照按会话查覆写', skillTools.includes('conversationSkillOverride.findMany') && skillTools.includes('conversationId'))
  check('ChatBot 读对象用 contentKey（覆写前缀）', skillTools.includes('objectKeyOf(entry, row.path)') && skillTools.includes('entry.contentKey'))
  check('ChatBot 覆写生效期间不写 last-loaded', chatBot.includes('outcome.audit.overrideRevision === undefined') && chatBot.includes('writeSkillLastLoaded'))
  check('tool_calls 审计带 overrideRevision', chatBot.includes('overrideRevision: outcome.audit.overrideRevision'))
  check('skillSync 物化 overrides/r{n}/<slug>/', sync.includes('skillOverrideDir') && sync.includes('materializeSkillOverride'))
  check('skillSync current 链接按 manifest path 切换', sync.includes('switchCurrentLink(root, entry.slug, entry.path)'))
  check('FOREIGN 的 canOverride=true', draftTools.includes('canOverride: true'))
  check('mode=OVERRIDE 生成 SESSION_OVERRIDE 草稿', draftTools.includes("overrideIntent ? 'SESSION_OVERRIDE' : 'REVISION'"))

  check('路由：POST/GET 列表、GET/PUT/DELETE 详情、rebased', routes.includes("'/api/conversations/:id/skill-overrides'") && routes.includes("'/api/conversations/:id/skill-overrides/:overrideId'") && routes.includes("'/api/conversations/:id/skill-overrides/:overrideId/rebased'"))
  check('promote 已随 c-5 注册（先 fork、再删覆写）', routes.includes('/skill-overrides/:overrideId/promote') && read('backend/src/services/skillFork.service.ts').includes('promoteConversationSkillOverride'))
  check('前端提示卡：canOverride 时启用「只改本会话」', notice.includes('notice.canOverride') && notice.includes('onEditInSession'))
  check('前端会话设置：覆写列表有放弃与按上游重建', panel.includes('useConversationSkillOverrides') && panel.includes('useDeleteConversationSkillOverride') && panel.includes('useRebaseConversationSkillOverride'))
  check('审核页：覆写保存走覆写端点且显示"只影响本会话"', draftPage.includes('useCreateConversationSkillOverride') && draftPage.includes('useReplaceConversationSkillOverride') && draftPage.includes('skillOverride.noticeTitle'))
}

console.log('\n⑤ i18n')
{
  const keys = Object.keys(zh).filter((key) => key.startsWith('skillOverride.') || key === 'toolCard.overrideRevision' || key === 'skillDraft.kindSessionOverride' || key === 'skillNotice.overrideTitle')
  check('覆写相关文案已登记（≥ 20 条）', keys.length >= 20)
  check('en 与 zh 键齐平', keys.every((key) => key in en))
  check('en 的覆写文案没有汉字', keys.every((key) => !/[\u4e00-\u9fff]/u.test(en[key as keyof typeof en] ?? '')))
  check('app.m320~m325 中英齐平', ['app.m320', 'app.m321', 'app.m322', 'app.m323', 'app.m324', 'app.m325'].every((key) => key in zh && key in en))
}

console.log(`\n结果：${String(passed)} 通过 / ${String(failed)} 失败`)
if (failed > 0) process.exit(1)