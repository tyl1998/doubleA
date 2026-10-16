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
import { useEffect, useState } from 'react'
import type { UserGroupItem } from '@doubulea/shared'

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

const SEARCH_DEBOUNCE_MS = 250

// ═════════════════════════════ 用户多选（成员编辑器用，带服务端搜索） ═════════════════════════════

function UserMultiSelect({
  value,
  onChange,
  disabled,
}: {
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [keyword])

  const search = useUserSearch(debounced)
  const [known, setKnown] = useState<Record<string, string>>({})
  useEffect(() => {
    const found = search.data ?? []
    if (found.length === 0) return
    setKnown((prev) => {
      const next = { ...prev }
      for (const user of found) next[user.id] = user.name
      return next
    })
  }, [search.data])

  const options = (search.data ?? []).map((user) => ({ value: user.id, label: user.name }))
  const missing = value.filter((id) => !options.some((o) => o.value === id))
  const selectedOptions = missing.map((id) => ({ value: id, label: known[id] ?? id }))

  return (
    <Select
      mode="multiple"
      showSearch
      filterOption={false}
      value={value}
      options={[...selectedOptions, ...options]}
      loading={search.isFetching}
      disabled={disabled}
      placeholder="按用户名 / 显示名搜索并选择成员"
      style={{ width: '100%' }}
      notFoundContent={
        search.isFetching ? <Spin size="small" /> : debounced === '' ? '输入关键词搜索用户' : '没有匹配的用户'
      }
      onSearch={setKeyword}
      onChange={onChange}
    />
  )
}

// ═════════════════════════════ 组表单弹窗（新建 / 改名改描述） ═════════════════════════════

function GroupFormModal({ group, open, onClose }: { group: UserGroupItem | null; open: boolean; onClose: () => void }) {
  const feedback = useFeedback()
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
      feedback.fail(new Error('请输入组名'), '无法保存')
      return
    }
    try {
      if (group === null) {
        await create.mutateAsync({ name: name.trim(), description: description.trim() })
        feedback.ok('已创建用户组')
      } else {
        await update.mutateAsync({ id: group.id, body: { name: name.trim(), description: description.trim() } })
        feedback.ok('已保存用户组')
      }
      onClose()
    } catch (error) {
      feedback.fail(error, '保存失败')
    }
  }

  return (
    <Modal
      open={open}
      title={group === null ? '新建用户组' : `编辑用户组 · ${group.name}`}
      okText="保存"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Form layout="vertical">
        <Form.Item label="组名" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：测试团队" />
        </Form.Item>
        <Form.Item label="描述">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="这个组是干什么的（可选）"
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ═════════════════════════════ 成员编辑器 ═════════════════════════════

function MembersModal({ group, open, onClose }: { group: UserGroupItem | null; open: boolean; onClose: () => void }) {
  const feedback = useFeedback()
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
      feedback.ok('已保存成员')
      onClose()
    } catch (error) {
      feedback.fail(error, '保存失败')
    }
  }

  return (
    <Modal
      open={open}
      title={group === null ? '管理成员' : `管理成员 · ${group.name}`}
      okText="保存"
      cancelText="取消"
      confirmLoading={replace.isPending}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <div className="stack stack--tight">
        <p className="ratio">整体替换：提交的就是全部成员（清空即移除所有人）。</p>
        {detail.isPending ? <Spin /> : <UserMultiSelect value={userIds} onChange={setUserIds} />}
      </div>
    </Modal>
  )
}

// ═════════════════════════════ 面板 ═════════════════════════════

export function UserGroupsPanel() {
  const feedback = useFeedback()
  const groups = useUserGroups()
  const remove = useRemoveUserGroup()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UserGroupItem | null>(null)
  const [membersFor, setMembersFor] = useState<UserGroupItem | null>(null)

  const columns: TableColumnsType<UserGroupItem> = [
    { title: '组名', dataIndex: 'name', width: 220 },
    {
      title: '描述',
      dataIndex: 'description',
      render: (_, group) => group.description ?? <span className="ratio">—</span>,
    },
    { title: '成员数', dataIndex: 'memberCount', width: 100, align: 'right' },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      align: 'right',
      render: (_, group) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditing(group)}>
            编辑
          </Button>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setMembersFor(group)}>
            管理成员
          </Button>
          <Popconfirm
            title={`删除用户组「${group.name}」？`}
            description="会从所有作为受众引用它的智能体上移除这个组。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              try {
                const result = await remove.mutateAsync(group.id)
                feedback.ok(
                  result.removedAudiences > 0
                    ? `已删除用户组（并从 ${result.removedAudiences} 个智能体受众中移除）`
                    : '已删除用户组',
                )
              } catch (error) {
                feedback.fail(error, '删除失败')
              }
            }}
          >
            <Button type="link" size="small" danger style={{ padding: 0 }}>
              删除
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
          用户组用于在智能体的「指定用户」可见范围里批量圈人；组由管理员维护。
        </p>
        <div className="u-right">
          <Button type="primary" onClick={() => setCreating(true)}>
            新建用户组
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
          locale={{ emptyText: groups.isFetching ? '正在读取…' : '还没有用户组' }}
        />
      </div>

      <GroupFormModal group={null} open={creating} onClose={() => setCreating(false)} />
      <GroupFormModal group={editing} open={editing !== null} onClose={() => setEditing(null)} />
      <MembersModal group={membersFor} open={membersFor !== null} onClose={() => setMembersFor(null)} />
    </>
  )
}
