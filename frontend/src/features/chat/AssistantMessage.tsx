/**
 * 助手消息（P0-1-32）
 *
 * `docs/03` §4.1 的消息流渲染规则表里，助手那一条消息由**五块**按到达顺序拼成：
 * 思考块 → 工具卡（可多张）→ 正文 Markdown → 引用卡 → 产物卡，末尾是收尾信息。
 * 这个顺序**不是排版偏好**：它就是 SSE 事件在一条流里的自然顺序
 * （`orchestrator/chatBot.ts` 先 thinking、再 tool_call、再 delta、`citations` 在检索阶段、
 * `artifact` 在沙箱阶段），而 `03` §五 要求"事件即真相"——界面按事件顺序生长，
 * 刷新后按同一套组件重画。**两种来源的长相必须一致**，这一点由
 * `messageModel.ts#messageToView` 与 `roundReducer.ts#roundToViews` 共同保证。
 *
 * ⚠️ 收尾信息（`done · COMPLETE · tokens …`）**只说真实存在的东西**：
 *   · `usage` 可能为 `null`（上游不给）⇒ 那一行不出现，而不是显示 `tokens 0 in / 0 out`；
 *   · 没有"用时"字段（`done` 事件里没有耗时，原型的 `12.4s` 来自演示数据）⇒ **不显示**；
 *   · `messageId === null`（这一轮没有可持久化的消息，`shared/src/sse.ts` 文件头 ④）
 *     ⇒ **显式说出来**，否则用户会在刷新后觉得"我刚才的回答丢了"。
 *
 * ⚠️ 「复制全文」按 `03` §4.1 用 `navigator.clipboard`（localhost 是安全上下文，开发期可用）。
 * 失败时不静默：复制不到就得告诉用户（他要的是那段文字，而不是"我点了按钮"）。
 */

import { memo, useEffect, useState } from 'react'
import type { ConversationRunOrigin } from '@doubulea/shared'

import { useFeedback } from '../../app/feedback.js'
import { ArtifactCard } from './ArtifactCard.js'
import { AssistantMarkdown } from './AssistantMarkdown.js'
import { CitationCard } from './CitationCard.js'
import { ErrorCard } from './ErrorCard.js'
import { isAssistantEmpty, type ChatMessageView } from './messageModel.js'

export interface AssistantMessageProps {
  view: ChatMessageView
  /** 头部显示的名字（`03` §4.1 的 `msg__head`） */
  agentName: string
  /**
   * 「重新生成」（P1-3）。**只在最新一轮的助手消息上给**（判据在页面：这一条是历史里最后
   * 一条助手回答，且当前没有流在跑）—— 传 `undefined` 表示这一条不显示该按钮。
   *
   * 需求："重跑最后一轮用户消息，替换原回答"。按钮挂在这条**回答**上，因为被替换的正是它。
   */
  onRegenerate?: (() => void) | undefined
  /**
   * 服务端侧仍在生成（2026-10-21）：本页**没有**这一轮的事件流（切走再切回 / 刷新后进入 /
   * 在别的窗口发起），所以只能如实说"还在生成"，**不编造**正文与工具进度。
   * 与 `view.status === 'streaming'` 互斥（流式时本页画得出来，不必走这一条）。
   */
  serverRunning?: boolean
  /** 服务端那条流的开始时刻（ISO；`null`/缺省 ⇒ 只显示"正在生成"，不算已用时） */
  serverStartedAt?: string | null
  /**
   * 这一轮**是谁发起的**（2026-10-22；`/active.startedBy`）：定时任务 / 外部 Open API 调用 /
   * 另一个窗口。这一行是用户唯一能看到"它从哪来"的地方，**不许**再写死成定时任务。
   */
  serverRunOrigin?: ConversationRunOrigin | null
}

/** token 用量 → 一行文案；两个数各自可空（`usage.tokensIn` 是 `number | null`） */
function usageText(usage: ChatMessageView['usage']): string | null {
  if (usage === null || usage === undefined) return null
  const input = usage.tokensIn === null ? '—' : String(usage.tokensIn)
  const output = usage.tokensOut === null ? '—' : String(usage.tokensOut)
  return `tokens ${input} in / ${output} out`
}

/**
 * 收尾行要说的那句话（`03` §五 的 `done` 行："结束流；`finishReason=STOPPED` 标注「已停止」
 * （COMPLETE 为正常结束）"）。返回 `null` = 这一行不出现。
 */
function footerText(view: ChatMessageView): string | null {
  if (view.status === 'streaming') return null
  // 失败由错误卡承担（它就在同一个 `<article>` 里），这里再来一句是重复
  if (view.status === 'error') return null

  const usage = usageText(view.usage)
  if (view.status === 'stopped') {
    return ['已停止 · 已生成的内容保留', usage].filter((part) => part !== null).join(' · ')
  }
  return ['已完成', usage].filter((part) => part !== null).join(' · ')
}

