/**
 * XMind 大纲预览（2026-11-20）—— 左树 + 右阅读区，用例节点自动摊平成"步骤 / 预期"
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么是树 + 阅读区，而不是在服务端画一张导图
 * ─────────────────────────────────────────────────────────────────────
 * 真实数据（933 节点 / 7 层的端到端用例导图）否掉了两条"画图"的路：
 *   · 左右分叉画布 —— 单支 394 节点，视口里必然溢出，缩到能看全就已读不清；
 *   · mermaid mindmap —— 节点文字不能换行，`预期结果` 那种多行 DB 断言压成一行等于丢信息。
 * ⇒ 服务端只解包成 JSON（`GET …/outline`），这里做"左树索引 + 右栏详情"：
 *   左树永远只有一列宽，右栏只渲染**当前节点**，内容再多也读得清。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 两条视图，可手动切换
 * ─────────────────────────────────────────────────────────────────────
 *   · **用例视图**：判定 `looksLikeCase`（`tc-` 前缀 **或** 子节点里有步骤/预期/前置）命中时默认进，
 *     把 `pc:` / `操作步骤N`（+ 其下的 `预期结果N`）/ `日志关注` 一次摊平，不用逐层点开；
 *   · **整体视图**：其余节点默认进，自身正文 + 整棵子树（默认展开）。
 * 判据全在零依赖的 `xmindOutline.ts`（`verify-xmind-outline.mjs` 直跑源码断言）。
 *
 * ⚠️ 树用 AntD `Tree`：933 行一次性渲染在本机可接受（虚拟滚动只在万级才有必要）；
 *    真要更大就把 `virtual` 打开 —— 但那样搜索定位的 `scrollTo` 行为会变，先保持简单。
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, Skeleton, Space, Tag, Tree } from 'antd'
import type { DataNode } from 'antd/es/tree'

import type { XmindOutline, XmindOutlineNode } from '@doubulea/shared'

import { useT } from '../../app/i18n.js'
import {
  bodyOf,
  buildCaseView,
  countNodes,
  firstLineOf,
  isCaseHeading,
  looksLikeCase,
  splitCaseHeading,
  subtreeMatches,
} from './xmindOutline.js'
import './xmindOutline.css'

export interface XmindOutlinePreviewProps {
  /** 已取回的大纲；`undefined` = 正在取 */
  outline: XmindOutline | undefined
  /** 取数失败时的说明（`null` = 没有失败） */
  error?: string | null
}

type Key = string

interface FlatRow {
  key: Key
  node: XmindOutlineNode
  parent: Key | null
  depth: number
  /** 从根到本节点的标题（首行）—— 面包屑与搜索结果用 */
  crumbs: string[]
}

/** 树 → 扁平行（O(1) 查节点、O(深度) 查祖先） */
function flattenSheets(sheets: XmindOutline['sheets']): { rows: Map<Key, FlatRow>; tops: Key[] } {
  const rows = new Map<Key, FlatRow>()
  const tops: Key[] = []
  const walk = (node: XmindOutlineNode, key: Key, parent: Key | null, depth: number, crumbs: string[]): void => {
    const trail = [...crumbs, firstLineOf(node.title) || '—']
    rows.set(key, { key, node, parent, depth, crumbs: trail })
    node.children.forEach((child, index) => walk(child, `${key}.${String(index)}`, key, depth + 1, trail))
  }
  sheets.forEach((sheet, index) => {
    const key = `s${String(index)}`
    if (sheet.root === null) return
    tops.push(key)
    walk(sheet.root, key, null, 0, [])
  })
  return { rows, tops }
}

/** 工具栏的 `P0 / P1 / P2` 上色 */
function priorityColorOf(id: string): string {
  if (id === 'P0') return 'red'
  if (id === 'P1') return 'orange'
  if (id === 'P2') return 'blue'
  return 'default'
}

