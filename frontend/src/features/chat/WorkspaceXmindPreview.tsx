/**
 * Code 模式工作区里的 XMind 预览（2026-11-20）。
 *
 * 与产物预览 / Skill 详情页**同一个组件**（`components/XmindOutline`），这里只负责
 * "按当前会话 + 路径取回大纲 JSON"：`GET /api/conversations/:id/workspace/file/outline?path=`。
 *
 * ⚠️ 不复用 `<iframe>` 那一路：xmind 的大纲是**结构化数据**（服务端只解包），
 * 交给 `XmindOutlinePreview` 画"左树 + 右阅读区"；iframe 只能承载 HTML（docx / xlsx 那两条）。
 */

import { useEffect, useState } from 'react'

import type { XmindOutline } from '@doubulea/shared'

import { describeError } from '../../api/client.js'
import { fetchWorkspaceOutline } from '../../api/workspace.js'
import { XmindOutlinePreview } from '../../components/XmindOutline/XmindOutlinePreview.js'

type State = { phase: 'idle' } | { phase: 'ready'; data: XmindOutline | undefined; error: string | null }

export function WorkspaceXmindPreview({ conversationId, path }: { conversationId: string; path: string }) {
  const [state, setState] = useState<State>({ phase: 'idle' })

  useEffect(() => {
    const controller = new AbortController()
    setState({ phase: 'idle' })
    void (async () => {
      try {
        const outline = await fetchWorkspaceOutline(conversationId, path, { signal: controller.signal })
        setState({ phase: 'ready', data: outline, error: null })
      } catch (error) {
        if (controller.signal.aborted) return
        // 失败也要说得出原因，而不是留一片空白
        setState({ phase: 'ready', data: undefined, error: describeError(error).message })
      }
    })()
    return () => controller.abort()
  }, [conversationId, path])

  return (
    <XmindOutlinePreview
      outline={state.phase === 'ready' ? state.data : undefined}
      error={state.phase === 'ready' ? state.error : null}
    />
  )
}
