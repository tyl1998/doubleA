/**
 * Agent 受众选择器（P1-18 · 子批 A/B）
 *
 * 「指定用户」可见范围的受众 = 直接指定的**用户** ∪ 指定**组**的成员（并集）。
 * 两个分段：用户走**登录可用**的搜索端点（`GET /api/users/search`，非管理员也能用）、
 * 组走管理员维护的组列表（`GET /api/admin/groups`）。
 *
 * ⚠️ 与 `AssetUserPicker`（转移所属人 / 旧版分享用的单选）刻意分开：那个是"选一个人"的单选，
 * 这里是"圈一批人/组"的多选，语义不同（合并会让两处各自的取舍互相牵制）。
 *
 * ⚠️ P1-23 末批：文案走字典（此前是裸中文，智能体表单的受众选择器因此在 en 下仍是中文）。
 */

import { useEffect, useMemo, useState } from 'react'
import { Select, Spin } from 'antd'

import { useUserSearch } from '../api/users.js'
import { useUserGroups } from '../api/userGroups.js'
import { useT } from '../app/i18n.js'

export interface AudiencePickerProps {
  /** 已选用户 id */
  userIds: string[]
  /** 已选组 id */
  groupIds: string[]
  /** 已选用户的已知显示名（来自已保存的受众回显），用于打开时直接展示名字而非 id */
  knownUsers?: { id: string; name: string }[]
  onChange: (next: { userIds: string[]; groupIds: string[] }) => void
  disabled?: boolean
}

/** 输入防抖（毫秒）——避免每敲一个字符就打一次搜索端点 */
const SEARCH_DEBOUNCE_MS = 250

export function AudiencePicker({ userIds, groupIds, knownUsers, onChange, disabled }: AudiencePickerProps) {
  const { t } = useT()
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [keyword])

  const search = useUserSearch(debounced)
  const groups = useUserGroups()

  // 已选用户的显示名：已保存的受众回显（打开即得）+ 搜索结果（增量补充）
  const seededUsers = useMemo(() => {
    const next: Record<string, string> = {}
    for (const user of knownUsers ?? []) next[user.id] = user.name
    return next
  }, [knownUsers])
  const [learnedUsers, setLearnedUsers] = useState<Record<string, string>>({})
  useEffect(() => {
    const found = search.data ?? []
    if (found.length === 0) return
    setLearnedUsers((prev) => {
      const next = { ...prev }
      for (const user of found) next[user.id] = user.name
      return next
    })
  }, [search.data])

  const knownLabels = useMemo(() => ({ ...seededUsers, ...learnedUsers }), [seededUsers, learnedUsers])

  const userOptions = (search.data ?? []).map((user) => ({ value: user.id, label: user.name }))
  // 兜底：已选但搜不到的，也要能显示（否则选中项会只剩一个 uuid）
  const missingUserIds = userIds.filter((id) => !userOptions.some((o) => o.value === id))
  const selectedUserOptions = missingUserIds.map((id) => ({ value: id, label: knownLabels[id] ?? id }))

  const groupOptions = (groups.data?.items ?? []).map((group) => ({
    value: group.id,
    label: t('audience.groupOption', { name: group.name, count: group.memberCount }),
  }))

  return (
    <div className="stack stack--tight">
      <div>
        <span className="ratio">{t('audience.usersLabel')}</span>
        <Select
          mode="multiple"
          showSearch
          filterOption={false}
          value={userIds}
          options={[...selectedUserOptions, ...userOptions]}
          loading={search.isFetching}
          disabled={disabled}
          placeholder={t('audience.usersPlaceholder')}
          style={{ width: '100%' }}
          aria-label={t('audience.usersAria')}
          notFoundContent={
            search.isFetching ? (
              <Spin size="small" />
            ) : debounced === '' ? (
              t('audience.usersTypeToSearch')
            ) : (
              t('audience.noMatch')
            )
          }
          onSearch={setKeyword}
          onChange={(next) => onChange({ userIds: next, groupIds })}
        />
      </div>
      <div>
        <span className="ratio">{t('audience.groupsLabel')}</span>
        <Select
          mode="multiple"
          value={groupIds}
          options={groupOptions}
          loading={groups.isPending}
          disabled={disabled}
          placeholder={t('audience.groupsPlaceholder')}
          style={{ width: '100%' }}
          aria-label={t('audience.groupsAria')}
          notFoundContent={groups.isPending ? t('audience.loadingGroups') : t('audience.noGroups')}
          onChange={(next) => onChange({ userIds, groupIds: next })}
        />
      </div>
    </div>
  )
}
