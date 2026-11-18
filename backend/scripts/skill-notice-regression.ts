#!/usr/bin/env node
/**
 * skill-notice-regression.ts —— P1-24c-4c（Agent 工具 + 草稿提示卡）的**无 DB / 无 Redis / 无上游**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend skill-notice:regression`
 *      （⚠️ 改过 `shared/src` 要先 `pnpm build:shared`；本档 import 的是构建产物）
 *
 * 守的是这几条：
 *  ① 三个入口工具的参数只收"意图 / 目标 / 捕获范围"，**不收 messageIds / markdown / patch**；
 *  ② manifest / OpenAI 下发共用同一份工具名与参数表（含 `revise_skill_draft` 的 required）；
 *  ③ 提示卡契约：kind / actions / draftId 可空 / 能力位；`GET` 结果与 `POST` 动作形状；
 *  ④ 接线（源码断言）：ChatBot 下发入口工具、builtin/call 代理、会话路由两条、前端提示卡/弹层；
 *  ⑤ 固定按钮已移除（`SaveAsSkillButton` / `UpdateSkillButton` 不再被 ChatPage 引用）；
 *  ⑥ i18n：`skillNotice.*` zh / en 对齐、en 无汉字。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SKILL_ANY_TOOL_NAMES,
  SKILL_DRAFT_NOTICE_ACTIONS,
  SKILL_DRAFT_TOOL_STATUSES,
  SKILL_REVISE_DRAFT_TOOL_NAME,
  SKILL_REQUEST_DRAFT_TOOL_NAME,
  SKILL_REQUEST_REVISION_TOOL_NAME,
  buildSkillManifestTools,
  buildSkillOpenAiTools,
  requestSkillDraftArgsSchema,
  requestSkillRevisionArgsSchema,
  reviseSkillDraftArgsSchema,
  skillDraftNoticeActionBodySchema,
  skillDraftNoticeSchema,
  skillDraftNoticesResultSchema,
  skillDraftToolResultSchema,
  zh,
  en,
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

const CJK = /[\u4e00-\u9fff]/u
const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

console.log('\n① 工具参数契约')
{
  check('入口工具名单 = 3 个', SKILL_ANY_TOOL_NAMES.slice(-3).join(',') ===
    [SKILL_REQUEST_DRAFT_TOOL_NAME, SKILL_REQUEST_REVISION_TOOL_NAME, SKILL_REVISE_DRAFT_TOOL_NAME].join(','))
  const draft = requestSkillDraftArgsSchema.safeParse({ scope: 'LAST_TURN', includeToolOutputs: true, titleHint: '日报' })
  check('request_skill_draft 接受意图 / 范围 / 勾选', draft.success)
  check('request_skill_draft 默认 scope 由服务端补（schema 不强制）', requestSkillDraftArgsSchema.safeParse({}).success)
  const stripped = requestSkillDraftArgsSchema.parse({ scope: 'WHOLE', messageIds: [UUID(1)], markdown: '# x' }) as Record<string, unknown>
  check('request_skill_draft 的 messageIds / markdown 被剥掉（工具不收正文）', !('messageIds' in stripped) && !('markdown' in stripped))

  check('request_skill_revision 接受目标 id / slug', requestSkillRevisionArgsSchema.safeParse({ targetSkillId: UUID(2), scope: 'WHOLE' }).success)
  check('request_skill_revision 拒绝非法目标 id', !requestSkillRevisionArgsSchema.safeParse({ targetSkillId: 'x' }).success)
  check('request_skill_revision 的 messageIds / patch 被剥掉', !('patch' in requestSkillRevisionArgsSchema.parse({ patch: 'x' })))

  check('revise_skill_draft 必须有 draftId + instruction', reviseSkillDraftArgsSchema.safeParse({ draftId: UUID(3), instruction: '改第 3 步' }).success)
  check('revise_skill_draft 缺 instruction ⇒ 拒绝', !reviseSkillDraftArgsSchema.safeParse({ draftId: UUID(3) }).success)
  check('revise_skill_draft 缺 draftId ⇒ 拒绝', !reviseSkillDraftArgsSchema.safeParse({ instruction: 'x' }).success)
  check('revise_skill_draft 不接受 markdown / patch', !('markdown' in reviseSkillDraftArgsSchema.parse({ draftId: UUID(3), instruction: 'x', markdown: 'y' })))
}

console.log('\n② 工具定义单一生成源')
{
  const manifest = buildSkillManifestTools([...SKILL_ANY_TOOL_NAMES])
  const openai = buildSkillOpenAiTools([...SKILL_ANY_TOOL_NAMES])
  check('manifest / OpenAI 工具名逐字一致（6 个）', manifest.map((tool) => tool.name).join(',') === openai.map((tool) => tool.function.name).join(','))
  const reviseManifest = manifest.find((tool) => tool.name === SKILL_REVISE_DRAFT_TOOL_NAME)
  const reviseOpenai = openai.find((tool) => tool.function.name === SKILL_REVISE_DRAFT_TOOL_NAME)
  check('revise_skill_draft 的 required = draftId,instruction', (reviseManifest?.inputSchema['required'] as string[] | undefined)?.join(',') === 'draftId,instruction')
  check('manifest 与 OpenAI 的 required 逐字一致', JSON.stringify(reviseManifest?.inputSchema['required']) === JSON.stringify(reviseOpenai?.function.parameters['required']))
  check('三个入口工具都在 manifest 里（容器 skills 扩展才会注册）', SKILL_ANY_TOOL_NAMES.every((name) => manifest.some((tool) => tool.name === name)))
}

console.log('\n③ 提示卡 / 结果契约')
{
  check(
    '结果状态取值稳定',
    SKILL_DRAFT_TOOL_STATUSES.join(',') === 'DRAFT_CREATED,REVISED,NO_CHANGE,FOREIGN,TARGET_NOT_FOUND,DRAFT_NOT_FOUND,INVALID,FAILED',
  )
  check('提示卡 kind 四档', skillDraftNoticeSchema.shape.kind.options.join(',') === 'CREATE,REVISION,FOREIGN,SESSION_OVERRIDE')
  check('提示卡动作五档', SKILL_DRAFT_NOTICE_ACTIONS.join(',') === 'REVIEW,LET_AGENT_REVISE,EDIT_IN_SESSION,FORK,DISMISS')

  const notice = skillDraftNoticeSchema.parse({
    id: 'sn_1',
    conversationId: 'c1',
    kind: 'REVISION',
    draftId: UUID(4),
    targetSkillId: UUID(5),
    targetName: '日报导出',
    fromVersion: 1,
    toVersion: 2,
    changeSummary: '改了第 3 步',
    risks: ['跳过确认 / 校验'],
    reason: null,
    actions: ['REVIEW', 'LET_AGENT_REVISE', 'DISMISS'],
    createdAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-16T01:00:00.000Z',
  })
  check('REVISION 提示卡解析成功', notice.kind === 'REVISION' && notice.draftId === UUID(4))
  check('FOREIGN 可以没有 draftId', skillDraftNoticeSchema.parse({ ...notice, kind: 'FOREIGN', draftId: null, actions: ['EDIT_IN_SESSION', 'FORK', 'DISMISS'] }).draftId === null)
  check('能力位默认 false（服务端按批次显式置 true）', notice.canOverride === false && notice.canFork === false)
  check('GET 结果是 { items }', skillDraftNoticesResultSchema.parse({ items: [notice] }).items.length === 1)
  check('POST 只接受 OPEN / DISMISS', skillDraftNoticeActionBodySchema.safeParse({ action: 'OPEN' }).success && !skillDraftNoticeActionBodySchema.safeParse({ action: 'ACCEPT' }).success)
  check('工具结果可解析（默认值齐全）', skillDraftToolResultSchema.parse({ status: 'DRAFT_CREATED', draftId: UUID(6) }).candidates.length === 0)
  check(
    'NO_CHANGE 结果可解析且没有新版本号（不伪造 vN+1）',
    skillDraftToolResultSchema.parse({ status: 'NO_CHANGE', reason: '零改动' }).toVersion === null,
  )
}

console.log('\n④ 接线（源码断言）')
{
  const chatBot = readFileSync(join(repoRoot, 'backend/src/orchestrator/chatBot.ts'), 'utf8')
  const proxy = readFileSync(join(repoRoot, 'backend/src/sandbox/proxy.ts'), 'utf8')
  const routes = readFileSync(join(repoRoot, 'backend/src/routes/conversations.ts'), 'utf8')
  const chatPage = readFileSync(join(repoRoot, 'frontend/src/pages/chat/ChatPage.tsx'), 'utf8')
  const extension = readFileSync(join(repoRoot, 'infra/sandbox/base/pi-agent/extensions/skills/index.ts'), 'utf8')
  const skillTools = readFileSync(join(repoRoot, 'backend/src/orchestrator/skillDraftTools.ts'), 'utf8')

  check('ChatBot 下发草稿入口工具', chatBot.includes('SKILL_REQUEST_TOOL_NAMES') && chatBot.includes('executeSkillDraftTool'))
  check(
    '权限 / 目标类结论不算工具失败（不误触"本轮有工具没成功"）',
    skillTools.includes('SKILL_DRAFT_TOOL_OK_STATUSES') &&
      skillTools.includes("'FOREIGN'") &&
      skillTools.includes('isError: !SKILL_DRAFT_TOOL_OK_STATUSES.includes(result.status)'),
  )
  check('builtin/call 代理草稿入口工具', proxy.includes('isSkillRequestToolName(body.name)') && proxy.includes('executeSkillDraftTool'))
  check('会话路由有 skill-notices 拉取与消费', routes.includes("'/api/conversations/:id/skill-notices'") && routes.includes('/skill-notices/:noticeId'))
  check('ChatPage 接线提示卡与审核弹层', chatPage.includes('SkillDraftNoticeStack') && chatPage.includes('SkillDraftReviewDrawer'))
  check('容器 skills 扩展把入口工具代理回后端', extension.includes('BUILTIN_CALL_PATH') && extension.includes('callBuiltinTool'))
  check(
    '固定按钮已移除（不再引用 SaveAsSkillButton / UpdateSkillButton）',
    !chatPage.includes('SaveAsSkillButton') &&
      !chatPage.includes('UpdateSkillButton') &&
      !existsSync(join(repoRoot, 'frontend/src/pages/chat/SaveAsSkillButton.tsx')) &&
      !existsSync(join(repoRoot, 'frontend/src/pages/chat/UpdateSkillButton.tsx')),
  )
}

console.log('\n⑤ i18n')
{
  const keys = Object.keys(zh).filter((key) => key.startsWith('skillNotice.'))
  check('skillNotice.* 至少 14 条', keys.length >= 14)
  check('en 与 zh 的 skillNotice.* 完全对齐', keys.every((key) => Object.prototype.hasOwnProperty.call(en, key)) && Object.keys(en).filter((key) => key.startsWith('skillNotice.')).length === keys.length)
  check('en 的 skillNotice.* 无汉字', keys.every((key) => !CJK.test(en[key])))
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败项'}：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
