/**
 * 「最近变更」的**分类判据**（纯函数）—— 本轮 / 更早、以及"这条改动现在还算不算"。
 *
 * 依据（用户定案 2026-10-28）：
 *   · **本轮改动 = 当前保存改动的内容**（文件保存列表要同步更新）；
 *   · **更早 = 非本轮改动**（`git pull` / `git clone` 拉下来的不算）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不能只按"时间窗口里发生过事件"分类
 * ─────────────────────────────────────────────────────────────────────
 * 之前的实现把「本轮」定义成 `[轮起点, 轮末]` 里**发生过事件**的路径。实测（会话 `01a17c6d`
 * 「拉取代码」）暴露了两个致命后果：
 *   ① Redis 轮次标记被写坏（该轮事件是 `00:23:31Z`，标记却是 `08:23:31Z`，`ttl=-1` ⇒ 永不过期）
 *      ⇒ 那一轮真正的编辑被划进「更早」，而**昨天的随手保存**被划进「本轮」，两段彻底错位；
 *   ② 只按"发生过"分类 ⇒ 已经把文件**改回去**（撤销 / 手动回退）的条目仍留在列表里，
 *      与"当前保存改动的内容"不符 —— 用户看到一条 `+3 −2`，点开文件却和原来一样。
 *
 * 所以分类改成两步，且**两步都是纯函数**（可被 `workspace-regression` 逐条断言）：
 *   1. {@link pickUsableRoundStart}：轮次标记**必须与事件流自洽**才可用（窗口里一条内容事件都没有
 *      ⇒ 标记是坏的：过期残留 / 手工写入 / 时钟偏差），否则按"没有本轮"处理；
 *   2. {@link isWorkspaceChangeStillPresent}：这条改动在**当前内容**里是否仍然存在
 *      （改回去了 / 删了又建回原样 ⇒ 不再存在 ⇒ 不进列表）。
 *
 * 这样「本轮」永远是"你现在真的改着的东西"，而不是"某个时间窗里碰过的东西"。
 */

import {
  WORKSPACE_CONTENT_EVENT_TYPES,
  type WorkspaceActor,
  type WorkspaceChangeEntry,
  type WorkspaceEventItem,
} from '@doubulea/shared'

/** 一条路径**当前**的落库状态（`workspace_files` 当前态；缺席 = 索引里没有 / 已删） */
export interface WorkspacePathState {
  /** 当前版本（`workspace_files.version`） */
  version: number
  /** 是否墓碑（软删） */
  deleted: boolean
  /** 当前版本的**内容 hash**（判断"改回去了"必须比内容，不能比版本号） */
  contentHash: string
}

/** 当前态查表（`path → state`；不在表里 = 索引中没有这一行） */
export type WorkspacePathStates = ReadonlyMap<string, WorkspacePathState>

/** 取某路径某版本的**内容 hash**（`undefined` = 没有这条历史，无从判定） */
export type WorkspaceVersionHashOf = (path: string, version: number) => string | undefined

/**
 * 这条改动**在当前内容里还算数**吗（纯函数）。
 *
 * 判据：
 *   · `deleted`：文件**仍然不在**（不存在 / 仍是墓碑）⇒ 算数；
 *   · `created`：文件**现在还在** ⇒ 算数（新建后又被删掉 ⇒ 不算，它已经不在了）；
 *   · `updated` / `renamed`：当前内容 **≠ 那一段开始时**的内容 ⇒ 算数。
 *     没有基线信息（`beforeVersion` 缺省）时**保守保留** —— 宁可多显示一条，也不把真实改动藏掉。
 *
 * ★ 2026-10-28（用户反馈「拉取代码这个会话最近变更对不上」，实测数据）：
 *   判"改回去了"**必须比内容 hash，不能比版本号**。实测 `repo/pytest.ini`：
 *   v1 与 v3 的 `content_hash` **完全相同**（改了又改回去），但版本号 `3 !== 1`。
 *   按版本号判 ⇒ 它一直挂在「本轮」里冒充"改动"，与"本轮 = 当前保存改动的内容"直接矛盾。
 */
