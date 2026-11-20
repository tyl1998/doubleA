/**
 * Skill 草稿入口工具（P1-24c-4c；`docs/子方案/会话生成Skill.md` §8.1.1）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个工具做什么（都**只产草稿或权限结果**，不保存、不绑定、不发布）
 * ─────────────────────────────────────────────────────────────────────
 * · `request_skill_draft`    —— 用户明确要求"把这段流程存成 Skill" ⇒ 生成 CREATE 草稿；
 * · `request_skill_revision` —— 用户明确要求"把这个 Skill 更新一下" ⇒ 生成 REVISION 草稿；
 *                               **先判 `canEditSkill` 再决定要不要调抽取模型**（非所属人不白烧模型）；
 * · `revise_skill_draft`     —— 审核阶段按用户意见修改**同一份草稿**（仍不保存）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四条口径（每条错了都只在运行期暴露）
 * ─────────────────────────────────────────────────────────────────────
 * ① **参数只收意图 / 目标 / 捕获范围**：不收 `messageIds` / `markdown` / patch —— 消息范围与正文
 *    由服务端按会话归属与草稿状态判定（模型不能替用户选一段别人看不到的会话）。
 * ② **工具失败不抛整轮错误**：所有异常都翻成结构化 `status + reason` 回给模型，由它用自然语言解释；
 *    真正权限拒绝仍以服务端判据为准（不靠模型自觉）。
 * ③ **目标必须在本会话候选内**：候选来自 `skillRevisionTargets`（本会话加载过 / 绑定过）；
 *    不在候选 ⇒ `TARGET_NOT_FOUND` + 候选清单，不生成草稿。点名的目标若是"绑着但对我不可见"
 *    （私有且非本人）⇒ 回 `FOREIGN`（没有权限），不再冒充"没加载 / 没绑定"。
 * ④ **非所属人只回 `FOREIGN`**：不调模型、不落草稿；提示卡动作位 `EDIT_IN_SESSION`（c-4b）
 *    与 `FORK`（c-5）均已可用。
 */

import {
  AppError,
  SKILL_ERROR_CODES,
  SKILL_EXTRACT_MAX_MESSAGES,
  isSkillRequestToolName,
  requestSkillDraftArgsSchema,
  requestSkillFromWorkspaceArgsSchema,
  requestSkillRevisionArgsSchema,
  reviseSkillDraftArgsSchema,
  skillCorrectionTurnRange,
  skillDraftToolResultSchema,
  skillErrorCodeOf,
  splitSkillExtractTurns,
  type SkillDraftToolResult,
  type SkillRequestToolName,
} from '@doubulea/shared'

import { parseToolArguments, type LlmTarget } from '../llm/client.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { MESSAGE_CHRONO_ORDER } from '../services/conversation.service.js'
import {
  extractSkillFromConversation,
  reviseSkillDraftFromInstruction,
} from '../services/skillExtract.service.js'
import {
  listHiddenSkillRevisionTargets,
  listSkillRevisionTargets,
} from '../services/skillRevision.service.js'
import { pushSkillDraftNotice } from '../services/skillDraftNotice.service.js'
import { createSkillDraftFromWorkspace } from '../services/skillWorkspaceDraft.service.js'
import type { SkillViewer } from '../services/skill.service.js'

/** 日志上下文（只用于 warn，不影响结果） */
export interface SkillDraftToolLogContext {
  conversationId?: string
  agentId?: string
}

/** 工具执行的统一出口：文本给模型，**恒不抛**（见文件头 ②） */
export interface SkillDraftToolOutcome {
  isError: boolean
  output: string
}

/** 这个工具名是不是草稿入口工具（ChatBot / TaskAgent 分流共用；与 `shared` 同一份名单） */
export function isSkillRequestTool(name: string): name is SkillRequestToolName {
  return isSkillRequestToolName(name)
}

/**
 * 这些状态是"工具正常给出了结论"，**不算调用失败**（卡片不标红、不进本轮失败核对）：
 * 草稿产出了，或明确告诉模型"没有权限 / 目标不在这" —— 它接着用自然语言解释即可。
 * 真正的失败只有 `INVALID` / `FAILED` / `DRAFT_NOT_FOUND`。
 */
const SKILL_DRAFT_TOOL_OK_STATUSES: readonly SkillDraftToolResult['status'][] = [
  'DRAFT_CREATED',
  'REVISED',
  'NO_CHANGE',
  'FOREIGN',
  'TARGET_NOT_FOUND',
]

