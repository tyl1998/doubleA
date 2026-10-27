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
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state'
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

import { useUiStore } from '../../stores/ui.js'
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

/** 编辑器布局主题（等宽字体；撑满父容器）。配色见 {@link colorModeExtension}。 */
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'auto' },
  '.cm-content': { minHeight: '160px' },
  '&.cm-focused': { outline: 'none' },
})

/**
 * 编辑器配色的**唯一**落点（行号栏 / 当前行）。**只有一份**：值全读 CSS 变量，两种主题自然各取各的
 * （`EditorView.theme` 每调用一次就生成一个新 class 并注入一个 style 模块 —— 按模式各建一份会让
 * 每次切主题都多挂一个模块，故这里提到模块级，切主题只切 `darkTheme` 门面）。
 *
 * ⚠️ **为什么写在这里而不是 `styles/app.css`**：CodeMirror 的 `baseTheme` 是**运行时注入
 * `<head>`** 的，里面把 `.cm-gutters` 写死成 `#f5f5f5` 底 + `#6c6c6c` 字、`.cm-activeLineGutter`
 * 写死成 `#e2f2ff`。静态样式表与它**同特异度**，谁后注入谁赢（CM 注入晚）⇒ 写在 app.css 里会被
 * 它盖掉；`EditorView.theme` 的角色样式排在 baseTheme **之后**（后者包了 `Prec.lowest`），才真能覆盖。
 *
 * 此前行号栏固定是 baseTheme 的浅色底，切暗色后编辑器黑了、它还是白的一条
 * （用户反馈 2026-10-26「行号一片白，很刺眼」）。走令牌后两种主题各自对齐。
 */
const editorTokenTheme = EditorView.theme({
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--muted-2)',
    borderRight: '1px solid var(--rule)',
  },
  // 当前行的行号：比普通行号重一档，但仍用底色而不是硬编码的浅蓝
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-3)', color: 'var(--ink-2)' },
  // 当前行的行底：与站内其它「当前行」同款强调淡底（`.node-step.is-active`）
  '.cm-activeLine': { backgroundColor: 'var(--accent-wash)' },
})

/**
 * 配色模式 → 扩展：`darkTheme` 门面决定 baseTheme 走 `&light` 还是 `&dark` 分支
 * （光标 / 选区 / 搜索面板这些**写死在 baseTheme 里**的部件跟着变），令牌主题负责行号栏与当前行。
 */
function colorModeExtension(mode: 'light' | 'dark'): Extension {
  return [EditorView.darkTheme.of(mode === 'dark'), editorTokenTheme]
}

export function CodeMirrorEditor(props: {
  value: string
  language: WorkspaceEditorLanguage
  /**
   * 当前文档的**身份**（工作区里就是文件路径）。
   *
   * ⚠️ 唯一用途：切换文档时**清空撤销历史**。外部替换（切文件 / 重新加载 / SSE 回填）走的是
   * `dispatch({changes})`，若不禁用历史，撤销栈会**跨文件**累积 —— 实测切到 B 后按 ⌘Z 会退回
   * A 的整篇内容（轻则内存被 N 份整篇文档撑大，重则把 A 的内容当 B 保存）。
   */
  docKey?: string
  readOnly?: boolean
  onChange: (value: string) => void
  /** ⌘S / Ctrl+S（`子方案` §十"保存 / ⌘S"）；不给则不拦截默认快捷键 */
  onSave?: () => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  /** 撤销历史的 compartment：切文档时重配一次即可**清空**（见文件头） */
  const historyCompartment = useRef(new Compartment())
  /** 外部替换文档期间置位：抑制 `updateListener` 把这次替换当成"用户编辑"回吐给 `onChange` */
  const suppressChangeRef = useRef(false)

  // 回调经 ref 转交：`EditorView` 建成后不再重建，闭包必须永远读到**最新**的 props
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const onSaveRef = useRef(props.onSave)
  onSaveRef.current = props.onSave

  const readOnly = props.readOnly ?? false
  /**
   * 配色模式：编辑器**必须**跟着站内主题走。
   *
   * CodeMirror 有一个 `darkTheme` 门面：不打开时它永远用 `baseTheme` 的 **light** 分支 ——
   * 光标是黑的、选区是浅灰、搜索面板是 `#f5f5f5`、行号栏是 `#f5f5f5`。站内切到暗色后，
   * `.ws__editor` 的底色来自令牌（变黑），于是这些写死的浅色就成了黑底上的一块白
   * （用户 2026-10-26 反馈的"行号一片白、很刺眼"就是它）。
   *
   * 用 `Compartment` 热切换（同 language / readOnly）：切主题不重建视图、不丢光标与滚动位置。
   */
  const themeMode = useUiStore((state) => state.themeMode)
  const colorModeCompartment = useRef(new Compartment())

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
          historyCompartment.current.of(history()),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorState.allowMultipleSelections.of(true),
          EditorView.lineWrapping,
          editorTheme,
          colorModeCompartment.current.of(colorModeExtension(themeMode)),
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
            if (update.docChanged && !suppressChangeRef.current) onChangeRef.current(update.state.doc.toString())
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
  //   ⚠️ `addToHistory: false`：外部替换**不进撤销栈**（否则撤销栈跨文件累积，⌘Z 会退回别的文件）
  //   ⚠️ 期间抑制 `onChange`：这次替换不是"用户编辑"，别回吐给调用方（会白标 dirty / 白写草稿）
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current === props.value) return
    suppressChangeRef.current = true
    view.dispatch({
      changes: { from: 0, to: current.length, insert: props.value },
      annotations: Transaction.addToHistory.of(false),
    })
    suppressChangeRef.current = false
  }, [props.value])

  // ── 切文档（`docKey` 变化）⇒ 清空撤销历史（重配 history compartment 即重置其 state field）──
  useEffect(() => {
    viewRef.current?.dispatch({ effects: historyCompartment.current.reconfigure(history()) })
  }, [props.docKey])

  // ── 语言热切换（compartment，不重建视图）──
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartment.current.reconfigure(languageExtensions(props.language)),
    })
  }, [props.language])

  // ── 主题热切换（compartment，不重建视图 ⇒ 切主题不丢光标与滚动位置）──
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: colorModeCompartment.current.reconfigure(colorModeExtension(themeMode)),
    })
  }, [themeMode])

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
