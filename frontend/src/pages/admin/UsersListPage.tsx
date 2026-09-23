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

import { Alert, Button, Input, Popconfirm, Table, Tag, Tooltip, type TableColumnsType } from 'antd'
import { PASSWORD_MAX_BYTES, type InitialPasswordResult, type UserListItem } from '@doubulea/shared'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { useAdminUsers, useResetUserPassword, useUpdateUser } from '../../api/adminUsers.js'
import { useCurrentUser } from '../../api/auth.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { formatUpdatedAt } from '../../app/format.js'
import { useFeedback } from '../../app/feedback.js'
import { HOME_PATH } from '../../app/paths.js'
import { InitialPasswordModal } from './InitialPasswordModal.js'
import { UserFormModal } from './UserFormModal.js'
import { USER_ROLE_LABELS, describeUserStatus, userRowActions } from './adminModel.js'

/** 建号成功的提示里要提一句密码口径 —— 读数来自 `shared` 的常量，不写死数字 */
const PASSWORD_RULE_HINT = `后端生成的初始密码是 18 位随机串；本人自助改密时要求 8~64 字符、不超过 ${PASSWORD_MAX_BYTES} 字节（中文按 3 字节计）。`

export function UsersListPage() {
  const feedback = useFeedback()
  const { data: currentUser } = useCurrentUser()
  const { data, isPending, isError, error, isFetching, refetch } = useAdminUsers()
  const update = useUpdateUser()
  const reset = useResetUserPassword()

  const [keyword, setKeyword] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UserListItem | null>(null)
  const [passwordResult, setPasswordResult] = useState<InitialPasswordResult | null>(null)
  const [passwordForReset, setPasswordForReset] = useState(false)

  const currentUserId = currentUser?.id ?? ''
  const items = data?.items ?? []
  const total = data?.total ?? 0

  const normalizedKeyword = keyword.trim().toLowerCase()
  const filtered =
    normalizedKeyword === ''
      ? items
      : items.filter((item) =>
          `${item.username}\n${item.nickname ?? ''}`.toLowerCase().includes(normalizedKeyword),
        )

  const toggleStatus = (user: UserListItem): void => {
    const disabling = user.status === 'ACTIVE'
    update.mutate(
      { id: user.id, body: { status: disabling ? 'DISABLED' : 'ACTIVE' } },
      {
        onSuccess: (saved) => {
          feedback.ok(
            disabling
              ? `已停用「${saved.username}」，他的下一个请求会立刻 401`
              : `已启用「${saved.username}」`,
          )
        },
        onError: (error_) => feedback.fail(error_, disabling ? '停用失败' : '启用失败'),
      },
    )
  }

  const doReset = (user: UserListItem): void => {
    reset.mutate(user.id, {
      onSuccess: (result) => {
        setPasswordForReset(true)
        setPasswordResult(result)
      },
      onError: (error_) => feedback.fail(error_, '重置密码失败'),
    })
  }

  const columns: TableColumnsType<UserListItem> = [
    {
      title: '用户',
      dataIndex: 'username',
      render: (_, user) => (
        <div className="kb-cell">
          <span className="kb-cell__name">
            {user.username}
            {user.id === currentUserId && (
              // 标出"这是我自己"：下面两个灰掉的操作键看起来才不像"权限不够"
              <Tag className="tag--accent" style={{ marginLeft: 'var(--sp-2)' }}>
                你自己
              </Tag>
            )}
          </span>
          <span className="kb-cell__sub">{user.nickname ?? '（未设置显示名）'}</span>
        </div>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 100,
      render: (_, user) => (
        <Tag className={user.role === 'ADMIN' ? 'tag--warn' : undefined}>{USER_ROLE_LABELS[user.role]}</Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 220,
      render: (_, user) => {
        const view = describeUserStatus(user)
        return (
          <div className="kb-cell">
            {/* 状态灯 + 文案两重表达（`.led--*` 是 P0-1-31 起在用的那三个） */}
            <span className="row" style={{ gap: 'var(--sp-2)' }}>
              <span className={`led led--${view.led}`} aria-hidden="true" />
              <span>{view.label}</span>
            </span>
            {view.hint !== null && <span className="kb-cell__sub">{view.hint}</span>}
          </div>
        )
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 130,
      render: (_, user) => <span className="num">{formatUpdatedAt(user.createdAt)}</span>,
    },
    {
      title: '操作',
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
              编辑
            </Button>

            {toggleAction?.disabled === true ? (
              // 灰掉的操作键**必须**能说出为什么（`title` 是给鼠标的，`aria-disabled` 给读屏）
              <Tooltip title={toggleAction.reason ?? ''}>
                <span>
                  <Button type="link" size="small" style={{ padding: 0 }} disabled>
                    {toggleAction.label}
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Popconfirm
                title={
                  user.status === 'ACTIVE' ? `停用「${user.username}」？` : `启用「${user.username}」？`
                }
                description={
                  user.status === 'ACTIVE'
                    ? '停用后他的下一个请求就会 401（后端会失效会话快照），正在进行的对话也会被打断。账号与数据都保留，可以随时启用回来。'
                    : '启用后他可以重新登录。如果他还处于"待首次改密"状态，登录后仍会先被要求改密。'
                }
                okText={user.status === 'ACTIVE' ? '停用' : '启用'}
                okButtonProps={{ danger: user.status === 'ACTIVE' }}
                cancelText="取消"
                onConfirm={() => toggleStatus(user)}
              >
                <Button
                  type="link"
                  size="small"
                  danger={user.status === 'ACTIVE'}
                  style={{ padding: 0 }}
                >
                  {toggleAction?.label}
                </Button>
              </Popconfirm>
            )}

            {resetAction?.disabled === true ? (
              <Tooltip title={resetAction.reason ?? ''}>
                <span>
                  <Button type="link" size="small" style={{ padding: 0 }} disabled>
                    重置密码
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Popconfirm
                title={`重置「${user.username}」的密码？`}
                description="会生成一个新的初始密码（只显示一次），对方当前密码立即失效、必须在下次登录时改密；他的连续登录失败计数也会被清掉。"
                okText="重置"
                cancelText="取消"
                onConfirm={() => doReset(user)}
              >
                <Button type="link" size="small" style={{ padding: 0 }} loading={reset.isPending && reset.variables === user.id}>
                  重置密码
                </Button>
              </Popconfirm>
            )}
          </div>
        )
      },
    },
  ]

  const head = (
    <>
      <nav className="crumb" aria-label="面包屑">
        <Link to={HOME_PATH}>工作台</Link>
        <span className="crumb__sep" aria-hidden="true">
          /
        </span>
        <span className="crumb__here">用户管理</span>
      </nav>

      <div className="page__head">
        <div>
          <h1>用户管理</h1>
          <p className="page__lead">
            {isPending ? (
              '正在读取用户列表…'
            ) : (
              <>
                共 <span className="num">{total}</span> 个账号。建号后的初始密码<strong>只显示一次</strong>；
                停用会立刻失效（下一个请求即 401）。管理员不能对自己做停用 / 降级 / 重置密码
                —— 这一条是后端定的（防止把自己锁在门外）。
              </>
            )}
          </p>
        </div>
        <div className="page__head-actions">
          <Button type="primary" onClick={() => setCreating(true)}>
            创建用户
          </Button>
        </div>
      </div>
    </>
  )

  if (isError) {
    return (
      <>
        {head}
        <ErrorState
          title="用户列表加载失败"
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

      <div className="row row--wrap" style={{ marginBottom: 'var(--sp-5)' }}>
        <Input.Search
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索用户名或显示名…"
          style={{ width: 260 }}
          aria-label="搜索用户"
        />
        <span className="ratio u-right">
          数据来自 GET /api/users · 缓存 30s
          {total > items.length && (
            <>
              {' '}
              · 共 <span className="num">{total}</span> 个，本次取回前 <span className="num">{items.length}</span> 个
              （<code>limit</code> 上限 100）
            </>
          )}
        </span>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message="关于密码"
        description={PASSWORD_RULE_HINT}
      />

      {isPending ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title="还没有用户"
            lead="系统里至少会有一个种子脚本创建的管理员（就是当前登录的你）。如果这一页是空的，说明种子没播或数据库被清过 —— 可以先建一个成员账号试一条链路。"
            action={
              <Button type="primary" onClick={() => setCreating(true)}>
                创建用户
              </Button>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title="没有匹配的用户"
            lead={`当前筛选条件下没有结果（关键字「${keyword.trim()}」）。`}
            action={
              <Button
                onClick={() => {
                  setKeyword('')
                }}
              >
                清空筛选
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
            pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => `共 ${count} 个 · 每页 20` }}
            scroll={{ x: 1000 }}
          />
        </div>
      )}

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
