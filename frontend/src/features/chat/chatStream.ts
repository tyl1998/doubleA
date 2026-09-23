/**
 * 对话事件流的读取与分发（P0-1-32）
 *
 * 依据：`docs/03-前端设计.md` §一（fetch + ReadableStream 自实现）、§六（"SSE 状态集中在
 *      `useChatStream`（fetch 流解析 → store 分发），页面组件只读 store"）、
 *      `shared/src/sse.ts`（事件全集）、`orchestrator/sse.ts`（对侧的序列化）。
 *
 * 这一层只做"**把字节变成事件**"，不含任何业务/React/store 逻辑 —— 于是它可以被
 * `frontend/scripts/verify-chat-sse.mjs` 用**真 `Response`**（手搓一个 ReadableStream）
 * 直接验，不必起浏览器。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两个必须写对的细节
 * ─────────────────────────────────────────────────────────────────────
 * ① **解码必须用 `{ stream: true }`**：一个汉字 3 字节，会被 TCP 切在两段之间。
 *    非流式 `decode(bytes)` 会在边界产出替换字符（`\uFFFD`）⇒ JSON 解析失败 ⇒ 症状是
 *    "回答偶尔断掉"，看起来像后端的锅。流结束时补一次 `decode()`（无参）把残留吐出来。
 * ② **帧边界由解析器负责，不由 chunk 负责**：见 `sseParser.ts` 的文件头。这里只负责
 *    "把每个 chunk 交给解析器、把完整帧交给调用方"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么返回值里有 `terminated` / `pending`（而不是 void）
 * ─────────────────────────────────────────────────────────────────────
 * 流"自然结束"与"被截断"在浏览器里**看起来一样**（都是 `reader.read()` 返回 done）——
 * 区别只有一个：**有没有收到过 `done`/`error` 终结帧**（`shared/src/sse.ts` 文件头 ③：
 * 一条流以 `done` 或 `error` 结尾，二选一、各一次）。没有终结帧就结束，只能是
 * 服务端崩了 / 代理断了 / 网络断了 ⇒ 上层必须让用户看到（P0-1-33 的断线黄条），
 * 而不是安静地把半条回答当作完整回答。
 */

import type { SseEvent } from '@doubulea/shared'

import { SseFrameParser, parseSseFrame, type SseParseOutcome } from './sseParser.js'

/** 解析过程中的异常信号（形状不对 / 不认识的事件名）—— 由调用方决定记日志还是忽略 */
export interface SseStreamIssue {
  kind: 'unknown' | 'invalid'
  name: string
  detail: string
}

/**
 * 把解析异常写到控制台（`onIssue` 的默认实现）。
 *
 * ⚠️ 为什么这里可以出现 `console`：本仓的 `no-console` 规则针对的是**后端**
 * （"业务代码里出现 console 通常意味着漏了 `getLogger()`"，`eslint.config.mjs` 的原话），
 * 而**前端没有日志框架**、也就没有 `getLogger()` 可用；这条信息只在开发期排查
 * "前后端事件契约漂了"时有价值（正常路径上一条都不会出现）。
 * 处置方式与 P0-1-21 把"故意的控制字符"写成 `isPrintable()` 同款：**显式豁免 + 就地说明**，
 * 而不是让规则失效或让这条线索消失。
 */
export function reportSseIssue(issue: SseStreamIssue): void {
  // eslint-disable-next-line no-console -- 见上方说明：前端没有日志框架，且这条只在开发期有用
  console.warn(`[chat] ${issue.kind} 事件被忽略：${issue.name} —— ${issue.detail}`)
}

export interface ReadChatStreamHandlers {
  /** 每个**合法**事件（含 `ping`，忽略与否是分派层的事） */
  onEvent: (event: SseEvent) => void
  /** 解析异常（默认只 `console.warn`：它不该打断这一轮流） */
  onIssue?: (issue: SseStreamIssue) => void
}

export interface ReadChatStreamResult {
  /** 是否收到过终结事件（`done` / `error`）。`false` = 这一轮**没有正常收口** */
  terminated: boolean
  /** 被丢弃的半帧原文（非空 = 流在帧中间被截断；只用于日志） */
  pending: string
  /** 合法事件数（含 `ping`） */
  events: number
}

/**
 * 读完一条事件流并逐帧分派。
 *
 * **不在这里**判断 `ping` / `done` / `error` 的语义（那是 store 的事）—— 它只把事件交出去。
 * 三种收尾路径都要如实报告：见 {@link ReadChatStreamResult}。
 */
export async function readChatEventStream(
  response: Response,
  handlers: ReadChatStreamHandlers,
): Promise<ReadChatStreamResult> {
  const body = response.body
  if (body === null) {
    return { terminated: false, pending: '', events: 0 }
  }

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = new SseFrameParser()
  let terminated = false
  let events = 0

  const dispatch = (outcome: SseParseOutcome): void => {
    if (outcome.kind === 'empty') return
    if (outcome.kind === 'event') {
      events += 1
      if (outcome.event.name === 'done' || outcome.event.name === 'error') terminated = true
      handlers.onEvent(outcome.event)
      return
    }
    handlers.onIssue?.({
      kind: outcome.kind,
      name: outcome.name,
      detail: outcome.kind === 'invalid' ? outcome.detail : '不认识的事件名（已忽略）',
    })
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // ⚠️ `{ stream: true }`：见文件头 ①。少了它，中文增量会在 chunk 边界变成替换字符
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      dispatch(parseSseFrame(frame))
    }
  }

  // 收尾：先把解码器残留吐出来（不完整的多字节序列），再 flush 解析器
  const tail = decoder.decode()
  if (tail !== '') {
    for (const frame of parser.push(tail)) dispatch(parseSseFrame(frame))
  }
  for (const frame of parser.flush()) dispatch(parseSseFrame(frame))

  return { terminated, pending: parser.pending, events }
}
