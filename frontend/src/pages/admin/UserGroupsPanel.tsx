/**
 * 用户组管理面板（P1-18 · 子批 B；嵌在「用户管理」页的第二个 tab 里）
 *
 * 依据：`子方案/资产共享与用户组标签.md` §四 + `shared/src/userGroup.ts`。
 * 组 = 显式成员集合，是 Agent「指定用户」受众的**主授权单位**（稳定、可审计）。
 * 改名/改描述/整体替换成员/删组（删组会连带清掉指向它的 Agent 受众行 —— 服务端一个事务里做）。
 *
 * ⚠️ **为什么是面板而不是独立路由**：组与用户是同一件事的两个面（"谁能被授权"）——
 * 拆成 `/admin/users` 与 `/admin/groups` 两条导航项会让"找一个人"与"找一组人"分居两处；
 * 合成一个页面的两个 tab 更贴近实际动线（用户 2026-10-16 定案）。
 */

import { Button, Form, Input, Modal, Popconfirm, Select, Spin, Table, type TableColumnsType } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { UserGroupItem, UserGroupMember } from '@doubulea/shared'

import { useUserSearch } from '../../api/users.js'
import {
  useCreateUserGroup,
  useRemoveUserGroup,
  useReplaceUserGroupMembers,
  useUpdateUserGroup,
  useUserGroup,
  useUserGroups,
} from '../../api/userGroups.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'

const SEARCH_DEBOUNCE_MS = 250

// ═════════════════════════════ 用户多选（成员编辑器用，带服务端搜索） ═════════════════════════════

function UserMultiSelect({
  value,
  onChange,
  knownMembers,
  disabled,
}: {
  value: string[]
  onChange: (next: string[]) => void
  /** 已选成员的已知显示名（来自组详情），用于打开弹窗时直接展示名字而非 id */
  knownMembers?: UserGroupMember[]
  disabled?: boolean
}) {
  const { t } = useT()
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [keyword])

  const search = useUserSearch(debounced)
  const [known, setKnown] = useState<Record<string, string>>({})

  // 已知名字的两个来源：组详情里的成员（打开时立即可用）+ 曾搜到的用户（增量补充）
  const seeded = useMemo(() => {
    const next: Record<string, string> = {}
    for (const member of knownMembers ?? []) next[member.id] = member.name
    return next
  }, [knownMembers])
  useEffect(() => {
    const found = search.data ?? []
    if (found.length === 0) return
    setKnown((prev) => {
      const next = { ...prev }
      for (const user of found) next[user.id] = user.name
      return next
    })
  }, [search.data])

  // 已知名字的两个来源合并：搜索结果覆盖同 id 的种子名（两者同源，取更新的一份）
  const knownLabels = useMemo(() => ({ ...seeded, ...known }), [seeded, known])

  const options = (search.data ?? []).map((user) => ({ value: user.id, label: user.name }))
  const missing = value.filter((id) => !options.some((o) => o.value === id))
  const selectedOptions = missing.map((id) => ({ value: id, label: knownLabels[id] ?? id }))

  return (
    <Select
      mode="multiple"
      showSearch
      filterOption={false}
      value={value}
      options={[...selectedOptions, ...options]}
      loading={search.isFetching}
      disabled={disabled}
      placeholder={t('userGroups.memberPlaceholder')}
      style={{ width: '100%' }}
      notFoundContent={
        search.isFetching ? <Spin size="small" /> : debounced === '' ? t('userGroups.searchHint') : t('userGroups.noMatch')
      }
      onSearch={setKeyword}
      onChange={onChange}
    />
  )
}

// ═════════════════════════════ 组表单弹窗（新建 / 改名改描述） ═════════════════════════════

function GroupFormModal({ group, open, onClose }: { group: UserGroupItem | null; open: boolean; onClose: () => void }) {
  const feedback = useFeedback()
  const { t } = useT()
  const create = useCreateUserGroup()
  const update = useUpdateUserGroup()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    if (!open) return
    setName(group?.name ?? '')
    setDescription(group?.description ?? '')
  }, [open, group])

  const submitting = create.isPending || update.isPending
  const submit = async () => {
    if (name.trim() === '') {
      feedback.fail(new Error(t('userGroups.nameRequired')), t('userGroups.cannotSave'))
      return
    }
    try {
      if (group === null) {
        await create.mutateAsync({ name: name.trim(), description: description.trim() })
        feedback.ok(t('userGroups.created'))
      } else {
        await update.mutateAsync({ id: group.id, body: { name: name.trim(), description: description.trim() } })
        feedback.ok(t('userGroups.saved'))
      }
      onClose()
    } catch (error) {
      feedback.fail(error, t('userGroups.saveFailed'))
    }
  }

  return (
    <Modal
      open={open}
      title={group === null ? t('userGroups.titleCreate') : t('userGroups.titleEdit', { name: group.name })}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Form layout="vertical">
        <Form.Item label={t('userGroups.nameLabel')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('userGroups.namePlaceholder')} />
        </Form.Item>
        <Form.Item label={t('userGroups.descriptionLabel')}>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('userGroups.descriptionPlaceholder')}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ═════════════════════════════ 成员编辑器 ═════════════════════════════

