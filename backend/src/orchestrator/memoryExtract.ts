/**
 * 长期记忆的**自动写入与提示**（P1-8 · L2 · 后端收尾）—— 一轮对话结束后的提取
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §4.2（准入准则：分档 + 用户可控）/
 *      §5.3（关键流程：自动事实 toast 晚一拍 / 偏好建议卡 / 显式指令最高优先）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 写入**只在后端**、与 bot 类型无关
 * ─────────────────────────────────────────────────────────────────────
 * ChatBot 与 TaskAgent 的收尾都调 {@link runMemoryExtraction}（用户消息与助手消息都已落库）——
 * 于是"这里记住、那里忘了"不会发生（§4.5：写入与注入解耦、主语唯一）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② ★ 显式"记住"走**模型归一**，其余仍是规则式（如实写明的边界）
 * ─────────────────────────────────────────────────────────────────────
 *   · **显式指令**（"记住：…" / "把 X 记住" / "忘掉 X"）—— 最高优先、任何开关下都生效。
 *     "记住"这一类**交给模型归一**（`memoryProfile.ts`）：把用户意图压成"关于用户的陈述"并判 kind，
 *     **非陈述（命令/疑问/与用户无关）不写** —— 初版把"记住"之后的原文直接当画像落库，实测把问句
 *     `为什么记的东西那么奇怪？` 写进了用户画像（见 `memoryProfile.ts` 文件头）。模型不可用/失败时
 *     退回**保守规则式**（{@link extractRememberCandidates}：按句切分 + "把 X 记住" + 疑问句过滤）。
 *   · **偏好/指令**（"以后都…" / "每次…" / "不要再…"）—— 默认出**建议卡**；开了「全自动」才直接写。
 * 其余"悄悄自动抽取事实"**本批不做**：一个不可靠的自动抽取器会往用户画像里塞噪声。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 敏感永不自动、失败不外抛
 * ─────────────────────────────────────────────────────────────────────
 *   · 只在"用户显式说记住"时才写（显式路径）；不猜敏感内容 ⇒ 不自动写敏感（HCI §4.2）。
 *   · 整个提取包在 try/catch 里：提取失败不该影响任何一轮对话（记忆是**赠品**）。
 */

import { getLogger } from '../infra/logger.js'
import { forgetMemoriesMatching, insertMemory, pushMemoryNotice } from '../services/memory.service.js'
import { resolveChatTarget } from '../services/model.service.js'
import {
  extractMemoryProfileStatements,
  extractRememberCandidates,
  hasRememberMarker,
  REMEMBER_MARKERS,
  textAfterMarker,
  type ProfileStatement,
  type UserStatementKind,
} from './memoryProfile.js'

/** {@link runMemoryExtraction} 的入参（窄到只列判定要用的字段） */
export interface RunMemoryExtractionInput {
  conversationId: string
  userId: string
  agentId: string | null
  /** 本轮用户消息正文（已 trim） */
  userText: string
  /** 本轮助手回答正文（本批不用它做抽取，留作将来模型抽取的输入） */
  assistantText: string
  /** 记忆总开关（关 = 既不提取也不提示） */
  enabled: boolean
  /** 自动提取开关（关 = 只有显式"记住"才写） */
  autoExtract: boolean
  /** 「全自动」开关（偏好类不再逐条确认、直接写） */
  fullAuto: boolean
  /** 会话级「不记入记忆」（true = 不自动写入；**显式指令仍最高优先**） */
  conversationExcluded: boolean
  /**
   * 本轮实际使用的对话模型 id（画像模型归一要用它解析上游目标）。
   * `null`/缺省 ⇒ 无法归一，显式"记住"退回**保守规则式**（见文件头 ②）。
   */
  modelId?: string | null
}

/** "忘掉"类标记 */
const FORGET_MARKERS = ['忘掉', '忘记', '别记', '不要记', '不用记'] as const

/** 指代性的"这个/这条"（作为忘掉对象时无法定位到具体条目 ⇒ 忽略） */
const FORGET_PRONOUNS = new Set(['这个', '这条', '那条', '那一条', '它', '此', '这一条'])

/** 偏好/指令的高置信信号（命中任意一个即视为"会改变未来行为"的偏好） */
const PREFERENCE_PATTERNS: readonly RegExp[] = [
  /以后(都|一律|全部|一直|每次)/u,
  /每次(都|请|要)/u,
  /请?一直/u,
  /始终/u,
  /默认(用|按|是|走)/u,
  /不要再/u,
  /不许/u,
  /别再用?/u,
  /从现在起/u,
  /我的?[\u4e00-\u9fa5A-Za-z]{1,12}(是|为)/u,
]

/** 判断一句话是不是"偏好/指令"类（决定写入类型与是否需要确认） */
export function looksLikePreference(text: string): boolean {
  return PREFERENCE_PATTERNS.some((pattern) => pattern.test(text))
}

/** 从用户消息里解析显式指令（"记住 X" / "忘掉 Y"） */
export function extractExplicitInstructions(userText: string): {
  remembers: string[]
  forgets: string[]
} {
  const remembers: string[] = []
  const forgets: string[] = []
  for (const rawLine of userText.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const remember = textAfterMarker(line, REMEMBER_MARKERS)
    if (remember !== null) remembers.push(remember)
    const forget = textAfterMarker(line, FORGET_MARKERS)
    if (forget !== null && !FORGET_PRONOUNS.has(forget)) forgets.push(forget)
  }
  return { remembers, forgets }
}

