/**
 * 工具清单弹窗（P0-2-11；对应 `GET /api/mcp/servers/:id/tools`，P0-2-5 的端点）
 *
 * 为什么是它、而不是"测试"按钮一个人扛：`03` §4.4 的表格上那一格写的是**「工具数（缓存）」**
 * —— 数字旁边有一个"缓存"二字，用户的第一反应就是"那我看的是什么时候的？"。
 * 本弹窗把这个区别**画出来**（`cached` + `fetchedAt`），并且给了唯一的破缓存入口（`刷新`）。
 *
 * ⚠️ 两个出口分得很清（`shared#mcpServerToolsResultSchema` 的注释）：
 *   · **拉不到且缓存空 ⇒ 502** ⇒ 这里渲染的是"我们答不了"（带错误码 + 重试），
 *     **不是**"这个 server 没有工具"（后者是一句真话，用 `{tools:[],cached:true}` 承载，
 *     会正常走到下面的空态分支）。
 *   把 502 显示成"0 个工具"会让用户去上游找一个其实不存在的配置问题。
 *
 * ⚠️ **不显示"以谁的凭据拉的"**：`tools/list` 刻意走"注册者视角"、不带用户凭据
 * （P0-2-5 坑预判 1 的定案），`tool_cache` 是**每个 server 一份、全员共享**的。
 * 界面写"你的工具"就是造假。
 */

import { Alert, Button, Modal, Table, Tag, type TableColumnsType } from 'antd'

import { describeError } from '../../api/client.js'
import { useMcpServerTools, useRefreshMcpServerTools } from '../../api/mcp.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { localeTag } from '../../app/locale.js'
import type { Locale, McpServerItem, McpToolDescriptor } from '@doubulea/shared'

export interface McpServerToolsModalProps {
  server: McpServerItem | null
  onClose: () => void
}

/**
 * `fetchedAt` 的读数（只在这一处格式化；`null` 就是"从没拉过"）。
 *
 * ⚠️ P1-23：日期 tag 走 `localeTag(locale)` —— 手写 `'zh-CN'` 会让英文界面下日期仍是中文格式
 * （静默、不报错；`03` §九 第二批定的口径）。
 */
function fetchedAtText(fetchedAt: string | null, locale: Locale, neverText: string): string {
  if (fetchedAt === null) return neverText
  const parsed = new Date(fetchedAt)
  if (Number.isNaN(parsed.getTime())) return fetchedAt
  return parsed.toLocaleString(localeTag(locale), { hour12: false })
}

export function McpServerToolsModal({ server, onClose }: McpServerToolsModalProps) {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const query = useMcpServerTools(server?.id)
  const refresh = useRefreshMcpServerTools(server?.id ?? '')

  const data = query.data
  const columns: TableColumnsType<McpToolDescriptor> = [
    {
      title: t('mcpTools.colName'),
      dataIndex: 'name',
      width: 240,
      render: (_, tool) => (
        <span className="agent-cell">
          <span className="num">{tool.name}</span>
          {/* `title` 缺失恒为 `null`（不是 undefined）—— 契约里六个键**恒存在** */}
          {tool.title === null ? null : <span className="agent-cell__sub">{tool.title}</span>}
        </span>
      ),
    },
    {
      title: t('mcpTools.colDesc'),
      dataIndex: 'description',
      render: (_, tool) =>
        // ⚠️ `description` 的 `null` 是"上游没给"、`''` 是"上游给了一个空串"
        //    —— 两者在界面上的处理一样（都是"没有说明"），但判据仍是 `null` 优先
        tool.description === null || tool.description === '' ? (
          <span className="ratio">{t('mcpTools.noDesc')}</span>
        ) : (
          tool.description
        ),
    },
  ]

  return (
    <Modal
      open={server !== null}
      title={server === null ? '' : t('mcpTools.title', { name: server.name })}
      width={720}
      onCancel={onClose}
      footer={
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <span className="ratio u-right">
            {data === undefined
              ? ''
              : data.fetchedAt === null
                ? t('mcpTools.metaCached')
                : t('mcpTools.meta', {
                    source: t(data.cached ? 'mcpTools.fromCache' : 'mcpTools.justFetched'),
                    time: fetchedAtText(data.fetchedAt, locale, t('mcpTools.neverFetched')),
                  })}
          </span>
          <Button onClick={onClose}>{t('mcpTools.close')}</Button>
          <Button
            type="primary"
            loading={refresh.isPending}
            onClick={() => {
              refresh.mutate(undefined, {
                onSuccess: (result) => {
                  feedback.ok(
                    result.cached && result.fetchedAt !== null
                      ? t('mcpTools.refetchPartial', { count: result.tools.length })
                      : t('mcpTools.refetched', { count: result.tools.length }),
                  )
                },
                onError: (error) => {
                  feedback.fail(error, t('mcpTools.refetchFailed'))
                },
              })
            }}
          >
            {t('mcpTools.refetch')}
          </Button>
        </div>
      }
    >
      {query.isPending ? (
        <p className="ratio">{t('mcpTools.loading')}</p>
      ) : query.isError ? (
        <Alert
          type="error"
          showIcon
          message={t('mcpTools.loadFailed')}
          description={t('mcpTools.loadFailedDesc', {
            code: describeError(query.error).code,
            message: describeError(query.error).message,
          })}
        />
      ) : data === undefined ? null : data.tools.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message={t('mcpTools.emptyTitle')}
          description={
            data.fetchedAt === null
              ? t('mcpTools.emptyNever')
              : t('mcpTools.emptyReal', { time: fetchedAtText(data.fetchedAt, locale, t('mcpTools.neverFetched')) })
          }
        />
      ) : (
        <>
          <Table<McpToolDescriptor>
            rowKey="name"
            size="small"
            columns={columns}
            dataSource={data.tools}
            pagination={false}
          />
          <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
            <Tag>{t('mcpTools.count', { count: data.tools.length })}</Tag>
            {t('mcpTools.sharedNote')}
          </p>
        </>
      )}
    </Modal>
  )
}
