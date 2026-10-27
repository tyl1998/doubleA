/**
 * 用户管理（`/admin/users`，P0-1-36，ADMIN）
 *
 * 依据：`docs/03-前端设计.md` §二（`/admin/users` = 用户管理，**ADMIN**）、§七（创建/编辑形态、
 *      删除分级、保存语义、反馈通道、二级页动线、表格规范、列表三态、文案词表、键盘约定、窄屏边界）、
 *      `docs/02-后端设计.md` §4.2（四个端点 + `cannot operate self` 约束）、
 *      `shared/src/user.ts`（`UserListItem` 唯一一套投影）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 这一页没有"删除"（不是漏了）
 * ─────────────────────────────────────────────────────────────────────
 * `02` §4.2 只有四个端点：列表 / 建号 / 启停与改角色 / 重置密码 —— **没有 DELETE**。
 * "停用"就是这条需求（`01` §3.1「用户管理（admin）：建号（初始密码）/启停/重置密码/列表」）
 * 对"移除一个人"的全部回答。所以操作列是三件事，而不是"三件事 + 一个灰掉的删除"：
 * 画一个 disabled 的删除键会让人以为"权限不够"，而实际是这条接口不存在。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 一次性密码的交接：**先开弹窗，再提示**
 * ─────────────────────────────────────────────────────────────────────
 * 建号与重置密码的响应里带着 `initialPassword`（唯一一次明文）。页面的处置是：拿到结果**立刻**
 * 打开 {@link InitialPasswordModal}，而不是先 `feedback.ok('创建成功')` 再指望用户自己去哪找。
 * 一次误关的补救只有"再重置一次"，而那会让对方手上的密码作废。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 取数：一次取满 100 + 客户端筛选（与智能体 / 知识库列表同口径）
 * ─────────────────────────────────────────────────────────────────────
 * `listUsersQuerySchema` 的 `limit` 上限是 100，本页取满一页后由 AntD Table 每页 20。
 * 为什么不做服务端分页 + 服务端搜索：`GET /api/users` **没有关键字参数**，而"服务端分页 +
 * 客户端筛选"会让筛选只作用于当前页 —— 那是**看着像坏了**的行为。超过 100 个用户时页脚
 * 如实提示（不静默截断）。
 */

import { Alert, Button, Input, Popconfirm, Table, Tabs, Tag, Tooltip, type TableColumnsType } from 'antd'
import { PASSWORD_MAX_BYTES, type InitialPasswordResult, type UserListItem } from '@doubulea/shared'
import { useState } from 'react'

import { useAdminUsers, useResetUserPassword, useUpdateUser } from '../../api/adminUsers.js'
import { useCurrentUser } from '../../api/auth.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { formatUpdatedAt } from '../../app/format.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { InitialPasswordModal } from './InitialPasswordModal.js'
import { UserFormModal } from './UserFormModal.js'
import { UserGroupsPanel } from './UserGroupsPanel.js'
import { describeUserStatus, userRowActions, userRoleLabel } from './adminModel.js'


