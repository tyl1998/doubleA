/**
 * 产物面板（P0-3-11；`docs/03-前端设计.md` §4.1 的"TaskAgent 差异"："右侧/下方多一个**产物面板**
 * （artifact 事件驱动，列出文件+预览入口）"、§二 的 `design/chat.html` 第三列、§4.6 预览弹层）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一列**只有 TaskAgent 有**，判据是 `showArtifactPanel(agent.type)`
 * ─────────────────────────────────────────────────────────────────────
 * 那件事（以及"为什么判据是类型而不是'有没有产物'"）写在 `artifactPanelModel.ts` 的文件头里 ——
 * **本组件不自己判**，调用方（`ChatPage`）判完决定要不要渲染本组件。
 * 一个组件同时承担"我该不该存在"和"我长什么样"两件事，会让"面板为什么没出现"
 * 变成一个要读两个文件才能回答的问题。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 面板是"这个会话产出过哪些文件"的**唯一清单** ⇒ 两个来源必须在这里合流
 * ─────────────────────────────────────────────────────────────────────
 * 合流点是 `mergeArtifactPanelItems(persisted, streamed)`（纯逻辑，有断言），
 * 它把"服务端列表（最新在前）"与"本轮 `artifact` 事件（产出顺序）"并成一份清单，
 * 并按 `artifactId` 去重（保留服务端那一份 —— 它有 `createdAt`）。
 * 本组件**只负责画**：它不认识那两个来源、也不知道谁先谁后。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 列表拉失败**不遮挡**事件那一路
 * ─────────────────────────────────────────────────────────────────────
 * 两个来源的可用性互相独立：`GET /artifacts` 挂了，本轮事件产出的那些**照样在手上**
 * （它们是内存里的）。所以失败时是**一条提示 + 重试**，而不是把整个面板换成错误态 ——
 * 后者会让用户以为"产物都没了"，而他刚刚明明看见它们出现。
 */

import { Alert, Button } from 'antd'

import { useT } from '../../app/i18n.js'
import {
  ARTIFACT_PANEL_EMPTY,
  ARTIFACT_PANEL_NOTE,
  ARTIFACT_PANEL_TITLE,
  artifactPanelOverflowNote,
  artifactTimeText,
  type ArtifactPanelItem,
} from './artifactPanelModel.js'
import { ArtifactCard } from './ArtifactCard.js'
import { useMinuteTick } from './useMinuteTick.js'

export interface ArtifactPanelProps {
  /** 合并后的清单（最新在前）—— 由调用方经 `mergeArtifactPanelItems` 算好 */
  items: readonly ArtifactPanelItem[]
  /** 服务端给的**总数**；`undefined` = 没问到 ⇒ 不显示"共 N 个"（别拿 `items.length` 冒充） */
  total: number | undefined
  /** 服务端列表读取失败（事件那一路仍然可用，见文件头） */
  listFailed: boolean
  /** 重试读取列表 */
  onRetry: () => void
  /** 本轮是否正在产出（点亮头部那盏灯；与对话页的"生成中"同源判据） */
  streaming: boolean
}

/** 头部那盏灯：在产出 = 脉冲；有产物但此刻没在跑 = 绿；空 = 灰 */
function headLedClass(streaming: boolean, count: number): string {
  if (streaming) return 'led led--run'
  return count > 0 ? 'led led--ok' : 'led led--idle'
}

export function ArtifactPanel({ items, total, listFailed, onRetry, streaming }: ArtifactPanelProps) {
  // 相对时间读数（"3 分钟前"）不会自己走 —— 与侧栏共用同一个节拍器（`useMinuteTick` 文件头）
  const now = useMinuteTick()
  const { t, locale } = useT()
  const overflow = artifactPanelOverflowNote(items.length, total, locale)

  return (
    <aside className="panel" aria-label={t('artifact.panelAria')} data-testid="artifact-panel">
      <div className="panel__head">
        <div className="row">
          <p className="kicker">
            {t(ARTIFACT_PANEL_TITLE)} · {items.length}
          </p>
          <span className={`${headLedClass(streaming, items.length)} u-right`} aria-hidden="true" />
        </div>
        {/* 副标题只说一件**能证实**的事：排序口径（服务端列表是 `created_at desc`，
            本轮的流式那一段被 `mergeArtifactPanelItems` 倒序对齐到同一口径） */}
        <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
          {t('artifact.panelLatestFirst')}
        </p>
      </div>

      <div className="panel__body">
        {listFailed ? (
          // 失败是**提示**不是"这一列坏了"（见文件头）：重试按钮摆在提示里，用户不必刷新整页
          <Alert
            type="warning"
            showIcon
            message={t('artifact.listFailedTitle')}
            description={t('artifact.listFailedDescription')}
            action={
              <Button size="small" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : null}

        {items.length === 0 ? (
          <p className="ratio" data-testid="artifact-panel-empty">
            {t(ARTIFACT_PANEL_EMPTY)}
          </p>
        ) : (
          items.map((item) => (
            // ⚠️ 时间读数**由这里算好再交给卡片**：卡片不认识 `ArtifactPanelItem`，
            //    它只接受一个字符串（见 `ArtifactCard` 文件头的 `timeText` 那段）
            <ArtifactCard
              key={item.artifactId}
              artifact={item}
              timeText={artifactTimeText(item.createdAt, now, locale)}
            />
          ))
        )}

        {overflow === null ? null : (
          <p className="ratio" data-testid="artifact-panel-overflow">
            {overflow}
          </p>
        )}

        {/* 底部常驻说明（`design/chat.html` 的 `.alert--info`）：它是"空闲回收之后还能下载"
            这条保证的**唯一落点** —— 用户看着沙箱被回收时，需要知道产物没跟着没 */}
        <Alert type="info" showIcon message={t(ARTIFACT_PANEL_NOTE)} />
      </div>
    </aside>
  )
}