/** 头部状态灯：在写 = 脉冲；收尾后按结果给颜色（与 `led--*` 同一套语义） */
function headLedClass(view: ChatMessageView): string {
  if (view.status === 'streaming') return 'led led--run'
  if (view.status === 'error') return 'led led--fail'
  if (view.status === 'stopped') return 'led led--idle'
  return 'led led--ok'
}

/**
 * ⚠️ `memo`（内存优化 P2，`docs/子方案/前端长会话内存优化.md`）：流式期间父组件（`MessageList`）
 * 每一帧 `delta` 都重渲染一次，而**历史消息的 `view` 引用是稳定的**（`ChatPage` 的
 * `messagesToViews` 结果按 `messagesQuery.data` 缓存）⇒ memo 让它们整块跳过。
 * 没有它时，一轮回答流几分钟 = 历史上每一条助手消息都跟着重走一遍元素树（含 `react-markdown`）。
 *
 * 前提（写在这里以免被改坏）：`ChatPage` 传下来的回调必须引用稳定，否则 memo 会被击穿。
 */
export const AssistantMessage = memo(function AssistantMessage({
  view,
  agentName,
  onRegenerate,
  serverRunning = false,
  serverStartedAt = null,
  serverRunOrigin = null,
}: AssistantMessageProps) {
  const feedback = useFeedback()
  const [copying, setCopying] = useState(false)

  const empty = isAssistantEmpty(view)
  const footer = footerText(view)

  const copyAll = async (): Promise<void> => {
    if (view.text === '') return
    setCopying(true)
    try {
      await navigator.clipboard.writeText(view.text)
      feedback.ok('已复制全文')
    } catch (error) {
      // 复制失败不静默（见文件头）：用户要的是那段文字，不是"点了按钮"
      feedback.fail(error, '复制失败')
    } finally {
      setCopying(false)
    }
  }

  return (
    <article className="msg msg--agent" data-testid="assistant-message">
      <p className="msg__head">
        <span className={headLedClass(view)} aria-hidden="true" />
        {agentName}
      </p>

      {empty ? (
        <p className="ratio" data-testid="assistant-placeholder">
          {view.status === 'streaming' ? (
            // 流式但**一个字都还没到**：**只留打字光标**。生命周期文案（`status` 事件）已由本轮末尾的
            // `StreamingStatusLine`（"模型正在思考… · 已用时 Ns"）呈现 —— 这里再写一句"正在等待上游响应…"
            // 就是**两条提示叠一起**，用户看起来像两件事（产品反馈题 3：只保留那一条）。
            <span className="caret" aria-hidden="true" />
          ) : view.status === 'stopped' ? (
            '已停止：本轮没有产生内容'
          ) : (
            '本轮没有产生内容'
          )}
        </p>
      ) : (
        <>
          {view.text !== '' || view.tools.length > 0 || view.thinkingSegments.length > 0 ? (
            // 思考段与工具卡**一起**交给 markdown：二者在内联时间线上按 (offset, seq) 排
            // （2026-10-21 —— 用户报"思考 B 跑到了工具卡前面"，根因是思考原先整块堆在正文上方）。
            // 只有**最后一段**带 streaming（它才是此刻还在长的那个；前面的段落已完成、自动折叠）。
            <AssistantMarkdown
              text={view.text}
              tools={view.tools}
              thinkingSegments={view.thinkingSegments}
              {...(view.status === 'streaming'
                ? { streamingThinkingIndex: view.thinkingSegments.length - 1 }
                : {})}
            />
          ) : null}
          {view.status === 'streaming' ? (
            // 流式光标：`design/styles/components.css` 的 `.caret`（块状、闪烁，暗示"打字机"）
            <span className="caret" aria-hidden="true" />
          ) : null}
        </>
      )}

      {/* 引用卡：`null` = 本轮没有引用 ⇒ 整块不渲染（未命中知识库时后端不发 citations 事件） */}
      {view.citations === null ? null : <CitationCard items={view.citations} />}

      {view.artifacts.map((artifact) => (
        <ArtifactCard key={artifact.artifactId} artifact={artifact} />
      ))}

      {/* 流式进度行：`statusText` + 已用时。比"只在空内容时给占位"更早、更持久 ——
          工具参数生成期（可 20s+）里没有任何正文事件，这一行是唯一在动的东西。
          ⚠️ 位置在**本轮的末尾**（正文 / 工具卡 / 引用 / 产物之后，用户反馈 2026-10-21）：
              放在开头时，回答一长就把这一行顶出视口，"正在生成 / 已用时 50s"用户看不到；
              贴底则始终可见（流式期间视口也是贴底跟随的，见 `ChatPage` 的 `pinnedRef`）。 */}
      {view.status === 'streaming' ? (
        <StreamingStatusLine statusText={view.statusText} startedAt={view.startedAt} />
      ) : null}

      {/* 服务端侧仍在生成（本页没有这一轮的事件流）—— 同上，贴在本轮末尾，最先被看到。
          只说"还在跑"，不编造正文 / 工具进度（那些帧没有经过本页）。 */}
      {serverRunning && view.status !== 'streaming' ? (
        <p className="msg__streaming ratio" data-testid="server-streaming-status">
          {serverRunStatusText(serverRunOrigin)}
          <ServerElapsed startedAt={serverStartedAt} />
        </p>
      ) : null}

      {view.status === 'error' && view.error !== undefined ? (
        <ErrorCard code={view.error.code} message={view.error.message} />
      ) : null}

      {footer === null ? null : (
        <p className="ratio num" data-testid="assistant-footer">
          {footer}
          {view.persisted === false ? ' · 本轮没有可保存的内容（刷新后不会出现在历史里）' : ''}
        </p>
      )}

      <div className="msg__tools">
        <button
          type="button"
          onClick={() => {
            void copyAll()
          }}
          disabled={copying || view.text === ''}
        >
          复制全文
        </button>
        {/* 重新生成（P1-3）：只挂在最新一轮的回答上（判据在页面）。流式中不提供
            （页面在"有流在跑"时根本不会传这个回调）⇒ 不会出现"点了两次"的入口。 */}
        {onRegenerate === undefined ? null : (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={view.status === 'streaming'}
            title="重跑这一轮的问题，用新的回答替换当前回答"
          >
            重新生成
          </button>
        )}
      </div>
    </article>
  )
})

