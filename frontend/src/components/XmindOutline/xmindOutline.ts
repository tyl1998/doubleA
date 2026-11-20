/**
 * XMind 大纲的**零依赖纯逻辑**（2026-11-20）—— 左树 + 右阅读区 / 用例视图的判据都集中在这里
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件**不 import React、不发请求、不读 DOM**
 * ─────────────────────────────────────────────────────────────────────
 * 与 `artifactPreview.ts` 同款理由：它要能被 `frontend/scripts/verify-xmind-outline.mjs` 用
 * `node --import tsx` **直跑源码**断言（不占端口、不连后端、不经 vite）。
 * 这里最容易写错、又最难在界面上看出来的是两类：**「哪个节点算用例」的判据**与
 * **「步骤 → 预期结果」的配对**（配对错了界面照样渲染，只是内容张冠李戴）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 两层判据，互不排斥
 * ─────────────────────────────────────────────────────────────────────
 *   ① 名字判据 `isCaseHeading`：标题以 `tc-` / `TC-XXX` 开头（XMind 用例模板的常见写法）；
 *   ② 结构判据 `looksLikeCase`：子节点里出现 `操作步骤N` / `步骤N` / `预期结果N` / `pc:` / `前置条件`。
 * 只认 ① 会漏掉 `PC-01: …` 这种同样有步骤、却没有 `tc-` 前缀的写法 —— 用户 2026-11-20 明确提过。
 * 两者都只是**默认视图**的建议：界面上永远可以手动切「用例视图 / 整体视图」。
 */

import type { XmindOutlineNode } from '@doubulea/shared'

/** 用例标题 → `{ id, name }`：`tc-P1: [APP][EC-MOD]S4 券…` ⇒ `P1` / `[APP][EC-MOD]S4 券…` */
export interface CaseHeading {
  /** 优先级 / 编号（`P0` / `P1` / `DY-3`…）；拆不出时为空串 */
  id: string
  /** 标题正文（去掉 `tc-XXX:` 前缀） */
  name: string
}

/**
 * 名字判据：`tc-…`、`TC-…`、`TC-DY-3 …` 都算用例标题。
 *
 * ⚠️ 只看**首行**：XMind 的标题常带多行正文（`tc-P1: …\n操作说明…`），
 * 判据不该被第二行内容影响。
 */
export function isCaseHeading(title: string): boolean {
  const head = firstLineOf(title)
  return /^tc-/iu.test(head) || /^tc-[a-z0-9]+/iu.test(head)
}

/** 把用例标题拆成 `{ id, name }`（拆不出时 `id` 为空、`name` 取原文） */
export function splitCaseHeading(title: string): CaseHeading {
  const head = firstLineOf(title)
  const match = /^tc-([^:：\s]+)\s*[:：]?\s*(.*)$/iu.exec(head)
  if (match === null) return { id: '', name: head }
  return { id: (match[1] ?? '').toUpperCase(), name: match[2] ?? '' }
}

/** 节点正文（标题里**第一行之后**的部分：XMind 把多行正文直接存在 `title` 里） */
export function firstLineOf(title: string): string {
  const index = title.indexOf('\n')
  return index === -1 ? title.trim() : title.slice(0, index).trim()
}

/** 节点正文（第一行之后的全部内容；没有则空串） */
export function bodyOf(title: string): string {
  const index = title.indexOf('\n')
  return index === -1 ? '' : title.slice(index + 1).trim()
}

/**
 * 结构判据：一个节点的**直接子节点**是否像"步骤 / 预期 / 前置"。
 *
 * 命中任一即认为这是一张用例 —— 这样 `PC-01: …`、`退款场景: …` 这类没有 `tc-` 前缀的写法
 * 也能默认进用例视图（用户 2026-11-20 的反馈）。
 */
export function looksLikeCase(node: XmindOutlineNode): boolean {
  if (isCaseHeading(node.title)) return true
  return node.children.some((child) => {
    const kind = sectionKindOf(child.title)
    return kind === 'step' || kind === 'expect' || kind === 'pc'
  })
}

/** 子节点归到哪一节（用例视图的排版依据） */
export type CaseSectionKind = 'pc' | 'step' | 'expect' | 'log' | 'other'

/** 按首行前缀归类：`操作步骤3: …` ⇒ `step`；`pc: …` ⇒ `pc`；`查看日志关注` ⇒ `log` */
export function sectionKindOf(title: string): CaseSectionKind {
  const head = firstLineOf(title).toLowerCase()
  if (head.startsWith('pc') === true && /^pc\s*[:：]?/u.test(head)) return 'pc'
  if (/^(操作步骤|步骤)\s*\d*/u.test(head)) return 'step'
  if (/^预期结果/u.test(head)) return 'expect'
  if (/日志/u.test(head)) return 'log'
  return 'other'
}

