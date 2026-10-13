/**
 * CodeMirror 6 编辑器（P1-9 · R7）
 *
 * 依据：`子方案/Code模式工作区.md` §十（"文件树 + 多标签 + CodeMirror 6"、保存 / ⌘S）、
 *      `06` §五·补 P1-9 · R7（编辑器由原生 `<textarea>` 升级为 CodeMirror 6）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 边界
 * ─────────────────────────────────────────────────────────────────────
 *   · **只做编辑器壳**：值 / 只读 / 语言由 props 驱动；保存、CAS、冲突、SSE 刷新仍归
 *     {@link WorkspacePanel}（本组件不碰网络与大模型）；
 *   · **受控但非每键重挂**：`EditorView` 只在挂载时建一次，外部 `value` 变化经 compartment
 *     外的 doc 对比后 `dispatch` 替换；语言 / 只读走 `Compartment` 热切换（不重建视图、不丢光标）；
 *   · **语言映射是纯函数**（`workspaceModel.ts#workspaceEditorLanguage`）：本组件只把语言 id
 *     绑到具体语言包，故 `workspaceModel.ts` 依旧零 CodeMirror 依赖、`verify:workspace-ui` 无依赖可跑。
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { useEffect, useRef } from 'react'

import type { WorkspaceEditorLanguage } from './workspaceModel.js'

/** 语言 id → 语言包（`'text'` = 不高亮）。**唯一**的 CodeMirror 语言绑定点。 */
function languageExtensions(language: WorkspaceEditorLanguage): Extension {
  switch (language) {
    case 'javascript':
      return javascript()
    case 'typescript':
      return javascript({ typescript: true, jsx: true })
    case 'json':
      return json()
    case 'html':
      return html()
    case 'css':
      return css()
    case 'python':
      return python()
    case 'markdown':
      return markdown()
    case 'text':
      return []
  }
}

/** 编辑器主题（浅色，配 antd 默认；等宽字体；撑满父容器）。 */
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'auto' },
  '.cm-content': { minHeight: '160px' },
  '&.cm-focused': { outline: 'none' },
})

export function CodeMirrorEditor(props: {
  value: string
  language: WorkspaceEditorLanguage
  readOnly?: boolean
  onChange: (value: string) => void
  /** ⌘S / Ctrl+S（`子方案` §十"保存 / ⌘S"）；不给则不拦截默认快捷键 */
  onSave?: () => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())

  // 回调经 ref 转交：`EditorView` 建成后不再重建，闭包必须永远读到**最新**的 props
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const onSaveRef = useRef(props.onSave)
  onSaveRef.current = props.onSave

  const readOnly = props.readOnly ?? false

  // ── 建视图（只一次）──
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorState.allowMultipleSelections.of(true),
          EditorView.lineWrapping,
          editorTheme,
          languageCompartment.current.of([]),
          readOnlyCompartment.current.of([]),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current?.()
                return true
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 只在挂载时建一次：后续变化走下面两个 effect（`props.value` 首帧已 ingest）
  }, [])

  // ── 外部 value 变化（切文件 / 重载 / 撤销后回填）⇒ 整篇替换（相同则不动，避免丢光标）──
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current === props.value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } })
  }, [props.value])

  // ── 语言热切换（compartment，不重建视图）──
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartment.current.reconfigure(languageExtensions(props.language)),
    })
  }, [props.language])

  // ── 只读热切换 ──
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
    })
  }, [readOnly])

  return <div ref={hostRef} data-testid="workspace-editor" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
}
