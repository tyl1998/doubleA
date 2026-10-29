/**
 * 会话产物页（`/artifacts`）
 *
 * 「跨会话汇总本人全部产物」的前端入口，数据来自 `GET /api/artifacts`（仅本人）。
 * 与对话页的产物面板（`/api/conversations/:id/artifacts`）不同：面板是**会话作用域**的，
 * 这里把**所有会话**的产物汇成一份清单 —— 会话被删后产物行会保留（`conversation_id` 置空），
 * 所以它们也仍然出现在这里。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 四个动作：预览 / 下载 / 删除 / **批量删除**
 * ─────────────────────────────────────────────────────────────────────
 * 卡（`ArtifactCard`：预览 / 下载）与弹层（`ArtifactPreviewDrawer`）都是**只认一个产物**的
 * 独立机器 —— 本页与对话页的唯一区别只是"清单从哪来"，所以直接复用，两处行为不会分叉。
 * 「删除」与「批量删除」都是本页**独有**的（`onDelete` / `onSelectedChange` 只在会话产物页传）：
 * 真删除（对象 + 行），走 `Popconfirm` 二次确认；删除后本页失效缓存重取。
 *
 * ⚠️ 批量删除的**选择面只有当前页**（勾选集是当页 id 的集合，翻页 / 删除后一律清空）——
 *    一页最多 `ARTIFACTS_PAGE_LIMIT` 条，也正是服务端 `ARTIFACT_BATCH_DELETE_MAX` 的来源；
 *    跨页选中会引出一个本页答不了的"到底删了哪几条"，不做。
 * ⚠️ 批量删除是**一个请求**（`POST /api/artifacts/batch-delete`，见 `api/artifacts.ts`），
 *    不是"前端循环调单条删除"：后者中途失败会留下半删状态，且 N 个产物 = N 次往返。
 *
 * ⚠️ 预览弹层必须**在本页也渲染一次**：它订阅的是 `stores/artifactPreview.ts`，
 *    而那个 store 是全局的，但弹层的宿主组件是各页自己 —— 对话页渲染了不代表本页也渲染。
 *
 * ⚠️ 分页是**服务端**的（offset/limit，与其它列表同口径）：产物可能远超一页，
 *    不能像面板那样"一次取满 100 就不管了"。
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, Pagination, Popconfirm } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
  ARTIFACTS_PAGE_LIMIT,
  artifactExtendUntil,
  deleteArtifact,
  deleteArtifacts,
  extendArtifact,
  useMyArtifacts,
} from '../../api/artifacts.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { AGENTS_PATH } from '../../app/paths.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { ArtifactPreviewDrawer } from '../../components/ArtifactPreview/ArtifactPreviewDrawer.js'
import { ArtifactCard, type ArtifactExtendChoice } from '../../features/chat/ArtifactCard.js'
import { artifactExpiresText, artifactTimeText } from '../../features/chat/artifactPanelModel.js'
import { useMinuteTick } from '../../features/chat/useMinuteTick.js'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.js'

export function ArtifactCollectionPage() {
  const limit = ARTIFACTS_PAGE_LIMIT
  const [offset, setOffset] = useState(0)
  const query = useMyArtifacts(offset, limit)
  const feedback = useFeedback()
  const { t, locale } = useT()
  const queryClient = useQueryClient()

  // 相对时间读数（"3 分钟前"）不会自己走 —— 与侧栏 / 产物面板共用同一个节拍器
  const now = useMinuteTick()
  const previewedArtifact = useArtifactPreviewStore((state) => state.preview)
  const closePreview = useArtifactPreviewStore((state) => state.closePreview)

  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0

  // 批量删除的勾选集（**只含当前页**的 id：翻页 / 删除后一律清空，见下面两处 setSelectedIds）。
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const selectedOnPage = items.filter((item) => selectedIds.has(item.artifactId))
  const allSelected = items.length > 0 && selectedOnPage.length === items.length
  const someSelected = selectedOnPage.length > 0 && !allSelected

  const remove = useMutation({
    mutationFn: (artifactId: string) => deleteArtifact(artifactId),
    onSuccess: (_data, artifactId) => {
      feedback.ok(t('artifacts.deletedOk'))
      // 单条删掉后把它从勾选集里摘掉，否则"批量删除（1）"会指着一个已不存在的产物
      setSelectedIds((prev) => {
        if (!prev.has(artifactId)) return prev
        const next = new Set(prev)
        next.delete(artifactId)
        return next
      })
    },
    onError: (error) => {
      feedback.fail(error, t('artifacts.deleteFailed'))
    },
    onSettled: () => {
      // 删掉当页最后一条时回退一页：否则会停在一个空页上，看着像"产物全没了"。
      if (items.length === 1 && offset > 0) setOffset(Math.max(0, offset - limit))
      void queryClient.invalidateQueries({ queryKey: ['artifacts', 'collection'] })
    },
  })

  /**
   * 延期（2026-10-29）：卡片弹窗把用户选的口径原样交回来 —— 这里只做"日期折算 + 调接口 +
   * 提示 + 失效列表"。三种口径：
   *   · `DAYS` / `FOREVER` 直接透传；
   *   · `UNTIL` 的 `day`（`YYYY-MM-DD`）折成**本地时区当天 23:59:59.999** 的绝对时刻
   *     （`artifactExtendUntil`）—— 服务端不猜时区。
   * 失败抛出去让 `ArtifactCard` 结束 loading 并保持弹窗（用户可改后再试）。
   */
  const extend = useMutation({
    mutationFn: ({ artifactId, choice }: { artifactId: string; choice: ArtifactExtendChoice }) =>
      extendArtifact(
        artifactId,
        choice.mode === 'UNTIL'
          ? { mode: 'UNTIL', until: artifactExtendUntil(choice.day) }
          : choice.mode === 'DAYS'
            ? { mode: 'DAYS', days: choice.days }
            : { mode: 'FOREVER' },
      ),
    onSuccess: () => {
      feedback.ok(t('artifact.extendedOk'))
    },
    onError: (error) => {
      feedback.fail(error, t('artifact.extendFailed'))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['artifacts', 'collection'] })
    },
  })

  const removeBatch = useMutation({
    mutationFn: (artifactIds: string[]) => deleteArtifacts(artifactIds),
    onSuccess: (result, artifactIds) => {
      // ⚠️ 报的是服务端**实际删掉的行数**（`deleted`），不是勾选数 —— 混进"不是我的 /
      //    已不存在"的会被如实扣掉（见 `api/artifacts.ts#deleteArtifacts`）。
      feedback.ok(t('artifacts.batchDeletedOk', { count: result.deleted }))
      setSelectedIds(new Set())
      // 把当页整页删空时回退一页（与单条删除同款，避免停在一个空页上）。
      // ⚠️ 只在**成功**时回退：失败（如 S3 不可用）时删掉的可能不足一页，跳页会更迷惑。
      if (artifactIds.length >= items.length && offset > 0) setOffset(Math.max(0, offset - limit))
    },
    onError: (error) => {
      feedback.fail(error, t('artifacts.batchDeleteFailed'))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['artifacts', 'collection'] })
    },
  })

  const toggleOne = (artifactId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(artifactId)
      else next.delete(artifactId)
      return next
    })
  }

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(items.map((item) => item.artifactId)) : new Set())
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{t('artifacts.title')}</h1>
          <p className="page__lead">{t('artifacts.lead')}</p>
        </div>
      </div>

      {query.isError ? (
        <ErrorState
          title={t('artifacts.loadFailed')}
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
          title={t('artifacts.emptyTitle')}
          lead={t('artifacts.emptyLead')}
          action={
            <Link to={AGENTS_PATH}>
              <Button type="primary">{t('artifacts.backToAgents')}</Button>
            </Link>
          }
        />
      ) : (
        <>
          <div className="row" style={{ marginBottom: 'var(--sp-3)' }}>
            <Checkbox
              checked={allSelected}
              indeterminate={someSelected}
              onChange={(event) => {
                toggleAll(event.target.checked)
              }}
            >
              {t('artifacts.selectAllPage')}
            </Checkbox>
            <p className="ratio">
              {t('artifacts.totalCount', { total })}
            </p>
            <Popconfirm
              title={t('artifacts.deleteSelectedTitle', { count: selectedOnPage.length })}
              description={t('artifacts.deleteConfirmDescription')}
              okText={t('common.delete')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
              disabled={selectedOnPage.length === 0}
              onConfirm={async () => {
                await removeBatch.mutateAsync([...selectedIds])
              }}
            >
              <Button
                danger
                size="small"
                style={{ marginLeft: 'auto' }}
                disabled={selectedOnPage.length === 0}
                loading={removeBatch.isPending}
              >
                {selectedOnPage.length > 0
                  ? t('artifacts.batchDeleteWithCount', { count: selectedOnPage.length })
                  : t('artifacts.batchDelete')}
              </Button>
            </Popconfirm>
          </div>
          <div data-testid="artifact-collection-list">
            {items.map((item) => (
              <ArtifactCard
                key={item.artifactId}
                artifact={item}
                timeText={artifactTimeText(item.createdAt, now, locale)}
                // 2026-10-28：产物会过期 —— 卡片上直接给"还剩 N 天"，不用点开才知道
                expiresText={artifactExpiresText(item.expiresAt, now, locale)}
                selected={selectedIds.has(item.artifactId)}
                onSelectedChange={(checked) => {
                  toggleOne(item.artifactId, checked)
                }}
                onDelete={async () => {
                  await remove.mutateAsync(item.artifactId)
                }}
                onExtend={async (choice) => {
                  await extend.mutateAsync({ artifactId: item.artifactId, choice })
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
                  // 翻页时勾选集**清空**：选择面只有"当前页"（见文件头与 `selectedIds` 注释），
                  // 让上一次的勾选跨页带过来会引出一个本页答不了的"到底删了哪几条"。
                  setSelectedIds(new Set())
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
