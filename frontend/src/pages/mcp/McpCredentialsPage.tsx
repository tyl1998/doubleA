/**
 * 我的凭据页（`/settings/credentials`，P0-2-11 换掉占位页；与 MCP 解耦的个人凭据页）
 *
 * 依据：`docs/03` §4.5（"顶部：面包屑返回；支持 `?serverId=` 定位（自动滚动 + 高亮该 server
 *      分组），可从 Agent 编辑页/工具失败卡片直达；按 server 分组的表单：每个 credential 参数一行
 *      （label + 密码框 + 已配置 ✓）；保存单个 server 的凭据；**未配置的 server 置顶提示**；
 *      明确提示「凭据仅用于代表你调用该工具，不会展示给他人」"）、
 *      §二 路由表的引注（"从 Agent 编辑页 / 工具失败卡片跳转时携带"）、
 *      `shared/src/mcp.ts`（凭据三端点与 `McpCredentialField` 的口径）、`design/mcp.html` `#credentials`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⓪ 三个分区（2026-10-16 修订：Provider 凭据与 MCP 凭据原先**堆叠**在一页）
 * ─────────────────────────────────────────────────────────────────────
 * 本页是**个人凭据的唯一入口**，按来源分成三个分区（`Tabs`）：
 *   · `mcp`      —— MCP 工具凭据（按 server 分组，代表你调用工具）；
 *   · `provider` —— 模型 Provider 凭据（各自 Key 可就地配；共享 Key 只读）；
 *   · `git`      —— Git 凭据与 Git 身份（Code 模式容器内 `git clone` 用）。
 * 分区键走 `?section=`（见 `app/paths.ts#credentialsSectionPath`）⇒ **从外部跳进来能直接落到对应分区**
 * （例如模型池/Agent 编辑页的「去我的凭据配置」落 `provider`，工具失败卡落 `mcp` 并锚定 server）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① MCP 分区：表单是**只写**的：界面上没有"当前值"这个东西
 * ─────────────────────────────────────────────────────────────────────
 * 凭据值不下发 —— **连掩码都不给**（`shared#mcpCredentialFieldSchema` 的注释：Provider Key 的掩码
 * 是给管理员"确认没配错"用的，而这里是每个用户自己的令牌，下发掩码等于把"这个人的令牌长什么样"
 * 放进一个更多人能读到的通道，收益却是零）。
 * ⇒ 输入框**恒为空**、占位符写"留空 = 不变"，已配置的行标一个「已配置 ✓」。
 * ⇒ 提交**只带真改过的 key**（`mcpModel#buildCredentialSubmitValues`）：这是"合并语义"
 * 的全部理由 —— 把整张表提交一遍会让没填的那些以空串提交，而空串的语义是**清空该 key**
 * （用户什么都没做，值却没了）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 权限：**只动我自己的**，页面上没有任何"别人的凭据"可看
 * ─────────────────────────────────────────────────────────────────────
 * `GET /api/mcp/credentials` 返回的是"我 × 每台 server"的清单；`PUT`/`DELETE` 的路径里
 * **只有 `serverId`**（行由 `(serverId, 我)` 推出来）⇒ 前端不该、也无法指定凭据行 id。
 * `DELETE` 没配过的东西是 **404**（不是幂等 200）⇒ 「清除凭据」按钮**只在有值时出现**
 * （摆一个必然 404 的按钮等于给用户一个必然的报错）。
 * ⚠️ 2026-10-16 起 `configured` 按"**我是否真的填过值**"判（`shared#isCredentialConfigured`）——
 * 这台 server 对每个人给出各自答案，"别人配过"不会再让你这里显示"已配置"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 这一页填的值**只用于调用工具**；测试 / 工具列表用**所属人**的凭据（P0-2-12）
 * ─────────────────────────────────────────────────────────────────────
 * 两条链路的主语不同（`06` §4.2 那张表）：
 *   · `tools/call`（对话里真调工具）⇒ 注入**我**填的这份；
 *   · `POST /:id/test` 与 `GET /:id/tools` ⇒ 注入**该 server 所属人**的那份
 *     （`tool_cache` 是 **server 级共享**的一份 ⇒ 主语必须唯一确定）。
 * ⚠️ 本页**刻意不再**用页脚卡解释"这些凭据会被用在哪里"（那会把这页读成 MCP 的子页）：与 MCP
 * 相关的这层说明由 `/mcp` 管理页顶部的 Alert 承担 —— 那里才是"测试用所属人凭据"的现场。
 */

