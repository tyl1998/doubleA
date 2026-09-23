/**
 * 检索测试抽屉（P0-1-35）
 *
 * 依据：`docs/03` §4.3（"检索测试抽屉：输入 query → 结果表（内容片段 / 向量分 / 全文分 /
 *      RRF 融合排名 / 命中库）"）、`子方案①` §六（B1 的新增列：双路得分与融合排名）、
 *      `shared/src/knowledgeBase.ts`（`searchKnowledgeBaseBodySchema` 与 `retrievalHitSchema`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 这一页的 mode / topK **不落库**，而库配置卡上的那份会落库
 * ─────────────────────────────────────────────────────────────────────
 * 两句看着像、意思相反的话，必须分开说（原型把它们混在一张卡上了）：
 *   · **这里**（抽屉）：`mode` / `topK` 是**本次试查的覆盖**，不写库 —— 页面的价值就是
 *     "同一个 query 试三种模式，看双路各自怎么判"（`searchKnowledgeBaseBodySchema` 的注释）。
 *   · **那里**（详情页的「检索配置」卡）：`mode` / `topK` / `score` / `rrfK` / `weights`
 *     是**这个库的口径**，改了就落库。
 * `score` / `rrfK` / `weights` 在这里**刻意不可改**：让一次试查能改阈值，等于让页面看到的结果
 * 与线上不一致 —— 那比看不到更坏（`docs/02` §4.6 的「请求」行原文）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 结果里的四个"容易显示错"的字段
 * ─────────────────────────────────────────────────────────────────────
 *   · `vectorScore` / `fulltextScore` / 两个 `rank` 为 **`null` 表示"这一路没命中"**
 *     ⇒ 显示 `—`，**不是 0**（`0` 会读成"算了但很低"）；
 *   · `rrfScore` 与相似度**不是一个量级**（0.03x vs 0.8x）⇒ 两套小数位（`rrfScoreText`）；
 *   · **「命中库」改成「来源文档」**：库是路径参数，这一列恒等于当前库名；
 *     真正有信息量的是 `docName` / `page` / `seq`（见 `hitSourceText` 的注释）；
 *   · `mode` / `topK` / `rrfK` / `candidatePool` / `elapsedMs` 显示的是**响应回显的生效值**
 *     （不是我们输入的值）—— `rrfScore` 只有配上 `rrfK` 才可解释，所以这一行不能省。
 */

import { Alert, Button, Drawer, Input, InputNumber, Select, Table, Tag, type TableColumnsType } from 'antd'
import { RETRIEVAL_MODES, type RetrievalHit, type RetrievalMode } from '@doubulea/shared'
import { useState } from 'react'

import { describeError } from '../../api/client.js'
import { useSearchKnowledgeBase } from '../../api/knowledgeBases.js'
import {
  RETRIEVAL_MODE_LABEL,
  hitSourceText,
  rankText,
  rrfScoreText,
  searchNotice,
  similarityText,
} from './knowledgeModel.js'

export interface SearchTestDrawerProps {
  kbId: string
  /** 标题里带上库名，避免"在哪个库里查"这件事要靠记忆 */
  kbName: string
  open: boolean
  onClose: () => void
}

