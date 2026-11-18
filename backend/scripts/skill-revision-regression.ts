#!/usr/bin/env node
/**
 * skill-revision-regression.ts —— P1-24c-4（从会话纠正更新既有 Skill）的**无 DB / 无 S3 / 无 Redis / 无上游**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend skill-revision:regression`
 *      （⚠️ 改过 `shared/src` 要先 `pnpm build:shared`；本档 import 的是构建产物）
 *
 * 依据：`docs/06-实施计划.md` P1-24c-4 验收项 + `docs/子方案/会话生成Skill.md` §十·补 / §十一·P1-24c-4。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 守的是这几条（每条都对应一个"只在运行期才暴露"的错法）
 * ─────────────────────────────────────────────────────────────────────
 * ① **REVISION 请求契约**：`targetSkillId + baseVersion` 必填；`messageIds` 与 `turnRange` 二选一；
 *    两个 body 的分流按 `targetSkillId` 在不在（CREATE 分支逐字不变）；
 * ② **纠正窗口**（§10.3）：默认只取"最后一条用户消息 + 其后回答"；指定 `correctionMessageId`
 *    取它所在的那一轮；没有用户消息 ⇒ `null`；
 * ③ **最小改动提示词**：`SKILL_REVISION_PROMPT` 与 `SKILL_EXTRACT_PROMPT` **逐字不同**，
 *    且明确要求"其余段落逐字保留"与给 `changeSummary`；
 * ④ **风险提示**（§10.4）：跳过确认 / 忽略错误 / force 等命中；**只在新增行与纠正原文**上判，
 *    原正文本来就有的不算（否则每次都标红）；
 * ⑤ **diff 由服务端算**（c-1 的 `computeSkillDiff` 复用）：纠正只改一段 ⇒ 其余段 `equal`；
 * ⑥ **保存选项**：`pinAgentId` 在 schema 里、`pinError` 在结果契约里（保存成功不受固定失败影响）；
 * ⑦ **权限子码**：`SKILL_REVISION_FOREIGN_DENIED` 存在；非所属人只能 fork / 会话覆写；
 * ⑧ **草稿来源**：REVISION 草稿带 `source`（c-2 的字段）+ `targetSkillId / baseVersion`；
 * ⑨ **i18n**：`app.m315 ~ app.m319` 两份字典齐平、en 无汉字、占位符个数对齐。
 *
 * ⚠️ 它**验不了**端到端（要 PG + MinIO + Redis + 真模型）：真模型写出来的 diff 好不好、
 *    浏览器里四选一作用域的手感 —— 按 `06` §六「手动 E2E」留给用户真跑。
 */

import { readFileSync } from 'node:fs'