export function isWorkspaceChangeStillPresent(
  change: Pick<WorkspaceChangeEntry, 'path' | 'type' | 'beforeVersion'> & { version?: number | null },
  states: WorkspacePathStates,
  hashOf: WorkspaceVersionHashOf,
): boolean {
  const state = states.get(change.path)
  const exists = state !== undefined && !state.deleted
  if (change.type === 'deleted') return !exists
  if (exists !== true) return false
  // ⚠️ `created` 也要往下走「段内净变化」判据（2026-10-28 实测：v1 建、v3/v4 改回原样 ⇒ 不该显示），
  //    但只有拿到 `version` 时才有得比；拿不到就保留（新建总归是改动）。
  if (change.type === 'created' && change.version === undefined) return true
  if (change.beforeVersion === undefined) return true
  // `beforeVersion === null` = 那一段开始时文件不存在（新建）。
  // ★ 2026-10-28：仍然要看"段内净变化"—— 新建后在本段内又改回空/原样，同样是零变化。
  //   拿不到 `version` 时才直接放行。
  const endVersion = change.version ?? null
  const baseline = change.beforeVersion
  // 段内净变化（2026-10-28 实测）：段初与段末内容完全相同 ⇒ 这一段没改动，不该显示。
  //   实测 `repo/conftest.py`「更早」是 v1→v37，两版 hash 相同（改了 36 次又改回原样）⇒ 徽标 +0 −0。
  //   新建（`baseline === null`）没有段初内容，跳过这一步。
  if (baseline !== null && endVersion !== null) {
    const endHash = hashOf(change.path, endVersion)
    if (endHash !== undefined) {
      const startHash = hashOf(change.path, baseline)
      if (startHash !== undefined && startHash === endHash) return false
    }
  }
  // `baseline === null` = 这一段开始时文件不存在（新建）⇒ 现在存在就一定是真实新增
  if (baseline === null) return true
  const baseHash = hashOf(change.path, baseline)
  // 查不到基线历史 ⇒ 无从判定，保守保留（不把可能的真实改动藏掉）
  if (baseHash === undefined) return true
  return state.contentHash !== baseHash
}

/**
 * 轮次标记**可用**吗（纯函数）→ 可用的起点（ISO），否则 `null`。
 *
 * 判据（全部要满足，任一不满足就按"没有本轮"处理，**绝不猜**）：
 *   · 起点能解析；`end` 存在时也能解析，且 `start <= end`；
 *   · 起点不在未来（容忍 `skewToleranceMs`：标记与事件由同一台机的两个时钟写入，几十毫秒的抖动正常）；
 *   · 窗口 `[start, end]` 内**至少有一条内容事件** —— 一轮什么都没改时"本轮"本就该是空的，
 *     但窗口里**一条都没有**同时又是坏标记最常见的形态（实测：标记偏 8 小时，窗口内空无一物）。
 *     两种情况都按"没有本轮"处理即可：没有本轮时，「本轮」退化成"当前仍存在的改动"，正好是
 *     用户要的「当前保存改动的内容」。
 *
 * @param nowMs  当前时刻（注入，便于回归里逐条构造）
 */
export function pickUsableRoundStart(
  marker: { start?: string; end?: string },
  contentAtMs: readonly number[],
  nowMs: number,
  skewToleranceMs = 60_000,
): string | null {
  if (marker.start === undefined) return null
  const startMs = Date.parse(marker.start)
  if (Number.isNaN(startMs)) return null
  const endMs = marker.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(marker.end)
  if (Number.isNaN(endMs) || endMs < startMs) return null
  if (startMs > nowMs + skewToleranceMs) return null
  // 窗口内得有内容事件（空窗口 ⇒ 标记与事件流不自洽）
  const hasInside = contentAtMs.some((at) => at >= startMs && at <= endMs)
  return hasInside ? marker.start : null
}

/** 原始事件 → 内容事件的时间戳（毫秒；解析不了的丢弃）。DB 原始行是 `Date`，事件项是 ISO 串，两种都收。 */
export function contentEventTimes(items: readonly { at: string | Date }[]): number[] {
  const out: number[] = []
  for (const item of items) {
    const at = item.at instanceof Date ? item.at.getTime() : Date.parse(item.at)
    if (!Number.isNaN(at)) out.push(at)
  }
  return out
}