/**
 * 一轮对话结束后的记忆提取（**恒不抛**；由 ChatBot / TaskAgent 的收尾调用）。
 *
 * 顺序即优先级（§5.3）：显式指令 > 偏好建议 > （本批无自动事实）。
 */
export async function runMemoryExtraction(input: RunMemoryExtractionInput): Promise<void> {
  if (!input.enabled) return
  try {
    const explicit = extractExplicitInstructions(input.userText)

    // ── ① 显式"忘掉 X"（任何开关下都生效；用户显式指令最高优先）──
    for (const needle of explicit.forgets) {
      const removed = await forgetMemoriesMatching(input.userId, needle)
      getLogger().debug(
        { conversationId: input.conversationId, removed, needle },
        '用户显式"忘掉"，已删除匹配的长期记忆',
      )
    }

    // ── ② 显式"记住"（最高优先：会话级豁免、自动开关关，都拦不住用户明说要记）──
    // ⚠️ v2（P1-8a）：后端提取**只写 USER 画像**（`agentId=null`）。AGENT 记忆改由**模型自己决定**
    //    （`remember(scope=AGENT)`，§8.3），不再在这里规则式抽取。
    // ⚠️ **非阻塞**：模型归一是一次上游调用（秒级），绝不能拖慢本轮收尾（见文件头 ② / §5.3"抽取
    //    不拖慢收尾"）⇒ 写库与提示在后台完成，提示本就"晚一拍"（下一轮/聚焦时被前端拉走）。
    if (hasRememberMarker(input.userText)) {
      // `writeExplicitMemories` 自身恒不抛；`.catch` 只是"后台任务绝不留未处理拒绝"的保险
      void writeExplicitMemories(input).catch(() => {})
      return
    }

    // ── ③ 偏好检测（USER 画像；仅在自动提取开启、且会话未豁免时）──
    if (!input.autoExtract || input.conversationExcluded) return
    const candidate = input.userText.trim()
    if (candidate === '' || !looksLikePreference(candidate)) return

    if (input.fullAuto) {
      const result = await insertMemory({
        userId: input.userId,
        agentId: null,
        kind: 'PREFERENCE',
        text: candidate,
        sourceConversationId: input.conversationId,
      })
      if (result.created !== null) {
        await pushMemoryNotice(input.conversationId, {
          kind: 'AUTO',
          memoryId: result.created.id,
          text: result.created.text,
          memoryKind: 'PREFERENCE',
          memoryScope: 'USER',
        })
      }
      return
    }

    // 默认：出**建议卡**（尚未写入；用户点"记住"时才落库，HCI §5.3）
    await pushMemoryNotice(input.conversationId, {
      kind: 'SUGGEST',
      memoryId: null,
      text: candidate,
      memoryKind: 'PREFERENCE',
      memoryScope: 'USER',
    })
  } catch (error) {
    getLogger().warn(
      { err: error, conversationId: input.conversationId },
      '长期记忆自动提取失败（已忽略，不影响本轮）',
    )
  }
}

// ═════════════════════════════ 显式"记住"：模型归一（后台，非阻塞） ═════════════════════════════

/**
 * 显式"记住"的**后台**写入（见文件头 ②；由 ② 处 `void` 调用，不阻塞收尾）。
 *
 * 优先让模型把用户意图归一成"关于用户的陈述"（`memoryProfile.ts`）；模型不可用 / 归一失败
 * ⇒ 退回**保守规则式**（{@link extractRememberCandidates}）。**恒不抛**（记忆是赠品）。
 */
async function writeExplicitMemories(input: RunMemoryExtractionInput): Promise<void> {
  try {
    /**
     * `null` = 归一没拿到可用结果（模型不可用 / 解析失败 / 上游故障）⇒ 走降级；
     * `[]` = 模型**明确判定**"没有关于用户的陈述" ⇒ 一条都不写（这正是要的）。
     */
    let statements: ProfileStatement[] | null = null
    try {
      const target =
        input.modelId === undefined || input.modelId === null
          ? null
          : await resolveChatTarget(input.modelId, input.userId)
      if (target !== null) statements = await extractMemoryProfileStatements(target, input.userText)
    } catch (error) {
      getLogger().warn(
        { err: error, conversationId: input.conversationId },
        '画像模型归一失败（目标解析/上游/解析），退回保守规则式提取',
      )
      statements = null
    }
    if (statements === null) {
      await writeConservativeRemembers(input)
      return
    }
    for (const statement of statements) {
      await insertRemember(input, statement.text, statement.kind)
    }
  } catch (error) {
    getLogger().warn(
      { err: error, conversationId: input.conversationId },
      '显式"记住"后台写入失败（已忽略，不影响本轮）',
    )
  }
}

/** 保守规则式降级（模型不可用时）：按句切分 + "把 X 记住" + 疑问句过滤 */
async function writeConservativeRemembers(input: RunMemoryExtractionInput): Promise<void> {
  for (const text of extractRememberCandidates(input.userText)) {
    await insertRemember(input, text, looksLikePreference(text) ? 'PREFERENCE' : 'PROFILE')
  }
}

/** 写一条 USER 记忆并推一张"已记入"提示（显式路径两条分支共用） */
async function insertRemember(
  input: RunMemoryExtractionInput,
  text: string,
  kind: UserStatementKind,
): Promise<void> {
  const result = await insertMemory({
    userId: input.userId,
    agentId: null,
    kind,
    text,
    sourceConversationId: input.conversationId,
  })
  if (result.created !== null) {
    await pushMemoryNotice(input.conversationId, {
      kind: 'AUTO',
      memoryId: result.created.id,
      text: result.created.text,
      memoryKind: kind,
      memoryScope: 'USER',
    })
  }
}

