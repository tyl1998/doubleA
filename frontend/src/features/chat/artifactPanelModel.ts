/**
 * 产物面板的**零依赖纯逻辑**（P0-3-11；`docs/03-前端设计.md` §4.1 的"TaskAgent 差异"、
 *      §4.6、`docs/06-实施计划.md` §五 P0-3-11 行）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 文件名带 `Model` 不是随手起的：**不能叫 `artifactPanel.ts`**
 * ─────────────────────────────────────────────────────────────────────
 * 同目录下那个组件是 `ArtifactPanel.tsx`（PascalCase = 组件，本仓惯例）。两个名字只差大小写，
 * 于是 `frontend` 的 `tsc` 当场报 **TS1149**（"File name ... differs from already included file
 * name only in casing"）—— 它在**同一次编译**里要把两个模块区分开，而 macOS 的默认文件系统
 * 对大小写不敏感（能创建出来、`ls` 也看得见两个，问题只在这一层暴露）。
 * 后缀 `Model` 与同目录的 `messageModel.ts` 同义（视图模型 / 判据），撞不上任何既有名字。
 * ★ 迁移启示：**新增文件前先扫一眼同目录有没有只差大小写的名字** —— 这个错只有在
 * `pnpm -r typecheck` 这一档才看得见，`vite` 跑起来完全正常。
 *
 * 依据：产物有两个来源，而**它们从来没有同时齐过**：
 *   · `GET /api/conversations/:id/artifacts`（P0-3-9）—— **刷新后产物还在的唯一出口**，
 *     带 `createdAt`，但只在"这一轮结束、列表被失效重取之后"才看得到新产物；
 *   · 流里的 `artifact` 事件（P0-3-7）—— 此刻正在产出，界面要立刻看得到，但**没有 `createdAt`**
 *     （事件是现发的，落库时刻要等服务端写那一行）。
 * 面板是"这个会话产出过哪些文件"的**唯一清单** ⇒ 两个来源必须在**一处**合并。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 合并的顺序不是排版偏好，是"两个来源的排序口径要一致"
 * ─────────────────────────────────────────────────────────────────────
 * 服务端列表是 `created_at desc`（**最新在前**，`02` §四），而 `artifact` 事件是**产出顺序**
 * （旧 → 新）。直接拼接会得到"上半段旧→新、下半段新→旧"的清单 —— 不报错、也不重复，
 * 只是"刚生成的那个"掉在中间，而用户找的就是它 ⇒ 流式那一段必须**倒序**放在最前。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 去重按 `artifactId`，且**保留服务端那一份**
 * ─────────────────────────────────────────────────────────────────────
 * 一轮结束之后会同时出现两份"同一个产物"：流式轮次里的（页面还没让位）与列表里的
 * （刚重取回来）。不去重 ⇒ "产物 · N"这个计数说谎，而界面上看不出**为什么多了一个**
 * （两条长得一模一样）。保留服务端那一份是因为它有 `createdAt` —— 有了它，面板上那一行
 * 就能从"刚生成"变成真正的时间读数。
 */

import type { AgentType, ArtifactItem, ArtifactListItem } from '@doubulea/shared'

import { describeConversationTime } from './conversationList.js'

/** 面板里的一条产物 = 卡片那一份形状 + "什么时候产出的" */
export interface ArtifactPanelItem extends ArtifactItem {
  /** ISO 8601；`null` = 这一轮刚产出、服务端列表里还没有它 */
  createdAt: string | null
  /** `true` = 只有 `artifact` 事件这一个来源（还没有 `createdAt`） */
  live: boolean
}

/** 面板标题那一格（`design/chat.html` 的 `产物 · 3`） */
export const ARTIFACT_PANEL_TITLE = '产物'

/** 还没有产物时面板里说的那句（不是错误态，是新会话的常态） */
export const ARTIFACT_PANEL_EMPTY = '这个会话还没有产出文件。TaskAgent 在沙箱里生成的文件会列在这里。'

/** 面板底部那句常驻说明（`design/chat.html` 的 `.alert--info`） */
export const ARTIFACT_PANEL_NOTE = '产物保存在沙箱工作目录，空闲回收后仍可从对象存储下载。'

