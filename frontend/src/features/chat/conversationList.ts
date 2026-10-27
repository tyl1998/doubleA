/**
 * 会话侧栏的纯逻辑（P0-1-34）—— **零依赖**（不 import React / zustand / antd）
 *
 * 依据：`docs/03-前端设计.md` §4.1（"**会话侧栏**：会话项 hover 浮出 [重命名][删除]；
 *      重命名行内编辑；删除走分级确认"、版式图左侧的「+ 新会话 / 会话列表（最近活跃）」）、
 *      §五（`done` 之后"刷新会话列表排序"）、`docs/02` §4.5 ③（排序 `lastMessageAt desc`
 *      且**新会话 `null` 排最前**）、`shared/src/conversation.ts`（投影与三个判据函数）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这几段要被抽出来（而不是写在组件里）
 * ─────────────────────────────────────────────────────────────────────
 * "按时间分组"与"相对时间文案"是**错了不会报错**的一类：分组判错只会让会话出现在错误的
 * 标题下面（甚至是"今天"那一组凭空少一条），相对时间算错只会显示一个偏了一点的读数 ——
 * 两者在浏览器里都不抛异常、控制台干净。而它们全是纯函数 ⇒ 归无依赖档 `verify:chat-sse`
 * 逐条断言（与 `sseParser` / `composerState` / `alignHistory` 同一手法）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件**不重排**服务端给的顺序
 * ─────────────────────────────────────────────────────────────────────
 * 排序口径（`lastMessageAt desc` + `nulls:'first'` + `createdAt desc` + `id desc`）是
 * **服务端**的事（`docs/02` §4.5 ③），前端分组只做"切片归属"、**一列都不动**：
 * 在前端再排一次，就出现了第二份排序口径，而它与服务端的分页（offset/limit）会打架 ——
 * 症状是"翻到第二页时同一条又出现一次/某一条永远看不到"。
 * 故 {@link groupConversationViews} 的契约只有一条：**拼接各组 = 入参原序**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 状态灯的取值域是**三个**，不是原型上的四个
 * ─────────────────────────────────────────────────────────────────────
 * `design/chat.html` 上写着「生成中 / 已完成 / 已失败 / 已停止」四种。落到本项目只有三种
 * 有**数据来源**：
 *   · `run`  —— 正在生成：来源是流 store 里**正在生成**的会话 id 集合（唯一能证明"这一轮在跑"
 *     的东西；P1-19 多流后可能同时有多个）；
 *   · `warn` —— 只读保留：`status === 'FINISHED'`（只由"Agent 被软删"产生，`02` §4.4）；
 *   · `idle` —— 其余（正常可继续）。
 * 「已失败」「已停止」是**单轮回答**的结局，不是会话的状态 —— `conversations` 表里没有这个列，
 * 也没有接口能给出"这个会话的最后一轮失败了"（`/active` 只回答"现在有没有在跑"）。
 * 编一个出来就是造假数据（`docs/03` §七 的口径：不造假），故**刻意只给三态**。
 */

import {
  CONVERSATION_TOPIC_MAX_CHARS,
  isConversationReadOnly,
  translate,
  type AgentType,
  type ConversationItem,
  type Locale,
  type MessageKey,
} from '@doubulea/shared'

/** 侧栏一行的视图（组件只把它画出来，不再做任何判断） */
export interface ConversationListItemView {
  id: string
  /** 显示名：没命名过时回落到 `shared` 的 `CONVERSATION_UNTITLED_HINT` */
  title: string
  /** 状态灯：`run` 正在生成 / `warn` 只读保留 / `idle` 正常 */
  led: 'run' | 'warn' | 'idle'
  /** 状态文案（已按当前语言译好；与 `led` 是"色 + 字"两重表达，`composerState` 同款） */
  state: string
  /** 时间读数（"2 分钟前" / "昨天 18:20" / "还没有消息"） */
  time: string
  /**
   * 会话所属智能体的**快照**（P1-15 跨智能体会话栏要显示徽标）。
   *
   * 来自 `ConversationItem` 自带的 `agentId/agentName/agentType`（服务端投影，Agent 被软删也有）
   * —— 单智能体侧栏（`ConversationSidebar`）不读它们，但跨智能体的 `ConvRail` 靠它一屏分清
   * "这条会话是谁的"。不再多打一次 `/api/agents/:id`：同一份事实只有一处来源。
   */
  agentId: string
  agentName: string
  agentType: AgentType
}