/** 用例视图：把整张用例一次摊平（前置条件 / 步骤+预期 / 日志 / 其它） */
function CaseSection({ node }: { node: XmindOutlineNode }) {
  const { t } = useT()
  const [compact, setCompact] = useState(false)
  const view = useMemo(() => buildCaseView(node), [node])

  return (
    <div className={`xm-case${compact ? ' xm-case--compact' : ''}`}>
      <div className="xm-case__head">
        <Space size={6} wrap>
          {view.id !== '' && <Tag color={priorityColorOf(view.id)}>{view.id}</Tag>}
          <h3 className="xm-case__title">{view.name}</h3>
        </Space>
        <Button size="small" type="text" onClick={() => setCompact((value) => !value)}>
          {compact ? t('xmind.showDetail') : t('xmind.stepsOnly')}
        </Button>
      </div>

      {view.precondition.length > 0 && (
        <section className="xm-case__sec">
          <h4>{t('xmind.precondition')}</h4>
          <ol className="xm-case__pre">
            {view.precondition.map((line, index) => (
              <li key={`${String(index)}-${line.slice(0, 12)}`}>{line}</li>
            ))}
          </ol>
        </section>
      )}

      {view.steps.length > 0 && (
        <section className="xm-case__sec">
          <h4>
            {t('xmind.stepsTitle')}（{view.steps.length} {t('xmind.stepUnit')}）
          </h4>
          <ol className="xm-case__steps">
            {view.steps.map((step, index) => (
              <li key={`${String(index)}-${String(step.index)}`}>
                <div className="xm-case__step">
                  <span className="xm-case__no">{step.index ?? index + 1}</span>
                  <span className="xm-case__step-text">{step.text}</span>
                </div>
                {step.expected.map((expect, expectIndex) => (
                  <div key={`${String(expectIndex)}-${expect.label}`} className="xm-case__expect">
                    <span className="xm-case__expect-label">{expect.label}</span>
                    <span className="xm-case__expect-text">{expect.text}</span>
                  </div>
                ))}
              </li>
            ))}
          </ol>
        </section>
      )}

      {view.logs.length > 0 && (
        <section className="xm-case__sec">
          <h4>{t('xmind.logs')}</h4>
          {view.logs.map((line, index) => (
            <p key={`${String(index)}-${line.slice(0, 10)}`} className="xm-case__block">
              {line}
            </p>
          ))}
        </section>
      )}

      {view.others.length > 0 && (
        <section className="xm-case__sec">
          <h4>{t('xmind.others')}</h4>
          {view.others.map((line, index) => (
            <p key={`${String(index)}-${line.slice(0, 10)}`} className="xm-case__block">
              {line}
            </p>
          ))}
        </section>
      )}
    </div>
  )
}

