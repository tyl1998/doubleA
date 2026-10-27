/**
 * 顶部黄条：断线提示（P0-1-33）
 *
 * 依据：`docs/03-前端设计.md` §4.1 —— **"断线 → 顶部黄条提示，点击黄条 = 立即拉取历史对齐"**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么整条是一个 `<button>`，而不是"一个 div + 里面一个按钮"
 * ─────────────────────────────────────────────────────────────────────
 * 契约说的是"**点击黄条** = 对齐"，不是"点击黄条里的某个按钮"。做成整条可点既贴合契约，
 * 也顺带把可访问性做对：`<div onClick>` 键盘用户永远够不到（Tab 停在它上面时 Enter 什么都不会发生），
 * 而 `<button>` 天然可聚焦、可回车、可被读屏软件读成"按钮"。
 * 视觉上它仍然是一条横贯的提示条（`styles/app.css` 的 `.banner--warn` 把按钮的默认外观抹平）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个必须写对的地方
 * ─────────────────────────────────────────────────────────────────────
 * ① **文案只有一份**（`streamErrors.ts`）：三种触发路径（连接中断 / 停止超时 / 停止信号没发出去）
 *    对用户来说是同一件事 —— "本地这一轮与服务端可能不一致，点我对齐"。具体线索（错误码、
 *    超时秒数）走 `extra` 一行，而不是给三种情况各编一套说辞。
 * ② **对齐中要禁用**：双击会打两次历史请求（第二次的结果仍然正确，但没有理由发出去）。
 * ③ **它不自己决定什么时候消失**：`clearDisconnect` 由调用方在"用户点过它"之后调
 *    （`useChatStream#alignAndClear`）。见 `stores/chatStream.ts` 里 `DisconnectState` 的注释：
 *    黄条若跟着轮次走，它会在对齐丢掉轮次的那一刻自己消失，用户就看不到"对齐完了"这个动作。
 */

import { useT } from '../../app/i18n.js'
import {
  DISCONNECT_BANNER_ACTION_KEY,
  DISCONNECT_BANNER_DETAIL_KEY,
  DISCONNECT_BANNER_TITLE_KEY,
} from './streamErrors.js'

export interface DisconnectBannerProps {
  /** 具体线索（错误码 / 超时说明）；`null` = 只显示通用说明 */
  extra: string | null
  onAlign: () => void
  /** 对齐请求在飞（禁用重复点击） */
  aligning: boolean
}

export function DisconnectBanner({ extra, onAlign, aligning }: DisconnectBannerProps) {
  const { t } = useT()
  return (
    <button
      type="button"
      className="banner banner--warn"
      data-testid="disconnect-banner"
      disabled={aligning}
      onClick={onAlign}
    >
      <span className="led led--warn" aria-hidden="true" />
      <span className="banner__text">
        <strong>{t(DISCONNECT_BANNER_TITLE_KEY)}</strong>
        <span className="banner__detail">
          {t(DISCONNECT_BANNER_DETAIL_KEY)}
          {extra === null ? null : <span className="num"> （{extra}）</span>}
        </span>
      </span>
      <span className="banner__action num">{aligning ? t('chat.disconnectAligning') : t(DISCONNECT_BANNER_ACTION_KEY)}</span>
    </button>
  )
}