/** 分段输入：一条内容事件 + 它的**基线版本**（那一段开始时该路径的版本；`null` = 不存在） */
export interface WorkspaceSegmentedEvent extends WorkspaceEventItem {
  /** 这一段开始时该路径的版本（`null` = 开始时不存在） */
  beforeVersion?: number | null
  /** 这条属于哪一段（`current` = 本轮 / `earlier` = 更早） */
  segment?: 'current' | 'earlier'
}

/**
 * 一条事件的**稳定标识**（`path + at + id`）—— 用它在调用方算好的基线表里取这一跳的基线。
 *
 * 只靠 `path` 不够：同一路径有几十跳，每一跳的基线都不同（按次口径的核心）。
 * `id` 兜住"同一毫秒写两次"的极端情形。
 */
export function segmentKey(event: Pick<WorkspaceEventItem, 'id' | 'path' | 'at'>): string {
  return `${event.path}\u0000${event.at}\u0000${event.id}`
}

/**
 * 把事件流切成「本轮 / 更早」两段（用户定案 2026-10-28，2026-10-28 二次修订）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 分段依据是**来源 + 每文件最近一次**，不是"某个时间窗"
 * ─────────────────────────────────────────────────────────────────────
 *   · **agent 写** ⇒ 按派活节奏：同一文件本轮最后一次 agent 写入算「本轮」。
 *   · **用户手写**（保存 / 上传 / 拖拽 / 新建 / 删除）⇒ **每次保存各自一段**，天然是「本轮」。
 *   · **本轮 = 每个文件各自最近一次保存**（不管谁写的）。于是：
 *       - 同一文件连改两次（33 行 → 44 行）⇒ 本轮是「33→44 那次」，前一次退回更早；
 *       - agent 依次保存 A、B、C 三个文件 ⇒ 三个**都**在本轮；
 *       - 用户手改 A、agent 改 B ⇒ 两条都在本轮（各自最近一次）；
 *       - 用户手改 A、agent 又改 A ⇒ 本轮是 agent 那次，用户那次退到更早。
 *   · **更早 = 每个文件的其余历史压成一条**（`轮前最早 → 轮前末版本`），不让几十次
 *     历史保存把清单撑爆。
 *   · 同一文件两段都动过 ⇒ 两段**各出现一条**（各自的版本范围），能看出"更早也动过"。
 *
 * ⚠️ 不做"纯手写会话"的特判：那由一个**它已有的数据**自然判定 —— 从没派过活时
 *   所有事件都是 `USER`，「本轮」就是用户的编辑历史，前端据此把标题显示成「变更历史」，
 *   而不是把真实改动塞进「更早」这个灰区（详见 `workspaceChangeGrouping`）。
 *
 * ⚠️ 曾经取"全局最后一跳"当本轮 —— 那会让 A、B 掉进「更早」、甚至被历史折叠掉，
 *   用户一次看到三个文件改动却只列出最后一个，这是明确的反例。
 *
 * 纯函数（不碰 DB / 时钟），`workspace-regression` 可直接逐条断言。
 *
 * @param events      内容事件流（顺序不限；内部按 `at` 比较）
 * @param beforeOf   取某条事件的**基线**（这一跳之前该文件的版本；`null` = 当时不存在）
 */
