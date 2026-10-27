/**
 * 登录页（P0-1-30）
 *
 * 依据：`docs/03-前端设计.md` §二（`/login` = 登录**含首登改密**，公开路由）、
 *      `design/login.html` 的构成（左"识别板" + 右"操作板"的非对称两栏，两态同屏可切）、
 *      `02` §4.1 的四端点与首登强制改密注记。
 *
 * ## 一条链路的两个态，为什么放在同一页
 *
 * 首登用户的处境是"我有会话、但除改密外所有 API 都 403"（后端闸门
 * `installPasswordChangeGate`）。把它做成**独立页面**会带来两个问题：
 * ① 用户从登录页被"扔"到另一个页面，会以为是两个功能；
 * ② 那个页面在"没有会话"时的表现（还能填吗？会不会弄丢输入？）需要额外定义。
 * 放在同一页、用 `?view=` 表达两态，则"当前在哪一步"是地址栏里可见、可刷新、可分享的。
 *
 * ## 识别板上的数字全部来自真实接口
 *
 * 原型的识别板写的是"会话并发 4 / 8""知识库 6 个""MCP 5 个"—— 那是画的样例，没有数据源。
 * 这里换成 `GET /health` 真实给的三件事（服务与版本 / 环境与端口 / 三个依赖的探活结论），
 * 与"这是什么系统、什么版本、依赖是否就绪"的意图一致，且每一条都能被证明。
 */

import { Alert, Button } from 'antd'
import type { AuthUser } from '@doubulea/shared'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useState } from 'react'

import { useCurrentUser } from '../../api/auth.js'
import { HEALTH_TARGET_KEY, useHealth, type HealthSummary } from '../../api/health.js'
import { useFeedback } from '../../app/feedback.js'
import { useT, type Translate } from '../../app/i18n.js'
import { loginPath, safeRedirectTarget, type LoginView } from '../../app/paths.js'
import { ChangePasswordForm } from './ChangePasswordForm.js'
import { LoginForm } from './LoginForm.js'

/** 识别板的一行事实（`design/login.html` 的 `.auth__read`） */
interface ReadRow {
  label: string
  value: string
}

/** 把 `/health` 的结论翻译成三行读数。**取不到就如实说取不到**，不留空也不编 */
function readRows(health: ReturnType<typeof useHealth>, t: Translate): ReadRow[] {
  const report: HealthSummary | undefined = health.data
  if (report === undefined) {
    return [
      {
        label: t('login.read.service'),
        value: health.isPending ? t('login.read.pending') : t('login.read.unavailable'),
      },
    ]
  }

  const broken = report.checks.filter((check) => !check.ok)
  const dependencies =
    broken.length === 0
      ? t('login.read.allHealthy', {
          names: report.checks.map((check) => t(HEALTH_TARGET_KEY[check.target])).join(' · '),
        })
      : broken
          .map((check) =>
            t('login.read.checkBroken', { name: t(HEALTH_TARGET_KEY[check.target]), detail: check.detail }),
          )
          .join(t('login.read.separator'))

  return [
    { label: t('login.read.service'), value: `${report.service} · v${report.version}` },
    // ⚠️「端口」这个词在英文里是 `port`；这里用整句插值以免「· port {port}」的语序在两种语言下都要拼
    { label: t('login.read.env'), value: `${report.env} · ${t('login.read.port', { port: report.port })}` },
    { label: t('login.read.dependency'), value: dependencies },
  ]
}

