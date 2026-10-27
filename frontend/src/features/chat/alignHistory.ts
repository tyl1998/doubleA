/**
 * 「对齐历史」（P0-1-33）
 *
 * 依据：`docs/03-前端设计.md` §4.1 —— **"断线 → 顶部黄条提示，点击黄条 = 立即拉取历史对齐；
 * TaskAgent 断线先查 `GET /active`（排队位次/当前工具）恢复进度视图，再拉历史"**，
 * 以及停止时序末句"随后拉历史对齐"；`shared/src/sse.ts` 文件头 ②（"断线重连**不重放**：
 * 先查 `/active` 拿进度，再拉历史补齐"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么"对齐"需要一个判据，而不是"拉一遍就完事"
 * ─────────────────────────────────────────────────────────────────────
 * 断线那一刻界面上有两份**同一轮**的内容叠在一起，必须有人决定丢哪一份：
 *   · **流式版本**（store 里的那一轮，用户看着它长出来的）；
 *   · **落库版本**（服务端在中断时照样落库 —— `02` §5.2"中断/故障照样落库"，唯一例外是 lock-lost）。
 *
 * 三条规则各有各的错法，且都**不报错**：
 *   · 永远丢流式版本 ⇒ 服务端其实没落库时（lock-lost / 一个字都没生成），内容**凭空消失**；
 *   · 永远不丢 ⇒ 历史到位后同一轮渲染**两遍**（P0-1-32 已用 `done.messageId` 的让位规则堵住了
 *     `done` 那一侧，但断线这一侧**没有 `messageId`**，那条规则管不到）；
 *   · 不看 `/active` ⇒ 服务端其实还在生成（比如只是浏览器这一侧的网络断了）时，
 *     用户点"对齐"却拿到"这段已经结束"的错误结论，然后以为回答丢了。
 *
 * 判据因此是**两条独立的问题**：
 *   ① "服务端还在跑吗？"（`/active`）
 *   ② "服务端存下来了吗？"（助手消息**条数**是否增加 —— 用条数而不是文本比对：
 *      落库的正文可能只是流式内容的前缀，逐字比对会在"最后一段没赶上落库"时判成"没存"，
 *      而**条数不会说谎**：多出一条助手消息，只可能是这一轮落库了）。
 *
 * ⚠️ 本文件**不碰网络也不碰 store**：它只把"对齐前后 + `/active` 快照"变成一条决定。
 * 于是"丢哪一份"这件事可以被无依赖档逐种输入断言（含上面三种错法各自的输入）。
 */

import type { ConversationActive, Locale, MessageItem } from '@doubulea/shared'
import { translate } from '@doubulea/shared'

/** 对齐的结论（三种，互斥且穷尽） */
export type AlignOutcomeKind =
  /** 服务端存下来了 ⇒ 用**落库版本**（丢流式版本，避免同一轮渲染两遍） */
  | 'recovered'
  /** 服务端没有这一轮 ⇒ 保留流式版本（它是**唯一**的副本，丢了就是内容真的没了） */
  | 'not-persisted'
  /** 服务端**还在生成**（这一侧只是断了连接）⇒ 什么都不丢，如实提示 */
  | 'server-still-streaming'

export interface AlignOutcome {
  kind: AlignOutcomeKind
  /** `true` 时调用方应当 `reset()` 掉流式轮次 */
  dropStreamVersion: boolean
  /** 给用户的结论（页面按它决定是否再提示；`03` §4.1 的黄条本身另有文案） */
  note: string
}

/** 助手消息条数（判据见文件头 ②） */
export function countAssistantMessages(items: readonly MessageItem[]): number {
  return items.reduce((total, item) => (item.role === 'ASSISTANT' ? total + 1 : total), 0)
}

/**
 * 落库版本是否已经出现（**只问这一个问题**，供"对齐"与"停止收口"两条路共用）。
 *
 * 单独导出的理由：停止那条路**没有 `/active` 那一步**（流刚收口，服务端不可能还在跑），
 * 它只需要这一个判据。两处共用同一个函数，才不会出现"停止后按条数判、断线后按别的东西判"。
 */
export function shouldDropStreamVersion(
  before: readonly MessageItem[],
  after: readonly MessageItem[],
): boolean {
  return countAssistantMessages(after) > countAssistantMessages(before)
}

/** `/active` 快照 → 一句进度（`queuedPosition` / `currentTool` 都可能为 `null`） */
function progressNote(active: ConversationActive | null, locale: Locale): string {
  if (active === null) return ''
  const parts: string[] = []
  if (active.queuedPosition !== null) {
    parts.push(translate(locale, 'align.queuedPosition', { position: active.queuedPosition }))
  }
  if (active.currentTool !== null) parts.push(translate(locale, 'align.currentTool', { tool: active.currentTool }))
  return parts.length === 0
    ? ''
    : translate(locale, 'align.progressWrapper', { progress: parts.join(translate(locale, 'align.progressSeparator')) })
}

/**
 * 对齐的判据（纯函数，输入即全部上下文）。
 *
 * @param before 对齐**前**页面上已有的历史（展平后的时间正序）
 * @param after  对齐**后**重新拉到的历史
 * @param active `GET /active` 的结果；**没查就是 `null`**（ChatBot 不走这一步，见 `03` §4.1）。
 *               ⚠️ 查询失败也传 `null`：`/active` 是"断线恢复"路径上的一步，
 *               它自己失败时**不该**让"对齐历史"这个动作整体失败（用户已经断过一次线了）。
 */
export function decideAlign(input: {
  before: readonly MessageItem[]
  after: readonly MessageItem[]
  active: ConversationActive | null
  locale: Locale
}): AlignOutcome {
  const { before, after, active, locale } = input

  if (active !== null && active.streaming) {
    return {
      kind: 'server-still-streaming',
      dropStreamVersion: false,
      note: translate(locale, 'align.serverStillStreaming', { progress: progressNote(active, locale) }),
    }
  }

  if (shouldDropStreamVersion(before, after)) {
    return {
      kind: 'recovered',
      dropStreamVersion: true,
      note: translate(locale, 'align.recovered'),
    }
  }

  return {
    kind: 'not-persisted',
    dropStreamVersion: false,
    note: translate(locale, 'align.notPersisted'),
  }
}
