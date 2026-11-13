/**
 * Skill 正文的**进程内缓存**（P1-24a-4）
 *
 * 依据：`docs/子方案/Skill能力.md` §5.11（"进程内缓存 key 必须包含 `skillId + version`"）+
 *      §5.14（"进程内缓存 key = `skillId + version`；不把正文缓存在进程内无限增长"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要缓存
 * ─────────────────────────────────────────────────────────────────────
 * 一次 `load_skill` 的分页读会**连着读同一个对象好几次**（每一页都是一次工具调用），
 * `read_skill_file` 同理。不缓存的话，一篇 9000 码点的 `SKILL.md` 翻两页就是两次 S3 往返，
 * 每次都要把整个对象收流。S3 对象**不可变**（路径含版本号），所以只要 key 里带版本，
 * 缓存就永远不会给出"另一个版本的内容"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条硬口径
 * ─────────────────────────────────────────────────────────────────────
 * ① **key 必须含 `skillId + version`**（外加 `path`）：只按路径缓存会在版本升级后给出旧正文 ——
 *    而症状是"模型读到旧流程 + 目录说新版本"，两者矛盾却没有任何报错。
 * ② **必须** 有上限（条数 + 总字符）：进程内缓存不设上限就是一个慢性内存泄漏（Skill 数量 ×
 *    版本数 × 文件数可以无限增长）。超限按 LRU 逐出，**不一次清空**（清空会让活跃 Skill 反复
 *    重读，等于没缓存）。
 * ③ **不缓存失败**：对象已回收 / 读失败一律不进缓存 —— 缓存"读不到"这件事会让一次临时的
 *    S3 故障变成永久的"版本已归档"，直到进程重启。
 *
 * ⚠️ 本文件**零依赖**（不碰 config / S3 / prisma）：容量参数由调用方传，回归可直测。
 */

/** 缓存键：`skillId + version + path` 三段（见文件头 ①） */
export function skillObjectCacheKey(skillId: string, version: number, path: string): string {
  return `${skillId}\u0000${String(version)}\u0000${path}`
}

/**
 * 缓存的取值域（只放"整份文件文本"，不放切片 —— 切片是每页各不相同的临时结果）。
 *
 * ⚠️ 容量按 `String.length`（UTF-16 码元）计：它是**内存量级**的近似，不是契约里的码点数。
 *    两者最多差 2 倍，而上限本身就是为了"别无限长"，不需要精确。
 */
export interface SkillObjectCache {
  /** 命中返回文本；未命中返回 `undefined`（**不区分"没缓存"与"值为空串"**：空文件也缓存，返回 `''`） */
  get(key: string): string | undefined
  /** 写入（`text` 超过单项上限时**不缓存**：一个巨物进来会把其它条目全挤掉） */
  set(key: string, text: string): void
  /** 当前条数与总字符（回归断言用；运行期只看上限行为） */
  stats(): { entries: number; totalChars: number }
  /** 清空（仅测试 / 诊断用） */
  clear(): void
}

/**
 * 造一个 LRU 缓存。
 *
 * @param maxEntries   条数上限（默认 64：一个 Agent 绑 20 个 Skill × 每版 3 个文件就到顶了）
 * @param maxTotalChars 总字符上限（默认 4,000,000 ≈ 4M 码点 ≈ 8–16MB 内存：一个进程级别的合理量级）
 * @param maxItemChars  单项上限（默认 1,000,000：再大的文件缓存它没有意义）
 *
 * ⚠️ 用 `Map` 的插入顺序当 LRU：`get` 命中时把键删了再插到末尾（O(1)），逐出时取第一个键。
 *    JS 的 `Map` 保插入顺序，这个手法在本仓库的 `chatStream` 拼接 / 帧队列里已有先例。
 */
export function createSkillObjectCache(
  maxEntries = 64,
  maxTotalChars = 4_000_000,
  maxItemChars = 1_000_000,
): SkillObjectCache {
  /** key → 文本（插入顺序 = 从旧到新） */
  const store = new Map<string, string>()
  let totalChars = 0

  const evictUntilWithinLimits = (): void => {
    while (store.size > maxEntries || totalChars > maxTotalChars) {
      const oldest = store.keys().next()
      if (oldest.done === true) break
      const value = store.get(oldest.value)
      store.delete(oldest.value)
      if (value !== undefined) totalChars -= value.length
    }
  }

  return {
    get(key: string): string | undefined {
      const value = store.get(key)
      if (value === undefined) return undefined
      // LRU：命中即提到队尾（先删后插，`totalChars` 不动）
      store.delete(key)
      store.set(key, value)
      return value
    },
    set(key: string, text: string): void {
      if (text.length > maxItemChars) return
      const previous = store.get(key)
      if (previous !== undefined) {
        totalChars -= previous.length
        store.delete(key)
      }
      store.set(key, text)
      totalChars += text.length
      evictUntilWithinLimits()
    },
    stats(): { entries: number; totalChars: number } {
      return { entries: store.size, totalChars }
    },
    clear(): void {
      store.clear()
      totalChars = 0
    },
  }
}