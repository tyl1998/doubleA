/**
 * 首帧等待页（P0-1-30）
 *
 * 唯一用途：`RequireAuth` 正在确认登录态（`GET /api/auth/me` 还没回来）。
 *
 * 为什么需要它（而不是直接渲染登录页再跳）：这个窗口里"已登录"和"未登录"都还不确定，
 * 先渲染登录页会让已登录的用户看到一次登录表单的闪烁；先渲染业务页又会漏出未鉴权内容。
 * 所以给一个**中性**的等待画面。
 *
 * 刻意不用 AntD 的全屏 Spin 遮罩：那会在最外圈压一层半透明黑，而本设计的底是暖纸
 * （遮罩色与页面色不对路）。这里只放一条等宽读数 —— 与左侧栏的语言一致。
 */

import { useT } from './i18n.js'

export function BootScreen() {
  const { t } = useT()
  return (
    <div className="boot" role="status" aria-live="polite">
      <p className="boot__line">
        <span className="led led--run" aria-hidden="true" />
        <span className="kicker">{`${t('boot.readingSession')} · /api/auth/me`}</span>
      </p>
    </div>
  )
}