export function splitWorkspaceChangesByRound(
  events: readonly WorkspaceSegmentedEvent[],
  beforeOf: (event: WorkspaceSegmentedEvent) => number | null | undefined = (event) => event.beforeVersion,
): { current: WorkspaceSegmentedEvent[]; earlier: WorkspaceSegmentedEvent[] } {
  const contents = events.filter((event) => (WORKSPACE_CONTENT_EVENT_TYPES as readonly string[]).includes(event.type))
  if (contents.length === 0) return { current: [], earlier: [] }

  // 每条路径**各自**的最后一跳（`at` 相同取后出现者，与 `foldWorkspaceEvents` 同款）
  const lastByPath = new Map<string, WorkspaceSegmentedEvent>()
  for (const event of contents) {
    const current = lastByPath.get(event.path)
    if (current === undefined || event.at >= current.at) lastByPath.set(event.path, event)
  }
  // 本轮 = 各路径自己的最近一次保存（A、B、C 都在，不是只有最后一个动作）
  const current = [...lastByPath.values()].map((event) => toSegment(event, 'current', beforeOf))

  // 更早 = 这些路径的**其余历史**，按路径压成一条（轮前最早 → 轮前末版本）
  const earlierByPath = new Map<string, { first: WorkspaceSegmentedEvent; last: WorkspaceSegmentedEvent }>()
  for (const event of contents) {
    const latest = lastByPath.get(event.path)
    if (latest !== undefined && event.at >= latest.at) continue
    const existing = earlierByPath.get(event.path)
    if (existing === undefined) earlierByPath.set(event.path, { first: event, last: event })
    else {
      if (event.at < existing.first.at) existing.first = event
      if (event.at >= existing.last.at) existing.last = event
    }
  }
  // ★ 2026-10-28 实测修正：更早那一条的基线**不能**用 `beforeOf(first)`。
  //   `first` 若是 `created`（该文件在本会话里第一次出现），`beforeOf(first)` = null
  //   ⇒ 清单显示 `vNone→v3`，等于说"更早这一段整篇都是新建"，可它其实是 v1 建、v1→v3 改。
  //   正确基线 = **本会话最早出现这条路径时**的版本（`created` ⇒ 它自己的 version；
  //   `updated` ⇒ 它的前一版；`deleted` ⇒ 被删前那一版），也就是"轮前这段开始之前长什么样"。
  const earlier = [...earlierByPath.values()].map(({ first, last: tail }) =>
    toSegment(tail, 'earlier', () =>
      // 更早那一条的基线 = 该路径在**本会话最早那次事件之前**的版本
      first.type === 'created' ? first.version : beforeOf(first),
    ),
  )
  const byRecent = (a: WorkspaceChangeEntry, b: WorkspaceChangeEntry): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)
  return { current: current.sort(byRecent), earlier: earlier.sort(byRecent) }
}

/**
 * 一份变更清单该按哪种口径展示（纯函数）。
 *
 * ★ 2026-10-28（用户定案「手写是一等公民」）：**从没派过活、只有手写的会话**不该出现
 *   「本轮 / 更早」两段 —— 那是"二手数据"的视觉，用户会以为自己看到的是残缺状态。
 *
 * ★ 2026-10-28 浏览器实测修正（**关键**）：原来判据是"清单里有 `AGENT` 才算 rounds"，
 *   实测会话 `01a17c6d`（真跑过 agent、clone 过仓库）一条 `AGENT` 事件都没有 ——
 *   它的 `created/updated` 全是 `SYSTEM`（watcher 对账读盘落的账；`git clone` 与
 *   用户经引擎的写也落 `SYSTEM`）。于是这个**明显有 agent 参与的会话**被判成
 *   「变更历史」，两段分组整个消失，与方案完全对不上。
 *
 *   改为：**只要不是"全是 USER 手写"，就按 `rounds` 分两段**。
 *   · 有 `AGENT` ⇒ rounds（明确）；
 *   · 有 `SYSTEM`（clone / 对账 / 引擎写）⇒ rounds —— 这些是机器写，不是"我的编辑历史"；
 *   · **只有 `USER`** ⇒ history（这才是真正的纯手写会话）。
 *
 * ⚠️ 不拿 `round.start` 是否存在来判：那个字段是按「最后一条用户消息」算的，纯手写会话
 *   也可能有（用户发过话但没派活），用它判会把手写历史错判成"有轮次"。
 *
 * @param items 已分段、已过滤的变更清单
 */
export function workspaceChangeGrouping(
  items: readonly Pick<WorkspaceChangeEntry, 'actor'>[],
): 'rounds' | 'history' {
  if (items.length === 0) return 'history'
  return items.every((item) => item.actor === 'USER') ? 'history' : 'rounds'
}

// ═════════════════════════════ 撤销范围（2026-10-28 用户定案） ═════════════════════════════