/** 一个分组标题 + 它的条目（顺序即渲染顺序） */
export interface ConversationGroup {
  /** **已译**的分组标题（`label.conversationGroup.*` 的译文）—— 组件直接渲染，不再判语言 */
  label: string
  items: ConversationListItemView[]
}

/**
 * 两个分组标题的 i18n key（`design/chat.html` 的 `.sidebar__group` 只有这两个）。
 *
 * P1-23：由"中文常量"改为 key —— 分组标题是**每屏都看得见**的读数，必须跟界面语言走；
 * 取值由组件 `useT()` 完成（`ConversationGroup.label` 仍是已译字符串，见该接口注释）。
 */
export const CONVERSATION_GROUP_TODAY: MessageKey = 'label.conversationGroup.today'
export const CONVERSATION_GROUP_EARLIER: MessageKey = 'label.conversationGroup.earlier'

/** 一天的毫秒数（用于算"日历日差"，不是 24h 差 —— 见 {@link calendarDayDiff}） */
const MS_PER_DAY = 86_400_000

/** `HH:mm`（本地时区、补零）。不用 `toLocaleTimeString`：它的输出随 ICU/区域设置变，断言会飘 */
function hhmm(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** `MM-DD HH:mm`（本地时区、补零） */
function mmddhhmm(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${mm}-${dd} ${hhmm(date)}`
}

/**
 * **日历日差**（把两个时刻各自归到本地零点再相减）。
 *
 * ⚠️ 不能用 `(now - at) / 86400000` 取整：23:50 发的消息在 00:30 看时差 40 分钟，
 * 整除后是 `0` ⇒ 它会被算成"今天"，而它其实是**昨天**的 —— 症状是分组标题下少了/多了一条，
 * 而读数（"40 分钟前"）看着完全正常，没人会去怀疑分组。
 */
function calendarDayDiff(now: Date, at: Date): number {
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfAt = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
  return Math.round((startOfNow - startOfAt) / MS_PER_DAY)
}

/**
 * 时间读数（`design/chat.html` 的 `.conv__meta` 最后一格就是它）。
 *
 * 分档按**日历日差**优先、当天内再按差值：
 *   · 同一天：< 1 分钟 `刚刚` / < 1 小时 `N 分钟前` / 其余 `N 小时前`
 *   · 昨天：`昨天 HH:mm`
 *   · 更早：`MM-DD HH:mm`
 *
 * `null` ⇒ `'还没有消息'`（`lastMessageAt` 的语义正是"**最后一条消息落库的时刻**"，
 * `shared` 文件头 ③；**不要**拿 `createdAt` 去冒充它 —— 那会把"刚建好还没说话"的会话
 * 显示成"3 分钟前"，而用户看不出这是两个不同的东西）。
 */
export function describeConversationTime(lastMessageAt: string | null, now: Date, locale: Locale): string {
  if (lastMessageAt === null) return translate(locale, 'sidebar.timeNoMessage')
  const at = new Date(lastMessageAt)
  if (Number.isNaN(at.getTime())) return translate(locale, 'sidebar.timeNoMessage')

  const dayDiff = calendarDayDiff(now, at)
  if (dayDiff <= 0) {
    // `dayDiff < 0` = 服务端时间比本机快（时钟漂移）⇒ 当"刚刚"处理，不显示负数
    const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
    if (minutes < 1) return translate(locale, 'sidebar.timeJustNow')
    if (minutes < 60) return translate(locale, 'sidebar.timeMinutesAgo', { minutes })
    return translate(locale, 'sidebar.timeHoursAgo', { hours: Math.floor(minutes / 60) })
  }
  // ⚠️ `MM-DD HH:mm`（更早那一档）是**仪器读数**，两语言同形，不译、不插值
  if (dayDiff === 1) return translate(locale, 'sidebar.timeYesterday', { time: hhmm(at) })
  return `${mmddhhmm(at)}`
}

/**
 * 一行会话 → 视图。三个输入决定三个字段，没有别的分支：
 *   · `title` —— `topic` 为 `null` 时回落 `CONVERSATION_UNTITLED_HINT`（**唯一**的回落点，
 *     组件里不许再写一次 `?? '新会话'`，否则改口径要全仓搜）；
 *   · `led` / `state` —— 见文件头"状态灯取值域"；`streamingIds` 是流 store 里**正在生成**的会话 id
 *     集合（**P1-19 多流**后可能同时有多个，早先是一个 `streamFor` 单值），只有这一条在集合里
 *     时才可能是"生成中"（**不能**用 `status` 去猜：`conversations` 表里没有"正在生成"这个状态，
 *     真值只在 Redis 的锁上）。
 */
export function conversationItemView(
  item: ConversationItem,
  now: Date,
  streamingIds: ReadonlySet<string>,
  locale: Locale,
): ConversationListItemView {
  // ⚠️ 「新会话」的回落文案现在在字典里（`label.conversationUntitled`）—— 这个 `??` 仍是
  //    **唯一**的回落点（组件里不许再写一次，否则改口径要全仓搜）。
  const title =
    item.topic === null || item.topic.trim() === '' ? translate(locale, 'label.conversationUntitled') : item.topic
  const snapshot = { agentId: item.agentId, agentName: item.agentName, agentType: item.agentType }
  const time = describeConversationTime(item.lastMessageAt, now, locale)

  if (streamingIds.has(item.id)) {
    return { id: item.id, title, led: 'run', state: translate(locale, 'sidebar.stateStreaming'), time, ...snapshot }
  }
  if (isConversationReadOnly(item.status)) {
    // `FINISHED` 只由"Agent 被软删"产生 ⇒ 文案直接说结果，比"已结束"更可操作
    //（`docs/02` §4.4："会话转只读**保留**"）
    return { id: item.id, title, led: 'warn', state: translate(locale, 'sidebar.stateReadOnly'), time, ...snapshot }
  }
  return { id: item.id, title, led: 'idle', state: translate(locale, 'sidebar.stateResumable'), time, ...snapshot }
}

/**
 * 分组（今天 / 更早）。
 *
 * 判据用的是 `lastMessageAt ?? createdAt`：
 *   · 刚建的会话 `lastMessageAt` 是 `null`，但它是**刚刚**发生的 ⇒ 必须落在「今天」；
 *   · 服务端把它排在最前（`nulls:'first'`），若这里拿 `null` 去算分组，它会掉进「更早」——
 *     于是侧栏顶部空着一截、而"刚才新建的那个会话"跑到列表下半部分。
 *
 * **空组不出现**（原型上没有"今天"就没有那一行）；组内顺序 = 入参顺序（见文件头）。
 */
export function groupConversationViews(
  items: readonly ConversationItem[],
  now: Date,
  streamingIds: ReadonlySet<string>,
  /**
   * 上一轮的分组结果（可选；内存优化 P6）。给出来时**只重建有变化的组与行**：
   *   · 某个分组一行都没变 ⇒ 返回**同一个对象**，渲染时整组 `memo` 命中、DOM 不动；
   *   · 某一行长得一样 ⇒ 返回**同一个视图对象**，行组件 `memo` 命中。
   *
   * ⚠️ 为什么需要它：`ConvRail` 每 60s（`useMinuteTick`）以及**任何一轮流式帧**（`rounds`
   * 变化 ⇒ `streamingIds` 重算）都会重跑本函数 —— 按旧写法这一圈会为 100 条会话**新建 100 个
   * 视图对象**，于是每行都重渲染一次、每个 `<Tooltip>` / `<Tag>` 都重走一遍。长会话里
   * 流式期间这是每秒几十次的纯浪费（还会产生大量短命对象给 GC）。
   *
   * ⚠️ 判据必须逐字段比较（不能用引用比较）：`items` 来自网络，翻页 / 失效重取后是全新对象。
   */
  locale: Locale,
  previous?: readonly ConversationGroup[],
): ConversationGroup[] {
  const today: ConversationListItemView[] = []
  const earlier: ConversationListItemView[] = []

  for (const item of items) {
    const reference = item.lastMessageAt ?? item.createdAt
    const at = new Date(reference)
    const isToday = Number.isNaN(at.getTime()) || calendarDayDiff(now, at) <= 0
    ;(isToday ? today : earlier).push(
      reuseListItemView(conversationItemView(item, now, streamingIds, locale), previous),
    )
  }

  // ⚠️ 组标签取**已译**字符串：`reuseGroup` 的"逐项引用相同即复用上一组"判据是拿
  //    `group.label` 对位的（见该函数），给 key 会让同一组在两种语言下拿到同一个标签。
  const groups: ConversationGroup[] = []
  if (today.length > 0) groups.push(reuseGroup(translate(locale, CONVERSATION_GROUP_TODAY), today, previous))
  if (earlier.length > 0) groups.push(reuseGroup(translate(locale, CONVERSATION_GROUP_EARLIER), earlier, previous))
  // 整体没变 ⇒ 返回上一份（让 `useMemo` 的消费者也停在同一个引用上）
  if (previous !== undefined && sameGroups(groups, previous)) return previous as ConversationGroup[]
  return groups
}

/** 行视图的**逐字段**相等（见 {@link groupConversationViews} 的 `previous`） */
function sameListItemView(a: ConversationListItemView, b: ConversationListItemView): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.led === b.led &&
    a.state === b.state &&
    a.time === b.time &&
    a.agentId === b.agentId &&
    a.agentName === b.agentName &&
    a.agentType === b.agentType
  )
}

/** 在上一轮结果里找到同 id 且逐字段相同的行，复用它的对象引用 */
function reuseListItemView(
  next: ConversationListItemView,
  previous: readonly ConversationGroup[] | undefined,
): ConversationListItemView {
  if (previous === undefined) return next
  for (const group of previous) {
    for (const item of group.items) {
      if (item.id === next.id && sameListItemView(item, next)) return item
    }
  }
  return next
}

/** 组内逐项引用都相同 ⇒ 复用上一轮的组对象（`label` 由调用方保证同源） */
function reuseGroup(
  label: string,
  items: ConversationListItemView[],
  previous: readonly ConversationGroup[] | undefined,
): ConversationGroup {
  if (previous === undefined) return { label, items }
  const before = previous.find((group) => group.label === label)
  if (before === undefined) return { label, items }
  if (before.items.length !== items.length) return { label, items }
  for (let index = 0; index < items.length; index += 1) {
    if (before.items[index] !== items[index]) return { label, items }
  }
  return before
}

/** 两组列表是否"长得一样"（组数、标签、每项引用） */
function sameGroups(next: readonly ConversationGroup[], previous: readonly ConversationGroup[]): boolean {
  if (next.length !== previous.length) return false
  return next.every((group, index) => group === previous[index])
}

/** 行内重命名的校验结果：`null` 表示"这次提交不成立"（按钮该是灰的、且不发请求） */
export interface TopicDraft {
  /** 可以提交的标题（已 trim） */
  topic: string
  /** 与原名相同 ⇒ 没有改动，不该发 PATCH（省一次请求，也避免把 `updatedAt` 无谓推进） */
  unchanged: boolean
}

/**
 * 行内重命名的**唯一**校验（`P0-1-34`；`shared` 的 `renameConversationBodySchema` 是服务端那一半）。
 *
 * 三条与后端**逐条对齐**（不是"看着差不多"）：
 *   · `trim()` 之后**非空**（后端的 `.trim().min(1)`）—— 只有空格算空；
 *   · 长度 ≤ {@link CONVERSATION_TOPIC_MAX_CHARS}（后端 `.max(...)`，同一个常量）；
 *   · **`null` 不是一种输入**：界面没有"清空标题"的交互，后端也会拒（`shared` 的 schema 注释）。
 *
 * 返回 `null` = 这次提交不成立。⚠️ 长度按**码点**算（`[...topic].length`）：后端 zod 的
 * `.max()` 也是按码点 —— 用 JS 的 `.length`（UTF-16 码元）会让**一个 emoji 算两个字符**，
 * 于是前端在自己这边拦下 128 个 emoji 的标题，而后端明明接受 255 个。
 */
export function normalizeTopicDraft(raw: string, original: string | null): TopicDraft | null {
  const topic = raw.trim()
  if (topic === '') return null
  if ([...topic].length > CONVERSATION_TOPIC_MAX_CHARS) return null
  return { topic, unchanged: topic === (original ?? '') }
}

/**
 * 新建会话按钮该做什么（**一个纯判据**，免得组件里写 `if (conversationId === undefined)`）。
 *
 * `already-new` 时**不改动 URL**：从"某个会话"切到"新会话态"是一次导航，而在新会话态里
 * 再点一次不该往浏览器历史里塞一个**什么都没变**的条目（用户按后退时会原地不动，
 * 看起来像"后退坏了"）。
 */
export function newConversationAction(conversationId: string | undefined): 'navigate' | 'already-new' {
  return conversationId === undefined ? 'already-new' : 'navigate'
}
