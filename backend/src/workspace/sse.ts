/**
 * 工作区 SSE 帧序列化（P1-9 · P3）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §六 2（前端订阅 `GET .../workspace/events` 实时刷新）。
 *
 * ⚠️ **不复用 `orchestrator/sse.ts#serializeSseFrame`**：那只接受 `shared#SseEvent`（chat 流的事件
 * 全集，判别联合）—— 工作区事件是**另一条 channel**（另一个端点），硬塞进 chat 的事件全集会污染
 * 那份契约（`02` §5.1）。这里只复用它的**头**（`SSE_RESPONSE_HEADERS`）与**格式约定**
 * （`event:` + `data:` 两行、结尾 `\n\n`、正文单行）。
 *
 * `JSON.stringify` 的输出不含裸换行（换行被转义）⇒ 正文恒为单行，符合 SSE 的硬要求。
 */
export const WORKSPACE_SSE_EVENT_NAME = 'workspace'

export function serializeWorkspaceSseEvent(event: unknown): string {
  return `event: ${WORKSPACE_SSE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`
}