/** `createdAt` 缺失时的读数（这一轮刚产出，还没有落库时刻） */
export const ARTIFACT_TIME_JUST = '刚生成'

/** `createdAt` 存在但解析不出来时的读数 —— 与"还没有"区分开，不拿别的话冒充 */
export const ARTIFACT_TIME_UNKNOWN = '时间未知'

/**
 * 面板要不要出现：**只有 TaskAgent 有**（`03` §4.1 的"TaskAgent 差异"）。
 *
 * ⚠️ 判据是 `agent.type` 而不是"这个会话有没有产物"：后者会让面板在第一次派活之前
 * 完全不存在、派活之后凭空出现 —— 用户会以为自己触发了什么。类型在**创建时就定死**
 * （`02` §3.2"创建后不可改"）⇒ 它是稳定的，而"有没有产物"不是。
 *
 * `undefined` = agent 还没读到（首帧）⇒ 按"不显示"处理，而不是先渲染再撤掉
 * （三栏布局的 `grid-template-columns` 变一次会让中栏宽度跳一下）。
 */
export function showArtifactPanel(agentType: AgentType | undefined): boolean {
  return agentType === 'TASK_AGENT'
}

/**
 * 两个来源 → 面板清单（**唯一**的合并点，见文件头）。
 *
 * @param persisted 服务端列表（**已按 `created_at desc` 排好**，本函数一列都不动它 ——
 *                  与 `conversationList.ts` 同款纪律：顺序只能来自服务端）
 * @param streamed  本轮 `artifact` 事件的产物（产出顺序：旧 → 新）
 */
export function mergeArtifactPanelItems(
  persisted: readonly ArtifactListItem[],
  streamed: readonly ArtifactItem[],
): ArtifactPanelItem[] {
  // 服务端那一份优先（它有 `createdAt`），故先把它的 id 收成集合
  const seen = new Set<string>()
  const result: ArtifactPanelItem[] = []

  for (const item of persisted) {
    if (seen.has(item.artifactId)) continue
    seen.add(item.artifactId)
    result.push({
      artifactId: item.artifactId,
      fileName: item.fileName,
      size: item.size,
      mime: item.mime,
      createdAt: item.createdAt,
      live: false,
    })
  }

  // 流式那一段：只要"列表里还没有的"，且**倒序**放在最前（见文件头：两段排序口径要一致）
  const fresh: ArtifactPanelItem[] = []
  for (const item of streamed) {
    if (seen.has(item.artifactId)) continue
    seen.add(item.artifactId)
    fresh.push({
      artifactId: item.artifactId,
      fileName: item.fileName,
      size: item.size,
      mime: item.mime,
      createdAt: null,
      live: true,
    })
  }
  fresh.reverse()

  return [...fresh, ...result]
}

/**
 * 产物"什么时候产出的"读数。
 *
 * 分档复用 `conversationList.ts#describeConversationTime`（**同一个口径**，不写第二份
 * —— P0-1-29 ⑰：同一事实在两处各写一遍，必有一处先腐烂）。只有两种边角是产物独有的：
 *   · `null`（流式、还没落库）⇒ 「刚生成」；
 *   · 解析不出时刻 ⇒ 「时间未知」（那一格是给用户看的，填"还没有消息"是句假话）。
 */
export function artifactTimeText(createdAt: string | null, now: Date): string {
  if (createdAt === null) return ARTIFACT_TIME_JUST
  const at = new Date(createdAt)
  if (Number.isNaN(at.getTime())) return ARTIFACT_TIME_UNKNOWN
  return describeConversationTime(createdAt, now)
}

/**
 * 列表只取回一页时的那句读数（`null` = 全都显示了，这一行不出现）。
 *
 * ⚠️ **读数取服务端给的 `total`，不取 `items.length`**：后者恒等于"这一页有多少条"，
 * 拿它当"共 N 个"会在超过一页时说谎（"`共 100 个`"其实还有第 101 个）。
 * `total` 拿不到（`undefined`）⇒ 什么都不说，而不是编一个数。
 */
export function artifactPanelOverflowNote(shown: number, total: number | undefined): string | null {
  if (total === undefined || total <= shown) return null
  return `仅显示最近 ${shown} 个（共 ${total} 个）`
}
