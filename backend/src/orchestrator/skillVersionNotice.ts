/**
 * Skill **版本变化提示**（P1-24a-4）—— 纯函数，可进无依赖档
 *
 * 依据：`docs/子方案/Skill能力.md` §4.2 / §5.9 / §5.16 + `docs/06-实施计划.md` P1-24a-4
 *      （`skill:last-loaded` + **不落库**的版本提示 + `tool_calls` 审计）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个文件只回答一个问题：**这一轮要不要对模型说"Skill 已更新，请重新 load"**
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要它（§4.2.1 最后一段）：历史里的旧 `load_skill` 结果**不会被平台改写**（它是对话上下文
 * 的一部分）。Skill 升到 v2 后，模型手里仍然是 v1 的正文，而目录段已经变成 v2 ⇒ 它会拿旧正文
 * 去执行新流程。目录变了但正文没变，这件事只能在轮次边界用**一句话**告诉它。
 *
 * ⚠️ **提示不落库**（§4.2："不落库的 system-like 提示"）：它只存在于本轮 `messages` 里的那条
 *    `user` 消息，不写 `messages.content`、不写 `tool_calls`。理由有两条：
 *    ① 落库后下一轮还会被历史带回来 —— "请重新 load"变成一句永远成立的话；
 *    ② 它是**运行时事实**（相对"上一次加载"），不是"这一轮发生了什么"，历史里没有它的语义位。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条判据（每条对应一种"误报 / 漏报"）
 * ─────────────────────────────────────────────────────────────────────
 * ① **只提示"本会话真的加载过"的 Skill**：`skill:last-loaded` 里没有这个 `skillId` ⇒ 什么都不断言。
 *    首次使用 / Redis 丢失 / 换了会话 —— 一律"没有上次版本"，**不提示**（不会把"第一次"说成"更新了"）。
 * ② **只比较上游版本**（`version`）：固定版本（`config.skillVersion`）的 Skill 版本本来就不会变；
 *    会话级覆写（c-4b）**不写这个哈希**，故也不参与"上游版本变化"的提示。
 * ③ **只提示"变了"**：`last === 本轮版本` ⇒ 不提示（`null` 返回值，调用方连消息都不拼）。
 *
 * ⚠️ 版本**回退**（v3 → v2，例如重新导入后手工把 `skills.version` 调小，或 Redis 里残留了旧值）
 *    也按"变了"处理：模型手里的正文同样可能对不上，提示的措辞对两种情况都成立。
 */

/**
 * 一条"需要重新 load"的记录（`skillId` 是 Redis 哈希的字段名，`slug` / `name` 只用于文案）。
 *
 * 为什么不带 `skillVersion` 的**旧值**：文案只需要"现在是哪一版"，旧版号对模型没有行动价值
 * （它要做的动作只有一个：重新 `load_skill`）。旧值留在 Redis 里供排查。
 */
export interface SkillVersionChange {
  skillId: string
  slug: string
  name: string
  /** 本轮（新）版本 */
  version: number
}

/** 提示里的**单条上限**：目录最多 20 条时，一条也不会被截掉；防御数据异常时消息无限长 */
export const SKILL_VERSION_NOTICE_MAX_ITEMS = 20

/**
 * 比较"上次加载的版本"与"本轮快照"，返回**需要提示**的项（空数组 = 不提示）。
 *
 * @param current     可用的快照项（`availableSkillEntries` 的输出，`slug asc`）
 * @param lastLoaded  Redis `skill:last-loaded:{conversationId}` 的内容（`skillId → version`）；
 *                    `undefined` = 没读到（Redis 丢失 / 首次使用 / 读取失败）⇒ **一律不提示**
 *
 * ⚠️ `lastLoaded === undefined` 与 `{}` 的差别只有一处：前者连"没有记录"都不该被当成"加载过"。
 *    两者在这里都产出空数组，但调用方据此可以跳过"写回"以外的所有逻辑（见 `chatBot.ts`）。
 */
