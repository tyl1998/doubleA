/**
 * 平台内置「记忆」工具（P1-8a · v2）—— agent 主动**写**（remember）与**按需读**（recall_memory）
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §8.3（AGENT 记忆由模型决定）/§8.4（按需检索）/
 *      §8.5b（反幻觉）；`shared/src/memory.ts#REMEMBER_TOOL_NAME/RECALL_MEMORY_TOOL_NAME`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条调用路径、同一个执行体（与知识库一族同款）
 * ─────────────────────────────────────────────────────────────────────
 *   · ChatBot（`orchestrator/chatBot.ts`）在工具循环里直接调；
 *   · TaskAgent（沙箱里的 pi 引擎）经 `/api/sandbox/builtin/call` 代理调**同一个**函数。
 * 主语（`user_id`）恒来自**会话行**（现查），不从模型参数取 —— 模型只给"记什么 / 查什么"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * v2 的两条口径
 * ─────────────────────────────────────────────────────────────────────
 *   · `remember(scope)`：默认 `USER`（全局画像）；`AGENT` 落**当前会话的 Agent**（模型认为"这是与这个
 *     agent 的重点"时用）。这正是"AGENT 记忆由模型自己决定"的落点（§8.3）。
 *   · `recall_memory(query, scope?)`：**按需检索**，`scope` 缺省 = USER + 本 Agent；未命中返回
 *     **显式文案**（反幻觉，§8.5b）。
 */

import {
  AppError,
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  MEMORY_KINDS,
  MEMORY_RECALL_TOPK_DEFAULT,
  MEMORY_SCOPES,
  MEMORY_TOOL_TEXT_MAX,
  RECALL_MEMORY_TOOL_NAME,
  REMEMBER_TOOL_NAME,
  type MemoryKind,
  type MemoryScope,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { parseToolArguments } from '../llm/client.js'
import { getMemorySettings, insertMemory, pushMemoryNotice, recallMemories } from '../services/memory.service.js'
import type { OpenAiFunctionTool } from '../mcp/toolSchema.js'

/** v2 kind 默认值：全局按 `PROFILE`、Agent 专属按 `HIGHLIGHT`（§8.2） */
function defaultKind(scope: MemoryScope): MemoryKind {
  return scope === 'AGENT' ? 'HIGHLIGHT' : 'PROFILE'
}

/** 归一 `kind` / `scope` 参数：非法值一律回落（不因一个词让整条记录失败） */
function normalizeKind(value: unknown, scope: MemoryScope): MemoryKind {
  if (typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)) {
    return value as MemoryKind
  }
  return defaultKind(scope)
}
function normalizeScope(value: unknown): MemoryScope {
  if (typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)) {
    return value as MemoryScope
  }
  return 'USER'
}

/**
 * 「记住」工具（OpenAI 形态定义，**与 bot 类型无关、始终下发**）。
 *
 * 为什么必须有它：模型"看不见"长期记忆写入通道 —— 只有告诉它、并给一个明确动作，
 * 它才可能把"以后都用中文回答"（USER 画像）或"这个问题已定位为 X"（AGENT 重点）主动记下来。
 */
export function rememberTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    function: {
      name: REMEMBER_TOOL_NAME,
      description:
        '把一条值得跨会话长期保留的信息记入记忆。' +
        'scope=USER（默认）：关于**用户本人**的稳定事实/偏好/习惯（跨所有对话通用）；' +
        'scope=AGENT：与**当前这个 agent** 相关的重点/结论（例如某问题已定位为 X）。' +
        '不要记一次性的、或仅本轮对话相关的内容；不要把凭据/密钥/个人隐私写进去。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容（一句陈述句，尽量精简）' },
          scope: {
            type: 'string',
            enum: [...MEMORY_SCOPES],
            description: 'USER=全局（默认，关于用户的画像）；AGENT=仅当前 agent 的重点。',
          },
          kind: {
            type: 'string',
            enum: [...MEMORY_KINDS],
            description: '记忆类型；省略时按 scope 取默认（USER→PROFILE，AGENT→HIGHLIGHT）。',
          },
        },
        required: ['text'],
      },
    },
  }
}

/**
 * 「按需检索记忆」工具（v2 新增）。
 *
 * AGENT 记忆不再每轮注入正文（常驻只有一行目录 TOC）—— 需要某条细节时由模型调用本工具拉取，
 * 类似"翻记录"（人的类比见 §8.4b）。
 */
export function recallMemoryTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    function: {
      name: RECALL_MEMORY_TOOL_NAME,
      description:
        '按关键词检索与该用户 / 当前 agent 相关的长期记忆**细节**（会话目录里只列了主题，细节要用它查）。' +
        '当需要回忆"之前聊过什么/做过什么/用户的偏好"时调用；**没有命中就如实说没有，不要凭印象编造**。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要检索的关键词或问题' },
          scope: {
            type: 'string',
            enum: [...MEMORY_SCOPES],
            description: 'USER=只看全局画像；AGENT=只看当前 agent 的重点；省略=两者都查。',
          },
          topK: { type: 'number', description: `返回条数（默认 ${MEMORY_RECALL_TOPK_DEFAULT}）` },
        },
        required: ['query'],
      },
    },
  }
}

