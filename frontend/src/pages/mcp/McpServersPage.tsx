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
 * ① 权限口径：**建/看/调用全员可用；测试 / 改 / 删只有所属人 + ADMIN**（P0-2-12 改过、2026-10-16 再收窄「测试」）
 * ─────────────────────────────────────────────────────────────────────
 * 原文是"登录即可、人人可改可删（第五族）、`createdBy` 只留痕、本页**不做任何按钮过滤**"。
 * **2026-09-24 起**：`createdBy` 升为**权限判据**，服务端在**改/删**上**先 404 再 403**
 * （判据 `shared#canEditMcpServer`）。⇒ 本页的「编辑」「删除」按**服务端给的 `canEdit`** 渲染，
 * **不**按角色或"我是不是创建者"自己判 —— `canEdit` 已经把"ADMIN 也算"算进去了，
 * 自己拿 `createdBy` 比 id 会让管理员连自己的编辑入口都没有（服务端却放行 ⇒ 两边对不上）。
 * ⚠️ **2026-10-16 修订（用户定案）**：「测试」**也**收进 `canEdit` 门禁 —— 它用的是**所属人**
 * 的凭据（见 ④），让任何登录用户都能点等于"拿别人的凭据去探活"。服务端 `testMcpServer` 已先
 * 404（不可见）再 403（可见非所属人）。
 * ⚠️ 页面顶部那条 Alert 必须**如实转述当前口径**：界面上写着"人人可改可删"而实际不是，
 * 与写着"能过滤"而实际不能，是同一种谎（原文那段注释讲的正是这个道理，口径换了、道理不变）。
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
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 「测试 / 工具列表」的主语是**所属人**，不是点按钮的人（P0-2-12）
 * ─────────────────────────────────────────────────────────────────────
 * `tool_cache` 是 **server 级共享**的一份 ⇒ 探测主语必须**唯一确定** = `mcp_servers.created_by`
 * （换成"点按钮的人"就是**串用户**：A 点过测试 ⇒ B 看到的是 A 的凭据拉到的列表 —— 那正是
 * P0-2-5 当初定"不带凭据"要挡的东西，而"主语唯一"这个性质它挡不掉）。⇒ 界面上要能
 * **看出这一位是谁**（「所属人」列，放**名字**不是 uuid），并且在页头把"测试报凭据无效该找谁"
 * 讲清楚。⚠️ 而 `tools/call`（对话里真调工具）注入的仍是**调用者自己**的凭据 ——
 * 两条链路的主语不同（`06` §4.2 那张表），是本页最容易讲错的一件事。
 */

import { Alert, Button, Popconfirm, Table, Tag, Tooltip, type TableColumnsType } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { useMcpServers, useMyCredentials, useRemoveMcpServer, useTestMcpServer } from '../../api/mcp.js'
import { credentialCell, credentialCellText, formatToolCount, serverStatusView, unconfiguredCount } from './mcpModel.js'
import { McpServerFormModal } from './McpServerFormModal.js'
import { McpServerToolsModal } from './McpServerToolsModal.js'
import { TransferOwnershipModal } from '../../components/TransferOwnershipModal.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { VisibilityBadge } from '../../components/VisibilityBadge.js'
import { CREDENTIALS_PATH, credentialsPath } from '../../app/paths.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import type { McpServerItem } from '@doubulea/shared'

