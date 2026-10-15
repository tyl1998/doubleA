/**
 * 对话页的**长期记忆交互**（P1-8 · L2 · HCI §5.2 / §5.3）
 *
 * 本文件只导出：
 *   · {@link MemoryNoticeStack} —— 「待展示记忆提示」栈（toast 晚一拍）：自动写入可撤销、
 *     偏好建议可 `[记住][忽略]`。提示由后端放进短 TTL 队列，前端在**下一轮/聚焦/重连**时拉取。
 *
 * ⚠️ 会话级「不记入记忆」开关**已迁出本文件**（R4）：它现在是输入框下方的一枚**图标按钮**，
 *    与其余控件同在 `ConversationSettings`（`BulbOutlined` + `onToggleMemoryExcluded`）。
 * ⚠️ 提示是**后端产出的事件/数据**（不是模型自由发挥的文本）⇒ ChatBot 与 TaskAgent 渲染同一套组件
 *    （HCI §5.6），读同一份契约（`shared#memoryNoticeSchema`）。
 */

import { CloseOutlined } from '@ant-design/icons'
import { Button, Tag, Tooltip } from 'antd'
import { useEffect, useState } from 'react'
import type { MemoryNotice } from '@doubulea/shared'

import { fetchMemoryNotices, useDeleteMemory, useMemoryNoticeAction } from '../../api/memory.js'
import { memoryKindLabel } from '../../pages/tasks/memoryModel.js'

/**
 * 「待展示记忆提示」栈。
 *
 * 拉取时机：`conversationId` 变化时、窗口**重新聚焦**时、以及 `refreshKey` 变化时
 * （`refreshKey` 由对话页在**每一轮结束后**递增 ⇒ 兑现"toast 晚一拍"）。
 * ⚠️ 后端对 `AUTO` 取出即消费、`SUGGEST` **留到作答**（要读回它才能落库）⇒ 不用 query 缓存，
 *    改用本地 `useState` 管队列，并**按 `id` 去重**（SUGGEST 会被重复返回）。
 */
export function MemoryNoticeStack({
  conversationId,
  refreshKey,
}: {
  conversationId: string | undefined
  /** 每轮结束后 +1（父组件维护）—— 变化即触发一次拉取 */
  refreshKey: number
}) {
  const [notices, setNotices] = useState<MemoryNotice[]>([])
  const action = useMemoryNoticeAction(conversationId)
  const removeMemory = useDeleteMemory()

  useEffect(() => {
    if (conversationId === undefined) {
      setNotices([])
      return
    }
    let cancelled = false
    const pull = (): void => {
      void fetchMemoryNotices(conversationId)
        .then((result) => {
          if (cancelled || result.items.length === 0) return
          // ⚠️ **按 `id` 去重**：SUGGEST 提示服务端**不消费**（要留到用户作答），故每次拉取都会
          //    再返回一次；不去重就会叠出多张同一张建议卡。
          setNotices((prev) => {
            const seen = new Set(prev.map((item) => item.id))
            const fresh = result.items.filter((item) => !seen.has(item.id))
            return fresh.length === 0 ? prev : [...prev, ...fresh]
          })
        })
        .catch(() => {
          /* 提示读不到不影响对话 */
        })
    }
    pull()
    window.addEventListener('focus', pull)
    return () => {
      cancelled = true
      window.removeEventListener('focus', pull)
    }
  }, [conversationId, refreshKey])

  function drop(notice: MemoryNotice): void {
    setNotices((prev) => prev.filter((item) => item.id !== notice.id))
  }

  /** 记住（仅 SUGGEST）：让服务端按提示里的 `memoryKind`/`memoryScope` 落库 */
  function accept(notice: MemoryNotice): void {
    drop(notice)
    action.mutate({ noticeId: notice.id, action: 'ACCEPT' })
  }

  /**
   * 撤销 / 忽略：
   *   · `AUTO` 的「撤销」= **撤回刚写入的那条记忆**（删记忆本身）。⚠️ `AUTO` 提示在拉取时已被
   *     服务端消费（一次性 toast）⇒ 走不了"按提示作答"，必须**直接按 `notice.memoryId` 删**。
   *   · `SUGGEST` 的「忽略」= 消费掉这条建议（**不写入**）。
   */
  function reject(notice: MemoryNotice): void {
    drop(notice)
    if (notice.kind === 'AUTO' && notice.memoryId !== null) {
      removeMemory.mutate(notice.memoryId)
      return
    }
    action.mutate({ noticeId: notice.id, action: 'REJECT' })
  }

  /**
   * 关掉一条提示（纯关闭）：
   *   · `SUGGEST` 队列里**还留着它**（服务端只对 AUTO"取出即消费"）⇒ 关闭必须**显式作答**
   *     （等价"忽略"、不写入），否则下次拉取会把它再弹一次。
   *   · `AUTO` 已被服务端消费 ⇒ 本地移除即永久收起，不动记忆。
   */
  function dismiss(notice: MemoryNotice): void {
    drop(notice)
    if (notice.kind === 'SUGGEST') action.mutate({ noticeId: notice.id, action: 'REJECT' })
  }

  if (notices.length === 0) return null

  return (
    <div className="column" style={{ gap: 'var(--sp-2)', padding: '0 var(--sp-4)', marginTop: 'var(--sp-2)' }}>
      {notices.map((notice) => {
        // 提示正文前缀（按提示类型/作用域）—— 与正文拼成一句话，供截断与悬浮完整展示共用
        const prefix =
          notice.kind === 'AUTO'
            ? `已记入${notice.memoryScope === 'AGENT' ? '该 Agent 记忆' : '全局记忆'}：`
            : '要记住这条吗？'
        const fullText = `${prefix}${notice.text}`
        return (
          <div
            key={notice.id}
            className="card card--pad"
            data-testid="memory-notice"
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}
          >
            <Tag>{memoryKindLabel(notice.memoryKind)}</Tag>
            {/* 正文**只占一行、超出省略**（否则一条长记忆会把右侧的动作按钮挤出可视区），
                悬浮约 1s 用 tooltip 展示完整内容。 */}
            <Tooltip title={fullText} mouseEnterDelay={1} placement="topLeft">
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {prefix}
                <span className="num">{notice.text}</span>
              </span>
            </Tooltip>
            {notice.kind === 'AUTO' ? (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => reject(notice)}>
                撤销
              </Button>
            ) : (
              <>
                <Button type="primary" size="small" onClick={() => accept(notice)}>
                  记住
                </Button>
                <Button size="small" onClick={() => reject(notice)}>
                  忽略
                </Button>
              </>
            )}
            {/* 纯关闭（不改记忆）：AUTO 想保留记忆只收起提示、偏好卡想这次不作答时用它 */}
            <Button
              type="text"
              size="small"
              aria-label="关闭提示"
              title="关闭提示"
              style={{ padding: 0, flexShrink: 0 }}
              onClick={() => dismiss(notice)}
            >
              <CloseOutlined />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
