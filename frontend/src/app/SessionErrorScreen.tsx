/**
 * 「读登录态失败」页（P0-1-30）
 *
 * 用途：`GET /api/auth/me` **报错**（后端没起、代理串到别的服务、网络断了）时，
 * 守卫既不能放行也不能当作"未登录"。
 *
 * ## 为什么必须有这一态，而不是让它继续转圈
 *
 * 三态语义是 `undefined`（还没问到）/ `null`（未登录）/ 对象（已登录）。
 * `fetchCurrentUser()` 把 401 收敛成 `null`，**其余错误照抛** —— 于是查询会进入
 * `isError`，此时 `data` 仍是 `undefined`。如果守卫只判断 `undefined` 就渲染等待页，
 * 页面会**永远停在"正在读取登录态"**：用户看到的是"卡住了"，而不是"后端没起"，
 * 排查方向直接跑偏（P0-1-30 实测踩到的就是这一条 —— 见 `issue_fix/`）。
 *
 * ## 为什么不能"当作未登录、直接跳登录页"
 *
 * 那会把"后端不可用"表现成"你没登录"：用户被送到登录页、认真输一遍密码、再失败一次。
 * 后端挂了就该说后端挂了，并且给一个**可以自己按的重试**。
 *
 * 刻意复用 `.boot` 的整屏居中骨架（同一瞬间、同一位置，只是读数不同）。
 */

import { Button } from 'antd'

import { describeError } from '../api/client.js'
import { useT } from './i18n.js'

export interface SessionErrorScreenProps {
  error: unknown
  /** 重试：由 `useQuery` 的 `refetch` 提供 */
  onRetry: () => void
  /** 重试是否正在进行（按钮据此禁用，避免连点出一串并发请求） */
  retrying: boolean
}

export function SessionErrorScreen({ error, onRetry, retrying }: SessionErrorScreenProps) {
  const { t } = useT()
  const { code, message } = describeError(error)

  return (
    <div className="boot" role="alert">
      <div className="boot__box">
        <span className="led led--fail" aria-hidden="true" />
        <p className="boot__title">{t('boot.sessionErrorTitle')}</p>
        <p className="boot__lead">
          {t('boot.sessionErrorLeadPrefix')}
          <code>/api/auth/me</code>
          {t('boot.sessionErrorLeadSuffix')}
        </p>
        {/* 错误码照实显示：这是内部工具，码比"出错了"三个字有用得多（`03` §六） */}
        <p className="kicker">
          {code} · {message}
        </p>
        <Button type="primary" loading={retrying} onClick={onRetry}>
          {t('common.retry')}
        </Button>
        <p className="boot__lead">
          {t('boot.sessionErrorHintPrefix')}
          <span className="num">13000</span>
          {t('boot.sessionErrorHintSuffix')}
          <span className="num">VITE_DEV_PROXY_TARGET</span>
          {t('boot.sessionErrorHintTail')}
        </p>
      </div>
    </div>
  )
}