export function LoginPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const feedback = useFeedback()
  const health = useHealth()
  const { t } = useT()
  const { data: user, isPending } = useCurrentUser()

  const view: LoginView = searchParams.get('view') === 'password' ? 'password' : 'login'

  /**
   * 登录成功时把"刚用过的那个密码"留在内存里，供首登改密当 `oldPassword`。
   * 刷新 / 换标签页就没了 —— 那时表单会退回"要求输入当前密码"，属预期。
   */
  const [knownOldPassword, setKnownOldPassword] = useState<string | null>(null)

  const goToView = (next: LoginView) => {
    setSearchParams(next === 'login' ? {} : { view: 'password' }, { replace: true })
  }

  const handleAuthenticated = (authenticated: AuthUser, password: string) => {
    if (authenticated.mustChangePassword) {
      setKnownOldPassword(password)
      feedback.ok(t('login.initialPasswordOk'))
      goToView('password')
      return
    }
    feedback.ok(t('login.welcomeBack', { name: authenticated.nickname ?? authenticated.username }))
    navigate(safeRedirectTarget(location), { replace: true })
  }

  const handlePasswordChanged = () => {
    setKnownOldPassword(null)
    feedback.ok(t('login.passwordUpdated'))
    navigate(safeRedirectTarget(location), { replace: true })
  }

  // ⚠️ `isPending` 不收窄 `data`（它是 `AuthUser | null | undefined`）⇒ 判断必须**先把
  //    `undefined` 排除**，否则「还没问到」会被当成"有会话"、`user.mustChangePassword` 直接抛。
  if (!isPending && user != null) {
    // 已登录且不缺改密 ⇒ 登录页没有存在的理由（也避免"登录后按后退又回到登录页"）
    if (!user.mustChangePassword) return <Navigate to={safeRedirectTarget(location)} replace />
    // 首登未改密 ⇒ 无论从哪进来都停在改密态（与后端闸门 `installPasswordChangeGate` 同一判据）
    if (view !== 'password') return <Navigate to={loginPath('password')} replace />
  } else if (!isPending && view === 'password') {
    // 改密态必须有会话：没有就直接给登录态（否则用户填完只会拿到 401）
    return <Navigate to={loginPath()} replace />
  }

  const rows = readRows(health, t)

  return (
    <div className="auth">
      {/* 左：识别板。这一屏要给"这是什么系统、谁在用、什么版本"一个答案 */}
      <section className="auth__ident reveal is-in">
        <div className="row">
          <span className="rail__mark" aria-hidden="true">
            A
          </span>
          <div>
            <p style={{ fontFamily: 'var(--font-display)', fontWeight: 800, letterSpacing: '-0.03em' }}>
              doubuleA
            </p>
            <p className="kicker">{t('login.brandTagline')}</p>
          </div>
        </div>

        <h1>
          {t('login.headlineLine1')}
          <br />
          {t('login.headlineLine2')}
          <br />
          {t('login.headlineLine3')}
        </h1>

        <div className="auth__reads">
          {rows.map((row) => (
            <div className="auth__read" key={row.label}>
              <p className="kicker">{row.label}</p>
              <p className="ratio" style={{ color: 'var(--ink-2)', lineHeight: 'var(--lh-snug)' }}>
                {row.value}
              </p>
            </div>
          ))}
        </div>

        {health.data !== undefined && (
          <span className="auth__stamp" aria-hidden="true">
            {`v${health.data.version}`}
          </span>
        )}
      </section>

      {/* 右：操作板。登录与「首登强制改密」是同一条链路的两态 */}
      <main className="auth__panel" aria-label={t('login.formAria')}>
        <div className="auth__form stack">
          <div className="row">
            <h2 style={{ fontSize: 'var(--fs-lg)' }}>{t('login.title')}</h2>
            <div className="seg u-right" role="group" aria-label={t('login.viewSwitchAria')}>
              <button type="button" aria-pressed={view === 'login'} onClick={() => goToView('login')}>
                {t('login.tabLogin')}
              </button>
              <button type="button" aria-pressed={view === 'password'} onClick={() => goToView('password')}>
                {t('login.tabPassword')}
              </button>
            </div>
          </div>

          {view === 'login' ? (
            <LoginForm onAuthenticated={handleAuthenticated} onGoToPasswordView={() => goToView('password')} />
          ) : (
            <div className="stack stack--tight">
              <Alert
                type="info"
                showIcon
                message={
                  knownOldPassword === null ? t('login.alertNeedOld') : t('login.alertInitial')
                }
              />
              <ChangePasswordForm
                knownOldPassword={knownOldPassword}
                submitLabel={t('login.submitAndEnter')}
                onSuccess={handlePasswordChanged}
              />
              <div className="row">
                <Button type="link" size="small" onClick={() => goToView('login')} style={{ padding: 0 }}>
                  {t('login.backToLogin')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="auth__foot">
          <p className="kicker">{t('login.foot')}</p>
        </div>
      </main>
    </div>
  )
}
