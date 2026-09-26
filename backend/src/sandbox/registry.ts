/**
 * 沙箱名额册（进程内）—— 「本实例此刻手上有几个容器」（P0-3-2）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §九 3（并发配额的作用域）+ §九 2（槽位泄漏是"明明没人用却在排队"的成因）、
 *      `docs/02-后端设计.md` §七 第 1 步（满则 `queued` 排队 + 位次可见）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么是**进程内**而不是 Redis（这一条是设计里最容易做错的地方）
 * ─────────────────────────────────────────────────────────────────────
 * `子方案③` §九 3 把语义写死了：**`SANDBOX_CONCURRENCY` 的作用域 = 单个后端实例**
 * （不是"整个平台"），因为**容器是本机的** —— 槽位由实例 A 持有、容器却在实例 B 的宿主机上，
 * 这种账本一旦用全局 Redis 来记，B 挂掉时 A 手里的槽位不会自动释放（原话）。
 *
 * 进程内计数还有一个"自愈"的硬收益：**后端崩一次，计数天然归零**，而遗留容器由启动对账
 * 全部清掉 ⇒ 崩完重启后"账面 == 实际"是自动成立的。反过来，用 Redis 计数时崩溃会留下
 * **无人认领的槽位**（`子方案③` §九 2 点名的症状：明明没人用却在排队），要额外写一套对账逻辑。
 *
 * ⚠️ **扩容前必须改的两件事**（§九 3 明文要求写进 `02` §七）：配额作用域、孤儿回收归属。
 *    本文件是前者的落点 —— 单实例假设直接写在类型旁边，而不是埋在实现里。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不用 `orchestrator/semaphore.ts` 那个信号量
 * ─────────────────────────────────────────────────────────────────────
 * 那个是**匿名**的（"这个进程同时在跑几轮生成"），拿到释放函数就得自己保管；
 * 而沙箱名额必须**按会话记名**：复用已有容器时（同一会话的第二轮消息）**不该占新名额**，
 * 而这个判断需要问"这个会话此刻是不是已经拿着一个名额"。匿名信号量答不了这个问题。
 * 两者语义不同，刻意不合并 —— 合并的代价是把 ChatBot 那侧也拖进"按 key 记账"的复杂度。
 *
 * 本文件不 import 任何东西（不碰 `config`、不碰 Redis、不碰 Docker），与 `semaphore.ts` 同款纪律：
 * **能在无依赖下判断的逻辑，别让它粘上依赖**。
 */

/** 名额册：`limit` 是上限，`size` 是当前**已占用**的数量 */
export interface SlotRegistry {
  /** 上限（构造时定，日志里写"x/limit"用） */
  readonly limit: number
  /** 当前占用数（不是控制路径；控制路径是 {@link SlotRegistry.tryAdd}） */
  readonly size: number
  /** 这个会话此刻是否占着名额 */
  has(conversationId: string): boolean
  /**
   * 尝试占一个名额。
   * @returns 占到了返回 `true`；
   *          **已满**或**这个会话已经在册**都返回 `false`（后者是幂等保护：
   *          重复占会让 `size` 虚高、把一个不存在的容器算进配额）。
   */
  tryAdd(conversationId: string): boolean
  /** 释放；不在册返回 `false`（幂等：回收路径会被对账器与 idle 回收器重复走到） */
  remove(conversationId: string): boolean
  /** 当前在册的会话 id（诊断/日志用；返回副本，外部改不到内部状态） */
  conversations(): string[]
}

/**
 * 造一个名额册。
 *
 * @param limit 上限。`< 1` 会被抬到 1：`0` 会让**所有**任务永远排在队列里（一个永远打不开的功能），
 *   而"一个沙箱都不允许"不是任何一个部署想要的语义（要停服务应该走停机，不是把上限设成 0）。
 *   与 `createSemaphore` 同一条取舍。
 */
export function createSlotRegistry(limit: number): SlotRegistry {
  const capacity = Math.max(1, Math.floor(limit))
  const held = new Set<string>()

  return {
    get limit(): number {
      return capacity
    },
    get size(): number {
      return held.size
    },
    has(conversationId: string): boolean {
      return held.has(conversationId)
    },
    tryAdd(conversationId: string): boolean {
      if (held.has(conversationId)) return false
      if (held.size >= capacity) return false
      held.add(conversationId)
      return true
    },
    remove(conversationId: string): boolean {
      return held.delete(conversationId)
    },
    conversations(): string[] {
      return [...held]
    },
  }
}
