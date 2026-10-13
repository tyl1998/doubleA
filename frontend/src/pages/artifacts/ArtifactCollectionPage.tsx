/**
 * 会话产物页（`/artifacts`）
 *
 * 「跨会话汇总本人全部产物」的前端入口，数据来自 `GET /api/artifacts`（仅本人）。
 * 与对话页的产物面板（`/api/conversations/:id/artifacts`）不同：面板是**会话作用域**的，
 * 这里把**所有会话**的产物汇成一份清单 —— 会话被删后产物行会保留（`conversation_id` 置空），
 * 所以它们也仍然出现在这里。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个动作：预览 / 下载 / 删除
 * ─────────────────────────────────────────────────────────────────────
 * 卡（`ArtifactCard`：预览 / 下载）与弹层（`ArtifactPreviewDrawer`）都是**只认一个产物**的
 * 独立机器 —— 本页与对话页的唯一区别只是"清单从哪来"，所以直接复用，两处行为不会分叉。
 * 「删除」是本页**独有**的（`onDelete` 只在会话产物页传）：真删除（对象 + 行），
 * 走 `Popconfirm` 二次确认；删除后本页失效缓存重取。
 *
 * ⚠️ 预览弹层必须**在本页也渲染一次**：它订阅的是 `stores/artifactPreview.ts`，
 *    而那个 store 是全局的，但弹层的宿主组件是各页自己 —— 对话页渲染了不代表本页也渲染。
 *
 * ⚠️ 分页是**服务端**的（offset/limit，与其它列表同口径）：产物可能远超一页，
 *    不能像面板那样"一次取满 100 就不管了"。
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Pagination } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ARTIFACTS_PAGE_LIMIT, deleteArtifact, useMyArtifacts } from '../../api/artifacts.js'
import { useFeedback } from '../../app/feedback.js'
import { AGENTS_PATH } from '../../app/paths.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { ArtifactPreviewDrawer } from '../../components/ArtifactPreview/ArtifactPreviewDrawer.js'
import { ArtifactCard } from '../../features/chat/ArtifactCard.js'
import { artifactTimeText } from '../../features/chat/artifactPanelModel.js'
import { useMinuteTick } from '../../features/chat/useMinuteTick.js'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.js'

export function ArtifactCollectionPage() {
  const limit = ARTIFACTS_PAGE_LIMIT
  const [offset, setOffset] = useState(0)
  const query = useMyArtifacts(offset, limit)
  const feedback = useFeedback()
  const queryClient = useQueryClient()

  // 相对时间读数（"3 分钟前"）不会自己走 —— 与侧栏 / 产物面板共用同一个节拍器
  const now = useMinuteTick()
  const previewedArtifact = useArtifactPreviewStore((state) => state.preview)
  const closePreview = useArtifactPreviewStore((state) => state.closePreview)

  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0

  const remove = useMutation({
    mutationFn: (artifactId: string) => deleteArtifact(artifactId),
    onSuccess: () => {
      feedback.ok('产物已删除')
    },
    onError: (error) => {
      feedback.fail(error, '删除失败')
    },
    onSettled: () => {
      // 删掉当页最后一条时回退一页：否则会停在一个空页上，看着像"产物全没了"。
      if (items.length === 1 && offset > 0) setOffset(Math.max(0, offset - limit))
      void queryClient.invalidateQueries({ queryKey: ['artifacts', 'collection'] })
    },
  })

  return (
    <>
      <div className="page__head">
        <div>
          <h1>会话产物</h1>
          <p className="page__lead">
            所有会话里 TaskAgent 在容器中生成的文件汇总在这里。可以预览、下载，也可以删除（删除后
            不可恢复）。与其它产物一样受保留期收口（超过保留天数后由后端清理）。
          </p>
        </div>
      </div>

      {query.isError ? (
        <ErrorState
          title="会话产物没读出来"
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
          title="还没有会话产物"
          lead="派一个任务型智能体干活，它在沙箱里生成的文件会汇总到这里。"
          action={
            <Link to={AGENTS_PATH}>
              <Button type="primary">回到智能体列表</Button>
            </Link>
          }
        />
      ) : (
        <>
          <p className="ratio" style={{ marginBottom: 'var(--sp-3)' }}>
            共 <span className="num">{total}</span> 个 · 最新产出在最上面
          </p>
          <div data-testid="artifact-collection-list">
            {items.map((item) => (
              <ArtifactCard
                key={item.artifactId}
                artifact={item}
                timeText={artifactTimeText(item.createdAt, now)}
                onDelete={async () => {
                  await remove.mutateAsync(item.artifactId)
                }}
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