/** 整体视图里的一层子节点（默认全部展开，不用逐级点开） */
function SubtreeList({
  node,
  baseKey,
  rows,
  onPick,
  depth,
}: {
  node: XmindOutlineNode
  baseKey: Key
  rows: Map<Key, FlatRow>
  onPick: (key: Key) => void
  depth: number
}) {
  const { t } = useT()
  return (
    <ul className={`xm-outline__subtree xm-outline__subtree--d${String(Math.min(depth, 6))}`}>
      {node.children.map((child, index) => {
        const childKey = `${baseKey}.${String(index)}`
        const row = rows.get(childKey)
        const caseLike = looksLikeCase(child)
        return (
          <li key={childKey}>
            <button type="button" className={caseLike ? 'is-case' : undefined} onClick={() => onPick(childKey)}>
              <span className="xm-outline__kid-title">{firstLineOf(child.title) || '—'}</span>
              {caseLike ? (
                <span className="xm-outline__kid-badge">
                  {t('xmind.caseBadge', {
                    id: splitCaseHeading(child.title).id === '' ? '—' : splitCaseHeading(child.title).id,
                    count: child.children.length,
                  })}
                </span>
              ) : (
                <span className="xm-outline__kid-meta">
                  {child.children.length === 0
                    ? t('xmind.leaf')
                    : t('xmind.childrenCount', { count: countNodes(child) })}
                </span>
              )}
              {bodyOf(child.title) !== '' && <span className="xm-outline__kid-body">{t('xmind.hasBody')}</span>}
            </button>
            {row !== undefined && depth < 3 && child.children.length > 0 && (
              <SubtreeList node={child} baseKey={childKey} rows={rows} onPick={onPick} depth={depth + 1} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function XmindOutlinePreview({ outline, error = null }: XmindOutlinePreviewProps) {
  const { t } = useT()
  const { rows, tops } = useMemo(
    () => flattenSheets(outline?.sheets ?? []),
    [outline],
  )
  const firstKey: Key | null = tops[0] ?? null

  const [current, setCurrent] = useState<Key | null>(null)
  const [expanded, setExpanded] = useState<Key[]>(firstKey === null ? [] : [firstKey])
  const [query, setQuery] = useState('')
  const [override, setOverride] = useState<'CASE' | 'OUTLINE' | null>(null)
  const [flatten, setFlatten] = useState(false)
  const treeRef = useRef<{ scrollTo: (config: { key: Key; align?: string }) => void } | null>(null)

  // 大纲换了（切产物 / 换版本）⇒ 回到第一棵树的首个节点，并按它展开
  const activeKey = current ?? firstKey
  const activeRow = activeKey === null ? undefined : rows.get(activeKey)

  const selectedIsCase = activeRow !== undefined && looksLikeCase(activeRow.node)
  const mode = override ?? (selectedIsCase ? 'CASE' : 'OUTLINE')

  const go = useCallback(
    (key: Key) => {
      setCurrent(key)
      const chain: Key[] = []
      let cursor: Key | null = key
      while (cursor !== null) {
        chain.unshift(cursor)
        cursor = rows.get(cursor)?.parent ?? null
      }
      setExpanded((prev) => Array.from(new Set([...prev, ...chain])))
      // 下一帧再滚：此时树已按新的 `expandedKeys` 渲染过
      window.requestAnimationFrame(() => treeRef.current?.scrollTo({ key, align: 'middle' }))
    },
    [rows],
  )

  const treeData = useMemo<DataNode[]>(() => {
    const build = (key: Key): DataNode => {
      const row = rows.get(key)
      if (row === undefined) return { key, title: '' }
      const count = row.node.children.length
      return {
        key,
        title: (
          <span className="xm-outline__row">
            <span className="xm-outline__text">{firstLineOf(row.node.title) || '—'}</span>
            {count > 0 && <span className="xm-outline__badge">{count}</span>}
          </span>
        ),
        children: row.node.children.map((_, index) => build(`${key}.${String(index)}`)),
      }
    }
    return tops.map(build)
  }, [rows, tops])

  const matches = useMemo<Key[] | null>(() => {
    const keyword = query.trim()
    if (keyword === '') return null
    const hits: Key[] = []
    for (const [key, row] of rows) {
      // 只在**顶层子树**上做一次判断：命中子串即把整棵子树的所有行都收进来会爆炸，
      // 这里收的是"子树里有命中的那个节点自己"，与界面上的"定位到该节点"一致
      if (subtreeMatches(row.node, keyword)) hits.push(key)
      if (hits.length >= 200) break
    }
    return hits
  }, [rows, query])

  if (error !== null) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('xmind.loadFailed')}
        description={`${error} ${t('xmind.invalidTip')}`}
      />
    )
  }
  if (outline === undefined) return <Skeleton active paragraph={{ rows: 8 }} />

  if (activeRow === undefined) {
    return <Empty description={t('xmind.emptySheet')} />
  }

  const ownBody = bodyOf(activeRow.node.title)

  return (
    <div className="xm-outline">
      <div className="xm-outline__tree">
        <div className="xm-outline__tools">
          <Input.Search
            allowClear
            size="small"
            placeholder={t('xmind.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            size="small"
            type="text"
            aria-label={expanded.length > tops.length ? t('xmind.collapseAll') : t('xmind.expandAll')}
            onClick={() => {
              const openAll = expanded.length > tops.length
              setExpanded(openAll ? tops : Array.from(rows.keys()))
              // 摊开后左栏会横向溢出（缩进 + 长标题）：把横向滚动复位到最左，
              // 否则上一次的横向位移会让整列文字被推到右边、左侧留一片空白（2026-11-20 反馈）。
              if (openAll) return
              const treeBox = treeRef.current as unknown as {
                scrollTo?: (config: { x?: number; y?: number }) => void
              } | null
              window.requestAnimationFrame(() => treeBox?.scrollTo?.({ x: 0 }))
            }}
          >
            {expanded.length > tops.length ? t('xmind.collapseAll') : t('xmind.expandAll')}
          </Button>
        </div>

        {outline.truncated && <Alert type="warning" showIcon message={t('xmind.truncated')} />}

        {matches !== null ? (
          <div className="xm-outline__results">
            {matches.length === 0 ? (
              <p className="xm-outline__muted">{t('xmind.noMatch')}</p>
            ) : (
              matches.map((key) => {
                const row = rows.get(key)
                if (row === undefined) return null
                return (
                  <button
                    key={key}
                    type="button"
                    className={`xm-outline__result${isCaseHeading(row.node.title) ? ' is-case' : ''}`}
                    onClick={() => go(key)}
                  >
                    <span>{firstLineOf(row.node.title) || '—'}</span>
                    <span className="xm-outline__crumb">{row.crumbs.slice(0, -1).join(' / ')}</span>
                  </button>
                )
              })
            )}
          </div>
        ) : (
          <Tree
            ref={treeRef as never}
            treeData={treeData}
            selectedKeys={activeKey === null ? [] : [activeKey]}
            expandedKeys={expanded}
            onExpand={(keys) => setExpanded(keys as Key[])}
            onSelect={(keys) => {
              const next = keys[0]
              if (typeof next === 'string') setCurrent(next)
            }}
            blockNode
            showLine
          />
        )}
      </div>

      <div className="xm-outline__read">
        <div className="xm-outline__crumbs">
          {activeRow.crumbs.slice(0, -1).map((label, index) => (
            <span key={`${String(index)}-${label.slice(0, 8)}`}>
              {index > 0 && ' / '}
              {label}
            </span>
          ))}
        </div>

        {activeRow.node.children.length > 0 && (
          <div className="xm-outline__mode">
            <Button
              size="small"
              type={mode === 'CASE' ? 'primary' : 'default'}
              onClick={() => setOverride('CASE')}
            >
              {t('xmind.caseView')}
            </Button>
            <Button
              size="small"
              type={mode === 'OUTLINE' ? 'primary' : 'default'}
              onClick={() => setOverride('OUTLINE')}
            >
              {t('xmind.outlineView')}
            </Button>
            <span className="xm-outline__hint">
              {selectedIsCase ? t('xmind.detectedCase') : t('xmind.detectedPlain')} · {t('xmind.switchHint')}
            </span>
          </div>
        )}

        {mode === 'CASE' && activeRow.node.children.length > 0 ? (
          <CaseSection node={activeRow.node} />
        ) : (
          <>
            <h3 className="xm-outline__title">{firstLineOf(activeRow.node.title) || '—'}</h3>
            <Space size={6} wrap className="xm-outline__meta">
              <Tag>{t('xmind.depth', { depth: activeRow.depth })}</Tag>
              <Tag>{t('xmind.nodesCount', { count: countNodes(activeRow.node) })}</Tag>
            </Space>

            {ownBody !== '' && (
              <section className="xm-case__sec">
                <h4>{t('xmind.body')}</h4>
                <div className="xm-outline__own">{ownBody}</div>
              </section>
            )}

            {activeRow.node.note !== undefined && activeRow.node.note !== '' && (
              <section className="xm-case__sec">
                <h4>{t('xmind.attachNote')}</h4>
                <div className="xm-outline__note">{activeRow.node.note}</div>
              </section>
            )}

            {activeRow.node.children.length === 0 ? (
              <p className="xm-outline__muted">{t('xmind.leaf')}</p>
            ) : (
              <>
                <div className="xm-outline__subhead">
                  <span>{t('xmind.allChildren', { count: activeRow.node.children.length })}</span>
                  <Button size="small" type="text" onClick={() => setFlatten((value) => !value)}>
                    {flatten ? t('xmind.expandAll') : t('xmind.collapseToOne')}
                  </Button>
                </div>
                {flatten ? (
                  <ul className="xm-outline__kids">
                    {activeRow.node.children.map((child, index) => {
                      const childKey = `${activeRow.key}.${String(index)}`
                      const caseLike = looksLikeCase(child)
                      return (
                        <li key={childKey}>
                          <button type="button" className={caseLike ? 'is-case' : undefined} onClick={() => go(childKey)}>
                            <span className="xm-outline__kid-title">{firstLineOf(child.title) || '—'}</span>
                            {caseLike ? (
                              <span className="xm-outline__kid-badge">
                                {t('xmind.caseBadge', {
                                  id: splitCaseHeading(child.title).id === '' ? '—' : splitCaseHeading(child.title).id,
                                  count: child.children.length,
                                })}
                              </span>
                            ) : (
                              <span className="xm-outline__kid-meta">
                                {child.children.length === 0
                                  ? t('xmind.leaf')
                                  : t('xmind.childrenCount', { count: countNodes(child) })}
                              </span>
                            )}
                            {bodyOf(child.title) !== '' && (
                              <span className="xm-outline__kid-body">{t('xmind.hasBody')}</span>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <SubtreeList node={activeRow.node} baseKey={activeRow.key} rows={rows} onPick={go} depth={0} />
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
