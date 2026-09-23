/**
 * 用户的创建 / 编辑弹窗（P0-1-36）
 *
 * 依据：`docs/03` §七「创建/编辑形态」——**字段 ≤6 的实体用弹窗（KB、MCP server、用户、模型）**，
 *      且"**同一实体创建与编辑同形态**"；`shared/src/user.ts`（`createUserBodySchema` /
 *      `updateUserBodySchema` 的可改字段）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 创建与编辑的差异只有两处，而这两处都是"后端就是这样"
 * ─────────────────────────────────────────────────────────────────────
 * ① **编辑态不能改用户名，也不能改昵称**：`updateUserBodySchema` 只有 `status` / `role`
 *    两个字段（`02` §4.2）。所以这两个字段在编辑态是**只读展示**（不是灰输入框）——
 *    摆一个灰着的输入框会让人以为是权限问题，而实际是"这条接口不存在"。
 *    ⇒ 编辑弹窗实际能做的只有**改角色**；启停与重置密码在列表行的操作列上（更顺手）。
 * ② **创建态不能指定密码**：初始密码由服务端生成（`02` §4.2："调用方不能指定"）。
 *    所以表单里**没有密码字段**，而不是"留一个空的让管理员填"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一处与后端逐条对齐的提示（不写就成了"点了没反应"）
 * ─────────────────────────────────────────────────────────────────────
 * 管理员**不能**把自己降级成成员（`409`：本系统只有 ADMIN 能进这一页，自锁后没人能改回来）。
 * 所以编辑自己时角色选择器**标灰 + 写明原因** —— 与列表行上那两个灰掉的操作键同一处置。
 */

import { Alert, Input, Modal, Select } from 'antd'
import { USER_ROLES, type InitialPasswordResult, type UserListItem, type UserRole } from '@doubulea/shared'
import { useEffect, useState } from 'react'

import { describeError } from '../../api/client.js'
import { useCreateUser, useUpdateUser } from '../../api/adminUsers.js'
import { useFeedback } from '../../app/feedback.js'
import {
  EMPTY_USER_FORM_VALUES,
  USER_ROLE_LABELS,
  buildCreateUserBody,
  buildUpdateUserBody,
  userEditValuesOf,
} from './adminModel.js'

export interface UserFormModalProps {
  /** `null` = 创建；非 `null` = 编辑这个人 */
  user: UserListItem | null
  open: boolean
  currentUserId: string
  onClose: () => void
  /** 创建成功 ⇒ 把一次性密码交给页面弹窗（见 `InitialPasswordModal` 的文件头） */
  onCreated: (result: InitialPasswordResult) => void
}

const ROLE_OPTIONS = USER_ROLES.map((role) => ({ value: role, label: USER_ROLE_LABELS[role] }))

export function UserFormModal({ user, open, currentUserId, onClose, onCreated }: UserFormModalProps) {
  const feedback = useFeedback()
  const create = useCreateUser()
  const update = useUpdateUser()

  const [username, setUsername] = useState('')
  const [nickname, setNickname] = useState('')
  const [role, setRole] = useState<UserRole>(EMPTY_USER_FORM_VALUES.role)
  const [errorText, setErrorText] = useState<string | null>(null)

  const editing = user !== null
  const isSelf = user !== null && user.id === currentUserId

  // 每次打开都按目标对象重置 —— 否则编辑完 A 再打开"创建"，表单里还留着 A 的内容
  useEffect(() => {
    if (!open) return
    const values = user === null ? EMPTY_USER_FORM_VALUES : userEditValuesOf(user)
    setUsername(values.username)
    setNickname(values.nickname)
    setRole(values.role)
    setErrorText(null)
  }, [open, user])

  const submitting = create.isPending || update.isPending
  /**
   * 编辑态**不按"是不是自己"禁用保存**：角色选择器已经标灰，改不动 ⇒
   * `buildUpdateUserBody` 必然返回 `null` ⇒ 走"没有需要保存的改动"那条路正常关闭。
   * 禁用保存键会让"关掉这个弹窗"只剩一个「取消」，而它看起来像"放弃修改"。
   */
  const canSubmit = editing ? !submitting : username.trim() !== '' && !submitting

  const submit = (): void => {
    setErrorText(null)

    if (user === null) {
      create.mutate(buildCreateUserBody({ username, nickname, role }), {
        onSuccess: (result) => {
          onClose()
          // 立刻把一次性密码交出去：**不要**先 ok 提示再"稍后显示"（见 `InitialPasswordModal`）
          onCreated(result)
        },
        // 失败停留弹窗：最典型的是 409「用户名已存在」（含大小写变体）
        onError: (error) => setErrorText(describeError(error).message),
      })
      return
    }

    const body = buildUpdateUserBody(user, role)
    if (body === null) {
      feedback.note('没有需要保存的改动')
      onClose()
      return
    }
    update.mutate(
      { id: user.id, body },
      {
        onSuccess: (saved) => {
          feedback.ok(`已把「${saved.username}」的角色改为 ${USER_ROLE_LABELS[saved.role]}`)
          onClose()
        },
        onError: (error) => setErrorText(describeError(error).message),
      },
    )
  }

  return (
    <Modal
      open={open}
      title={editing ? `编辑「${user.username}」` : '创建用户'}
      okText={editing ? '保存' : '创建'}
      okButtonProps={{ disabled: !canSubmit, loading: submitting }}
      cancelText="取消"
      onOk={submit}
      onCancel={onClose}
      maskClosable={!submitting}
    >
      <div className="stack">
        <div>
          <p className="block-label">用户名</p>
          {editing ? (
            <p className="num">{user.username}</p>
          ) : (
            <Input
              value={username}
              maxLength={64}
              aria-label="用户名"
              placeholder="登录名，例如 zhangsan（不含空格）"
              onChange={(event) => setUsername(event.target.value)}
              onPressEnter={() => {
                if (canSubmit) submit()
              }}
            />
          )}
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {editing
              ? '用户名创建后不可修改（后端没有这个字段）。'
              : '最多 64 个字符，不能含空格；服务端会去掉首尾空白并转成小写后保存。'}
          </p>
        </div>

        <div>
          <p className="block-label">显示名</p>
          {editing ? (
            <p>{user.nickname ?? '（未设置）'}</p>
          ) : (
            <Input
              value={nickname}
              maxLength={64}
              aria-label="显示名"
              placeholder="留空表示不设置（界面回落到用户名）"
              onChange={(event) => setNickname(event.target.value)}
              onPressEnter={() => {
                if (canSubmit) submit()
              }}
            />
          )}
          {editing && <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>显示名同样不可修改（后端只接受 status 与 role）。</p>}
        </div>

        <div>
          <p className="block-label">角色</p>
          <Select<UserRole>
            value={role}
            options={ROLE_OPTIONS}
            disabled={isSelf}
            style={{ width: '100%' }}
            aria-label="角色"
            onChange={setRole}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
            {isSelf
              ? '不能改自己的角色（后端会 409）：本系统只有管理员能进这一页，把自己降级后没有任何入口能改回来。'
              : '管理员可进「用户管理」与「模型池管理」；成员只能用智能体、知识库与对话。'}
          </p>
        </div>

        {!editing && (
          <Alert
            type="info"
            showIcon
            message="初始密码由服务端生成"
            description="创建成功后只会显示一次（18 位、无易混字符）。对方首次登录会被强制改密，之后这个密码就作废了。"
          />
        )}

        {errorText !== null && (
          <Alert type="error" showIcon message={editing ? '保存失败' : '创建失败'} description={errorText} />
        )}
      </div>
    </Modal>
  )
}
