/**
 * 展示层的格式化（P0-1-35 提为公共模块）
 *
 * 原本只有 `formatUpdatedAt` 一个函数、住在 `pages/agents/agentModel.ts` 里（P0-1-31）。
 * 知识库列表（P0-1-35）同样要显示"最近更新"，而**时间读数的格式必须只有一份**：
 * 两处各写一遍的后果不是"多几行"，而是同一份数据在两张表上长得不一样 ——
 * 用户对照截图排查时，会先怀疑"是不是两条数据的更新时间真的不同"。
 *
 * ⚠️ 这是一次**跨批次的抽取**，所以按本仓既定的重构口径处理（`06` §六 第 ② 条）：
 * 1. **对外导出与实现逐字未变** —— `agentModel.ts` 改成 `export { … } from` 重导出，
 *    P0-1-31 的页面 import 路径一字未动；
 * 2. 抽取前 `verify:chat-sse` / `lint` / `tsc` 的基线就是它的安全网（P0-1-31 的页面无专属脚本，
 *    但 `tsc` 会拦住任何漏改的引用）；
 * 3. 验收档里加了一条**源码级守门**：`formatUpdatedAt` 的 `function` 定义在全仓**恰好一处**
 *    （同 `06` §六 第 ⑰ 条"同一口径在两处各写一遍，必有一处先腐烂"）。
 */

/**
 * 时间格式化：`09-22 15:04`（与 `design/*.html` 的表格读数一致）。
 *
 * 刻意**不用 `toLocaleString`**：它的输出随运行环境（语言 / 时区 / ICU 版本）变化，而这个读数
 * 会被拿来与文档、截图对照 —— 一个本地化格式会让"这里显示的时间对不对"变成不可判的事。
 * 取本地时区这一点是刻意的（用户看的是自己机器上的时间）。
 */
export function formatUpdatedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 字节数 → 人类可读（`512 B` / `2.0 KB` / `5.0 MB` / `1.2 GB`）。
 *
 * ⚠️ **P1-15：全仓唯一的体积口径**。此前有两份实现 —— `features/chat/workspaceModel.ts` 的
 * `formatBytes`（到 GB）与 `features/chat/ArtifactCard.tsx` 的 `formatSize`（只到 MB）——
 * 同一份字节数在两个页面显示**不一样**（1.5 GB 的产物在消息流里显示成 1536.0 MB）。
 * 两份实现必然先烂一处，故收成这一份：`workspaceModel` 改为**重导出**（原有 import 不动），
 * `ArtifactCard` 直接 import 这里。
 *
 * 判据（与原先的 `formatBytes` 逐字一致，`verify-workspace-ui` 的 W6 是安全网）：
 * `< 1024` 原样显示 B；往上每 1024 一档，最多到 GB，保留 1 位小数。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
