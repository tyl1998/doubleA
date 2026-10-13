/**
 * 全局服务状态灯（P0-1-30 起住在旧外壳 `AppLayout` 的 rail 里；P1-15 提为公共组件）
 *
 * 依据：`docs/03-前端设计.md` §三（"全局服务状态灯 —— 真实数据来自 `GET /health`，不是装饰"）。
 *
 * ⚠️ **为什么 P1-15 要把它从外壳里提出来**：P1-15 修订后外壳收敛为一个（`AppShell`），
 * 左列是**会话栏** `ConvRail`（聊天与各管理页共用同一列），这盏灯就长在会话栏底部；
 * 提成公共组件后，谁渲染左列都不必抄第二份 `ok/degraded` 判据 —— 正是 `06` §六 第 28 条
 * 要防的"同一口径两处写"。
 */

import { HEALTH_TARGET_LABEL, useHealth } from '../api/health.js'

/**
 * 三态（正常 / 降级 / 取不到），文案在 `title` 里给全 —— 避免只有一个颜色（色觉障碍用户读不出）。
 * 数据源是 {@link useHealth}（`GET /health`），每处渲染调用它一次；TanStack Query 会合并缓存。
 */
export function ServiceLed() {
  const health = useHealth()

  let className = 'led led--idle'
  let title = '正在读取服务状态…'
  if (!health.isPending) {
    const report = health.data
    if (report === undefined) {
      className = 'led led--fail'
      title = '取不到服务状态（/health 未响应）'
    } else if (report.status === 'ok') {
      className = 'led led--ok'
      title = `服务正常 · v${report.version} · ${report.env}`
    } else {
      const broken = report.checks
        .filter((check) => !check.ok)
        .map((check) => `${HEALTH_TARGET_LABEL[check.target]}：${check.detail}`)
        .join('；')
      className = 'led led--warn'
      title = `部分依赖不可用 —— ${broken}`
    }
  }

  return <span className={className} title={title} role="img" aria-label={title} />
}