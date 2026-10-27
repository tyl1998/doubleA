/**
 * 用量统计（`/admin/usage`，P1-7，**ADMIN**）
 *
 * 依据：`docs/03` §4.8（`/admin/usage`）、`01` §3.8 需求 37（"按用户/Agent 的 token 累计与简单报表"、
 *      验收要点"可回答『这个月谁用最多』"）、`docs/02` §四（`GET /api/usage/summary`）、
 *      `shared/src/usage.ts`（契约）、`pages/admin/usageModel.ts`（零依赖纯逻辑）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 三张表 + 一个区间 = 一次筛选
 * ─────────────────────────────────────────────────────────────────────
 * 维度是**用户 / 智能体 / 模型**三张并排的聚合表，共用同一个时间区间 ⇒ 同一次筛选发三个请求
 * （`groupBy` 不同）。默认区间是**本月**（"这个月谁用最多"），另有上月 / 近 7 天 / 近 30 天与自定义。
 * 排序由服务端定（合计降序）⇒ 每张表的第一行就是该维度的"用得最多"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 只说真实存在的东西（不编费用、`NULL` ≠ `0`）
 * ─────────────────────────────────────────────────────────────────────
 * `usage_records` **没有费用列** ⇒ 这一页**不做"金额"**（原型/占位页那句"费用统计"已删）。
 * token 之和是"**已知的**和"：某条没上报就是 `NULL`（显示 `—`），不是 0 ⇒ 每张表都带一列
 * 「上报覆盖」（`tokenRecords / records`），让读者分得清"真的只用了这么多"与"一半没上报"。
 */

import { Alert, Button, Table, type TableColumnsType } from 'antd'
import { useState } from 'react'
import { USAGE_GROUP_HEADER_KEY, USAGE_GROUP_KEY, translate, type Locale, type UsageGroupBy, type UsageSummaryItem } from '@doubulea/shared'

import { useUsageSummary } from '../../api/usage.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { useT, type Translate } from '../../app/i18n.js'
import {
  coverageText,
  dateInputValue,
  formatCount,
  formatDurationMs,
  formatTokens,
  rangeFromDayInputs,
  usageRangePresets,
  type UsageRange,
  type UsageRangePresetKey,
} from './usageModel.js'

/** 名称列的表头随维度变（"用户"/"智能体"/"模型"） */
function columnsFor(groupBy: UsageGroupBy, locale: Locale, t: Translate): TableColumnsType<UsageSummaryItem> {
  return [
    {
      title: translate(locale, USAGE_GROUP_HEADER_KEY[groupBy]),
      dataIndex: 'label',
      render: (_, item) => <span className="kb-cell__name">{item.label}</span>,
    },
    {
      title: t('usage.colRecords'),
      dataIndex: 'records',
      width: 90,
      align: 'right',
      render: (_, item) => <span className="num">{formatCount(item.records)}</span>,
    },
    {
      title: t('usage.colInput'),
      dataIndex: 'tokensIn',
      width: 130,
      align: 'right',
      render: (_, item) => <span className="num">{formatTokens(item.tokensIn)}</span>,
    },
    {
      title: t('usage.colOutput'),
      dataIndex: 'tokensOut',
      width: 130,
      align: 'right',
      render: (_, item) => <span className="num">{formatTokens(item.tokensOut)}</span>,
    },
    {
      title: t('usage.colTotal'),
      dataIndex: 'tokensTotal',
      width: 130,
      align: 'right',
      render: (_, item) => <span className="num">{formatTokens(item.tokensTotal)}</span>,
    },
    {
      title: t('usage.colCoverage'),
      key: 'coverage',
      width: 150,
      align: 'right',
      render: (_, item) => (
        <span className="ratio" title={t('usage.coverageTooltip')}>
          {coverageText(item.tokenRecords, item.records, locale)}
        </span>
      ),
    },
    {
      title: t('usage.colDuration'),
      dataIndex: 'durationMs',
      width: 110,
      align: 'right',
      render: (_, item) => <span className="num">{formatDurationMs(item.durationMs, locale)}</span>,
    },
    {
      title: t('usage.colRounds'),
      dataIndex: 'rounds',
      width: 90,
      align: 'right',
      render: (_, item) => <span className="num">{formatCount(item.rounds)}</span>,
    },
  ]
}