/**
 * 尾部那句"服务端还在跑"的**来源**（2026-10-22）：文案必须与真正发起方一致。
 *
 * 为什么不能只写"服务端仍在生成这一轮"：用户看到一条不断变长的回答却不知道是谁在跑 ——
 * 而最常见的两种情形（定时任务、外部 Open API 调用）**本页都停不掉**，说清楚比含糊更好。
 * `null`（旧后端 / 值坏）= 来源不明，用中性措辞，**不猜**。
 */
function serverRunStatusText(origin: ConversationRunOrigin | null): string {
  switch (origin) {
    case 'SCHEDULED':
      return '定时任务正在后台运行这一轮'
    case 'OPEN_API':
      return '外部调用正在生成这一轮'
    case 'UI':
      return '另一个窗口正在生成这一轮'
    default:
      return '服务端仍在生成这一轮'
  }
}

/**
 * 流式进度行：`statusText`（后端 `status` 事件：模型在思考 / 根据工具结果继续…）+ 秒级计时器。
 *
 * 只在**流式中**渲染。为什么单独一行而不是并进占位：占位只在"一个字都还没有"时出现，而真正
 * 安静的是**工具参数生成期**（正文/思考已经出现过、参数还在流，可能 20s+）—— 那时占位早就不在了。
 * 这一行在整段流式期间都在，且每秒自增，是"还在动"最直接的证据。
 *
 * ⚠️ 它渲染在**本轮末尾**（不是开头）：开头那一个位置会被长回答顶出视口，用户就看不到"还在生成"。
 * 与末尾那条流式光标同处一屏，读起来是"内容 + 此刻状态"。
 */
const StreamingStatusLine = memo(function StreamingStatusLine({
  statusText,
  startedAt,
}: {
  statusText?: string
  startedAt?: string
}) {
  return (
    <p className="msg__streaming ratio" data-testid="streaming-status">
      {statusText ?? '正在生成…'}
      <Elapsed startedAt={startedAt} />
    </p>
  )
})

/**
 * 「 · 已用时 Ns」（每秒自增）。`startedAt` 缺省 / 不是合法时刻 ⇒ 什么都不显示
 * （**不知道就不说**：编一个 0s 会让用户以为刚发出）。
 */
function Elapsed({ startedAt }: { startedAt?: string | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const start = startedAt === undefined || startedAt === null ? Number.NaN : Date.parse(startedAt)
  if (Number.isNaN(start)) return null
  return <>{` · 已用时 ${Math.max(0, Math.floor((now - start) / 1000))}s`}</>
}

/**
 * 服务端侧那条流的已用时（`/active.startedAt`）。没有开始时刻 ⇒ 不显示
 * （见 {@link Elapsed}：不知道就不说）。
 */
function ServerElapsed({ startedAt }: { startedAt?: string | null }) {
  return <Elapsed startedAt={startedAt} />
}
