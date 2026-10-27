/**
 * 活动时间线（P1-8 · L0）—— 并入「任务中心」的 tab
 *
 * 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §4.1（L0）/§4.6（L0 先行）。
 *
 * 两块：
 *   · **时间线**：本人的会话（主题 / 智能体 / 消息数 / 产物数 / 用量 / L1 小结），可点进会话；
 *   · **消息搜索**：在本人所有会话里按关键词搜消息，命中显示所属会话 + 片段，可跳回。
 */

import { Input, Pagination, Tag } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ActivityItem, ActivitySearchHit } from '@doubulea/shared'

import { ACTIVITY_PAGE_LIMIT, useActivity, useActivitySearch } from '../../api/activity.js'
import { useT, type Translate } from '../../app/i18n.js'
import { chatPath } from '../../app/paths.js'
import { formatUpdatedAt } from '../../app/format.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'

function conversationLabel(item: { topic: string | null }, t: Translate): string {
  return item.topic ?? t('activity.newConversation')
}

export function ActivityPanel() {
  const { t } = useT()
  const [offset, setOffset] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [committed, setCommitted] = useState('')

  const searching = committed !== ''
  const timeline = useActivity({ offset, limit: ACTIVITY_PAGE_LIMIT, q: committed })
  const search = useActivitySearch({ q: committed, offset, limit: ACTIVITY_PAGE_LIMIT }, searching)

  const items = timeline.data?.items ?? []
  const hits = search.data?.items ?? []
  const total = searching ? (search.data?.total ?? 0) : (timeline.data?.total ?? 0)

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--sp-4)', gap: 'var(--sp-3)' }}>
        <Input.Search
          placeholder={t('activity.searchPlaceholder')}
          style={{ maxWidth: 420 }}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onSearch={(value) => {
            setCommitted(value.trim())
            setOffset(0)
          }}
          allowClear
        />
        <span className="ratio">{t('activity.totalCount', { total })}</span>
      </div>

      {searching ? (
        <SearchResults query={search} hits={hits} t={t} />
      ) : (
        <Timeline query={timeline} items={items} t={t} />
      )}

      {total > ACTIVITY_PAGE_LIMIT ? (
        <div className="row" style={{ marginTop: 'var(--sp-4)', justifyContent: 'flex-end' }}>
          <Pagination
            current={Math.floor(offset / ACTIVITY_PAGE_LIMIT) + 1}
            pageSize={ACTIVITY_PAGE_LIMIT}
            total={total}
            showSizeChanger={false}
            onChange={(page) => setOffset((page - 1) * ACTIVITY_PAGE_LIMIT)}
          />
        </div>
      ) : null}
    </>
  )
}

function Timeline({
  query,
  items,
  t,
}: {
  query: ReturnType<typeof useActivity>
  items: readonly ActivityItem[]
  t: Translate
}) {
  if (query.isError) {
    return (
      <ErrorState
        title={t('activity.loadFailed')}
        error={query.error}
        onRetry={() => {
          void query.refetch()
        }}
        retrying={query.isFetching}
      />
    )
  }
  if (query.isLoading) return <TableSkeleton />
  if (items.length === 0) {
    return (
      <div className="card">
        <EmptyState title={t('activity.emptyTitle')} lead={t('activity.emptyLead')} />
      </div>
    )
  }
  return (
    <div className="card card--pad" data-testid="activity-timeline">
      {items.map((item) => (
        <div key={item.conversationId} className="row" style={{ alignItems: 'flex-start', gap: 'var(--sp-4)', padding: 'var(--sp-3) 0', borderBottom: '1px solid var(--rule)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <Link to={chatPath(item.agentId, item.conversationId)}>{conversationLabel(item, t)}</Link>
              <Tag>{item.agentName}</Tag>
              {item.status === 'FINISHED' ? <Tag>{t('activity.readOnly')}</Tag> : null}
            </div>
            {item.summary !== null ? <p className="ratio" style={{ marginTop: 4 }}>{item.summary}</p> : null}
          </div>
          <div className="agent-cell" style={{ textAlign: 'right', width: 200 }}>
            <span className="agent-cell__name num">
              {t('activity.messageArtifact', {
                messages: item.messageCount,
                artifacts: item.artifactCount,
              })}
            </span>
            <span className="agent-cell__sub">{formatUpdatedAt(item.lastMessageAt ?? item.createdAt)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function SearchResults({
  query,
  hits,
  t,
}: {
  query: ReturnType<typeof useActivitySearch>
  hits: readonly ActivitySearchHit[]
  t: Translate
}) {
  if (query.isError) {
    return (
      <ErrorState
        title={t('activity.searchFailed')}
        error={query.error}
        onRetry={() => {
          void query.refetch()
        }}
        retrying={query.isFetching}
      />
    )
  }
  if (query.isLoading) return <TableSkeleton />
  if (hits.length === 0) {
    return (
      <div className="card">
        <EmptyState title={t('activity.noHitTitle')} lead={t('activity.noHitLead')} />
      </div>
    )
  }
  return (
    <div className="card card--pad" data-testid="activity-search">
      {hits.map((hit, index) => (
        <div key={`${hit.conversationId}-${index}`} style={{ padding: 'var(--sp-3) 0', borderBottom: '1px solid var(--rule)' }}>
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <Link to={chatPath(hit.agentId, hit.conversationId)}>{conversationLabel(hit, t)}</Link>
            <Tag>{hit.role === 'USER' ? t('activity.roleMe') : t('activity.roleAssistant')}</Tag>
            <span className="ratio">{formatUpdatedAt(hit.createdAt)}</span>
          </div>
          <p style={{ marginTop: 4 }}>{hit.snippet}</p>
        </div>
      ))}
    </div>
  )
}
