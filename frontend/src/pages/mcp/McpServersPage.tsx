/**
 * MCP server 管理页（`/mcp`，P0-2-11 换掉占位页）
 *
 * 依据：`docs/03` §4.4（"Server 表格：名称 / endpoint / 工具数（缓存）/ 状态 / [测试] [编辑] [删除]；
 *      注册/编辑弹窗：基本信息 + 凭据参数模板编辑器；**「我的凭据」入口常驻此页顶部
 *      （徽标显示未配置数量）**"）、§二 路由表（`/mcp`，**登录即可**）、§七（列表三态、
 *      表格规范：操作列固定右侧、文字链按钮、危险操作红色、**删除放最后**、>3 个操作收进"更多"）、
 *      `docs/02` §4.7（六条端点的权限与信封）、`design/mcp.html`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 权限口径：**登录即可**，而且人人可改可删（第五族）
 * ─────────────────────────────────────────────────────────────────────
 * `mcp_servers` **没有 owner 列**，`createdBy` 只留痕（`02` §4.7 / `01` 决策 22）。
 * ⇒ 本页**不做任何按角色/创建者的按钮过滤**。看着"应该"只让创建者删自己建的 server
 * 是一种很自然的冲动，但那是**发明权限模型** —— 后端会放行，界面上藏起来只会让
 * "能点的都点得了、点不了的其实也能点"变成一句假话。界面上做的是**如实展示**
 * （"由谁注册"），不是代替后端判权限。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 「我的凭据」徽标的数字**只有一个来源**
 * ─────────────────────────────────────────────────────────────────────
 * `GET /api/mcp/credentials` 的 `unconfigured`（`06` P0-2-11 坑预判 4：Agent 编辑页的红点、
 * 顶部入口的徽标、表格里那一格，三处**必须**由同一份投影派生）。前端**不自己数一遍**
 * `items.filter(...)` —— 数两遍就会出现"徽标说 2、表格里只有 1 台标红"这种没有编译期错误的偏差。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 「测试」是**恒 200** 的结论，不是一次可能失败的请求
 * ─────────────────────────────────────────────────────────────────────
 * `POST /:id/test` 连不上时回的是 `{ok:false,error}` + 200（`02` §4.9 的 `/health` 同源口径）
 * ⇒ `ok:false` 走 `feedback.note`（中性）而**不是** `fail`（红 + 错误码）：
 * 把一条正常结论渲染成"失败"会让用户以为操作没生效、反复重点。
 * `fail` 只留给真正的 4xx/5xx（server 不存在 404、网络层失败）。
 */

import { Alert, Button, Popconfirm, Table, Tag, type TableColumnsType } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { useMcpServers, useMyCredentials, useRemoveMcpServer, useTestMcpServer } from '../../api/mcp.js'
import { credentialCell, formatToolCount, serverStatusView, unconfiguredCount } from './mcpModel.js'
import { McpServerFormModal } from './McpServerFormModal.js'
import { McpServerToolsModal } from './McpServerToolsModal.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { MCP_CREDENTIALS_PATH, mcpCredentialsPath } from '../../app/paths.js'
import { useFeedback } from '../../app/feedback.js'
import type { McpServerItem } from '@doubulea/shared'