export function SearchTestDrawer({ kbId, kbName, open, onClose }: SearchTestDrawerProps) {
  const search = useSearchKnowledgeBase(kbId)
  const [query, setQuery] = useState('')
  /**
   * `undefined` = **不覆盖**（跟随该库的快照配置）。
   * 用 `undefined` 而不是"默认选中 HYBRID"：后者会让每次试查都带上一个 `mode`，
   * 于是"库配置里的 mode 到底生不生效"在页面上永远观察不到（覆盖值恰好把它遮住了）。
   */
  const [mode, setMode] = useState<RetrievalMode | undefined>(undefined)
  const [topK, setTopK] = useState<number | null>(null)

  const result = search.data
  const notice = result === undefined ? null : searchNotice(result)

  const run = (): void => {
    if (query.trim() === '') return
    search.mutate({
      query: query.trim(),
      ...(mode === undefined ? {} : { mode }),
      ...(topK === null ? {} : { topK }),
    })
  }

  const columns: TableColumnsType<RetrievalHit> = [
    {
      title: '内容片段',
      dataIndex: 'snippet',
      render: (_, hit) => <span className="kb-snippet">{hit.snippet}</span>,
    },
    {
      title: '向量分',
      dataIndex: 'vectorScore',
      width: 90,
      align: 'right',
      render: (_, hit) => (
        <span className="num" title={hit.vectorRank === null ? '向量路未命中' : `向量路第 ${hit.vectorRank} 名`}>
          {similarityText(hit.vectorScore)}
        </span>
      ),
    },
    {
      title: '全文分',
      dataIndex: 'fulltextScore',
      width: 90,
      align: 'right',
      render: (_, hit) => (
        <span className="num" title={hit.fulltextRank === null ? '全文路未命中' : `全文路第 ${hit.fulltextRank} 名`}>
          {similarityText(hit.fulltextScore)}
        </span>
      ),
    },
    {
      title: '融合排名',
      dataIndex: 'finalRank',
      width: 110,
      align: 'right',
      render: (_, hit) => (
        <span className="num" title={`RRF 融合分 ${rrfScoreText(hit.rrfScore)}`}>
          {rankText(hit.finalRank)} · {rrfScoreText(hit.rrfScore)}
        </span>
      ),
    },
    {
      title: '来源',
      key: 'source',
      width: 200,
      render: (_, hit) => <span className="ratio">{hitSourceText(hit)}</span>,
    },
  ]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={880}
      title={
        <span className="row" style={{ gap: 'var(--sp-3)' }}>
          检索测试「{kbName}」
          {result !== undefined && (
            <Tag>
              {RETRIEVAL_MODE_LABEL[result.mode]} · topK {result.topK} · k={result.rrfK}
            </Tag>
          )}
        </span>
      }
    >
      <div className="stack">
        <div className="row row--wrap" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <p className="block-label">查询</p>
            <Input
              value={query}
              maxLength={1000}
              aria-label="检索查询"
              placeholder="例如：索引重建期间检索超时怎么处理"
              onChange={(event) => setQuery(event.target.value)}
              onPressEnter={run}
            />
          </div>
          <div style={{ width: 200 }}>
            <p className="block-label">模式（可覆盖）</p>
            <Select
              value={mode}
              allowClear
              style={{ width: '100%' }}
              aria-label="检索模式"
              placeholder="跟随该库配置"
              onChange={(value: RetrievalMode | undefined) => setMode(value)}
              options={RETRIEVAL_MODES.map((item) => ({ value: item, label: RETRIEVAL_MODE_LABEL[item] }))}
            />
          </div>
          <div style={{ width: 140 }}>
            <p className="block-label">topK（可覆盖）</p>
            <InputNumber
              value={topK}
              min={1}
              max={100}
              style={{ width: '100%' }}
              aria-label="返回条数"
              placeholder="跟随该库"
              onChange={(value) => setTopK(value === null ? null : Number(value))}
            />
          </div>
          <Button type="primary" loading={search.isPending} disabled={query.trim() === ''} onClick={run}>
            检索
          </Button>
        </div>

        <p className="ratio">
          这里的 mode / topK 只是<strong>本次试查</strong>的覆盖，不落库；库的检索口径在详情页的
          「检索配置」里改。
        </p>

        {search.isError && <Alert type="error" showIcon message="检索失败" description={describeError(search.error).message} />}

        {notice !== null && <Alert type={notice.tone === 'warn' ? 'warning' : 'info'} showIcon message={notice.text} />}

        {result !== undefined && (
          <>
            <p className="ratio">
              生效口径：{RETRIEVAL_MODE_LABEL[result.mode]} · topK <span className="num">{result.topK}</span> ·
              RRF k=<span className="num">{result.rrfK}</span> · 候选池 <span className="num">{result.candidatePool}</span> ·
              耗时 <span className="num">{result.elapsedMs}</span> ms · 命中 <span className="num">{result.items.length}</span> 条
            </p>
            <Table<RetrievalHit>
              rowKey="chunkId"
              size="small"
              columns={columns}
              dataSource={[...result.items]}
              pagination={false}
              scroll={{ x: 860 }}
              locale={{ emptyText: '没有命中任何内容' }}
            />
            <p className="ratio">
              未命中的那一路显示为 <strong>—</strong>（接口返回空值而不是 0）：显示 0 会被读成
              &quot;两路都算了、只是很低&quot;。融合排名是 RRF 复算后的最终顺序，与表格顺序一致；
              同分时按 chunkId 升序（uuid7 时间有序 ⇒ 先入库的优先）。
            </p>
          </>
        )}
      </div>
    </Drawer>
  )
}
