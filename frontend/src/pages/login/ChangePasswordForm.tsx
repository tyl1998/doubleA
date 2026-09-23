/**
 * 改密表单（P0-1-30）
 *
 * 一份实现被两个入口复用（`docs/06` P0-1-30 内容里的"/settings/password 改密页"
 * 与"登录页含首登强制改密"）：
 * - **首登强制改密**：用户刚用初始密码登录过 ⇒ 当前密码「已知」，表单只问新密码
 *   （`design/login.html` 的第二态就是这个构成）；已知密码失效时自动退回"要你重输"。
 * - **设置页改密**：当前密码必须由用户输入。
 *
 * ## 为什么校验走 `shared` 的 schema 而不是在这里写 rules
 *
 * `shared/src/auth.ts` 的文件头把这条写成了纪律："前端登录页与改密页直接用这里的 schema
 * 做表单校验，避免'后端能过、前端不让填'这类口径漂移"。所以这里 `safeParse` 同一份
 * `changePasswordBodySchema`，AntD 的 `rules` 只留"必填/两次一致"这种**表单级**约定。
 *
 * ## 文案口径按真实常量走，不抄原型
 *
 * 原型的密码提示是"≥10 位，含大小写字母与数字"—— 与后端真实策略不符
 * （`PASSWORD_MIN_LENGTH = 8`，**没有**大小写/数字复杂度要求，另有 72 字节的 bcrypt 上限）。
 * 这类"原型上写死的示例文案"必须回到 `shared` 的常量，否则用户会被一个不存在的规则拦住。
 */

import { Alert, Button, Form, Input } from 'antd'
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  changePasswordBodySchema,
  type AuthUser,
} from '@doubulea/shared'
import { useState } from 'react'

import { useChangePassword } from '../../api/auth.js'
import { ApiError } from '../../api/client.js'
import { useFeedback } from '../../app/feedback.js'

interface FormValues {
  oldPassword?: string
  newPassword: string
  confirmPassword: string
}

type FieldName = 'oldPassword' | 'newPassword'

/** zod 的 `issue.path[0]` → 表单字段名（取不到就返回 undefined，交给表单级提示兜底） */
function fieldOfPath(path: readonly (PropertyKey | undefined)[]): FieldName | undefined {
  const head = path[0]
  if (head === 'oldPassword' || head === 'newPassword') return head
  return undefined
}

export interface ChangePasswordFormProps {
  /**
   * 已知的当前密码（首登时刚用它登录过）。
   * 有值时不再渲染「当前密码」输入框 —— 让人把刚打过的初始密码再打一遍是纯摩擦。
   * ⚠️ 它只活在本页的内存里，提交成功即丢弃，不落 localStorage / 不进任何持久层。
   */
  knownOldPassword?: string | null
  submitLabel: string
  /** 提交成功后的去处（导航由调用方决定：首登去首页，设置页停留） */
  onSuccess: (user: AuthUser) => void
}

export function ChangePasswordForm({ knownOldPassword, submitLabel, onSuccess }: ChangePasswordFormProps) {
  const [form] = Form.useForm<FormValues>()
  const feedback = useFeedback()
  const changePassword = useChangePassword()

  /** 表单级提示（字段级错误标在输入框上，剩下的放这里） */
  const [formError, setFormError] = useState<string | null>(null)
  /** 已知密码被服务端否掉（改密后又改过 / 记忆的不是当前那个）⇒ 退回"要求输入当前密码" */
  const [knownPasswordRejected, setKnownPasswordRejected] = useState(false)

  const needOldPasswordInput = knownOldPassword === undefined || knownOldPassword === null || knownPasswordRejected

  const handleSubmit = (values: FormValues) => {
    setFormError(null)
    const oldPassword = needOldPasswordInput ? (values.oldPassword ?? '') : (knownOldPassword ?? '')

    // 与后端同一份 schema：能过这里就一定不会被 400 拦下（除了服务端的时点性校验）
    const parsed = changePasswordBodySchema.safeParse({
      oldPassword,
      newPassword: values.newPassword,
    })
    if (!parsed.success) {
      const unnamed: string[] = []
      const fields: { name: FieldName; errors: string[] }[] = []
      for (const issue of parsed.error.issues) {
        const name = fieldOfPath(issue.path)
        if (name === undefined) unnamed.push(issue.message)
        else fields.push({ name, errors: [issue.message] })
      }
      if (fields.length > 0) form.setFields(fields)
      if (unnamed.length > 0) setFormError(unnamed.join(' · '))
      return
    }

    changePassword.mutate(parsed.data, {
      onSuccess: (user) => {
        feedback.ok('密码已更新')
        onSuccess(user)
      },
      onError: (error) => {
        if (error instanceof ApiError) {
          // 字段级文案在 `data.fields[{path,message}]`，服务端给的是 `body.oldPassword` 这种路径
          // （`backend/src/services/auth.service.ts` 的 changePassword）。见 api/client.ts 规则 2。
          const oldMessage = error.fieldMessage('oldPassword')
          const newMessage = error.fieldMessage('newPassword')
          if (oldMessage !== undefined) {
            if (!needOldPasswordInput) setKnownPasswordRejected(true)
            form.setFields([{ name: 'oldPassword', errors: [oldMessage] }])
          }
          if (newMessage !== undefined) form.setFields([{ name: 'newPassword', errors: [newMessage] }])
          if (oldMessage === undefined && newMessage === undefined) setFormError(error.message)
        }
        feedback.fail(error, '修改密码失败')
      },
    })
  }

  return (
    <Form form={form} layout="vertical" onFinish={handleSubmit} disabled={changePassword.isPending}>
      {needOldPasswordInput && (
        <Form.Item
          name="oldPassword"
          label="当前密码"
          rules={[{ required: true, message: '请输入当前密码' }]}
        >
          <Input.Password autoComplete="current-password" placeholder="初始密码 / 你现在的密码" />
        </Form.Item>
      )}

      <Form.Item
        name="newPassword"
        label="新密码"
        extra={`至少 ${PASSWORD_MIN_LENGTH} 个字符，最多 ${PASSWORD_MAX_LENGTH} 个字符（${PASSWORD_MAX_BYTES} 字节，中文按 3 字节计）`}
        rules={[{ required: true, message: '请输入新密码' }]}
      >
        <Input.Password autoComplete="new-password" placeholder="设置一个新密码" />
      </Form.Item>

      <Form.Item
        name="confirmPassword"
        label="确认新密码"
        dependencies={['newPassword']}
        rules={[
          { required: true, message: '请再次输入新密码' },
          ({ getFieldValue }) => ({
            validator(_rule, value: unknown) {
              if (value === undefined || value === '' || value === getFieldValue('newPassword')) {
                return Promise.resolve()
              }
              return Promise.reject(new Error('两次输入的密码不一致'))
            },
          }),
        ]}
      >
        <Input.Password autoComplete="new-password" placeholder="再输入一次" />
      </Form.Item>

      {formError !== null && (
        <Form.Item>
          <Alert type="error" showIcon message={formError} />
        </Form.Item>
      )}

      <Form.Item style={{ marginBottom: 0, marginTop: 'var(--sp-2)' }}>
        <Button type="primary" htmlType="submit" block loading={changePassword.isPending}>
          {submitLabel}
        </Button>
      </Form.Item>
    </Form>
  )
}
