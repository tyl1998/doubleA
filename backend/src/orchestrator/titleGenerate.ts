/**
 * 会话标题的**模型生成**（2026-10-22）
 *
 * 依据：产品优化（2026-09-29 会话标题自动命名）的延伸 —— 用一个廉价模型把首条消息压成短标题；
 *      契约 `shared/src/titleModel.ts`、配置与服务 `services/titleModel.service.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条口径（写给后来改它的人）
 * ─────────────────────────────────────────────────────────────────────
 * ① **纯函数与副作用分开**：prompt 组装 / 回复解析都是纯函数（{@link buildTitleMessages} /
 *    `shared#normalizeGeneratedTitle`），可被无依赖回归直接喂字面量断言；本文件的
 *    {@link generateConversationTitle} 才碰 DB 与上游。
 *
 * ② **永远回落、绝不抛**：生成阶段的每一个失败（未配 / 不可用 / 上游报错 / 回复解析不出）
 *    都归到"返回 `null`"，调用方保留已有的**确定性标题**（`deriveConversationTopic`）。
 *    "调用不通或者没有配置则用当前逻辑"这句产品口径，其实现就是本函数的 `return null` ——
 *    **不要**把这里的失败上抛（那会让一句模型调用把已经落好的会话标题弄成"新会话"）。
 *
 * ③ **它跑在落库之后、且不阻塞落库**：调用方（`persist.ts`）已先把确定性标题 CAS 写进库，
 *    本函数只是"尽力把它升级成模型生成的标题"。故本函数自身**串行、无超时兜底会拖慢谁**——
 *    但调用方**不 `await`**（见 `persist.ts`），生成慢/卡住都不影响这一轮回给用户的时间。
 */

import { TITLE_GENERATE_PROMPT, normalizeGeneratedTitle } from '@doubulea/shared'

import { chat, type ChatMessage, type LlmTarget } from '../llm/client.js'
import { getLogger } from '../infra/logger.js'
import { resolveTitleTarget } from '../services/titleModel.service.js'

/**
 * 标题生成的**输入长度上限**（字符）—— 只取首条消息的前一段喂给模型。
 *
 * 理由：首条消息可能很长（粘贴一整份日志 / 需求文档），而"起个短标题"不需要全文 ——
 * 徒增 token 与延迟。截断只按**字符**切（这一步是给上游的输入，不是最终标题，
 * 劈代理对的两个 code unit 由上游 tokenizer 容忍），最终标题的码点截断在 `shared` 里做。
 */
const TITLE_INPUT_MAX_CHARS = 2000

/** 组装"起标题"这一次上游调用的消息（把首条用户消息附在指令之后） */
export function buildTitleMessages(firstUserText: string): ChatMessage[] {
  const clipped =
    firstUserText.length > TITLE_INPUT_MAX_CHARS ? firstUserText.slice(0, TITLE_INPUT_MAX_CHARS) : firstUserText
  return [
    {
      role: 'user',
      content: `${TITLE_GENERATE_PROMPT}\n\n用户开场消息：\n${clipped}`,
    },
  ]
}

/**
 * 用配置的标题模型给首条消息生成一个短标题；拿不到可用标题 ⇒ 返回 `null`（调用方回落）。
 *
 * 流程：解析目标（未配 / 不可用 ⇒ `null`）→ 组装消息 → `chat()` 调上游 → 归一回复。
 * **全程不抛**（见文件头 ②）：`chat()` 的 `AppError` / `LlmAbortError` 都被这一层吃掉。
 */
export async function generateConversationTitle(firstUserText: string): Promise<string | null> {
  let target: LlmTarget | null
  try {
    target = await resolveTitleTarget()
  } catch (error) {
    // `resolveTitleTarget` 自身已捕获大部分情形；这里兜底"读配置时 DB 抖动"这类意外
    getLogger().warn({ err: error }, '读取标题模型配置失败，本轮标题回落确定性截断')
    return null
  }
  if (target === null) return null

  let raw: string
  try {
    // `temperature: 0`：标题要稳定、可复现，不需要发散（与 `pipeline/caption.ts` 同款）
    const result = await chat(target, buildTitleMessages(firstUserText), { temperature: 0 })
    raw = result.text
  } catch (error) {
    getLogger().warn(
      { err: error, modelId: target.modelId },
      '标题模型调用失败，本轮标题回落确定性截断',
    )
    return null
  }

  const title = normalizeGeneratedTitle(raw)
  if (title === null) {
    getLogger().warn({ modelId: target.modelId, rawLength: raw.length }, '标题模型回复无法解析出标题，已忽略')
  }
  return title
}