/** 撤销范围（用户选择的三级；**默认最安全**） */
export const WORKSPACE_REVERT_SCOPES = ['AGENT_ONLY', 'ALL', 'SELECTED'] as const
export type WorkspaceRevertScope = (typeof WORKSPACE_REVERT_SCOPES)[number]

/** 撤销计划里的一条（比 `shared#WorkspaceRevertPlanEntry` 多"来源 / 是否含手写"） */
export interface WorkspaceRevertCandidate {
  path: string
  /** 这一段该路径的**起始版本**（`null` = 段初不存在）；仅用于展示"本轮从哪开始改" */
  beforeVersion: number | null
  /**
   * 本段**最后一跳之前**的那一版（`null` = 那一跳是新建 ⇒ 退一步 = 回到"删除文件"）。
   * 撤销的回滚点是它 —— "撤销本轮" = 文件级的**退一步**（2026-10-29 用户定案）。
   */
  previousVersion?: number | null
  /** 这一段该路径的**末状态**（CAS 判据："此后无人再动"） */
  expect: { deleted: true } | { deleted: false; version: number }
  /** 这一段里**最后一次**写入是谁（决定默认是否勾选） */
  lastActor: WorkspaceActor
  /** 这一段里是否**出现过用户手写**（`USER` 事件；仅展示用，不参与回滚点） */
  touchesUserEdit: boolean
  /** 不可撤销的原因（改名 / 二进制等由后续步骤补） */
  unsupported?: string
  /** 这一段内**用户手写**过的版本（升序；仅展示用，回滚点只看 `previousVersion`） */
  userVersions?: number[]
}

/** 撤销前的**预演三栏**：会还原 / 会删除 / 会跳过 */
export interface WorkspaceRevertPreview {
  /** 会改写成某历史版本（`fromVersion` 非空） */
  restore: string[]
  /** 这一段新建的 ⇒ 撤销 = 删除 */
  remove: string[]
  /** 不会动，附原因（用户手写未勾选 / 冲突 / 不可撤销） */
  skip: { path: string; reason: WorkspaceRevertSkipReason }[]
}

/** 跳过原因（前端按 key 取文案） */
export const WORKSPACE_REVERT_SKIP_REASONS = [
  'USER_EDIT_EXCLUDED',
  'CONFLICT',
  'UNAVAILABLE',
  'UNSUPPORTED',
  'NET_ZERO',
] as const
export type WorkspaceRevertSkipReason = (typeof WORKSPACE_REVERT_SKIP_REASONS)[number]

/**
 * 把**这一段内的内容事件**按路径折叠成撤销候选（纯函数）—— 与「最近变更」用**同一段划分**。
 *
 * 为什么不直接复用 `shared#planWorkspaceRevert`：那个只做"最早 / 最晚"折叠，回答不了
 * "这一段最后一次是谁写的""段里有没有用户手写"，而撤销范围与回滚点都靠这两个问题。
 * `beforeVersion` / `expect` 的算法与它**逐字一致**，所以两条路给出的回滚落点不会分叉。
 *
 * @param events 这一段内的内容事件（顺序不限）
 */