/** 一张维度表（三张共用；三态各自独立 —— 一个维度失败不遮挡另外两个） */
function UsageTable({ groupBy, range }: { groupBy: UsageGroupBy; range: UsageRange }) {
  const { t, locale } = useT()
  const query = useUsageSummary({ groupBy, from: range.from, to: range.to })
  const items = query.data?.items ?? []

  const title = (
    <span>
      {translate(locale, USAGE_GROUP_KEY[groupBy])}
      {query.isSuccess && (
        <span className="ratio" style={{ marginLeft: 'var(--sp-3)' }}>
          {t('usage.groupCount', { count: formatCount(items.length) })}
        </span>
      )}
    </span>
  )

  return (
    <section className="card" style={{ marginBottom: 'var(--sp-6)' }}>
      <h2 className="card__title" style={{ padding: 'var(--sp-4) var(--sp-5) 0' }}>
        {title}
      </h2>
      {query.isPending ? (
        <div style={{ padding: 'var(--sp-4)' }}>
          <TableSkeleton rows={3} />
        </div>
      ) : query.isError ? (
        <div style={{ padding: 'var(--sp-4)' }}>
          <ErrorState
            title={t('usage.loadFailed')}
            error={query.error}
            retrying={query.isFetching}
            onRetry={() => {
              void query.refetch()
            }}
          />
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: 'var(--sp-4)' }}>
          <EmptyState
            title={t('usage.emptyTitle')}
            lead={t('usage.emptyLead')}
          />
        </div>
      ) : (
        <Table<UsageSummaryItem>
          rowKey="key"
          size="middle"
          columns={columnsFor(groupBy, locale, t)}
          dataSource={items}
          loading={false}
          pagination={items.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
          scroll={{ x: 960 }}
        />
      )}
    </section>
  )
}

export function UsagePage() {
  const { t, locale } = useT()
  const presets = usageRangePresets()
  const [range, setRange] = useState<UsageRange>(presets[0]!.range)
  const [activePreset, setActivePreset] = useState<UsageRangePresetKey | null>('thisMonth')
  const [fromDay, setFromDay] = useState(dateInputValue(range.from))
  const [toDay, setToDay] = useState(dateInputValue(range.to))

  const customRange = rangeFromDayInputs(fromDay, toDay)

  const applyPreset = (key: UsageRangePresetKey): void => {
    const preset = presets.find((entry) => entry.key === key)
    if (preset === undefined) return
    setActivePreset(key)
    setRange(preset.range)
    setFromDay(dateInputValue(preset.range.from))
    setToDay(dateInputValue(preset.range.to))
  }

  const applyCustom = (): void => {
    if (customRange === null) return
    setActivePreset(null)
    setRange(customRange)
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{t('usage.title')}</h1>
          <p className="page__lead">
            {t('usage.leadPrefix')}
            <code>usage_records</code>
            {t('usage.leadMid')}
          </p>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message={t('usage.noteTitle')}
        description={
          <>
            {t('usage.notePrefix')}
            <strong>{t('usage.noteStrong1')}</strong>
            {t('usage.noteMid1')}
            <code>—</code>
            {t('usage.noteMid2')}
            <strong>{t('usage.noteStrong2')}</strong>
            {t('usage.noteMid3')}
          </>
        }
      />

      <div className="usage-range" role="group" aria-label={t('usage.rangeAria')}>
        {presets.map((preset) => (
          <Button
            key={preset.key}
            size="small"
            type={activePreset === preset.key ? 'primary' : 'default'}
            onClick={() => {
              applyPreset(preset.key)
            }}
          >
            {translate(locale, preset.labelKey)}
          </Button>
        ))}
        <span className="usage-range__sep" aria-hidden="true" />
        <label className="usage-range__field">
          {t('usage.from')}
          <input
            type="date"
            value={fromDay}
            max={toDay}
            onChange={(event) => {
              setFromDay(event.target.value)
            }}
          />
        </label>
        <label className="usage-range__field">
          {t('usage.to')}
          <input
            type="date"
            value={toDay}
            min={fromDay}
            onChange={(event) => {
              setToDay(event.target.value)
            }}
          />
        </label>
        <Button size="small" type="primary" disabled={customRange === null} onClick={applyCustom}>
          {t('usage.query')}
        </Button>
        {customRange === null && <span className="ratio">{t('usage.invalidRange')}</span>}
      </div>

      <UsageTable groupBy="user" range={range} />
      <UsageTable groupBy="agent" range={range} />
      <UsageTable groupBy="model" range={range} />
    </>
  )
}