function MembersModal({ group, open, onClose }: { group: UserGroupItem | null; open: boolean; onClose: () => void }) {
  const feedback = useFeedback()
  const { t } = useT()
  const detail = useUserGroup(open && group !== null ? group.id : undefined)
  const replace = useReplaceUserGroupMembers()
  const [userIds, setUserIds] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setUserIds((detail.data?.members ?? []).map((m) => m.id))
  }, [open, detail.data])

  const submit = async () => {
    if (group === null) return
    try {
      await replace.mutateAsync({ id: group.id, body: { userIds } })
      feedback.ok(t('userGroups.membersSaved'))
      onClose()
    } catch (error) {
      feedback.fail(error, t('userGroups.saveFailed'))
    }
  }

  return (
    <Modal
      open={open}
      title={group === null ? t('userGroups.membersTitle') : t('userGroups.membersTitleNamed', { name: group.name })}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={replace.isPending}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <div className="stack stack--tight">
        <p className="ratio">{t('userGroups.membersReplaceNote')}</p>
        {detail.isPending ? <Spin /> : <UserMultiSelect value={userIds} onChange={setUserIds} knownMembers={detail.data?.members} />}
      </div>
    </Modal>
  )
}

// ═════════════════════════════ 面板 ═════════════════════════════

export function UserGroupsPanel() {
  const feedback = useFeedback()
  const { t } = useT()
  const groups = useUserGroups()
  const remove = useRemoveUserGroup()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UserGroupItem | null>(null)
  const [membersFor, setMembersFor] = useState<UserGroupItem | null>(null)

  const columns: TableColumnsType<UserGroupItem> = [
    { title: t('userGroups.colName'), dataIndex: 'name', width: 220 },
    {
      title: t('userGroups.colDescription'),
      dataIndex: 'description',
      render: (_, group) => group.description ?? <span className="ratio">—</span>,
    },
    { title: t('userGroups.colMemberCount'), dataIndex: 'memberCount', width: 100, align: 'right' },
    {
      title: t('models.colActions'),
      key: 'actions',
      width: 260,
      align: 'right',
      render: (_, group) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditing(group)}>
            {t('common.edit')}
          </Button>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setMembersFor(group)}>
            {t('userGroups.manageMembers')}
          </Button>
          <Popconfirm
            title={t('userGroups.removeTitle', { name: group.name })}
            description={t('userGroups.removeDesc')}
            okText={t('common.delete')}
            okButtonProps={{ danger: true }}
            cancelText={t('common.cancel')}
            onConfirm={async () => {
              try {
                const result = await remove.mutateAsync(group.id)
                feedback.ok(
                  result.removedAudiences > 0
                    ? t('userGroups.deletedWithCount', { count: result.removedAudiences })
                    : t('userGroups.deleted'),
                )
              } catch (error) {
                feedback.fail(error, t('userGroups.removeFailed'))
              }
            }}
          >
            <Button type="link" size="small" danger style={{ padding: 0 }}>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  return (
    <>
      <div className="row row--wrap" style={{ marginBottom: 'var(--sp-5)' }}>
        <p className="ratio">
          {t('userGroups.lead')}
        </p>
        <div className="u-right">
          <Button type="primary" onClick={() => setCreating(true)}>
            {t('userGroups.create')}
          </Button>
        </div>
      </div>

      <div className="card">
        <Table<UserGroupItem>
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={groups.data?.items ?? []}
          loading={false}
          pagination={false}
          scroll={{ x: 800 }}
          locale={{ emptyText: groups.isFetching ? t('common.loading') : t('userGroups.emptyTable') }}
        />
      </div>

      <GroupFormModal group={null} open={creating} onClose={() => setCreating(false)} />
      <GroupFormModal group={editing} open={editing !== null} onClose={() => setEditing(null)} />
      <MembersModal group={membersFor} open={membersFor !== null} onClose={() => setMembersFor(null)} />
    </>
  )
}
