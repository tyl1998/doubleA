/**
 * 会话标题生成模型契约（平台级单例配置；2026-10-22）
 *
 * 依据：产品优化（2026-09-29「发起会话后标题不该停在『新会话』」）的延伸 —— 把会话标题的
 *      来源从"首条消息**原文截断**"（{@link deriveConversationTopic}）升级为"用一个**廉价模型**
 *      压成短标题"。选型口径对齐 `KnowledgeBase.captionModelId`（从模型池选 + 保存时校验），
 *      落点则对齐 `EgressPolicy`（平台级单例行）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条口径（写给后来改它的人）
 * ─────────────────────────────────────────────────────────────────────
 * ① **它是"平台级单一事实"，所以是单例行、只收 ADMIN**
 *    与会话标题相关的模型选择只有一份（所有会话共用）。权限与 `/api/admin/egress-policy` 同族：
 *    **仅 ADMIN** 能读能改 —— 它是平台配置，不是"每个人自己的东西"。DB 里也**只有一行**（见下方 schema）。
 *
 * ② **是"总开关 + 可选模型"两件事，不是三态**
 *    `enabled` 管"要不要尝试模型生成"，`modelId` 管"用哪个模型"。二者缺一都回落确定性截断：
 *      · 关 ⇒ 不尝试（`modelId` 留着但不生效，等价于"配了但先停用"）；
 *      · 开但没配模型 ⇒ 不尝试；
 *      · 开且配了 ⇒ 尝试（调用失败仍回落，见 `orchestrator/titleGenerate.ts`）。
 *    刻意**不把"清空模型"做成第三态**：它不是 `renameConversationBodySchema` 那种"回到未命名"
 *    的语义，改模型/停用都有显式开关表达，多一种"置 null"写法只会多一种恢复默认的路径。
 *
 * ③ **模型回复的解析口径放这里**（{@link normalizeGeneratedTitle}），因为它要**两处**一致：
 *    后端生成完写库前（`titleGenerate.ts`）、以及回归脚本断言"解析得对不对"。放 `shared` 的理由
 *    与 `deriveConversationTopic` 相同：这是纯函数、无依赖，可被无 DB 回归直接喂字面量断言。
 */

import { z } from 'zod'

/**
 * 标题模型生成的**指令 prompt**（`titleGenerate.ts` 用它组装这一次上游调用）。
 *
 * 与 `MEMORY_PROFILE_PROMPT`（`orchestrator/memoryProfile.ts`）同款：要求模型**只回一个
 * 短标题**，不要解释、不要引号、不要句末标点。关键词是"名称式"——标题是给用户在一串会话里
 * **认出这一条**用的，不是回答本身（同 `hermes-agent` 的 `_TITLE_PROMPT_TEMPLATE` 口径）。
 */
export const TITLE_GENERATE_PROMPT = [
  '你是「会话标题」生成助手。请给下面这条用户开场消息起一个短标题，让用户之后能在会话列表里认出来。',
  '',
  '要求：',
  '- **只输出标题本身**，不要引号、不要句末标点、不要任何解释或前后缀。',
  '- 用**与用户消息相同的语言**（用户写中文就用中文）。',
  '- 概括"用户想做什么"，而不是复述成一句问句。',
  '- 保留关键术语 / 文件名 / 数字 / 错误码的原样。',
  '- 简洁：不超过 20 个汉字（或 8 个英文单词）。',
].join('\n')

/**
 * "短标题"的字数上限（**码点**）—— 比 {@link CONVERSATION_TOPIC_MAX_CHARS} 紧得多。
 *
 * `topic` 列的硬上限是 255（`renameConversationBodySchema` 与建库一致），那是"用户手动改名"
 * 的宽松闸门；自动生成的标题应当短（侧栏一行显示），故这里另给一个更紧的上限。
 * 生成结果超出即按码点截断（与 {@link deriveConversationTopic} 同口径：`slice` 会劈代理对）。
 */
export const TITLE_GENERATE_MAX_CHARS = 60

/**
 * 把模型回的**自由文本**归一成一个可用标题；拿不到可用标题时返回 `null`（= 回落确定性截断）。
 *
 * 归一四步（每一步都对应一类实测会出现的脏输出）：
 *   · 去掉 <code>```</code> 代码围栏（模型爱把结果包在代码块里）；
 *   · 取**第一行非空文本**（模型可能"标题 + 解释"两行都给）；
 *   · 去掉首尾的引号 / 书名号 / 各类成对括号，以及**句末标点**（`.。!！?？`）；
 *   · 压空白 + 按**码点**截断到 {@link TITLE_GENERATE_MAX_CHARS}。
 *
 * 返回 `null` 的两种情形：清洗后为空串（模型什么都没给 / 只回了围栏与标点）、清洗后全是标点空白。
 * **永不抛错** —— 调用方把它当"这次生成没结果"，据此**不写库**（保留已有的确定性标题）。
 */