export function McpServersPage() {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const servers = useMcpServers()
  const credentials = useMyCredentials()
  const removeServer = useRemoveMcpServer()
  const testServer = useTestMcpServer()

  const [editing, setEditing] = useState<McpServerItem | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [toolsFor, setToolsFor] = useState<McpServerItem | null>(null)
  const [transferFor, setTransferFor] = useState<McpServerItem | null>(null)

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
      title: t('mcpServers.colName'),
      dataIndex: 'name',
      render: (_, server) => (
        <div className="agent-cell">
          <span className="agent-cell__name">{server.name}</span>
          {/* slug 是工具名前缀的来源，藏起来会让用户看不懂 `mcp_git_xxx` 里的 `git` 是什么。
              ⚠️ 副行**不再写"由 X 注册"**（P0-2-12 起）：那一格原本是个 uuid，用户读不出是谁；
              「所属人」现在有**专门的列**，而且它已经从留痕字段升成**权限主语**。 */}
          <span className="agent-cell__sub">{t('mcpServers.slugPrefix', { slug: server.slug })}</span>
        </div>
      ),
    },
    {
      title: t('mcpServers.endpoint'),
      dataIndex: 'endpointUrl',
      width: 260,
      render: (_, server) => <span className="mcp-endpoint">{server.endpointUrl}</span>,
    },
    {
      title: t('mcpServers.colToolCount'),
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
      title: t('mcpServers.colStatus'),
      dataIndex: 'status',
      width: 130,
      render: (_, server) => {
        const view = serverStatusView(server.status)
        return (
          <span className="row" style={{ gap: 'var(--sp-2)' }} title={t(view.hintKey)}>
            <span className={`led led--${view.led}`} aria-hidden="true" />
            <span>{t(view.labelKey)}</span>
          </span>
        )
      },
    },
    {
      title: t('mcpServers.colOwner'),
      dataIndex: 'creatorName',
      width: 130,
      render: (_, server) =>
        // ⚠️ 这一格**不只是**"谁建的这个 server"（P0-2-12）：**连通测试与工具列表都用这位的凭据**。
        //    所以放**名字**（`creatorName`，昵称优先回落用户名）而不是 uuid，并把"探测主语"
        //    写在 title 上 —— 用户问"测试报凭据无效，我该改哪儿"时，答案是这里。
        // P1-18（2026-10-16 修订）：去掉操作列的「转移所属人」按钮，把这一列做成入口 ——
        //    只有所属人/管理员（`canEdit`）能点；其余人只显示名字（带同一句说明）。
        server.canEdit ? (
          <Tooltip title={t('mcpServers.ownerTitle')}>
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setTransferFor(server)}>
              {server.creatorName}
            </Button>
          </Tooltip>
        ) : (
          <span title={t('mcpServers.ownerTooltip')}>{server.creatorName}</span>
        ),
    },
    {
      // P1-13：可见性徽标（判据来自服务端下发的 `visibility`，前端不自己算）
      title: t('mcpServers.colVisibility'),
      dataIndex: 'visibility',
      width: 100,
      render: (_, server) => <VisibilityBadge visibility={server.visibility} />,
    },
    {
      title: t('mcpServers.colCredential'),
      key: 'credential',
      width: 140,
      render: (_, server) => {
        const cell = credentialCell(credentialsById.get(server.id))
        const text = credentialCellText(cell, locale)
        if (cell.kind === 'configured') return <Tag className="tag--ok">{text.label}</Tag>
        if (cell.kind === 'missing') {
          return (
            <Link to={credentialsPath(server.id)} title={text.hint}>
              <span className="cred-dot" aria-hidden="true" />
              {text.label}
            </Link>
          )
        }
        return <span className="ratio" title={text.hint}>{text.label}</span>
      },
    },
    {
      title: t('mcpServers.colActions'),
      key: 'actions',
      width: 280,
      align: 'right',
      render: (_, server) => (
        // ⚠️ §七「表格规范」：操作列固定右侧、**文字链按钮**（`type="link"`，
        //    不自己发明外观类 —— P0-1-35 的教训）、危险操作红色、**删除放最后**。
        //    `/mcp` 一行只有三个操作（测试 / 编辑 / 删除），所以**不**用"更多"菜单
        //    （那条规则的门槛是 >3）。
        // ⚠️ **2026-10-16 修订（用户定案）：「测试」也只给所属人或 ADMIN**（服务端已 403）——
        //    测试用**所属人的凭据**，让任何人点等于"拿别人的凭据去探活"。故它与编辑/删除同门禁。
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          {server.canEdit ? (
            <>
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                loading={testServer.isPending && testServer.variables === server.id}
                onClick={() => {
                  testServer.mutate(server.id, {
                    onSuccess: (result) => {
                      if (result.ok) {
                        feedback.ok(t('mcpServers.handshakeOk', { count: result.tools.length }))
                        // 握手就是"重新拉一次工具列表" ⇒ 顺手把清单弹窗打开，让结论有可见的落点
                        setToolsFor(server)
                      } else {
                        // 恒 200 的**结论**（不是异常）⇒ 中性通道，见文件头 ③
                        feedback.note(t('mcpServers.handshakeFailed', { error: result.error }))
                      }
                    },
                    onError: (error) => {
                      feedback.fail(error, t('mcpServers.testFailed'))
                    },
                  })
                }}
              >
                {t('mcpServers.test')}
              </Button>
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openEdit(server)}>
                {t('mcpServers.edit')}
              </Button>
              <Popconfirm
                title={t('mcpServers.removeTitle')}
                description={t('mcpServers.removeDesc')}
                okText={t('common.delete')}
                okButtonProps={{ danger: true }}
                cancelText={t('common.cancel')}
                onConfirm={() => {
                  removeServer.mutate(server.id, {
                    onSuccess: (result) => feedback.ok(t('mcpServers.deleted', { name: result.name })),
                    onError: (error) => feedback.fail(error, t('mcpServers.removeFailed')),
                  })
                }}
              >
                <Button type="link" size="small" danger style={{ padding: 0 }}>
                  {t('common.delete')}
                </Button>
              </Popconfirm>
            </>
          ) : (
            // ⚠️ 判据是**服务端给的 `canEdit`**（P0-2-12），不自己拿 `createdBy` 跟当前用户 id 比 ——
            //    那样 ADMIN 会在界面上连自己的编辑入口都没有，而服务端允许他改 ⇒ 两边对不上。
            //    ⚠️ 2026-10-16 修订：「测试」也已归入本门禁（用所属人凭据，见上）。
            <span className="ratio" title={t('mcpServers.noEditPermTitle')}>
              {t('mcpServers.noEditPerm')}
            </span>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{t('mcpServers.title')}</h1>
          <p className="page__lead">
            {servers.isPending ? t('mcpServers.loading') : t('mcpServers.leadPrefix', { total })}
          </p>
        </div>
        <div className="page__head-actions">
          {/* §4.4：**「我的凭据」入口常驻此页顶部**，徽标显示未配置数量。
              ⚠️ 这里的数字与表格里那一列同源（见文件头 ②），不是另算一遍。 */}
          <Link to={CREDENTIALS_PATH}>
            <Button>
              {t('mcpServers.myCredentials')}
              {missingCount > 0 && (
                <>
                  {' '}
                  <Tag className="tag--warn">{t('mcpServers.missingTag', { count: missingCount })}</Tag>
                </>
              )}
            </Button>
          </Link>
          <Button type="primary" onClick={openCreate}>
            {t('mcpServers.register')}
          </Button>
        </div>
      </div>

      {/* 权限口径在 P0-2-12 收窄过、2026-10-16 又收窄了「测试」—— 界面必须如实转述**当前**那一条
          （原文是"任何登录用户都可以注册、修改、删除"）。现在：**建/看/调用**全员可用，
          **测试 / 改 / 删**只有「所属人」或管理员（测试用**所属人**的凭据，见文件头 ④）。 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message={t('mcpServers.collabTitle')}
        description={t('mcpServers.collabDesc')}
      />

      {credentials.isError ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 'var(--sp-5)' }}
          message={t('mcpServers.credLoadFailed')}
          description={t('mcpServers.credLoadFailedDesc')}
        />
      ) : null}

      {servers.isError ? (
        <ErrorState
          title={t('mcpServers.loadFailed')}
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
            title={t('mcpServers.emptyTitle')}
            lead={t('mcpServers.emptyLead')}
            action={
              <Button type="primary" onClick={openCreate}>
                {t('mcpServers.register')}
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
                  ? t('mcpServers.totalMore', { total, shown: items.length })
                  : t('mcpServers.total', { count }),
            }}
          />
        </div>
      )}

      <McpServerFormModal server={editing} open={formOpen} onClose={() => setFormOpen(false)} />
      <McpServerToolsModal server={toolsFor} onClose={() => setToolsFor(null)} />
      <TransferOwnershipModal
        open={transferFor !== null}
        assetKind="MCP"
        assetId={transferFor?.id ?? ''}
        assetName={transferFor?.name ?? ''}
        currentOwnerName={transferFor?.creatorName ?? ''}
        onClose={() => setTransferFor(null)}
      />
    </>
  )
}
