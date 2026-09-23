/**
 * 「逐字确认」的唯一判据（P0-1-36 提为公共模块）
 *
 * `docs/03` §七「删除分级确认」把删除分成两档：普通删除（`Popconfirm`）与**级联删除**
 * （Modal + 红色危险按钮 + 明示影响范围）。本仓对级联那一档的实现口径是**再叠一层"输入
 * 某个词"**：删智能体输入 Agent 名称、删知识库输入库名、删会话输入固定的「删除」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要把这一行判据抽出来
 * ─────────────────────────────────────────────────────────────────────
 * 「逐字对上」这件事在 P0-1-34 与 P0-1-35 各写了一遍（`conversationList.isDeleteConfirmed`
 * 与 `knowledgeModel.isKnowledgeDeleteConfirmed`），本批（P0-1-36 的 Provider 级联删除）
 * 本来会出现**第三遍**。三遍的后果不是"多两行"，而是 `docs/06` §六 第 ⑰ 条那句话：
 * **同一口径在两处各写一遍，必有一处先腐烂** —— 只要有人给其中一处加上 `trim()`，
 * "逐字确认"就在那一档悄悄变成"差不多就行"，而它**不会报任何错**（用户也不会察觉）。
 *
 * 所以：**判据只有这一处**，`conversationList` 与 `knowledgeModel` 改成委托调用（对外导出
 * 与行为逐字未变，调用方 import 路径一字不动 —— 这与 P0-1-35 抽取 `formatUpdatedAt` 是
 * 同一手法）。
 *
 * ⚠️ 为什么**不做 `trim()`、不忽略大小写、不接受全角**：这一类"确认成本"的全部意义就在于
 * **逼用户慢下来**，而"顺手把空白去掉"会让"粘了个带空格的词进来"也算通过 —— 它挡不住任何
 * 一次误触，却让"逐字确认"这句话变成一句空话（`conversationList.ts` 的原注释，保留）。
 */

/**
 * 输入是否与期望文本**逐字**相同。
 *
 * 写成函数而不是让组件里写 `typed === name`，是为了让**这一条**能被无依赖验收档钉住
 * （`frontend/scripts/verify-admin-ui.mjs` 的 I 组与 `verify-knowledge-ui.mjs` 的 H 组
 * 各有一条断言盯着它；`verify-chat-sse.mjs` 的 K 组盯会话那一档）。
 */
export function isTypedConfirmMatch(typed: string, expected: string): boolean {
  return typed === expected
}