import { Alert, Button, Input, Popconfirm, Tabs, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { useMyCredentials, usePutMyCredential, useRemoveMyCredential } from '../../api/mcp.js'
import {
  buildCredentialSubmitValues,
  credentialDraftsFromFields,
  credentialGroupAnchorId,
  hasCredentialInput,
  missingAfterSubmit,
  resolveScrollTarget,
  setCredentialDraftValue,
  sortCredentialGroups,
  type CredentialDraftRow,
} from './mcpModel.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { GitCredentialsSection } from '../settings/GitCredentialsSection.js'
import { OpenApiKeysSection } from '../agents/OpenApiKeysSection.js'
import { ProviderKeySection } from '../settings/ProviderKeySection.js'
import { GitIdentitySection } from '../settings/GitIdentitySection.js'
import {
  CREDENTIALS_SECTIONS,
  MCP_PATH,
  credentialsSectionAnchorId,
  type CredentialsSection,
} from '../../app/paths.js'
import { useFeedback } from '../../app/feedback.js'

/** 注入位置的中文读数（与模板编辑器同一份口径；这里只读 `shared` 的取值域） */
const INJECT_HINT: Record<string, string> = {
  HEADER: '请求头',
  QUERY: '查询参数',
  BODY: '报文体',
}

/** `?section=` → 分区键（非法值 / 缺省 ⇒ 默认 `mcp`，不报错也不造一个不存在的分区） */
function resolveSection(raw: string | null): CredentialsSection {
  return raw !== null && (CREDENTIALS_SECTIONS as readonly string[]).includes(raw)
    ? (raw as CredentialsSection)
    : 'mcp'
}

export function McpCredentialsPage() {
  const feedback = useFeedback()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = useMyCredentials()
  const putCredential = usePutMyCredential()
  const removeCredential = useRemoveMyCredential()

  const [drafts, setDrafts] = useState<Record<string, CredentialDraftRow[]>>({})

  const items = useMemo(() => sortCredentialGroups(query.data?.items ?? []), [query.data])
  const unconfigured = query.data?.unconfigured ?? []

  // 分区键（默认 `mcp`）。切分区写回 `?section=`（`replace` 不污染历史），并清掉只对 MCP 有意义的
  // `serverId` 定位参数 —— 否则切到 provider 后地址栏还挂着一台 server 的 id，刷新又跳回 MCP。
  const section = resolveSection(searchParams.get('section'))
  const selectSection = (next: CredentialsSection): void => {
    const params = new URLSearchParams(searchParams)
    if (next === 'mcp') params.delete('section')
    else params.set('section', next)
    if (next !== 'mcp') params.delete('serverId')
    setSearchParams(params, { replace: true })
  }

  // 数据到位/刷新后用服务端投影重建草稿（**全空**，见文件头 ①）。
  // ⚠️ 只在 `items` 真的换了引用时重建：它由 `useMemo` 派生自 query 数据，
  //    所以这里等价于"每次查询返回新数据就重置" —— 恰好是我们要的
  //    （保存成功后失效重拉 ⇒ 输入框清空、「已配置 ✓」亮起来）。
  useEffect(() => {
    const next: Record<string, CredentialDraftRow[]> = {}
    for (const item of items) next[item.serverId] = credentialDraftsFromFields(item.fields)
    setDrafts(next)
  }, [items])

  /**
   * `?serverId=` 定位：滚动 + 高亮（`03` §4.5）。
   *
   * ⚠️ 它**只做两件事**，而"找不到目标"时**什么都不做**（`resolveScrollTarget` 返回 `null`
   * 的三种情形共用这一条路径 —— 见那个函数的注释）。
   * ⚠️ 目标分组**只存在于 `mcp` 分区** ⇒ 带 `serverId` 进来时分区必须是 `mcp`（`credentialsPath`
   * 已经这么构造；这里对"手敲 URL 只带 serverId 不带 section"也兜一层）。
   * ⚠️ 滚动用 `block:'center'`（不是默认的 `start`）：目标是一张卡片，贴顶会让它的标题
   * 被吸顶的顶栏盖住 —— 症状是"跳是跳过去了，但我得往上滚一点才看得见是哪台 server"。
   * ⚠️ 高亮类**必须在滚动之后加**（先加再滚也行，但那样动画会在滚动途中开始播放，
   * 用户滚到位时它已经淡完了）。
   */
  useEffect(() => {
    if (query.data === undefined) return
    if (section !== 'mcp') return
    const target = resolveScrollTarget(searchParams.get('serverId'), items)
    if (target === null) return
    const element = document.getElementById(target)
    if (element === null) return
    element.scrollIntoView({ block: 'center' })
    element.classList.add('target-flash')
    return () => {
      element.classList.remove('target-flash')
    }
  }, [query.data, items, searchParams, section])

  const head = (
    <div className="page__head">
      <div>
        <h1>我的凭据</h1>
        <p className="page__lead">
          这里集中管理<strong>你个人</strong>的凭据，按来源分为四个分区：
          <strong>MCP 工具凭据</strong>（代表你调用工具）、<strong>模型 Provider 凭据</strong>
          （你是所属人的 Provider + 需要你自配的「各自 Key」Provider）、<strong>Git 凭据 / 身份</strong>
          （Code 模式下 agent 在容器里 <code>git clone</code> 私有仓库）、
          <strong>开放调用</strong>（给外部系统用的 API Key，代表<strong>你</strong>调用某个智能体）。凭据不会展示给他人，
          也不会出现在会话记录里；列表接口永不返回明文或掩码 —— 保存之后界面上只剩一个「已配置」标记。
        </p>
      </div>
    </div>
  )

  // MCP 分区的内容（加载 / 出错 / 空 / 正常四态都在这里收口，供 `Tabs` 直接挂载）
  const mcpBody = (() => {
    if (query.isError) {
      return (
        <ErrorState
          title="凭据清单加载失败"
          error={query.error}
          retrying={query.isFetching}
          onRetry={() => {
            void query.refetch()
          }}
        />
      )
    }
    if (query.isPending) return <TableSkeleton rows={4} />
    if (items.length === 0) {
      return (
        <div className="card">
          <EmptyState
            title="还没有任何 MCP server"
            lead="「我的凭据」是按 server 分组的 —— 先有人注册一台 server（并定义它需要哪些参数），这里才会有内容。"
            action={
              <Link to={MCP_PATH}>
                <Button type="primary">去 MCP 管理页</Button>
              </Link>
            }
          />
        </div>
      )
    }

    return (
      <>
        {unconfigured.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 'var(--sp-5)' }}
            message={`有 ${unconfigured.length} 台 server 你还没填过凭据，已置顶`}
            description={unconfigured
              .map((server) =>
                server.missingKeys.length > 0
                  ? `${server.serverName}（缺 ${server.missingKeys.join('、')}）`
                  : server.serverName,
              )
              .join(' · ')}
          />
        )}

        <div className="stack">
          {items.map((item) => {
            const rows = drafts[item.serverId] ?? credentialDraftsFromFields(item.fields)
            const blocked = missingAfterSubmit(rows)
            const changed = hasCredentialInput(rows)

            return (
              <div className="cred-group card" key={item.serverId} id={credentialGroupAnchorId(item.serverId)}>
                <div className="card__head">
                  <p className="card__title">{item.serverName}</p>
                  {item.configured ? (
                    <Tag className="tag--ok">已配置</Tag>
                  ) : (
                    <Tag className="tag--warn">未配置</Tag>
                  )}
                  <div className="card__head-right">
                    <span className="ratio">
                      {item.updatedAt === null
                        ? '你还没有填过这台 server 的凭据'
                        : `你最后一次更新：${new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}`}
                    </span>
                  </div>
                </div>

                <div className="card__body stack stack--tight">
                  {rows.length === 0 ? (
                    <p className="ratio">
                      这台 server 的模板里没有需要用户填写的参数 —— 与你的凭据无关，直接用就行。
                    </p>
                  ) : (
                    rows.map((row) => (
                      <div key={row.key}>
                        {/* ⚠️ 用 `.block-label` 而不是原型上的 `.field__label`：`app.css` 里
                            **没有** `.field*` 这一族（`P0-1-30` 定案「AntD 已有的样式不重写」，
                            而 AntD 的字段标签由 `Form.Item` 自带）—— 照原型类名写会得到一个
                            完全没有样式的 `<label>`，且不报任何错。 */}
                        <label className="block-label" htmlFor={`cred-${item.serverId}-${row.key}`}>
                          {row.label}
                          {row.required ? <span title="必填"> *</span> : null}
                          {row.hasValue ? (
                            <Tag className="tag--ok" style={{ marginLeft: 'var(--sp-2)' }}>
                              已配置 ✓
                            </Tag>
                          ) : null}
                        </label>
                        <Input.Password
                          id={`cred-${item.serverId}-${row.key}`}
                          value={row.value}
                          // ⚠️ 值永不回填（连掩码都没有）⇒ 占位符只能写"留空 = 不变"，
                          //    而**不能**把 `placeholder` 当成"当前值"来展示
                          placeholder={row.placeholder === '' ? '留空 = 不变' : `${row.placeholder}（留空 = 不变）`}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [item.serverId]: setCredentialDraftValue(rows, row.key, event.target.value),
                            }))
                          }
                        />
                        <p className="ratio" style={{ marginTop: 'var(--sp-1)' }}>
                          注入位置：{INJECT_HINT[row.inject] ?? row.inject} · 参数名{' '}
                          <code>{row.key}</code>
                          {row.hasValue ? ' · 已有一个值（重新填写会覆盖它）' : ''}
                        </p>
                      </div>
                    ))
                  )}

                  {rows.length > 0 && (
                    <div className="row" style={{ marginTop: 'var(--sp-3)', gap: 'var(--sp-3)' }}>
                      <Button
                        type="primary"
                        // ⚠️ 一个 key 都没改 ⇒ **不发请求**：空 `values` 会被后端 400
                        //    （"要清空整份凭据请用 DELETE"），而"什么都没改"不是一次错误
                        disabled={!changed}
                        loading={putCredential.isPending && putCredential.variables?.serverId === item.serverId}
                        onClick={() => {
                          const values = buildCredentialSubmitValues(rows)
                          if (values === null) return
                          if (blocked.length > 0) {
                            // 本地预检：必填项既没有旧值、这次也没填 ⇒ 交上去必然 400
                            feedback.note(`还有必填参数没填：${blocked.join('、')}`)
                            return
                          }
                          putCredential.mutate(
                            { serverId: item.serverId, values },
                            {
                              onSuccess: () => feedback.ok(`${item.serverName} 的凭据已保存（仅你可见）`),
                              onError: (error) => feedback.fail(error, '保存凭据失败'),
                            },
                          )
                        }}
                      >
                        保存该 server 的凭据
                      </Button>

                      {/* 「清除凭据」只在**已有值**时出现：`DELETE` 没配过的东西是 404，
                          摆一个必然 404 的按钮等于给用户一个必然的报错（见文件头 ②） */}
                      {item.configured ? (
                        <Popconfirm
                          title={`清除 ${item.serverName} 的凭据？`}
                          description="清除后，依赖这些凭据的工具会报「尚未配置所需凭据」，直到你重新填写。"
                          okText="清除"
                          okButtonProps={{ danger: true }}
                          cancelText="取消"
                          onConfirm={() => {
                            removeCredential.mutate(item.serverId, {
                              onSuccess: (result) => feedback.ok(`已清除 ${result.serverName} 的凭据`),
                              onError: (error) => feedback.fail(error, '清除凭据失败'),
                            })
                          }}
                        >
                          <Button danger disabled={changed}>
                            清除凭据
                          </Button>
                        </Popconfirm>
                      ) : null}

                      <span className="ratio u-right">只提交你这次真的填过的参数，其余保持原样</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </>
    )
  })()

  return (
    <>
      {head}

      <Tabs
        activeKey={section}
        onChange={(key) => selectSection(key as CredentialsSection)}
        items={[
          {
            key: 'mcp',
            label: `MCP 工具凭据${unconfigured.length > 0 ? `（${unconfigured.length} 未配置）` : ''}`,
            children: (
              <section id={credentialsSectionAnchorId('mcp')} className="stack">
                <Alert
                  type="info"
                  showIcon
                  message="凭据仅用于代表你调用工具"
                  description="这里的值只注入到 tools/call（对话里真调工具）；server 的「测试 / 工具列表」用的是**所属人**的凭据，与这里无关（见 MCP 管理页说明）。"
                />
                {mcpBody}
              </section>
            ),
          },
          {
            key: 'provider',
            label: '模型 Provider 凭据',
            children: (
              <section id={credentialsSectionAnchorId('provider')}>
                <ProviderKeySection />
              </section>
            ),
          },
          {
            key: 'openapi',
            label: '开放调用',
            children: (
              <section id={credentialsSectionAnchorId('openapi')} className="stack">
                <OpenApiKeysSection />
              </section>
            ),
          },
          {
            key: 'git',
            label: 'Git 凭据',
            children: (
              <section id={credentialsSectionAnchorId('git')} className="stack">
                <GitCredentialsSection />
                <GitIdentitySection />
              </section>
            ),
          },
        ]}
      />
    </>
  )
}
