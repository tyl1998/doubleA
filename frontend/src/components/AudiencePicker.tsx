/**
 * Agent 受众选择器（P1-18 · 子批 A/B）
 *
 * 「指定用户」可见范围的受众 = 直接指定的**用户** ∪ 指定**组**的成员（并集）。
 * 两个分段：用户走**登录可用**的搜索端点（`GET /api/users/search`，非管理员也能用）、
 * 组走管理员维护的组列表（`GET /api/admin/groups`）。
 *
 * ⚠️ 与 `AssetUserPicker`（转移所属人 / 旧版分享用的单选）刻意分开：那个是"选一个人"的单选，
 * 这里是"圈一批人/组"的多选，语义不同（合并会让两处各自的取舍互相牵制）。
 */

import { useEffect, useState } from 'react'
import { Select, Spin } from 'antd'

import { useUserSearch } from '../api/users.js'
import { useUserGroups } from '../api/userGroups.js'

export interface AudiencePickerProps {
  /** 已选用户 id */
  userIds: string[]
  /** 已选组 id */
  groupIds: string[]
  onChange: (next: { userIds: string[]; groupIds: string[] }) => void
  disabled?: boolean
}

/** 输入防抖（毫秒）——避免每敲一个字符就打一次搜索端点 */
const SEARCH_DEBOUNCE_MS = 250

export function AudiencePicker({ userIds, groupIds, onChange, disabled }: AudiencePickerProps) {
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [keyword])

  const search = useUserSearch(debounced)
  const groups = useUserGroups()

  // 已选用户的显示名：搜索结果里能拿到；已被选过但当前搜索不到的用户，保留上一次见到的名字
  const [knownUsers, setKnownUsers] = useState<Record<string, string>>({})
  useEffect(() => {
    const found = search.data ?? []
    if (found.length === 0) return
    setKnownUsers((prev) => {
      const next = { ...prev }
      for (const user of found) next[user.id] = user.name
      return next
    })
  }, [search.data])

  const userOptions = (search.data ?? []).map((user) => ({ value: user.id, label: user.name }))
  // 兜底：已选但搜不到的，也要能显示（否则选中项会只剩一个 uuid）
  const missingUserIds = userIds.filter((id) => !userOptions.some((o) => o.value === id))
  const selectedUserOptions = missingUserIds.map((id) => ({ value: id, label: knownUsers[id] ?? id }))

  const groupOptions = (groups.data?.items ?? []).map((group) => ({
    value: group.id,
    label: `${group.name}（${group.memberCount} 人）`,
  }))

  return (
    <div className="stack stack--tight">
      <div>
        <span className="ratio">用户</span>
        <Select
          mode="multiple"
          showSearch
          filterOption={false}
          value={userIds}
          options={[...selectedUserOptions, ...userOptions]}
          loading={search.isFetching}
          disabled={disabled}
          placeholder="按用户名 / 显示名搜索并选择用户"
          style={{ width: '100%' }}
          aria-label="受众用户"
          notFoundContent={search.isFetching ? <Spin size="small" /> : debounced === '' ? '输入关键词搜索用户' : '没有匹配的用户'}
          onSearch={setKeyword}
          onChange={(next) => onChange({ userIds: next, groupIds })}
        />
      </div>
      <div>
        <span className="ratio">组</span>
        <Select
          mode="multiple"
          value={groupIds}
          options={groupOptions}
          loading={groups.isPending}
          disabled={disabled}
          placeholder="选择一个或多个用户组"
          style={{ width: '100%' }}
          aria-label="受众组"
          notFoundContent={groups.isPending ? '正在读取用户组…' : '还没有用户组（可在「管理 · 用户组」创建）'}
          onChange={(next) => onChange({ userIds, groupIds: next })}
        />
      </div>
    </div>
  )
}