function resultOf(partial: Partial<SkillDraftToolResult> & Pick<SkillDraftToolResult, 'status'>): SkillDraftToolResult {
  return skillDraftToolResultSchema.parse({
    kind: null,
    draftId: null,
    targetSkillId: null,
    targetName: null,
    fromVersion: null,
    toVersion: null,
    changeSummary: '',
    risks: [],
    reason: null,
    candidates: [],
    canOverride: false,
    canFork: false,
    ...partial,
  })
}

function outputOf(result: SkillDraftToolResult): string {
  return JSON.stringify(result, null, 2)
}

function issueOf(error: { issues: { message: string; path: (string | number)[] }[] }): string {
  const issue = error.issues[0]
  if (issue === undefined) return '参数不合法'
  const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}：`
  return `${where}${issue.message}`
}

function reasonOf(error: unknown): string {
  if (error instanceof AppError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

function statusOf(error: unknown): SkillDraftToolResult['status'] {
  if (error instanceof AppError && skillErrorCodeOf(error.data) === SKILL_ERROR_CODES.DRAFT_NOT_FOUND) {
    return 'DRAFT_NOT_FOUND'
  }
  if (error instanceof AppError) {
    const code = skillErrorCodeOf(error.data)
    if (code === SKILL_ERROR_CODES.REVISION_FOREIGN_DENIED) return 'FOREIGN'
    if (code === SKILL_ERROR_CODES.REVISION_NO_CHANGE) return 'NO_CHANGE'
  }
  return 'FAILED'
}

/** 取本会话消息（只 id / role；切轮次用；上限多取一条由服务层再判） */
async function messagesOf(conversationId: string): Promise<{ id: string; role: 'USER' | 'ASSISTANT' | 'SYSTEM' }[]> {
  return await getPrisma().message.findMany({
    where: { conversationId },
    select: { id: true, role: true },
    orderBy: [...MESSAGE_CHRONO_ORDER],
    take: SKILL_EXTRACT_MAX_MESSAGES + 1,
  })
}

async function noticeOfDraft(input: {
  conversationId: string
  kind: 'CREATE' | 'REVISION' | 'SESSION_OVERRIDE'
  draftId: string
  targetSkillId: string | null
  targetName: string | null
  fromVersion: number | null
  toVersion: number | null
  changeSummary: string
  risks: string[]
}): Promise<void> {
  await pushSkillDraftNotice(input.conversationId, {
    conversationId: input.conversationId,
    kind: input.kind,
    draftId: input.draftId,
    targetSkillId: input.targetSkillId,
    targetName: input.targetName,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    changeSummary: input.changeSummary,
    risks: input.risks,
    reason: null,
    actions: ['REVIEW', 'LET_AGENT_REVISE', 'DISMISS'],
    canOverride: false,
    canFork: false,
  })
}

/** `request_skill_draft`：生成 CREATE 草稿 */
async function runRequestSkillDraft(input: {
  conversationId: string
  viewer: SkillViewer
  arguments: string
  log: SkillDraftToolLogContext
  /** 本轮实际使用的模型；没配抽取模型时优先用它（2026-11-17 用户定案） */
  chatTarget?: LlmTarget
}): Promise<SkillDraftToolResult> {
  const parsed = parseToolArguments(input.arguments)
  if (!parsed.ok) return resultOf({ status: 'INVALID', reason: `参数不是合法 JSON：${parsed.reason}` })
  const args = requestSkillDraftArgsSchema.safeParse(parsed.value)
  if (!args.success) return resultOf({ status: 'INVALID', reason: issueOf(args.error) })

  const scope = args.data.scope ?? 'LAST_TURN'
  const messages = await messagesOf(input.conversationId)
  const turnRange = scope === 'LAST_TURN' ? skillCorrectionTurnRange(messages) : null
  const includeToolOutputs = args.data.includeToolOutputs === true
  const includeArtifacts = args.data.includeArtifacts === true
  const trace = includeToolOutputs || includeArtifacts

  try {
    const extracted = await extractSkillFromConversation(
      input.conversationId,
      {
        ...(turnRange === null ? {} : { turnRange }),
        ...(trace ? { mode: 'TRACE' as const } : {}),
        includeToolOutputs,
        includeArtifacts,
      },
      input.viewer,
      { chatTarget: input.chatTarget },
    )
    await noticeOfDraft({
      conversationId: input.conversationId,
      kind: 'CREATE',
      draftId: extracted.draftId,
      targetSkillId: null,
      targetName: null,
      fromVersion: null,
      toVersion: null,
      changeSummary: extracted.draft.changeSummary,
      risks: extracted.draft.risks,
    })
    getLogger().info(
      { conversationId: input.conversationId, draftId: extracted.draftId, scope, trace },
      'Agent 工具已生成 Skill 新建草稿',
    )
    return resultOf({
      status: 'DRAFT_CREATED',
      kind: 'CREATE',
      draftId: extracted.draftId,
      changeSummary: extracted.draft.changeSummary,
      risks: extracted.draft.risks,
    })
  } catch (error) {
    getLogger().warn({ err: error, conversationId: input.conversationId, agentId: input.log.agentId }, 'request_skill_draft 失败')
    return resultOf({ status: statusOf(error), reason: reasonOf(error) })
  }
}

/** `request_skill_revision`：先判归属，再决定是否调模型 */
async function runRequestSkillRevision(input: {
  conversationId: string
  viewer: SkillViewer
  arguments: string
  log: SkillDraftToolLogContext
  /** 本轮实际使用的模型；没配抽取模型时优先用它 */
  chatTarget?: LlmTarget
}): Promise<SkillDraftToolResult> {
  const parsed = parseToolArguments(input.arguments)
  if (!parsed.ok) return resultOf({ status: 'INVALID', reason: `参数不是合法 JSON：${parsed.reason}` })
  const args = requestSkillRevisionArgsSchema.safeParse(parsed.value)
  if (!args.success) return resultOf({ status: 'INVALID', reason: issueOf(args.error) })

  const targets = await listSkillRevisionTargets(input.conversationId, input.viewer)
  const wanted =
    args.data.targetSkillId !== undefined
      ? targets.items.find((item) => item.skillId === args.data.targetSkillId)
      : args.data.targetSlug !== undefined
        ? targets.items.find((item) => item.slug === args.data.targetSlug)
        : (targets.items.find((item) => item.mostRecent) ?? targets.items[0])
  if (wanted === undefined) {
    const hidden = await listHiddenSkillRevisionTargets(input.conversationId, input.viewer)
    const explicit = args.data.targetSkillId !== undefined || args.data.targetSlug !== undefined
    const hiddenMatch =
      args.data.targetSkillId !== undefined
        ? hidden.find((item) => item.skillId === args.data.targetSkillId)
        : args.data.targetSlug !== undefined
          ? hidden.find((item) => item.slug === args.data.targetSlug)
          : undefined
    if (hiddenMatch !== undefined) {
      return resultOf({
        status: 'FOREIGN',
        kind: 'REVISION',
        targetSkillId: hiddenMatch.skillId,
        targetName: hiddenMatch.name,
        fromVersion: hiddenMatch.version,
        reason: `你不是 Skill「${hiddenMatch.name}」的所属人，不能更新它的上游版本。该 Skill 未公开（私有），本会话只能使用、不能修改；如需修改请联系所属人（或由所属人把可见范围改为公开）。`,
        canOverride: false,
        canFork: false,
      })
    }
    if (!explicit && targets.items.length === 0 && hidden.length > 0) {
      return resultOf({
        status: 'FOREIGN',
        kind: 'REVISION',
        reason: '本会话在用、但都不属于你的 Skill（且未公开），不能更新上游版本；如需修改请联系所属人。',
        canOverride: false,
        canFork: false,
      })
    }
    return resultOf({
      status: 'TARGET_NOT_FOUND',
      kind: 'REVISION',
      reason:
        targets.items.length === 0
          ? '本会话还没有加载或绑定任何 Skill。如果要新建，请用 request_skill_draft。'
          : '指定的 Skill 不在本会话候选里（本会话没有加载过它，它也没有绑在本会话的智能体上）。',
      candidates: targets.items.map((item) => ({ skillId: item.skillId, name: item.name, slug: item.slug })),
    })
  }

  const overrideIntent = args.data.mode === 'OVERRIDE'

  // ★ 口径 ④：非所属人**不调抽取模型**（UPSTREAM 时才拦；OVERRIDE 是明示的"只改本会话"）
  if (!wanted.canUpdate && !overrideIntent) {
    await pushSkillDraftNotice(input.conversationId, {
      conversationId: input.conversationId,
      kind: 'FOREIGN',
      draftId: null,
      targetSkillId: wanted.skillId,
      targetName: wanted.name,
      fromVersion: wanted.version,
      toVersion: null,
      changeSummary: '',
      risks: [],
      reason: `你不是 Skill「${wanted.name}」的所属人，不能直接更新上游版本。`,
      actions: ['EDIT_IN_SESSION', 'FORK', 'DISMISS'],
      canOverride: true,
      canFork: true,
    })
    return resultOf({
      status: 'FOREIGN',
      kind: 'REVISION',
      targetSkillId: wanted.skillId,
      targetName: wanted.name,
      fromVersion: wanted.version,
      reason: `你不是 Skill「${wanted.name}」的所属人。可以「只改本会话的 Skill」（会话级覆写，不改上游），或「复制为我的 Skill」（保存为你的副本后再改），也可以取消。`,
      canOverride: true,
      canFork: true,
    })
  }

  const scope = args.data.scope ?? 'CORRECTION'
  let turnRange: { from: number; to: number } | undefined
  if (scope === 'WHOLE') {
    const messages = await messagesOf(input.conversationId)
    const turns = splitSkillExtractTurns(messages)
    const last = turns[turns.length - 1]
    if (last !== undefined) turnRange = { from: 1, to: last.turn }
  }
  const includeToolOutputs = args.data.includeToolOutputs === true
  const includeArtifacts = args.data.includeArtifacts === true
  const trace = includeToolOutputs || includeArtifacts
  const instruction = args.data.instruction?.trim() ?? ''

  try {
    const extracted = await extractSkillFromConversation(
      input.conversationId,
      {
        targetSkillId: wanted.skillId,
        baseVersion: wanted.version,
        ...(overrideIntent ? { intent: 'OVERRIDE' as const } : {}),
        ...(instruction === '' ? {} : { instruction }),
        ...(turnRange === undefined ? {} : { turnRange }),
        ...(trace ? { mode: 'TRACE' as const } : {}),
        includeToolOutputs,
        includeArtifacts,
      },
      input.viewer,
      { chatTarget: input.chatTarget },
    )
    const revision = extracted.revision
    await noticeOfDraft({
      conversationId: input.conversationId,
      kind: overrideIntent ? 'SESSION_OVERRIDE' : 'REVISION',
      draftId: extracted.draftId,
      targetSkillId: wanted.skillId,
      targetName: revision?.name ?? wanted.name,
      fromVersion: revision?.baseVersion ?? wanted.version,
      toVersion: overrideIntent ? null : (revision?.baseVersion ?? wanted.version) + 1,
      changeSummary: revision?.changeSummary ?? extracted.draft.changeSummary,
      risks: revision?.risks ?? extracted.draft.risks,
    })
    getLogger().info(
      {
        conversationId: input.conversationId,
        draftId: extracted.draftId,
        targetSkillId: wanted.skillId,
        scope,
        trace,
      },
      'Agent 工具已生成 Skill 更新草稿',
    )
    return resultOf({
      status: 'DRAFT_CREATED',
      kind: overrideIntent ? 'SESSION_OVERRIDE' : 'REVISION',
      draftId: extracted.draftId,
      targetSkillId: wanted.skillId,
      targetName: revision?.name ?? wanted.name,
      fromVersion: revision?.baseVersion ?? wanted.version,
      toVersion: overrideIntent ? null : (revision?.baseVersion ?? wanted.version) + 1,
      changeSummary: revision?.changeSummary ?? extracted.draft.changeSummary,
      risks: revision?.risks ?? extracted.draft.risks,
      overrideRevision: extracted.draft.expectedRevision,
    })
  } catch (error) {
    const status = statusOf(error)
    getLogger().warn(
      { err: error, conversationId: input.conversationId, targetSkillId: wanted.skillId },
      status === 'NO_CHANGE' ? 'request_skill_revision 未产生改动（不生成草稿）' : 'request_skill_revision 失败',
    )
    return resultOf({
      status,
      kind: overrideIntent ? 'SESSION_OVERRIDE' : 'REVISION',
      targetSkillId: wanted.skillId,
      targetName: wanted.name,
      fromVersion: wanted.version,
      reason: reasonOf(error),
    })
  }
}

/**
 * 工作区导入的失败分类：路径 / 包 / 草稿形状问题都属于"模型可以换个 path 再试"，
 * 回 `INVALID`；其余（DB / S3 / FS 异常）回 `FAILED`。
 */
function workspaceErrorStatusOf(error: unknown): 'INVALID' | 'FAILED' {
  if (error instanceof AppError) {
    const code = skillErrorCodeOf(error.data)
    if (code === SKILL_ERROR_CODES.IMPORT_INVALID || code === SKILL_ERROR_CODES.DRAFT_INVALID) return 'INVALID'
    if (error.code === 'VALIDATION' || error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN') return 'INVALID'
  }
  return 'FAILED'
}

/** `request_skill_from_workspace`：TaskAgent 从工作区目录 / zip 生成 CREATE 草稿 */
async function runRequestSkillFromWorkspace(input: {
  conversationId: string
  agentId: string
  viewer: SkillViewer
  arguments: string
  log: SkillDraftToolLogContext
}): Promise<SkillDraftToolResult> {
  const parsed = parseToolArguments(input.arguments)
  if (!parsed.ok) return resultOf({ status: 'INVALID', reason: `参数不是合法 JSON：${parsed.reason}` })
  const args = requestSkillFromWorkspaceArgsSchema.safeParse(parsed.value)
  if (!args.success) return resultOf({ status: 'INVALID', reason: issueOf(args.error) })

  const agent = await getPrisma().agent.findUnique({
    where: { id: input.agentId },
    select: { type: true },
  })
  if (agent === null || agent.type !== 'TASK_AGENT') {
    return resultOf({
      status: 'INVALID',
      kind: 'CREATE',
      reason: 'request_skill_from_workspace 只支持任务型智能体（TaskAgent）；ChatBot 没有工作区，请用 request_skill_draft。',
    })
  }

  try {
    const created = await createSkillDraftFromWorkspace({
      conversationId: input.conversationId,
      path: args.data.path,
      ...(args.data.titleHint === undefined ? {} : { titleHint: args.data.titleHint }),
      viewer: input.viewer,
    })
    const changeSummary = `已从工作区 ${args.data.path} 生成草稿（${String(created.fileCount)} 个附加文件，运行时 ${created.runtime.toLowerCase()}）`
    await noticeOfDraft({
      conversationId: input.conversationId,
      kind: 'CREATE',
      draftId: created.draftId,
      targetSkillId: null,
      targetName: null,
      fromVersion: null,
      toVersion: null,
      changeSummary,
      risks: [],
    })
    getLogger().info(
      {
        conversationId: input.conversationId,
        draftId: created.draftId,
        path: args.data.path,
        runtime: created.runtime,
        fileCount: created.fileCount,
      },
      'Agent 工具已从工作区生成 Skill 新建草稿',
    )
    return resultOf({
      status: 'DRAFT_CREATED',
      kind: 'CREATE',
      draftId: created.draftId,
      changeSummary,
      risks: [],
    })
  } catch (error) {
    const status = workspaceErrorStatusOf(error)
    getLogger().warn(
      { err: error, conversationId: input.conversationId, agentId: input.agentId, path: args.data.path },
      'request_skill_from_workspace 失败',
    )
    return resultOf({ status, kind: 'CREATE', reason: reasonOf(error) })
  }
}

/** `revise_skill_draft`：按用户意见修改同一份草稿 */
async function runReviseSkillDraft(input: {
  conversationId: string
  viewer: SkillViewer
  arguments: string
  log: SkillDraftToolLogContext
  /** 本轮实际使用的模型；没配抽取模型时优先用它 */
  chatTarget?: LlmTarget
}): Promise<SkillDraftToolResult> {
  const parsed = parseToolArguments(input.arguments)
  if (!parsed.ok) return resultOf({ status: 'INVALID', reason: `参数不是合法 JSON：${parsed.reason}` })
  const args = reviseSkillDraftArgsSchema.safeParse(parsed.value)
  if (!args.success) return resultOf({ status: 'INVALID', reason: issueOf(args.error) })

  try {
    const revised = await reviseSkillDraftFromInstruction({
      draftId: args.data.draftId,
      instruction: args.data.instruction,
      scope: args.data.scope,
      viewer: input.viewer,
      chatTarget: input.chatTarget,
    })
    const draft = revised.draft
    const kind = draft.kind === 'REVISION' ? 'REVISION' : draft.kind === 'SESSION_OVERRIDE' ? 'SESSION_OVERRIDE' : 'CREATE'
    await noticeOfDraft({
      conversationId: input.conversationId,
      kind,
      draftId: draft.id,
      targetSkillId: draft.targetSkillId,
      targetName: draft.kind === 'CREATE' ? null : draft.name,
      fromVersion: draft.baseVersion,
      toVersion: draft.kind === 'REVISION' ? (draft.baseVersion ?? 1) + 1 : null,
      changeSummary: revised.changeSummary,
      risks: revised.risks,
    })
    return resultOf({
      status: 'REVISED',
      kind,
      draftId: draft.id,
      targetSkillId: draft.targetSkillId,
      targetName: draft.kind === 'CREATE' ? null : draft.name,
      fromVersion: draft.baseVersion,
      toVersion: draft.kind === 'REVISION' ? (draft.baseVersion ?? 1) + 1 : null,
      changeSummary: revised.changeSummary,
      risks: revised.risks,
      overrideRevision: draft.expectedRevision,
    })
  } catch (error) {
    const status = statusOf(error)
    getLogger().warn(
      { err: error, conversationId: input.conversationId, draftId: args.data.draftId },
      status === 'NO_CHANGE' ? 'revise_skill_draft 未产生改动（草稿保持原样）' : 'revise_skill_draft 失败',
    )
    return resultOf({ status, draftId: args.data.draftId, reason: reasonOf(error) })
  }
}

/** 按工具名分流（新增入口工具时只改这一处） */
async function runSkillDraftTool(
  name: SkillRequestToolName,
  input: {
    conversationId: string
    agentId: string
    viewer: SkillViewer
    arguments: string
    log: SkillDraftToolLogContext
    chatTarget?: LlmTarget
  },
): Promise<SkillDraftToolResult> {
  switch (name) {
    case 'request_skill_draft':
      return await runRequestSkillDraft(input)
    case 'request_skill_revision':
      return await runRequestSkillRevision(input)
    case 'request_skill_from_workspace':
      return await runRequestSkillFromWorkspace(input)
    case 'revise_skill_draft':
      return await runReviseSkillDraft(input)
    default:
      return resultOf({ status: 'INVALID', reason: `不支持的 Skill 草稿工具：${name}` })
  }
}

/**
 * 执行一次草稿入口工具（**恒不抛**：失败也是 `isError:true` + 结构化结果）。
 *
 * ⚠️ `"失败"` 只指调用本身出错（见 {@link SKILL_DRAFT_TOOL_OK_STATUSES}）：权限 / 目标类结论
 * 是正常返回值，不当 ERROR —— 否则同一轮里"先 FOREIGN 再成功建草稿"会在收尾时误报本轮失败。
 * ⚠️ `name` 必须是 {@link isSkillRequestTool} 认的名字；调用方已按它分流。
 */
export async function executeSkillDraftTool(input: {
  conversationId: string
  agentId: string
  name: SkillRequestToolName
  /** 模型给的 `arguments` **原文**（JSON 串） */
  arguments: string
  viewer: SkillViewer
  /** 本轮实际使用的模型；没配抽取模型时优先用它 */
  chatTarget?: LlmTarget
  log?: SkillDraftToolLogContext
}): Promise<SkillDraftToolOutcome> {
  const log = input.log ?? { conversationId: input.conversationId, agentId: input.agentId }
  try {
    const result = await runSkillDraftTool(input.name, { ...input, log })
    return {
      // `FOREIGN` / `TARGET_NOT_FOUND` 是**工具正常给出的结论**（权限拒绝 / 目标不合法），
      // 不是调用失败。把它们算成 ERROR 会让同一轮的 `failedToolNamesOf` 冒出"本轮有工具调用
      // 没有成功执行"——即使紧接着的同名调用已经成功建了草稿（用户看到的"成功但本轮失败"）。
      isError: !SKILL_DRAFT_TOOL_OK_STATUSES.includes(result.status),
      output: outputOf(result),
    }
  } catch (error) {
    getLogger().warn({ err: error, ...log, toolName: input.name }, 'Skill 草稿入口工具执行失败（已作为错误结果回填）')
    return {
      isError: true,
      output: outputOf(resultOf({ status: 'FAILED', reason: reasonOf(error) })),
    }
  }
}