/**
 * 执行一次「记住」工具。**恒不抛**：失败翻成模型读得懂的 `isError`（同 `executeKnowledgeTool`）。
 *
 * `over-limit` 会明确告诉模型"已达上限、请提醒用户整理"，让模型把这件事**说给用户**（HCI §5.5）。
 */
export async function executeMemoryTool(input: {
  userId: string
  /** 当前会话的 Agent（`scope=AGENT` 时落它；`null` 时不能记 AGENT） */
  agentId: string | null
  conversationId: string
  arguments: string
}): Promise<{ isError: boolean; output: string }> {
  const logger = getLogger()
  try {
    const parsed = parseToolArguments(input.arguments)
    if (!parsed.ok) {
      return { isError: true, output: `工具调用失败：${parsed.reason}。` }
    }
    const raw = typeof parsed.value['text'] === 'string' ? parsed.value['text'].trim() : ''
    if (raw === '') {
      return { isError: true, output: '工具调用失败：缺少 text 参数（请给出要记住的内容）。' }
    }
    const chars = [...raw]
    const text = chars.length > MEMORY_TOOL_TEXT_MAX ? chars.slice(0, MEMORY_TOOL_TEXT_MAX).join('') : raw
    const scope = normalizeScope(parsed.value['scope'])
    if (scope === 'AGENT' && input.agentId === null) {
      return { isError: true, output: '工具调用失败：本会话没有关联的 Agent，无法记入 Agent 记忆（可用 scope=USER）。' }
    }
    // 总开关关掉 ⇒ 拒绝写入（HCI：关掉后既不注入也不写入）
    const settings = await getMemorySettings(input.userId)
    if (!settings.enabled) {
      return { isError: true, output: '长期记忆总开关已关闭（用户关闭），本次未写入。' }
    }
    // 会话级「不记入记忆」⇒ 也拒绝**模型主动**写入（用户显式"记住：…"走后端解析、不受此限，见 §8.4）
    const conversationRow = await getPrisma().conversation.findUnique({
      where: { id: input.conversationId },
      select: { memoryExcluded: true },
    })
    if (conversationRow?.memoryExcluded === true) {
      return {
        isError: true,
        output: '本次对话已被设为「不记入记忆」，本次未写入。若确实要记，请让用户明确说「记住：…」。',
      }
    }
    const kind = normalizeKind(parsed.value['kind'], scope)

    const result = await insertMemory({
      userId: input.userId,
      agentId: scope === 'AGENT' ? input.agentId : null,
      kind,
      text,
      sourceConversationId: input.conversationId,
    })
    if (result.created === null) {
      if (result.reason === 'over-limit') {
        return {
          isError: true,
          output: '记忆条目已达上限，本次未写入。请提示用户在「任务中心 · 记忆」里整理后再记。',
        }
      }
      return { isError: true, output: '记入记忆失败（内容为空或系统异常）。' }
    }
    await pushMemoryNotice(input.conversationId, {
      kind: 'AUTO',
      memoryId: result.created.id,
      text: result.created.text,
      memoryKind: kind,
      memoryScope: scope,
    })
    const where = scope === 'AGENT' ? '该 Agent 记忆' : '全局记忆'
    return { isError: false, output: `已记入${where}：[${kind}] ${text}` }
  } catch (error) {
    logger.warn({ err: error, userId: input.userId }, '内置记忆工具执行失败（已作为错误结果回填）')
    return {
      isError: true,
      output: `工具调用失败：${error instanceof AppError ? error.message : DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL}`,
    }
  }
}

/** 执行一次「按需检索记忆」工具。**恒不抛**（失败翻成 `isError`）。 */
export async function executeRecallMemoryTool(input: {
  userId: string
  agentId: string
  arguments: string
}): Promise<{ isError: boolean; output: string }> {
  const logger = getLogger()
  try {
    const parsed = parseToolArguments(input.arguments)
    if (!parsed.ok) return { isError: true, output: `工具调用失败：${parsed.reason}。` }
    const query = typeof parsed.value['query'] === 'string' ? parsed.value['query'].trim() : ''
    if (query === '') {
      return { isError: true, output: '工具调用失败：缺少 query 参数（请给出要检索的关键词）。' }
    }
    const scopeRaw = parsed.value['scope']
    const scope =
      typeof scopeRaw === 'string' && (MEMORY_SCOPES as readonly string[]).includes(scopeRaw)
        ? (scopeRaw as MemoryScope)
        : undefined
    const topKRaw = parsed.value['topK']
    const topK = typeof topKRaw === 'number' && Number.isFinite(topKRaw) ? Math.floor(topKRaw) : undefined
    const result = await recallMemories({
      userId: input.userId,
      agentId: input.agentId,
      query,
      ...(scope === undefined ? {} : { scope }),
      ...(topK === undefined ? {} : { topK }),
    })
    return { isError: false, output: result.text }
  } catch (error) {
    logger.warn({ err: error, userId: input.userId }, '记忆检索工具执行失败（已作为错误结果回填）')
    return {
      isError: true,
      output: `工具调用失败：${error instanceof AppError ? error.message : DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL}`,
    }
  }
}
