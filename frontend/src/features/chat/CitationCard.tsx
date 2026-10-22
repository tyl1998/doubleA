/**
 * 引用卡（P0-1-32；`docs/03` §4.1 消息流渲染规则表第 5 行："文档名列表 + 展开 snippet 原文；
 * **完成时随 citations 事件出现**"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 这一张卡是本批"单一渲染路径"最硬的证据
 * ─────────────────────────────────────────────────────────────────────
 * 它的数据有两个来源，而**两个来源共用同一个 schema**（`citationItemSchema`，
 * 见 `shared/src/conversation.ts` 的注释："同一个引用卡既由本事件现画、又由
 * `messages.content.citations` 在刷新后重画，两处各写一份会让'流里看到的卡'与
 * '历史恢复出来的卡'悄悄分叉"）：
 *   · 流式：`citations` 事件（`roundReducer` 挂到本轮助手消息上）；
 *   · 历史：`messages.content.citations`（`messageToView` 解出来）。
 * 两者最终都是 {@link ChatMessageView} 上的 `citations` ⇒ 本组件只认这一个入参。
 *
 * ⚠️ 未命中知识库时后端**不发** `citations` 事件（P0-1-29 决策 12"未命中 ⇒ 不发引用"，
 * 同时 prompt 里禁止编造来源）⇒ `citations === null` ⇒ **整块不渲染**。
 * 这与"发了但 `items: []`"是两件事：前者是"这轮没有引用"，后者是"有一张空卡"
 * （归约层把空数组也收敛成 `null`，见 `roundReducer.ts`）。
 *
 * ⚠️ **不做关键词高亮**：`citationItemSchema` 只有 `docName` / `snippet` / `score` 三个字段，
 * 没有"命中了哪个词"。原型里的 `<mark>` 需要那个信息 —— **不编造**（按 bigram/分词去猜
 * 会高亮出与检索无关的词，反而误导用户核对"模型到底看到了什么"）。
 */

import { memo } from 'react'
import type { CitationItem } from '@doubulea/shared'

export interface CitationCardProps {
  items: readonly CitationItem[]
}

/** RRF 融合分很小（两路各 0.5 权重、k=60 时约 0.03 量级）⇒ 定点 4 位小数（与 `design/chat.html` 同） */
function formatScore(score: number): string {
  return score.toFixed(4)
}

/**
 * ⚠️ `memo`（内存优化 P2，`docs/子方案/前端长会话内存优化.md`）：流式期间父组件每帧重渲染，
 * 而历史消息的 `items` 引用稳定（`messageToView` 按查询数据缓存）⇒ 整块跳过。
 * 流式那一轮的引用卡只在 `citations` 帧到达时换一次引用，所以也只重渲染一次。
 */
export const CitationCard = memo(function CitationCard({ items }: CitationCardProps) {
  if (items.length === 0) return null

  return (
    <div className="cites" data-testid="citation-card">
      <div className="cites__head">
        <span className="kicker">引用 · {items.length} 篇</span>
        {/* 口径来自 `docs/子方案①` §六（两路召回 + RRF 融合）与 `shared` 的 `citationItemSchema`
            注释："`score` 是**融合分**而不是任何一路的原始分"——两路量纲不可比，
            把 `vectorScore` 与 `bigm_similarity` 混在一张卡上会让数字无法解释。 */}
        <span className="ratio u-right">向量 + 全文双路，RRF 融合排序</span>
      </div>
      {items.map((item, index) => (
        <details
          className="cite"
          key={`${item.docName}#${index}`}
          // 第一条默认展开：用户最常核对的是"排第一的那篇到底写了什么"
          open={index === 0}
        >
          <summary>
            <span className="cite__idx">{String(index + 1).padStart(2, '0')}</span>
            <span>{item.docName}</span>
            <span className="cite__score num">rrf {formatScore(item.score)}</span>
          </summary>
          <p className="cite__snippet">{item.snippet}</p>
        </details>
      ))}
    </div>
  )
})
