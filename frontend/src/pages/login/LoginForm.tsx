/**
 * 登录表单（P0-1-30）
 *
 * ## 失败文案的三个来源，各有各的位置
 *
 * | 服务端 | 界面呈现 | 为什么不合并成一种 |
 * |---|---|---|
 * | 401 `UNAUTHORIZED` | **表单内联**警示条（`用户名或密码错误` / `账号已停用，请联系管理员`） | 用户正盯着表单；浮一个右上角通知会把输入框挡住，而且这两条文案本身就是"你刚才那下不行" |
 * | 429 `BUSY` | 内联 + **实时倒计时**，提交按钮禁用 | 倒计时要贴着提交按钮才有意义（"还要等多久才能再试"） |
 * | 其余（网络 / 5xx / 非预期） | 内联 + **右上通知（含错误码）** | 这类"不是你输入的问题"，用户需要能报出错误码（`03` §七） |
 *
 * ⚠️ **字段级失败不能用 `msg` 判断**：校验失败时顶层 `msg` 恒为「请求参数校验失败」，
 * 真正的字段信息在 `data.fields[{path,message}]`（`02` §四 规则 3）。这里用
 * `ApiError.fieldMessage()` 取，见 `api/client.ts` 的规则 2。
 *
 * ⚠️ **不要显示"已失败 N 次"**：设计原型的警示条写了"已失败 3 次，连续 5 次将锁定账号"，
 * 但后端**没有下发这个计数**（`auth.service.ts` 把 `failures` 写进日志、响应里只有一个通用文案，
 * 这是"不泄露账号是否存在"的刻意设计）。界面上写死一个数字就是编数据 ⇒ 只在真正锁定（429）时
 * 显示剩余时间，那是服务端确实给了的。
 */

import { Alert, Button, Form, Input } from 'antd'
import { loginBodySchema, type AuthUser } from '@doubulea/shared'
import { useState } from 'react'

import { useLogin } from '../../api/auth.js'
import { ApiError } from '../../api/client.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { formatCountdown, useLockCountdown } from './useLockCountdown.js'

interface FormValues {
  username: string
  password: string
}

/** `data.retryAfterSec`（BUSY 时后端给的剩余秒数） */
function readRetryAfterSec(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as { retryAfterSec?: unknown }).retryAfterSec
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export interface LoginFormProps {
  /**
   * 登录成功（当前用户已写入缓存）。
   * `password` 是刚提交成功的那个密码 —— 首登强制改密要拿它当 `oldPassword`，
   * 这样用户不必把初始密码再打一遍（`design/login.html` 的两态就是这么设计的）。
   * ⚠️ 它只在内存里传递，用完即弃，不落任何持久层。
   */
  onAuthenticated: (user: AuthUser, password: string) => void
  /** 点「首次登录？先改初始密码」时切到强制改密态 */
  onGoToPasswordView: () => void
}

export function LoginForm({ onAuthenticated, onGoToPasswordView }: LoginFormProps) {
  const [form] = Form.useForm<FormValues>()
  const feedback = useFeedback()
  const { t } = useT()
  const login = useLogin()
  const lock = useLockCountdown()

  /** 表单内联警示（账号密码错 / 已锁定 / 提交前的 schema 提示） */
  const [notice, setNotice] = useState<{ tone: 'warn' | 'danger'; text: string } | null>(null)

  const locked = lock.remaining > 0

  const handleSubmit = (values: FormValues) => {
    const parsed = loginBodySchema.safeParse(values)
    if (!parsed.success) {
      // 形状不对（空用户名 / 超长）不该发请求；文案直接用 shared 的（与后端同一份，**故仍是中文**）
      const first = parsed.error.issues[0]
      setNotice({ tone: 'warn', text: first?.message ?? t('login.checkInput') })
      form.setFields(
        parsed.error.issues.flatMap((issue) => {
          const name = issue.path[0]
          return name === 'username' || name === 'password' ? [{ name, errors: [issue.message] }] : []
        }),
      )
      return
    }

    setNotice(null)
    login.mutate(parsed.data, {
      onSuccess: (user) => {
        lock.clear()
        onAuthenticated(user, parsed.data.password)
      },
      onError: (error) => {
        if (error instanceof ApiError) {
          const retryAfterSec = readRetryAfterSec(error.data)
          if (error.code === 'BUSY' && retryAfterSec !== undefined) {
            lock.start(retryAfterSec)
            setNotice({ tone: 'danger', text: error.message })
            return
          }
          if (error.isUnauthorized) {
            setNotice({ tone: 'warn', text: error.message })
            // 只清密码，保留用户名 —— 允许他改密码重试，不用重打账号
            form.setFieldsValue({ password: '' })
            return
          }
        }
        const message = error instanceof ApiError ? error.message : t('login.loginFailedRetry')
        setNotice({ tone: 'danger', text: message })
        feedback.fail(error, t('login.loginFailedTitle'))
      },
    })
  }

  return (
    <Form form={form} layout="vertical" onFinish={handleSubmit} autoComplete="on">
      <Form.Item
        name="username"
        label={t('login.usernameLabel')}
        rules={[{ required: true, message: t('login.usernameRequired') }]}
      >
        <Input autoComplete="username" placeholder={t('login.usernamePlaceholder')} autoFocus />
      </Form.Item>

      <Form.Item
        name="password"
        label={t('login.passwordLabel')}
        rules={[{ required: true, message: t('login.passwordRequired') }]}
      >
        <Input.Password autoComplete="current-password" placeholder={t('login.passwordPlaceholder')} />
      </Form.Item>

      {notice !== null && (
        <Form.Item>
          <Alert
            type={notice.tone === 'danger' ? 'error' : 'warning'}
            showIcon
            message={
              locked ? (
                <span>
                  {notice.text}
                  <span className="num" style={{ marginLeft: 'var(--sp-3)', fontFamily: 'var(--font-mono)' }}>
                    {t('login.remaining', { time: formatCountdown(lock.remaining) })}
                  </span>
                </span>
              ) : (
                notice.text
              )
            }
          />
        </Form.Item>
      )}

      <Form.Item style={{ marginBottom: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}>
        <Button
          type="primary"
          htmlType="submit"
          block
          loading={login.isPending}
          disabled={locked}
          title={locked ? t('login.lockedTitle') : undefined}
        >
          {t('login.tabLogin')}
        </Button>
      </Form.Item>

      <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
        <Button type="link" size="small" onClick={onGoToPasswordView} style={{ padding: 0 }}>
          {t('login.firstLoginHint')}
        </Button>
      </div>
    </Form>
  )
}