export function planWorkspaceRevertCandidates(
  events: readonly WorkspaceEventItem[],
): WorkspaceRevertCandidate[] {
  const byPath = new Map<
    string,
    { first: WorkspaceEventItem; last: WorkspaceEventItem; userVersions: number[] }
  >()
  for (const event of events) {
    if (!(WORKSPACE_CONTENT_EVENT_TYPES as readonly string[]).includes(event.type)) continue
    const seenUser = event.actor === 'USER' && event.version !== null
    const current = byPath.get(event.path)
    if (current === undefined) {
      byPath.set(event.path, {
        first: event,
        last: event,
        userVersions: seenUser ? [event.version as number] : [],
      })
      continue
    }
    if (event.at < current.first.at) current.first = event
    // `>=`：`at` 相同时后出现者胜（与 `foldWorkspaceEvents` 同款）
    if (event.at >= current.last.at) current.last = event
    if (seenUser) current.userVersions.push(event.version as number)
  }

  const candidates: WorkspaceRevertCandidate[] = []
  for (const [path, { first, last, userVersions }] of byPath) {
    // 改名 / 移动：整段撤销不支持（与 `planWorkspaceRevert` 同一条口径）
    if (first.type === 'renamed' || last.type === 'renamed') {
      candidates.push({
        path,
        beforeVersion: null,
        expect: { deleted: false, version: 0 },
        lastActor: last.actor,
        touchesUserEdit: userVersions.length > 0,
        unsupported: '改名/移动暂不支持整轮撤销',
      })
      continue
    }
    let beforeVersion: number | null
    if (first.type === 'created') beforeVersion = null
    else if (first.type === 'updated') beforeVersion = (first.version ?? 1) - 1 > 0 ? (first.version ?? 1) - 1 : null
    else beforeVersion = first.version ?? null // deleted：被删前的版本
    // ★ 2026-10-29（用户定案「撤销 = 退一步」）：`previousVersion` = 本段**最后一跳**之前的那一版。
    //   段初（`beforeVersion`）是"这一整段开始之前"，一轮里改了三次会连前面两次一起退掉；
    //   用户要的是文件级的"撤销一步"。
    let previousVersion: number | null
    if (last.type === 'deleted') previousVersion = last.version ?? null // 删除的上一版 = 被删前的内容
    else previousVersion = (last.version ?? 1) - 1 > 0 ? (last.version ?? 1) - 1 : null
    const expect =
      last.type === 'deleted'
        ? ({ deleted: true } as const)
        : ({ deleted: false, version: last.version ?? 0 } as const)
    candidates.push({
      path,
      beforeVersion,
      previousVersion,
      expect,
      lastActor: last.actor,
      touchesUserEdit: userVersions.length > 0,
      ...(userVersions.length === 0 ? {} : { userVersions: [...userVersions].sort((a, b) => a - b) }),
    })
  }
  return candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 这一条**在给定范围内**要不要撤（纯函数）。
 *
 * 口径（2026-10-29 用户定案「撤销本轮 = 退一步，选哪一个哪一个就回退」）：
 *   · `AGENT_ONLY`（默认）：**只撤"不是我手写收尾"的文件**。判据是**这一段最后一次写入是谁**：
 *       - 最后是 `USER` ⇒ 不撤（这一跳是你自己保存的，默认不动你）；
 *       - 最后是其它（`AGENT` / `SYSTEM`）⇒ 撤，回滚点 = **上一版**（见 `revertRollbackVersion`）。
 *   · `ALL`：这条路径**在本轮里出现过**就撤（含用户手写）—— 勾了就要回退。
 *   · `SELECTED`：**勾了谁就撤谁**，不看谁写的。
 *
 * ★ 为什么不再"含手写就跳过"（2026-10-29 用户指正「选哪一个哪一个就要回退」）：
 *   手写保护已经由**回滚点**承担（退回本段最后一跳的前一版），再在范围上否决一次，
 *   就变成"勾了没反应"。两条规则叠在一起看起来只是"更安全"，实际是"按了按钮什么都没发生"。
 *
 * ★ 实测修正（2026-10-28）：原来只认 `AGENT`，可真跑过的会话里 agent 写入常常落 `SYSTEM`
 *   （引擎写 / 对账读盘 / `git clone`）—— 会话 `01a17c6d` 一条 `AGENT` 事件都没有，
 *   于是「默认只撤 agent」等于**什么都不撤**，撤销按钮形同虚设。
 *
 * @param selected `SELECTED` 时用户勾选的路径（其它范围忽略）
 */
export function shouldRevertPath(
  candidate: Pick<WorkspaceRevertCandidate, 'path' | 'lastActor'>,
  scope: WorkspaceRevertScope,
  selected: readonly string[] = [],
): boolean {
  if (scope === 'SELECTED') return selected.includes(candidate.path)
  if (scope === 'ALL') return true
  return candidate.lastActor !== 'USER'
}

/**
 * 这一条撤销时**回滚到哪个版本**（纯函数）——「撤销本轮」= 文件级**退一步**。
 *
 * ★ 2026-10-29 用户定案（「撤销本轮的意思就是前一版本，无论如何都是前一个版本」）：
 *   回滚点 = **本段最后一跳之前的那一版**（{@link WorkspaceRevertCandidate.previousVersion}）。
 *   例 `v1 我建 → v2 agent → v3 我` ⇒ 回到 **v2**，文件不会消失。
 *   按旧口径（段初）这个例子会退到"不存在" ⇒ 整份文件被删（用户实测事故）。
 *
 * ⚠️ 只有"回滚点 == 当前版本"时才是"无可撤销的改动"；回滚点**大于**当前版本是不可能的
 *   （`previousVersion = last.version - 1`），所以不存在"回到未来"。
 *
 * `version === null` = 退一步会回到"文件不存在" ⇒ 撤销 = 删除。
 *   唯一成因：这一跳本身就是新建（`created`），也就是撤销"新建"这个动作本身，是正确的。
 *   （删除事件 `deleted vN` 的 `previousVersion` = `N` = 被删前的内容 ⇒ 撤销 = 恢复这个文件。）
 */
export function revertRollbackVersion(
  candidate: Pick<WorkspaceRevertCandidate, 'beforeVersion'> &
    Partial<Pick<WorkspaceRevertCandidate, 'previousVersion'>>,
): { version: number | null; reason: 'segment-start' } {
  if (candidate.previousVersion !== undefined) {
    return { version: candidate.previousVersion, reason: 'segment-start' }
  }
  return { version: candidate.beforeVersion, reason: 'segment-start' }
}

/**
 * 预演三栏（纯函数）：把候选按"会还原 / 会删除 / 会跳过"分好，供前端点之前就看得见。
 *
 * `skip` 里的 `USER_EDIT_EXCLUDED` = 范围没包含用户手写（默认范围下最常见的一条），
 * 前端要**单独灰显并注明原因**："系统不是漏了，是故意没动"。
 */
export function buildWorkspaceRevertPreview(
  candidates: readonly WorkspaceRevertCandidate[],
  scope: WorkspaceRevertScope,
  selected: readonly string[] = [],
): WorkspaceRevertPreview {
  const preview: WorkspaceRevertPreview = { restore: [], remove: [], skip: [] }
  for (const candidate of candidates) {
    if (candidate.unsupported !== undefined) {
      preview.skip.push({ path: candidate.path, reason: 'UNSUPPORTED' })
      continue
    }
    if (!shouldRevertPath(candidate, scope, selected)) {
      // 用户手写收尾 ⇒ 默认范围下"故意不动"；显式勾选了却仍不在范围内是不可能的（SELECTED 直接命中）
      preview.skip.push({
        path: candidate.path,
        reason: candidate.lastActor === 'USER' ? 'USER_EDIT_EXCLUDED' : 'CONFLICT',
      })
      continue
    }
    // 净变化为零 = 撤销的落点就是当前状态（段初与段末相同 ⇒ 这段没改动）。判据必须是
    // **回滚点**，不是 `beforeVersion`：现在是"退一步"，比段初会漏掉"改了又改回"的一整段。
    const rollbackTarget = revertRollbackVersion(candidate).version
    if (candidate.expect.deleted === false && rollbackTarget === candidate.expect.version) {
      preview.skip.push({ path: candidate.path, reason: 'NET_ZERO' })
      continue
    }
    // ★ 2026-10-29：预演与实际执行**同一个函数、同一个判据**（`revertRollbackVersion`）——
    //   预演存在的意义就是"点之前看得见结果"，两处判据分叉过一次（预演说还原、执行却删除）。
    if (rollbackTarget === null) preview.remove.push(candidate.path)
    else preview.restore.push(candidate.path)
  }
  return preview
}

/** 事件 → 变更条目（带段标记与基线） */
function toSegment(
  event: WorkspaceSegmentedEvent,
  segment: 'current' | 'earlier',
  beforeOf: (event: WorkspaceSegmentedEvent) => number | null | undefined,
): WorkspaceSegmentedEvent {
  const beforeVersion = beforeOf(event)
  return {
    ...event,
    segment,
    ...(beforeVersion === undefined ? {} : { beforeVersion }),
  }
}