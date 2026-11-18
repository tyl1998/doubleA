/**
 * TaskAgent 侧与容器 `skills` 扩展的**衔接点**（P1-24b-2）
 *
 * 依据：`docs/子方案/Skill能力.md` §4.14（同步时机第 4 步）/ §4.15（容器内工具注册）/
 *      §4.16（失败与重建）/ §4.19（验收判据）；`docs/06-实施计划.md` P1-24b-2。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这里只做三个**纯函数**（派活路径上的判断，全部可无容器逐条核对）
 * ─────────────────────────────────────────────────────────────────────
 * ① {@link skillToolSetOf}：这一轮该在容器里注册哪几个工具（**只从 manifest 读** —— manifest 是
 *    后端生成的唯一真相，容器不手写第二份名单）；
 * ② {@link needsSkillsRefresh}：要不要在 prompt 前注入 `/doubulea:skills-refresh`
 *    （工具集合 0→N / N→0 / 集合本身变了才要；**仅版本变化不用**，扩展读的是 `path`）；
 * ③ {@link skillsMountHealthy}：容器里 `$HOME/.skills` 是否真的挂着宿主副本
 *    （历史容器 / 手工 `docker run` 出来的容器没有这条 bind ⇒ 必须重建，见 §4.16）。
 *
 * ⚠️ 本文件**不碰 Docker、不碰引擎桥**：`taskAgent.ts` 把三者的结论拼进这一轮的 prompt / 重建判据，
 *    回归 `skill-sync:regression` 直接喂数据核对。
 */

import { SKILLS_REFRESH_COMMAND, type SkillManifest } from '@doubulea/shared'

/** 容器扩展刷新命令（`/` 前缀才是 pi 的扩展命令；与 `SKILLS_REFRESH_COMMAND` 逐字对应） */
export function skillsRefreshPromptLine(): string {
  return `/${SKILLS_REFRESH_COMMAND}`
}

/**
 * 这一轮要在容器里注册的工具名（**来自 manifest 的 `tools[]`**，顺序即 manifest 顺序）。
 *
 * 空数组 = 一个 Skill 都没绑 ⇒ 扩展不注册任何工具（"有 Skill 才有工具"）。这也是 refresh 的判据源：
 * 扩展注册过的集合与它不同 ⇒ 要刷新。
 */
export function skillToolSetOf(manifest: SkillManifest | null): string[] {
  if (manifest === null) return []
  return manifest.tools.map((tool) => tool.name)
}

/**
 * 是否需要在 prompt 前注入 refresh。
 *
 * 判据是**工具名集合**（排序后逐项比较），不是整份 manifest：
 *   · 0→N（首次绑定）⇒ 要；N→0（全部解绑）⇒ 要（把旧工具摘掉）；
 *   · 集合相同、只有版本/正文变 ⇒ **不要**（扩展每次调用都按 manifest 的 `path` 读，版本已是最新）；
 *   · 集合不同（未来放开 `run_skill_script` 时）⇒ 要。
 *
 * @param registered 容器里当前**已注册**的工具名（`null` = 不知道 ⇒ 宁可多刷一次，代价只是一条命令）
 */
export function needsSkillsRefresh(registered: readonly string[] | null, desired: readonly string[]): boolean {
  if (registered === null) return desired.length > 0
  const a = [...registered].sort()
  const b = [...desired].sort()
  if (a.length !== b.length) return true
  return a.some((name, index) => name !== b[index])
}

/**
 * 容器里的 Skill 挂载点是否与宿主副本**对得上**（§4.16「容器没有 Skill mount ⇒ 重建」）。
 *
 * 两条判据缺一不可（只判一条都会造出"看着挂着、其实读的是另一份"的静默状态）：
 *   ① 挂载点是个**目录**（不是文件 / 不存在 ⇒ 历史容器或建容器时源目录没就位）；
 *   ② 目录里能读到 `manifest.json` —— 至少能读出**会话 id**，且与调用方给的 `conversationId` 一致
 *      （bind 源指到了别人的目录 / 只读层里恰巧有同名文件 ⇒ 不能继续用）。
 *
 * 有效 ⇒ 不需要重建（**哪怕 manifest 里的技能集合是空的** —— 空目录 + 空 manifest 是一致的状态）；
 * 无效 ⇒ 重建容器（`manager.ts#ensureSkillRuntimeDir` 会先把宿主目录建好、再挂回去，内容由同步器补齐）。
 *
 * @param probe 探针的结果（`null` = 读不到 manifest）
 */
export function skillsMountHealthy(
  probe: { isDirectory: boolean; manifest: Pick<SkillManifest, 'conversationId'> | null },
  conversationId: string,
): boolean {
  if (!probe.isDirectory) return false
  if (probe.manifest === null) return false
  return probe.manifest.conversationId === conversationId
}
