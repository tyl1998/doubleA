/**
 * 资产「接收人 / 被分享人」选择器（P1-13）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这里要分两种形态（**不是偷懒**）
 * ─────────────────────────────────────────────────────────────────────
 * 转移所属人 / 分享都需要一个**用户 id**，但本仓**没有面向非管理员的"列出用户"端点**
 * ——`GET /api/users` 挂的是 `requireAdmin`（`backend/src/routes/users.ts`）。所以：
 *   · **ADMIN**：下拉搜索（数据源就是那个管理端点），可点选，不会把 uuid 抄错；
 *   · **非 ADMIN**：只给一个**粘贴 uuid** 的输入框，并如实说明"你没有列出用户的权限"。
 *     —— 不"造"一个对非管理员不可用的下拉（那会让每次选择都 403，看起来像页面坏了）。
 *
 * 判据是当前用户的 `role`（`useCurrentUser`），不是"页面在哪个路由下"：模型池页现在对
 * 全员开放（P1-13），同一个页面两种身份都会进来。
 */

import { useQuery } from '@tanstack/react-query'
import { Input, Select } from 'antd'

import { useCurrentUser } from '../api/auth.js'
import { fetchAdminUsers } from '../api/adminUsers.js'

export interface AssetUserPickerProps {
  /** 已选用户 id（空串 = 未选） */
  value: string
  onChange: (userId: string) => void
  disabled?: boolean
  placeholder?: string
}

export function AssetUserPicker({ value, onChange, disabled, placeholder }: AssetUserPickerProps) {
  const { data: me } = useCurrentUser()
  const isAdmin = me?.role === 'ADMIN'

  // 只有 ADMIN 才去拉用户列表：非 ADMIN 打这个端点必然 403（`enabled` 让它根本不发请求）
  const users = useQuery({
    queryKey: ['admin', 'users', 'asset-picker'] as const,
    queryFn: () => fetchAdminUsers(0, 100),
    enabled: isAdmin,
  })

  if (!isAdmin) {
    return (
      <div className="stack stack--tight">
        <Input
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? '粘贴对方的用户 ID（UUID）'}
          aria-label="接收人用户 ID"
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="ratio">
          你当前不是管理员，没有"列出用户"的权限 —— 请向对方索取用户 ID（UUID）后粘贴到这里。
        </span>
      </div>
    )
  }

  const options = (users.data?.items ?? [])
    .filter((user) => user.id !== me?.id)
    .map((user) => ({
      value: user.id,
      label: `${user.nickname ?? user.username}（${user.username}）`,
    }))

  return (
    <Select
      showSearch
      optionFilterProp="label"
      value={value === '' ? undefined : value}
      options={options}
      loading={users.isPending}
      disabled={disabled}
      placeholder={placeholder ?? '搜索并选择一个用户'}
      style={{ width: '100%' }}
      aria-label="接收人"
      notFoundContent={users.isPending ? '正在读取用户列表…' : '没有匹配的用户'}
      onChange={onChange}
    />
  )
}