export function detectSkillVersionChanges(
  current: readonly { skillId: string; slug: string; name: string; version: number }[],
  lastLoaded: Readonly<Record<string, number>> | undefined,
): SkillVersionChange[] {
  if (lastLoaded === undefined) return []
  const changes: SkillVersionChange[] = []
  for (const entry of current) {
    const last = lastLoaded[entry.skillId]
    // ① 本会话没加载过这个 Skill（或那一条记录坏了：NaN / 0 / 负数 —— 版本从 1 开始）：不知道该提示什么
    if (typeof last !== 'number' || !Number.isInteger(last) || last < 1) continue
    // ③ 版本没变：不提示（这是绝大多数轮次的路径）
    if (last === entry.version) continue
    changes.push({ skillId: entry.skillId, slug: entry.slug, name: entry.name, version: entry.version })
    if (changes.length >= SKILL_VERSION_NOTICE_MAX_ITEMS) break
  }
  return changes
}

/**
 * 把变化列表拼成注入 `messages` 的**一条 `user` 消息正文**。
 *
 * 为什么是 `user` 而不是 `system`：system 只有 `messages[0]`（`tools` 与它必须一起下发），轮中
 * 再插一条 system 会被部分上游拒绝 / 静默合并；"下一次 LLM 调用前插一条 user 消息"在这个仓库里
 * 既有先例（中途插话的注入、`TOOL_LOOP_LIMIT_NOTICE`）。
 *
 * ⚠️ **首行是 `SKILL_VERSION_NOTICE_MARK`**：这是"这条消息是平台生成的、不是用户说的"的**唯一**
 * 判据（日志排查 / 回归断言 / 将来 c 批抽取会话时跳过它都用这一处）。
 * 它**不落库**（`persist.ts` 只落正文与 `tool_calls`）⇒ 下一轮 `chatBot.ts` 重建 `messages` 时
 * 这条消息自然不存在，不需要"剔除上一轮提示"的额外逻辑 —— 提示只对**出现它的那一轮**成立。
 *
 * 文案里的三条约束：
 *   · 说清"现在已经是哪一版"—— 模型据此决定要不要重读；
 *   · 说清"你上下文里的正文是旧版"—— 否则它会认为历史里的 v1 正文仍然有效；
 *   · 不说"请忽略上面的内容"这类宽泛指令（会把用户真正的需求一起否掉）。
 */
export function formatSkillVersionNotice(changes: readonly SkillVersionChange[]): string {
  if (changes.length === 0) return ''
  const lines = changes.map((change) => `- ${change.name}（${change.slug}）已更新到 v${String(change.version)}`)
  return [
    SKILL_VERSION_NOTICE_MARK,
    '你之前加载过的 Skill 已经更新：',
    ...lines,
    '你上下文里现有的 Skill 正文可能是旧版本。涉及这些 Skill 的任务，请先重新调用 `load_skill` 读取最新版本再继续；不要继续依据旧正文执行。',
  ].join('\n')
}

/**
 * 版本提示消息的**尾标**（判据单一）：`chatBot.ts` 用它识别"这是上一轮注入的提示、不是用户说的话"。
 *
 * 用户消息里也可能碰巧包含这一句 —— 那种情况下平台只会多认一条消息（它本来就要发出去），
 * 不会丢任何用户内容、也不会改变任何判据的**结论**（版本比较只看 Redis 里的哈希）。
 */
export const SKILL_VERSION_NOTICE_MARK = '【平台提示 · Skill 版本变化】'

/**
 * `skill:last-loaded` 哈希的**回写输入**：一次成功读取（`load_skill` / `read_skill_file`）的
 * `skillId → 本轮版本`。
 *
 * ⚠️ **只写上游版本**：`audit.skillVersion` 命中会话级覆写时（c-4b）是 `basedOnVersion`，
 *    那时**不写**这个哈希（§5.9 / §5.16）。本批没有覆写 ⇒ 恒写；c-4b 回填时在调用点加一个
 *    `overrideRevision === undefined` 判据（`chatBot.ts` 的注释已留位）。
 */
export function skillLastLoadedUpdate(audit: { skillId: string; skillVersion: number }): Record<string, number> {
  return { [audit.skillId]: audit.skillVersion }
}