export function McpServersPage() {
  const feedback = useFeedback()
  const servers = useMcpServers()
  const credentials = useMyCredentials()
  const removeServer = useRemoveMcpServer()
  const testServer = useTestMcpServer()

  const [editing, setEditing] = useState<McpServerItem | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [toolsFor, setToolsFor] = useState<McpServerItem | null>(null)

  const items = servers.data?.items ?? []
  const total = servers.data?.total ?? 0
  const credentialsById = new Map((credentials.data?.items ?? []).map((item) => [item.serverId, item]))
  const missingCount = unconfiguredCount(credentials.data?.unconfigured ?? [])

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (server: McpServerItem) => {
    setEditing(server)
    setFormOpen(true)
  }

  const columns: TableColumnsType<McpServerItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_, server) => (
        <div className="agent-cell">
          <span className="agent-cell__name">{server.name}</span>
          {/* slug 是工具名前缀的来源，藏起来会让用户看不懂 `mcp_git_xxx` 里的 `git` 是什么 */}
          <span className="agent-cell__sub">工具名前缀 mcp_{server.slug}_ · 由 {server.createdBy} 注册</span>
        </div>
      ),
    },
    {
      title: 'endpoint',
      dataIndex: 'endpointUrl',
      width: 260,
      render: (_, server) => <span className="mcp-endpoint">{server.endpointUrl}</span>,
    },
    {
      title: '工具数',
      key: 'tools',
      width: 110,
      // ⚠️ 这一格是**可点的**：它是"缓存的工具数"，点开才知道缓存里到底是什么、缓存于何时
      //    （`06` P0-2-5：`cached` 是"你看到的不是刚拉的"的唯一信号）。§七 的"表格规范"
      //    说操作列放右侧 —— 这一格不是操作，是**读数**，所以它留在读数区、只用文字链的样式。
      render: (_, server) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setToolsFor(server)}>
          <span className="num">{formatToolCount(server)}</span>
        </Button>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (_, server) => {
        const view = serverStatusView(server.status)
        return (
          <span className="row" style={{ gap: 'var(--sp-2)' }} title={view.hint}>
            <span className={`led led--${view.led}`} aria-hidden="true" />
            <span>{view.label}</span>
          </span>
        )
      },
    },
    {
      title: '我的凭据',
      key: 'credential',
      width: 140,
      render: (_, server) => {
        const cell = credentialCell(credentialsById.get(server.id))
        if (cell.kind === 'configured') return <Tag className="tag--ok">已配置</Tag>
        if (cell.kind === 'missing') {
          return (
            <Link to={mcpCredentialsPath(server.id)} title={cell.hint}>
              <span className="cred-dot" aria-hidden="true" />
              未配置
            </Link>
          )
        }
        return <span className="ratio" title={cell.hint}>{cell.label}</span>
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      align: 'right',
      render: (_, server) => (
        // ⚠️ §七「表格规范」：操作列固定右侧、**文字链按钮**（`type="link"`，
        //    不自己发明外观类 —— P0-1-35 的教训）、危险操作红色、**删除放最后**。
        //    `/mcp` 一行只有三个操作（测试 / 编辑 / 删除），所以**不**用"更多"菜单
        //    （那条规则的门槛是 >3）。
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            loading={testServer.isPending && testServer.variables === server.id}
            onClick={() => {
              testServer.mutate(server.id, {
                onSuccess: (result) => {
                  if (result.ok) {
                    feedback.ok(`握手成功：拿到 ${result.tools.length} 个工具`)
                    // 握手就是"重新拉一次工具列表" ⇒ 顺手把清单弹窗打开，让结论有可见的落点
                    setToolsFor(server)
                  } else {
                    // 恒 200 的**结论**（不是异常）⇒ 中性通道，见文件头 ③
                    feedback.note(`握手失败：${result.error}`)
                  }
                },
                onError: (error) => {
                  feedback.fail(error, '连通测试失败')
                },
              })
            }}
          >
            测试
          </Button>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openEdit(server)}>
            编辑
          </Button>
          <Popconfirm
            title="删除这个 server？"
            description="删除后绑定它的智能体将失去这些工具，绑定关系会一并清理。这个动作不可撤销。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => {
              removeServer.mutate(server.id, {
                onSuccess: (result) => feedback.ok(`已删除 server「${result.name}」`),
                onError: (error) => feedback.fail(error, '删除失败'),
              })
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
      <nav className="crumb" aria-label="面包屑">
        <Link to="/">工作台</Link>
        <span className="crumb__sep" aria-hidden="true">
          /
        </span>
        <span className="crumb__here">MCP server</span>
      </nav>

      <div className="page__head">
        <div>
          <h1>MCP server</h1>
          <p className="page__lead">
            {servers.isPending ? (
              '正在读取 server 列表…'
            ) : (
              <>
                已注册 <span className="num">{total}</span> 个 server。工具列表带缓存，点「测试」会重新握手并刷新工具数；
                点工具数那一格可以看缓存里到底是什么。
              </>
            )}
          </p>
        </div>
        <div className="page__head-actions">
          {/* §4.4：**「我的凭据」入口常驻此页顶部**，徽标显示未配置数量。
              ⚠️ 这里的数字与表格里那一列同源（见文件头 ②），不是另算一遍。 */}
          <Link to={MCP_CREDENTIALS_PATH}>
            <Button>
              我的凭据
              {missingCount > 0 && (
                <>
                  {' '}
                  <Tag className="tag--warn">{missingCount} 个未配置</Tag>
                </>
              )}
            </Button>
          </Link>
          <Button type="primary" onClick={openCreate}>
            注册 server
          </Button>
        </div>
      </div>

      {/* 已登录即可见 —— 但"人人可改可删"这件事**必须说出来**：不说的话，用户会以为
          「编辑」只对自己建的 server 生效（那正是他习惯的模型），直到改坏了别人的才发现。
          `01` 决策 22 是有意的取舍（全员可注册的内部工具台），界面如实转述它。 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message="任何登录用户都可以注册、修改、删除 MCP server"
        description="这族资源没有「创建者」权限收窄：改成全员共享的公共设施。删除一台被智能体绑定的 server 会被后端拒绝（409），需要先去编辑页解绑。"
      />

      {credentials.isError ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 'var(--sp-5)' }}
          message="凭据状态没有读出来"
          description="表格里「我的凭据」那一列此刻显示「未知」而不是「未配置」—— 说不出来的事不冒充结论。可以刷新页面重试。"
        />
      ) : null}

      {servers.isError ? (
        <ErrorState
          title="MCP server 列表加载失败"
          error={servers.error}
          retrying={servers.isFetching}
          onRetry={() => {
            void servers.refetch()
          }}
        />
      ) : servers.isPending ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title="还没有注册任何 MCP server"
            lead="注册一台 server 后，它的工具会出现在智能体编辑页的「MCP 工具」里。注册时还能定义一组凭据参数模板，决定「我的凭据」页要每个人填什么。"
            action={
              <Button type="primary" onClick={openCreate}>
                注册 server
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card">
          <Table<McpServerItem>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={items}
            // 加载态由 `TableSkeleton` 承担（`03` §七 的"加载骨架屏"），这里不再叠 AntD 的遮罩
            loading={false}
            pagination={{
              pageSize: 20,
              showSizeChanger: false,
              showTotal: (count) =>
                total > items.length
                  ? `共 ${total} 条 · 本次取回前 ${items.length} 条（limit 上限 100）· 每页 20`
                  : `共 ${count} 条 · 每页 20`,
            }}
          />
        </div>
      )}

      <McpServerFormModal server={editing} open={formOpen} onClose={() => setFormOpen(false)} />
      <McpServerToolsModal server={toolsFor} onClose={() => setToolsFor(null)} />
    </>
  )
}