export function UsersListPage() {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const { data: currentUser } = useCurrentUser()
  const { data, isPending, isError, error, isFetching, refetch } = useAdminUsers()
  const update = useUpdateUser()
  const reset = useResetUserPassword()

  const [keyword, setKeyword] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UserListItem | null>(null)
  const [passwordResult, setPasswordResult] = useState<InitialPasswordResult | null>(null)
  const [passwordForReset, setPasswordForReset] = useState(false)
  /** P1-18：用户与用户组合成一页的两个 tab（`users` 落在 `/admin/users`） */
  const [tab, setTab] = useState<'users' | 'groups'>('users')

  const currentUserId = currentUser?.id ?? ''
  const items = data?.items ?? []
  const total = data?.total ?? 0

  const normalizedKeyword = keyword.trim().toLowerCase()
  const filtered =
    normalizedKeyword === ''
      ? items
      : items.filter((item) =>
          `${item.username}\n${item.nickname ?? ''}\n${item.groups.map((group) => group.name).join(' ')}`
            .toLowerCase()
            .includes(normalizedKeyword),
        )

  const toggleStatus = (user: UserListItem): void => {
    const disabling = user.status === 'ACTIVE'
    update.mutate(
      { id: user.id, body: { status: disabling ? 'DISABLED' : 'ACTIVE' } },
      {
        onSuccess: (saved) => {
          feedback.ok(
            disabling
              ? t('users.disabledOk', { name: saved.username })
              : t('users.enabledOk', { name: saved.username }),
          )
        },
        onError: (error_) => feedback.fail(error_, disabling ? t('users.disableFailed') : t('users.enableFailed')),
      },
    )
  }

  const doReset = (user: UserListItem): void => {
    reset.mutate(user.id, {
      onSuccess: (result) => {
        setPasswordForReset(true)
        setPasswordResult(result)
      },
      onError: (error_) => feedback.fail(error_, t('users.resetFailed')),
    })
  }

  const columns: TableColumnsType<UserListItem> = [
    {
      title: t('users.colUser'),
      dataIndex: 'username',
      render: (_, user) => (
        <div className="kb-cell">
          <span className="kb-cell__name">
            {user.username}
            {user.id === currentUserId && (
              // 标出"这是我自己"：下面两个灰掉的操作键看起来才不像"权限不够"
              <Tag className="tag--accent" style={{ marginLeft: 'var(--sp-2)' }}>
                {t('users.selfTag')}
              </Tag>
            )}
          </span>
          <span className="kb-cell__sub">{user.nickname ?? t('users.noNickname')}</span>
        </div>
      ),
    },
    {
      title: t('users.colRole'),
      dataIndex: 'role',
      width: 100,
      render: (_, user) => (
        <Tag className={user.role === 'ADMIN' ? 'tag--warn' : undefined}>{userRoleLabel(user.role, locale)}</Tag>
      ),
    },
    {
      // P1-18：该用户**所在的用户组**（服务端下发，已按组名排序）。组是 Agent「指定用户」受众的
      // 主授权单位 ⇒ "谁在哪些组里"应当在用户列表一眼可见（与「用户组」tab 同源，不另算一份）。
      title: t('users.colGroups'),
      dataIndex: 'groups',
      width: 200,
      render: (_, user) =>
        user.groups.length === 0 ? (
          <span className="ratio">{t('users.noGroup')}</span>
        ) : (
          <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            {user.groups.map((group) => (
              <Tag key={group.id}>{group.name}</Tag>
            ))}
          </span>
        ),
    },
    {
      title: t('users.colStatus'),
      dataIndex: 'status',
      width: 220,
      render: (_, user) => {
        const view = describeUserStatus(user)
        return (
          <div className="kb-cell">
            {/* 状态灯 + 文案两重表达（`.led--*` 是 P0-1-31 起在用的那三个） */}
            <span className="row" style={{ gap: 'var(--sp-2)' }}>
              <span className={`led led--${view.led}`} aria-hidden="true" />
              <span>{t(view.labelKey)}</span>
            </span>
            {view.hintKey !== null && <span className="kb-cell__sub">{t(view.hintKey)}</span>}
          </div>
        )
      },
    },
    {
      title: t('users.colCreated'),
      dataIndex: 'createdAt',
      width: 130,
      render: (_, user) => <span className="num">{formatUpdatedAt(user.createdAt)}</span>,
    },
    {
      title: t('users.colActions'),
      key: 'actions',
      width: 250,
      align: 'right',
      // 操作列固定右侧（`03` §七 表格规范）；本表列宽之和已接近 900px ⇒ 窄屏必然横向滚动
      fixed: 'right',
      render: (_, user) => {
        const actions = userRowActions(user, currentUserId)
        const toggleAction = actions.find((action) => action.key === 'toggle')
        const resetAction = actions.find((action) => action.key === 'reset')

        return (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
            {/* 编辑恒可点（弹窗里还有只读的用户名/显示名可看，不只是"改角色"） */}
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEditing(user)}>
              {t('common.edit')}
            </Button>

            {toggleAction?.disabled === true ? (
              // 灰掉的操作键**必须**能说出为什么（`title` 是给鼠标的，`aria-disabled` 给读屏）
              <Tooltip title={toggleAction.reasonKey === null ? '' : t(toggleAction.reasonKey)}>
                <span>
                  <Button type="link" size="small" style={{ padding: 0 }} disabled>
                    {toggleAction.labelKey === undefined ? null : t(toggleAction.labelKey)}
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Popconfirm
                title={
                  user.status === 'ACTIVE'
                    ? t('users.disableTitle', { name: user.username })
                    : t('users.enableTitle', { name: user.username })
                }
                description={
                  user.status === 'ACTIVE' ? t('users.disableDesc') : t('users.enableDesc')
                }
                okText={user.status === 'ACTIVE' ? t('users.disable') : t('users.enable')}
                okButtonProps={{ danger: user.status === 'ACTIVE' }}
                cancelText={t('common.cancel')}
                onConfirm={() => toggleStatus(user)}
              >
                <Button
                  type="link"
                  size="small"
                  danger={user.status === 'ACTIVE'}
                  style={{ padding: 0 }}
                >
                  {toggleAction === undefined ? null : t(toggleAction.labelKey)}
                </Button>
              </Popconfirm>
            )}

            {resetAction?.disabled === true ? (
              <Tooltip title={resetAction.reasonKey === null ? '' : t(resetAction.reasonKey)}>
                <span>
                  <Button type="link" size="small" style={{ padding: 0 }} disabled>
                    {t('users.reset')}
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Popconfirm
                title={t('users.resetTitle', { name: user.username })}
                description={t('users.resetDesc')}
                okText={t('users.reset')}
                cancelText={t('common.cancel')}
                onConfirm={() => doReset(user)}
              >
                <Button type="link" size="small" style={{ padding: 0 }} loading={reset.isPending && reset.variables === user.id}>
                  {t('users.reset')}
                </Button>
              </Popconfirm>
            )}
          </div>
        )
      },
    },
  ]

  const head = (
    <div className="page__head">
      <div>
        <h1>{t('users.title')}</h1>
        <p className="page__lead">
          {t('users.leadPrefix')}
          <strong>{t('users.leadStrong1')}</strong>
          {t('users.leadMid')}
          <strong>{t('users.leadStrong2')}</strong>
          {t('users.leadSuffix')}
          <strong>{t('users.leadStrong3')}</strong>
          {t('users.leadMid2')}
        </p>
      </div>
    </div>
  )

  const usersTab = (
    <>
      <div className="row row--wrap" style={{ marginBottom: 'var(--sp-5)' }}>
        <Input.Search
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('users.searchPlaceholder')}
          style={{ width: 260 }}
          aria-label={t('users.searchAria')}
        />
        <span className="ratio">
          {t('users.sourceCount', { total })}
          {total > items.length && (
            <>
              {' '}
              {t('users.sourceMore', { shown: items.length })}
            </>
          )}
        </span>
        <div className="u-right">
          <Button type="primary" onClick={() => setCreating(true)}>
            {t('users.create')}
          </Button>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message={t('users.passwordNoteTitle')}
        description={t('users.passwordNoteDesc', { hint: t('users.passwordRuleHint', { max: PASSWORD_MAX_BYTES }) })}
      />

      {isPending ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('users.emptyTitle')}
            lead={t('users.emptyLead')}
            action={
              <Button type="primary" onClick={() => setCreating(true)}>
                {t('users.create')}
              </Button>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('users.noMatchTitle')}
            lead={t('users.noMatchLead', { keyword: keyword.trim() })}
            action={
              <Button
                onClick={() => {
                  setKeyword('')
                }}
              >
                {t('users.clearFilter')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card">
          <Table<UserListItem>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={filtered}
            // 加载态由页面骨架屏承担，这里不再叠一层 AntD 遮罩转圈
            loading={false}
            pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => t('users.total', { count }) }}
            scroll={{ x: 1000 }}
          />
        </div>
      )}
    </>
  )

  if (isError) {
    return (
      <>
        {head}
        <ErrorState
          title={t('users.loadFailed')}
          error={error}
          retrying={isFetching}
          onRetry={() => {
            void refetch()
          }}
        />
      </>
    )
  }

  return (
    <>
      {head}

      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as 'users' | 'groups')}
        items={[
          { key: 'users', label: t('users.tabUsers'), children: usersTab },
          { key: 'groups', label: t('users.tabGroups'), children: <UserGroupsPanel /> },
        ]}
      />

      <UserFormModal
        user={null}
        open={creating}
        currentUserId={currentUserId}
        onClose={() => setCreating(false)}
        onCreated={(result) => {
          setPasswordForReset(false)
          setPasswordResult(result)
        }}
      />
      <UserFormModal
        user={editing}
        open={editing !== null}
        currentUserId={currentUserId}
        onClose={() => setEditing(null)}
        onCreated={() => undefined}
      />
      <InitialPasswordModal
        result={passwordResult}
        forReset={passwordForReset}
        onClose={() => setPasswordResult(null)}
      />
    </>
  )
}