export function normalizeGeneratedTitle(raw: string): string | null {
  if (typeof raw !== 'string') return null
  // ① 去代码围栏（```json … ``` / ``` … ```）
  const withoutFence = raw.replace(/```[a-zA-Z]*\s*|\s*```/g, '')
  // ② 第一行非空文本
  const firstLine = withoutFence
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  if (firstLine === undefined) return null
  // ③ 去成对包裹符号与句末标点（先剥一层包裹，再剥句末标点，再剥可能露出来的第二层包裹）
  const stripped = stripWrapping(firstLine).replace(/[.。!！?？、,，;；:：]+\s*$/u, '')
  const cleaned = stripWrapping(stripped)
  // ④ 压空白 + 按码点截断
  const collapsed = cleaned.trim().replace(/\s+/g, ' ')
  if (collapsed === '') return null
  const chars = [...collapsed]
  const limited =
    chars.length > TITLE_GENERATE_MAX_CHARS ? chars.slice(0, TITLE_GENERATE_MAX_CHARS).join('') : collapsed
  return limited === '' ? null : limited
}

/** 剥掉一层成对包裹符号（引号 / 书名号 / 成对括号）；不成对时原样返回 */
function stripWrapping(text: string): string {
  let out = text.trim()
  let changed = true
  while (changed && [...out].length >= 2) {
    changed = false
    for (const [open, close] of WRAPPER_PAIRS) {
      if (out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim()
        changed = true
      }
    }
  }
  // 单向残留也剥：模型可能只回了半边（如 `」` / `"`）—— 这类字符本身没有信息，
  // 留着会让标题变成一串引号括号。
  // ⚠️ **只对"引号/书名号"这类双向无歧义的标记做单向剥离**：`)` / `]` / `）` 在正常标题里
  //    可能合法收尾（如「修复登录 (v2)」），单向剥它们会把标题削掉半截。
  while ([...out].length > 0 && ONE_SIDED_MARKS.has(out[0] ?? '')) out = out.slice(1).trim()
  while ([...out].length > 0 && ONE_SIDED_MARKS.has([...out].at(-1) ?? '')) out = out.slice(0, -1).trim()
  return out
}

/** 「单向剥离安全」的标记：引号 / 书名号（双向都不构成合法标题的首尾字符，剥掉无损） */
const ONE_SIDED_MARKS = new Set(['"', "'", '“', '”', '‘', '’', '《', '》', '「', '」', '『', '』'])

/** 成对包裹符号表（引号 / 书名号 / 成对括号）—— `stripWrapping` 的唯一来源 */
const WRAPPER_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
  ['《', '》'],
  ['「', '」'],
  ['『', '』'],
  ['（', '）'],
  ['(', ')'],
  ['[', ']'],
  ['【', '】'],
  ["'", "'"],
]

// ───────────────────────────── 读取 / 写入投影 ─────────────────────────────

/**
 * `GET /api/admin/title-model` 与 `PUT` 的成功响应（**同一份投影**）。
 *
 * `modelLabel` 是选定模型的展示名（`null` = 未配置 / 模型已删），仅供界面显示"当前用哪个模型"，
 * 与 `KnowledgeBase.captionModelName` 同款（**只读快照**，不参与编删）。
 */
export const titleModelConfigSchema = z.object({
  /** 平台总开关 */
  enabled: z.boolean(),
  /** 选定的标题模型 id（`models.id`）；`null` = 未配置 */
  modelId: z.string().nullable(),
  /** 选定模型的**当前**展示名（未配 / 已删为 `null`），仅供界面显示 */
  modelLabel: z.string().nullable(),
  /** ISO 8601 */
  updatedAt: z.string(),
})
export type TitleModelConfig = z.infer<typeof titleModelConfigSchema>

/**
 * `PUT /api/admin/title-model` 请求体：总开关 + 选定模型（**整体替换**）。
 *
 * · `enabled` 必填（布尔）—— 这是一个显式开关，"没传"没有合理默认（与 `setConversationAutoApproveBodySchema` 同款）；
 * · `modelId` **三态**：`null` / 省略 = **清除**（未配置）；uuid = 设置。⚠️ 与 `enabled` 分开：
 *   可以"先配好模型但不启用"（`enabled:false` + `modelId` 有值），故它不是"回到未命名"那种三态
 *   （见文件头 ②：这里**允许**清除模型，因为"改用确定性逻辑"有两种正交手段，清不清除语义都清楚）。
 *   设置时后端校验它是 `type=CHAT` 且模型与 Provider 都启用（见服务层）。
 */
export const updateTitleModelBodySchema = z.object({
  enabled: z.boolean({
    required_error: '缺少 enabled（true = 启用模型生成标题，false = 只用确定性截断）',
    invalid_type_error: 'enabled 必须是布尔值',
  }),
  modelId: z
    .string({ invalid_type_error: 'modelId 必须是字符串 UUID 或 null' })
    .uuid('标题模型 ID 不是合法 UUID')
    .nullable()
    .optional(),
})
export type UpdateTitleModelBody = z.infer<typeof updateTitleModelBodySchema>

/**
 * 标题模型校验失败的提示（模型不是对话模型 / 已停用 / Provider 停用时由服务层抛 400/409）。
 *
 * 与 `CAPTION_MODEL_MUST_SUPPORT_VISION_HINT` 同款：放在 `shared` 让前后端同一份文案。
 */
export const TITLE_MODEL_MUST_BE_CHAT_HINT =
  '所选标题模型必须是对话模型（CHAT），且模型与其所属 Provider 都已启用'