import {
  APP_MESSAGES,
  SKILL_ERROR_CODES,
  SKILL_EXTRACT_PROMPT,
  SKILL_REVISION_PROMPT,
  SKILL_REVISION_SCOPES,
  computeSkillDiff,
  detectSkillRevisionRisks,
  parseSkillExtractOutput,
  saveSkillFromDraftResultSchema,
  saveSkillRevisionFromDraftBodySchema,
  skillCorrectionTurnRange,
  skillDraftSchema,
  skillExtractBodySchema,
  skillExtractRequestSchema,
  skillExtractResultSchema,
  skillExtractSelectionOf,
  skillRevisionExtractBodySchema,
  skillRevisionTargetsSchema,
  updateSkillDraftBodySchema,
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

// ═════════════════════════════════════════════════════════════════════
// ① 请求契约与分流
// ═════════════════════════════════════════════════════════════════════
console.log('\n① 请求契约与分流')
{
  check('作用域取值 = CORRECTION / WHOLE', SKILL_REVISION_SCOPES.join(',') === 'CORRECTION,WHOLE')
  const minimal = skillRevisionExtractBodySchema.safeParse({ targetSkillId: UUID(9), baseVersion: 1 })
  check('REVISION 最少字段（目标 + 基准版本）即可', minimal.success)
  check('REVISION 缺 targetSkillId ⇒ 400', !skillRevisionExtractBodySchema.safeParse({ baseVersion: 1 }).success)
  check('REVISION 缺 baseVersion ⇒ 400', !skillRevisionExtractBodySchema.safeParse({ targetSkillId: UUID(9) }).success)
  check(
    'REVISION 的 baseVersion 从 1 开始',
    !skillRevisionExtractBodySchema.safeParse({ targetSkillId: UUID(9), baseVersion: 0 }).success,
  )
  check(
    'REVISION messageIds + turnRange 同时给 ⇒ 400',
    !skillRevisionExtractBodySchema.safeParse({
      targetSkillId: UUID(9),
      baseVersion: 1,
      messageIds: [UUID(1)],
      turnRange: { from: 1, to: 1 },
    }).success,
  )
  check(
    'REVISION turnRange.from > to ⇒ 400',
    !skillRevisionExtractBodySchema.safeParse({ targetSkillId: UUID(9), baseVersion: 1, turnRange: { from: 3, to: 2 } }).success,
  )

  // 路由级分流：按 `targetSkillId` 在不在决定套哪份 schema（CREATE 分支逐字不变）
  check('分流：CREATE body 通过', skillExtractRequestSchema.safeParse({ turnRange: { from: 1, to: 1 } }).success)
  check(
    '分流：REVISION body 通过',
    skillExtractRequestSchema.safeParse({ targetSkillId: UUID(9), baseVersion: 1 }).success,
  )
  check(
    '分流：带 targetSkillId 但缺 baseVersion ⇒ 报 REVISION 的错（不是 CREATE 的）',
    !skillExtractRequestSchema.safeParse({ targetSkillId: UUID(9) }).success,
  )
  check('分流：CREATE 仍拒绝空的 turnRange.from', !skillExtractRequestSchema.safeParse({ turnRange: { from: 0, to: 1 } }).success)
  // CREATE 的 schema 是 `.superRefine` 之后的 ZodEffects ⇒ 判据用"带 targetSkillId 的 body 不报错"代替字段表
  check(
    'CREATE body 上的 targetSkillId 被当作未知键（不会进 REVISION 分支）',
    skillExtractBodySchema.safeParse({ turnRange: { from: 1, to: 1 }, targetSkillId: UUID(9) }).success &&
      skillExtractRequestSchema.safeParse({ turnRange: { from: 1, to: 1 }, targetSkillId: UUID(9) }).success === false,
  )

  // 归一：两种 body → 同一份"消息选择"
  const createSelection = skillExtractSelectionOf({ mode: 'SUMMARY', includeToolOutputs: true })
  check('归一（CREATE）：模式与勾选原样带出', createSelection.mode === 'SUMMARY' && createSelection.includeToolOutputs === true)
  const revisionSelection = skillExtractSelectionOf({
    revision: { targetSkillId: UUID(9), baseVersion: 2, scope: 'CORRECTION' },
  })
  check(
    '归一（REVISION）：没给范围 ⇒ 不伪造 turnRange（窗口由服务层按纠正算）',
    revisionSelection.turnRange === undefined && revisionSelection.messageIds === undefined,
  )
}

// ═════════════════════════════════════════════════════════════════════
// ② 纠正窗口（§10.3）
// ═════════════════════════════════════════════════════════════════════
console.log('\n② 纠正窗口')
{
  const messages = [
    { id: 'u1', role: 'USER' as const },
    { id: 'a1', role: 'ASSISTANT' as const },
    { id: 'u2', role: 'USER' as const },
    { id: 'a2', role: 'ASSISTANT' as const },
    { id: 's2', role: 'SYSTEM' as const },
    { id: 'a3', role: 'ASSISTANT' as const },
  ]
  const range = skillCorrectionTurnRange(messages)
  check('默认 = 最后一轮', range !== null && range.from === 2 && range.to === 2)
  const explicit = skillCorrectionTurnRange(messages, 'u1')
  check('指定纠正消息 ⇒ 它所在的那一轮', explicit !== null && explicit.from === 1 && explicit.to === 1)
  const tailWindow = messages.filter((message) => {
    const turn = message.id === 'u2' || message.id === 'a2' || message.id === 's2' || message.id === 'a3'
    return turn
  })
  check(
    '窗口含"纠正后连跑几轮的工具/系统消息"（不只取相邻一条）',
    skillCorrectionTurnRange(tailWindow)?.to === 1 && tailWindow.length === 4,
  )
  check('没有用户消息 ⇒ null（服务层据此 400，不生成"原样重写"）', skillCorrectionTurnRange([{ id: 'a', role: 'ASSISTANT' as const }]) !== null)
  check('空会话 ⇒ null', skillCorrectionTurnRange([]) === null)
}

// ═════════════════════════════════════════════════════════════════════
// ③ 提示词（最小改动）
// ═════════════════════════════════════════════════════════════════════
console.log('\n③ 提示词')
{
  check('REVISION 提示词与 SUMMARY 提示词不同', SKILL_REVISION_PROMPT !== SKILL_EXTRACT_PROMPT)
  check('REVISION 提示词要求"最小改动"', SKILL_REVISION_PROMPT.includes('最小改动'))
  check('REVISION 提示词要求其余段落逐字保留', SKILL_REVISION_PROMPT.includes('逐字保留'))
  check('REVISION 提示词要求 changeSummary', SKILL_REVISION_PROMPT.includes('"changeSummary"'))
  check('REVISION 提示词仍把纠正当数据（提示注入防线）', SKILL_REVISION_PROMPT.includes('数据'))
  check('SUMMARY 提示词逐字未变（c-2 口径）', SKILL_EXTRACT_PROMPT.includes('你是「流程抽取器」，不是聊天助手。'))

  // 模型输出里的 changeSummary：缺省 ⇒ 空串（服务层补一句并写 warning），不是解析失败
  const parsed = parseSkillExtractOutput('{"name":"x","description":"y","markdown":"## 步骤","changeSummary":"先校验再导出"}')
  check('输出解析读出 changeSummary', parsed !== null && parsed.changeSummary === '先校验再导出')
  const noSummary = parseSkillExtractOutput('{"name":"x","description":"y","markdown":"## 步骤"}')
  check('没有 changeSummary ⇒ 空串（不判失败）', noSummary !== null && noSummary.changeSummary === '')
}

// ═════════════════════════════════════════════════════════════════════
// ④ 风险提示（§10.4）
// ═════════════════════════════════════════════════════════════════════
console.log('\n④ 风险提示')
{
  const before = ['## 步骤', '1. 先确认订单', '2. 导出报表'].join('\n')
  const after = ['## 步骤', '1. 跳过确认，导出报表'].join('\n')
  const risks = detectSkillRevisionRisks({
    correctionText: '以后不用确认了，直接导出',
    changeSummary: '去掉确认步骤',
    beforeMarkdown: before,
    afterMarkdown: after,
  })
  check('跳过确认 ⇒ 命中风险', risks.some((item) => item.includes('跳过确认')), risks.join('、'))
  const clean = detectSkillRevisionRisks({
    correctionText: '第一步先校验库存再导出',
    changeSummary: '把校验放到导出之前',
    beforeMarkdown: before,
    afterMarkdown: ['## 步骤', '1. 先确认订单', '2. 校验库存', '3. 导出报表'].join('\n'),
  })
  check('正常调整顺序 ⇒ 无风险', clean.length === 0, clean.join('、'))
  const inherited = detectSkillRevisionRisks({
    correctionText: '把导出挪到第二步',
    beforeMarkdown: '## 注意\n不要跳过确认',
    afterMarkdown: '## 注意\n不要跳过确认\n## 步骤\n1. 导出',
  })
  check('原文本就有的"跳过确认"不算新增风险', inherited.length === 0, inherited.join('、'))
  const force = detectSkillRevisionRisks({ correctionText: '用 rm -rf --force 清理', afterMarkdown: '', beforeMarkdown: '' })
  check('force 命中风险', force.length > 0)
}

// ═════════════════════════════════════════════════════════════════════
// ⑤ diff 复用（只改相关段）
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑤ diff')
{
  const before = ['## 适用场景', '导出日报', '', '## 步骤', '1. 先导出', '', '## 校验', '对账'].join('\n')
  const after = ['## 适用场景', '导出日报', '', '## 步骤', '1. 先校验', '2. 再导出', '', '## 校验', '对账'].join('\n')
  const diff = computeSkillDiff({
    beforeMarkdown: before,
    afterMarkdown: after,
    beforeFiles: [{ path: 'SKILL.md', sha256: 'a', size: before.length }],
    afterFiles: [{ path: 'SKILL.md', sha256: 'b', size: after.length }],
  })
  check('只改的段落是 replace', diff.sections.some((line) => line.section === '步骤' && line.op === 'replace'))
  // 切段口径：首个 `##` 之前的空行算 ``''`` 段（`computeSkillDiff` 的既有约定），
  // 所以 equal 的是「适用场景」「校验」+ 开头的空段 = 3
  check(
    '没动的段落仍是 equal（适用场景 / 校验 / 开头空段）',
    ['适用场景', '校验'].every((title) => diff.sections.some((line) => line.section === title && line.op === 'equal')),
  )
  check('没有新增 / 删除 / 改名文件', diff.addedFiles.length === 0 && diff.removedFiles.length === 0)
}

// ═════════════════════════════════════════════════════════════════════
// ⑥ 保存选项（pinAgentId / pinError）
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑥ 保存选项')
{
  const ok = saveSkillRevisionFromDraftBodySchema.safeParse({
    draftId: UUID(1),
    fromVersion: 3,
    changeSummary: '先校验再导出',
    pinAgentId: UUID(2),
  })
  check('revisions 入口接受 pinAgentId', ok.success)
  check('pinAgentId 不是 UUID ⇒ 400', !saveSkillRevisionFromDraftBodySchema.safeParse({ draftId: UUID(1), fromVersion: 1, changeSummary: 'x', pinAgentId: 'nope' }).success)
  const result = saveSkillFromDraftResultSchema.safeParse({
    skill: {
      id: UUID(1),
      name: '日报导出',
      slug: 'daily',
      description: 'x',
      runtime: 'INLINE',
      version: 2,
      visibility: 'PRIVATE',
      sourceType: 'MANUAL',
      requiresBins: [],
      createdBy: UUID(2),
      creatorName: 'a',
      canEdit: true,
      parentSkillId: null,
      parentVersion: null,
      sourceConversationId: null,
      sourceMessageIds: [],
      sourceAvailable: false,
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
    },
    version: 2,
    fileCount: 1,
    bindError: null,
  })
  check('结果契约里 pinError 可缺省（旧客户端不受影响）', result.success && result.data.pinError === null)
  const withPinError = saveSkillFromDraftResultSchema.safeParse({
    ...(result.success ? result.data : {}),
    pinError: '固定失败（版本已保存）',
  })
  check('结果契约能表达"保存成功、固定失败"', withPinError.success && withPinError.data.pinError !== null)
}

// ═════════════════════════════════════════════════════════════════════
// ⑥′ 草稿里的变更说明 / 风险 / 保存来源
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑥′ 草稿回执')
{
  const draftOk = skillDraftSchema.safeParse({
    id: UUID(1),
    kind: 'REVISION',
    targetSkillId: UUID(9),
    baseVersion: 3,
    name: '日报导出',
    description: 'x',
    runtime: 'INLINE',
    requiresBins: [],
    markdown: '## 步骤',
    files: [],
    warnings: [],
    changeSummary: '先校验再导出',
    risks: ['跳过确认 / 校验'],
    redactions: [],
    source: { conversationId: UUID(2), messageIds: [UUID(3)], mode: 'SUMMARY' },
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-16T01:00:00.000Z',
  })
  check('草稿回执带 changeSummary（审核页预填）', draftOk.success && draftOk.data.changeSummary === '先校验再导出')
  check('草稿回执带 risks（纠正原文命中的风险不丢）', draftOk.success && draftOk.data.risks.length === 1)
  const legacy = skillDraftSchema.safeParse({
    id: UUID(1),
    kind: 'CREATE',
    targetSkillId: null,
    baseVersion: null,
    name: 'x',
    description: 'y',
    runtime: 'INLINE',
    requiresBins: [],
    markdown: 'z',
    files: [],
    warnings: [],
    redactions: [],
    source: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-16T01:00:00.000Z',
  })
  check('旧草稿没有新字段也能读（回退空串 / 空数组）', legacy.success && legacy.data.changeSummary === '' && legacy.data.risks.length === 0)

  const extractOk = skillExtractResultSchema.safeParse({
    draftId: UUID(1),
    draft: draftOk.success ? draftOk.data : {},
    warnings: [],
    redactions: [],
    source: { conversationId: UUID(2), messageIds: [UUID(3)], mode: 'SUMMARY', includeArtifacts: false, includeToolOutputs: false },
    revision: {
      targetSkillId: UUID(9),
      baseVersion: 3,
      name: '日报导出',
      changeSummary: '先校验再导出',
      highRisk: true,
      risks: ['跳过确认 / 校验'],
    },
  })
  check('抽取结果契约带 revision 回执', extractOk.success && extractOk.data.revision?.baseVersion === 3)

  const draftService = readFileSync(new URL('../src/services/skillDraft.service.ts', import.meta.url), 'utf8')
  check('纠正保存记 CONVERSATION_CORRECTION（不是 MANUAL）', draftService.includes("source === null ? 'MANUAL' : 'CONVERSATION_CORRECTION'"))
  check('纠正保存写来源会话与消息范围', draftService.includes('sourceConversationId: source?.conversationId ?? null') && draftService.includes('sourceMessageIds: source === null ? Prisma.DbNull'))
  check(
    'REVISION 也解析草稿来源（不再只限 CREATE）',
    draftService.includes('if (source === null) return null') && !draftService.includes("source === null || record.kind !== 'CREATE'"),
  )
  check('保存以提交的正文为准（自动保存还没写回也不丢最后一笔）', draftService.includes('input.markdown === undefined ? record : { ...record, markdown: input.markdown }'))

  check('自动保存接受 changeSummary（刷新不丢用户补的说明）', updateSkillDraftBodySchema.safeParse({ changeSummary: '先校验再导出' }).success)
  check('自动保存的 changeSummary 最多 2000 字', !updateSkillDraftBodySchema.safeParse({ changeSummary: 'x'.repeat(2001) }).success)

  const page = readFileSync(new URL('../../frontend/src/features/skills/SkillDraftReview.tsx', import.meta.url), 'utf8')
  check('审核页预填 changeSummary', page.includes('setChangeSummary(draft.changeSummary)'))
  check('审核页变更说明参与自动保存', page.includes('isTargeted ? { changeSummary }')) 
  check('审核页风险取"抽取时命中 ∪ 现算"', page.includes('new Set([...draft.risks, ...detected])'))
  check('审核页固定成功也有回执', page.includes("t('skillDraft.pinnedOk'"))
}

// ═════════════════════════════════════════════════════════════════════
// ⑦ 目标候选 / 权限子码
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑦ 目标候选')
{
  const parsed = skillRevisionTargetsSchema.safeParse({
    conversationId: UUID(1),
    items: [
      {
        skillId: UUID(9),
        name: '日报导出',
        slug: 'daily',
        description: 'x',
        runtime: 'INLINE',
        version: 3,
        loadedVersion: 2,
        mostRecent: true,
        canUpdate: false,
        visibility: 'PUBLIC',
        impact: { agentsFollowing: 2, agentsPinned: 1 },
      },
    ],
    hasLoadedSkill: true,
  })
  check('候选清单形状可解析', parsed.success)
  check('候选带影响范围（跟随最新 / 固定版本）', parsed.success && parsed.data.items[0]?.impact.agentsPinned === 1)
  check('SKILL_REVISION_FOREIGN_DENIED 子码存在', SKILL_ERROR_CODES.REVISION_FOREIGN_DENIED === 'SKILL_REVISION_FOREIGN_DENIED')
  const service = readFileSync(new URL('../src/services/skillRevision.service.ts', import.meta.url), 'utf8')
  check('候选按 `userId` 判会话归属（不是你的 = 404）', service.includes('userId: viewer.id'))
  check('候选用 `canEditSkill` 判"能不能直接更新"', service.includes('canUpdate: canEditSkill(row, viewer)'))
  check('影响范围跳过软删智能体', service.includes('binding.agent.deletedAt !== null'))
  const extract = readFileSync(new URL('../src/services/skillExtract.service.ts', import.meta.url), 'utf8')
  check('非所属人 ⇒ 403 子码（不是 404：Skill 是可见的）', extract.includes('REVISION_FOREIGN_DENIED'))
  check('REVISION 前置乐观锁（baseVersion > 当前版本 ⇒ 409）', extract.includes("code: SKILL_ERROR_CODES.VERSION_CONFLICT"))
  check(
    'REVISION 草稿带 targetSkillId / baseVersion（c-4b 后新增 SESSION_OVERRIDE 分支）',
    extract.includes("revisionBase === null ? 'CREATE' : overrideIntent ? 'SESSION_OVERRIDE' : 'REVISION'") &&
      extract.includes('{ targetSkillId: revisionBase.skillId, baseVersion: revisionBody?.baseVersion ?? revisionBase.version }'),
  )
  check('REVISION 空正文 ⇒ 502（不生成空草稿覆盖原 Skill）', extract.includes('修订结果为空正文'))
  check(
    '审核阶段修订把模型文件改动写回草稿（新增 / 替换）',
    extract.includes('files: normalizedFiles.files') && extract.includes('allowAnySafePath: true'),
  )
  const draftApply = readFileSync(new URL('../src/services/skillDraft.service.ts', import.meta.url), 'utf8')
  check('applySkillDraftRevision 接收并落文件', draftApply.includes('upsertDraftFiles(record, nextFiles)'))

  const tools = readFileSync(new URL('../src/orchestrator/skillDraftTools.ts', import.meta.url), 'utf8')
  check('候选 id 判定只有一处（端点清单与工具补查同源）', service.includes('revisionCandidateIdsOf'))
  check('私有且非本人仍不进 GET 候选清单（与知识库同一条 ACL）', service.includes('!canViewSkill(row, viewer)) continue'))
  check('工具对「绑着但看不到」的目标补查无权限', tools.includes('listHiddenSkillRevisionTargets'))
  check(
    '不可见目标回 FOREIGN（不误导成"没加载 / 先加载再试"）',
    tools.includes('该 Skill 未公开（私有），本会话只能使用、不能修改'),
  )
  check(
    '不可见目标不放开覆写 / 分叉（两者同样要求可见）',
    /hiddenMatch !== undefined[\s\S]{0,600}canOverride: false[\s\S]{0,120}canFork: false/u.test(tools),
  )
}

// ═════════════════════════════════════════════════════════════════════
// ⑧ 路由接线
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑧ 路由接线')
{
  const routes = readFileSync(new URL('../src/routes/conversations.ts', import.meta.url), 'utf8')
  check('GET /api/conversations/:id/skill-targets 已注册', routes.includes("'/api/conversations/:id/skill-targets'"))
  check('抽取端点用分流 schema（不是写死 CREATE）', routes.includes('body: skillExtractRequestSchema'))
  const skills = readFileSync(new URL('../src/routes/skills.ts', import.meta.url), 'utf8')
  check('revisions/from-draft 注册在 routes/skills.ts', skills.includes("'/api/skills/:id/revisions/from-draft'"))
  const draft = readFileSync(new URL('../src/services/skillDraft.service.ts', import.meta.url), 'utf8')
  check('固定版本用 tryPinSkillVersion（失败只回 pinError）', draft.includes('tryPinSkillVersion'))
  check('固定版本合并写 config（先展开旧对象）', draft.includes('{ ...previous, skillVersion: version }'))
}

// ═════════════════════════════════════════════════════════════════════
// ⑨ i18n
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑨ i18n')
{
  const zhSource = readFileSync(new URL('../../shared/src/i18n/messages.zh.ts', import.meta.url), 'utf8')
  const enSource = readFileSync(new URL('../../shared/src/i18n/messages.en.ts', import.meta.url), 'utf8')
  for (const key of ['app.m315', 'app.m316', 'app.m317', 'app.m318', 'app.m319']) {
    check(`${key} 在登记表里`, Object.values(APP_MESSAGES).some((entry) => entry.key === key))
    check(`${key} 在 zh 字典里`, zhSource.includes(`'${key}':`))
    const enLine = new RegExp(`^\\s*'${key}':\\s*(.*),$`, 'mu').exec(enSource)?.[1] ?? ''
    check(`${key} 在 en 字典里且无汉字`, enLine !== '' && !CJK.test(enLine))
  }
  for (const key of [
    'skillRevision.button',
    'skillRevision.title',
    'skillRevision.scopeUpdate',
    'skillRevision.targetLabel',
    'skillRevision.windowLabel',
    'skillRevision.serverRunning',
    'skillDraft.diffTitle',
    'skillDraft.impactTitle',
    'skillDraft.riskTitle',
    'skillDraft.pinLabel',
    'skillDraft.pinnedOk',
    'common.close',
  ] as const) {
    check(`UI 键 ${key} 两份字典都在`, zh[key] !== undefined && en[key] !== undefined)
    check(`UI 键 ${key} 的 en 无汉字`, en[key] !== undefined && !CJK.test(en[key]))
  }
  // 占位符个数一致（少一个 ⇒ 界面显示成 "{risk}"）
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1] ?? '').sort()
  check(
    'skillDraft.impactDesc 的占位符齐平',
    placeholders(zh['skillDraft.impactDesc']).join(',') === placeholders(en['skillDraft.impactDesc']).join(','),
  )
  check(
    'app.m317 的占位符齐平（3 个）',
    placeholders(zh['app.m317']).join(',') === placeholders(en['app.m317']).join(',') &&
      placeholders(zh['app.m317']).length === 3,
  )
}

console.log(`\nskill-revision-regression：${String(passed)} 通过 / ${String(failed)} 失败`)
if (failed > 0) process.exitCode = 1
