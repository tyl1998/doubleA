/**
 * 历史产物页（`/artifacts/history`，**TaskAgent 记忆与产物 块 4/5**）
 *
 * 依据：`docs/子方案/TaskAgent记忆与产物.md` 块 3/4/5 —— 删除会话时产物行**不删**，
 *      只把 `conversation_id` 置空、归入"历史产物"；本页是"删了会话之后还能找到并下载"
 *      的前端入口，数据来自 `GET /api/artifacts/history`（仅本人）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一页（而不是塞进对话页的产物面板）
 * ─────────────────────────────────────────────────────────────────────
 * 产物面板是**会话作用域**的（`/api/conversations/:id/artifacts`）—— 会话都没了，那个面板
 * 自然也没有宿主。历史产物是**用户作用域**的（`user_id = me AND conversation_id IS NULL`），
 * 只有它需要一个"跨会话"的入口。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 复用产物卡与预览弹层，不重写一套
 * ─────────────────────────────────────────────────────────────────────
 * 卡（`ArtifactCard`：预览 / 下载）与弹层（`ArtifactPreviewDrawer`）都是**只认一个产物**的
 * 独立机器 —— 本页与对话页的唯一区别只是"清单从哪来"，所以直接复用，两处行为不会分叉。
 * ⚠️ 预览弹层必须**在本页也渲染一次**：它订阅的是 `stores/artifactPreview.ts`，
 *    而那个 store 是全局的，但弹层的宿主组件是各页自己 —— 对话页渲染了不代表本页也渲染。
 *
 * ⚠️ 分页是**服务端**的（offset/limit，与其它列表同口径）：历史产物可能远超一页，
 *    不能像面板那样"一次取满 100 就不管了"。
 */

import { Button, Pagination } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ARTIFACTS_PAGE_LIMIT, useArtifactHistory } from '../../api/artifacts.js'

import { HOME_PATH } from '../../app/paths.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { ArtifactPreviewDrawer } from '../../components/ArtifactPreview/ArtifactPreviewDrawer.js'
import { ArtifactCard } from '../../features/chat/ArtifactCard.js'
import { artifactTimeText } from '../../features/chat/artifactPanelModel.js'
import { useMinuteTick } from '../../features/chat/useMinuteTick.js'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.js'

export function ArtifactHistoryPage() {
  const limit = ARTIFACTS_PAGE_LIMIT
  const [offset, setOffset] = useState(0)
  const query = useArtifactHistory(offset, limit)

  // 相对时间读数（"3 分钟前"）不会自己走 —— 与侧栏 / 产物面板共用同一个节拍器
  const now = useMinuteTick()
  const previewedArtifact = useArtifactPreviewStore((state) => state.preview)
  const closePreview = useArtifactPreviewStore((state) => state.closePreview)

  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0

  return (
    <>
      <div className="page__head">
        <div>
          <p className="kicker">S-10 · 历史产物</p>
          <h1>历史产物</h1>
          <p className="page__lead">
            已删除会话保留下的产物。它们是 TaskAgent 在容器里生成的文件本体，仍然可以预览与下载；
            与其它产物一样受保留期收口（超过保留天数后由后端清理）。
          </p>
        </div>
      </div>

      {query.isError ? (
        <ErrorState
          title="历史产物没读出来"
          error={query.error}
          onRetry={() => {
            void query.refetch()
          }}
          retrying={query.isFetching}
        />
      ) : query.isLoading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          title="还没有历史产物"
          lead="删除一个产出过文件的会话后，它的产物会保留在这里（不会随会话一起消失）。"
          action={
            <Link to={HOME_PATH}>
              <Button type="primary">回到智能体列表</Button>
            </Link>
          }
        />
      ) : (
        <>
          <p className="ratio" style={{ marginBottom: 'var(--sp-3)' }}>
            共 <span className="num">{total}</span> 个 · 最新产出在最上面
          </p>
          <div data-testid="artifact-history-list">
            {items.map((item) => (
              <ArtifactCard
                key={item.artifactId}
                artifact={item}
                timeText={artifactTimeText(item.createdAt, now)}
              />
            ))}
          </div>
          {total > limit ? (
            <div className="row" style={{ marginTop: 'var(--sp-4)', justifyContent: 'flex-end' }}>
              <Pagination
                current={Math.floor(offset / limit) + 1}
                pageSize={limit}
                total={total}
                showSizeChanger={false}
                onChange={(page) => {
                  setOffset((page - 1) * limit)
                }}
              />
            </div>
          ) : null}
        </>
      )}

      {/* 预览弹层（与对话页同一台机器；见文件头"必须在本页也渲染一次"） */}
      <ArtifactPreviewDrawer
        artifact={previewedArtifact}
        open={previewedArtifact !== null}
        onClose={closePreview}
      />
    </>
  )
}