/** `前缀: 正文` 拆开（正文里的换行**保留** —— DB 断言都是多行的） */
export function splitPrefix(title: string): { prefix: string; body: string } {
  const head = firstLineOf(title)
  const rest = bodyOf(title)
  const colon = head.search(/[:：]/u)
  if (colon === -1) return { prefix: '', body: title.trim() }
  const prefix = head.slice(0, colon).trim()
  const tail = head.slice(colon + 1).trim()
  return { prefix, body: rest === '' ? tail : `${tail}\n${rest}` }
}

/** 用例视图里的一个步骤（含它的预期结果） */
export interface CaseStep {
  /** 步骤序号（`操作步骤3` 的 `3`）；拆不出时 `null`，由界面按顺序显示 */
  index: number | null
  /** 步骤正文（去掉 `操作步骤N:` 前缀，保留多行） */
  text: string
  /** 这一步的预期结果（子节点，通常一条） */
  expected: { label: string; text: string }[]
}

/** 用例视图的完整数据（**一次摊平**，不用逐层点开） */
export interface CaseView {
  id: string
  name: string
  /** `pc:` / `前置条件` 拆成行的列表（去掉行内 `1.` `2.` 编号） */
  precondition: string[]
  steps: CaseStep[]
  /** `查看日志关注` 等 */
  logs: string[]
  /** 认不出的子节点（原样保留，不丢信息） */
  others: string[]
}

/** 前置条件按行拆（去掉行内编号 `1.` `2.`，空行丢弃） */
function preconditionLines(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*\d+[.、)]\s*/u, '').trim())
    .filter((line) => line !== '')
}

/**
 * 一个用例节点 → {@link CaseView}。
 *
 * 三条配对规则（B 组断言逐条对应）：
 *   · `操作步骤N` 的**子节点**是它的预期结果（结构上一对一，`预期结果N` 标题里的 N 不参与配对）；
 *   · `预期结果` 与步骤**平级**出现时挂到**上一个**步骤（仍有少数用例这么写，丢掉就少一条断言）；
 *   · 一个步骤都没有时，`预期结果` 落到 `others`（不丢、不误导）。
 */
export function buildCaseView(node: XmindOutlineNode): CaseView {
  const heading = splitCaseHeading(node.title)
  const view: CaseView = { id: heading.id, name: heading.name, precondition: [], steps: [], logs: [], others: [] }

  for (const child of node.children) {
    const kind = sectionKindOf(child.title)
    const { prefix, body } = splitPrefix(child.title)
    if (kind === 'pc') {
      view.precondition.push(...preconditionLines(body))
      continue
    }
    if (kind === 'step') {
      const digit = /\d+/u.exec(prefix)
      view.steps.push({
        index: digit === null ? null : Number.parseInt(digit[0], 10),
        text: body,
        expected: child.children.map((grand) => {
          const parsed = splitPrefix(grand.title)
          return { label: parsed.prefix === '' ? '预期结果' : parsed.prefix, text: parsed.body }
        }),
      })
      continue
    }
    if (kind === 'expect') {
      const last = view.steps[view.steps.length - 1]
      if (last === undefined) view.others.push(`${prefix === '' ? '' : `${prefix}: `}${body}`.trim())
      else last.expected.push({ label: prefix === '' ? '预期结果' : prefix, text: body })
      continue
    }
    if (kind === 'log') {
      view.logs.push(body)
      continue
    }
    view.others.push(`${firstLineOf(child.title)}\n${body}`.trim())
  }
  return view
}

/** 节点（含子孙）的节点总数 —— 左树徽标与"共 N 个节点"读数用 */
export function countNodes(node: XmindOutlineNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0)
}

/** 子树里是否**任一节点**的标题命中关键字（搜索用：能按 DB 字段名找到含该断言的用例） */
export function subtreeMatches(node: XmindOutlineNode, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase()
  if (needle === '') return false
  if (node.title.toLowerCase().includes(needle)) return true
  if (node.note !== undefined && node.note.toLowerCase().includes(needle)) return true
  return node.children.some((child) => subtreeMatches(child, needle))
}

/** 从根到目标节点的路径（按引用比较；找不到返回 `null`） */
export function pathTo(root: XmindOutlineNode, target: XmindOutlineNode): XmindOutlineNode[] | null {
  if (root === target) return [root]
  for (const child of root.children) {
    const found = pathTo(child, target)
    if (found !== null) return [root, ...found]
  }
  return null
}
