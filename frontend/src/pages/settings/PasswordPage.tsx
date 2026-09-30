/**
 * 修改密码页（`/settings/password`，P0-1-30）
 *
 * 与登录页的"首登强制改密态"共用 {@link ChangePasswordForm}—— 同一件事只有一份实现，
 * 差别只在"当前密码要不要用户再输一遍"与提交成功后的去处。
 *
 * 这一页**要求输入当前密码**（`02` §4.1：改密必须校验旧密码）。首登那条路能免掉这一步，
 * 只是因为用户刚在同一个页面输过 —— 不是这条规则有例外。
 */

import { Button } from 'antd'
import { useNavigate } from 'react-router-dom'

import { useCurrentUser } from '../../api/auth.js'
import { HOME_PATH } from '../../app/paths.js'
import { ChangePasswordForm } from '../login/ChangePasswordForm.js'

export function PasswordPage() {
  const navigate = useNavigate()
  const { data: user } = useCurrentUser()

  return (
    <>
      <div className="page__head">
        <div>
          <p className="kicker">S-08 · 改密</p>
          <h1>修改密码</h1>
          <p className="page__lead">
            当前账号 <span className="num">{user?.username ?? '—'}</span>。改密后立即生效，
            当前会话保持登录，不需要重新登录。
          </p>
        </div>
      </div>

      <div className="card bracket card--pad" style={{ maxWidth: 420 }}>
        <ChangePasswordForm
          submitLabel="保存新密码"
          onSuccess={() => {
            navigate(HOME_PATH, { replace: true })
          }}
        />
        <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
          <Button type="link" size="small" onClick={() => navigate(-1)} style={{ padding: 0 }}>
            ← 返回上一页
          </Button>
        </div>
      </div>
    </>
  )
}
