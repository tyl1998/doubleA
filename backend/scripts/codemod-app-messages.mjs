/**
 * codemod：把后端 `AppError.*(<中文>)` 改写成 `AppError.*(appMsg('<key>', { … }))`
 *
 * 用法（仓库根目录）：
 *   node backend/scripts/codemod-app-messages.mjs [--dry]
 *
 * 依据：`docs/子方案/界面语言切换.md` §3.5c / §六 第 3 条。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本（而不是手改 400 处）
 * ─────────────────────────────────────────────────────────────────────
 * 手改 400 处必然拼错 key、漏参数、或者把相邻的实参搞混；而这类错误**不会报错** ——
 * 只会让某条英文消息显示成另一句。脚本做三件事：
 *   ① 从 `shared/src/appMessages.ts` 读登记表（中文模板 → key + 参数名）；
 *   ② 把调用点里的模板字面量归一化后查表，命中就改写；
 *   ③ 未命中 / 形态复杂（字符串拼接、三元、跨行多实参）⇒ **原样跳过并列出**，
 *      由人决定（这些必须人工处理，脚本不猜）。
 *
 * 幂等：已经写成 `appMsg(...)` 的调用点不会被再次改写（第一个实参不是字符串字面量）。
 */

import fs from 'node:fs'
import path from 'node:path'

const DRY = process.argv.includes('--dry')

const ROOT = path.resolve(import.meta.dirname, '../..')
const REGISTRY_FILE = path.join(ROOT, 'shared/src/appMessages.ts')

/** 从登记表源码里读 `"<中文模板>": { key: "app.mNNN", names: [...] }` */
function readRegistry() {
  const src = fs.readFileSync(REGISTRY_FILE, 'utf8')
  const map = new Map()
  const re = /^\s*("(?:[^"\\]|\\.)*"):\s*\{\s*key:\s*"([^"]+)",\s*names:\s*\[([^\]]*)\]\s*\},?$/gm
  let m
  while ((m = re.exec(src))) {
    const tpl = JSON.parse(m[1])
    const names = m[3]
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter((s) => s !== '')
    map.set(tpl, { key: m[2], names })
  }
  return map
}

/** 归一化：把 `${expr}` 换成 `{0}`，并返回表达式文本 */
function normalize(raw) {
  const exprs = []
  const tpl = raw.replace(/\$\{([\s\S]*?)\}/g, (_, e) => {
    exprs.push(e.trim())
    return `{${exprs.length - 1}}`
  })
  return { tpl, exprs }
}

const FACTORIES = [
  'validation',
  'unauthorized',
  'forbidden',
  'notFound',
  'conflict',
  'unprocessable',
  'busy',
  'needCredential',
  'upstreamError',
  'upstreamTimeout',
  'internal',
]

/** 去掉注释但保留换行（行号稳定） */
function stripComments(t) {
  return t
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/**
 * 把 `'a' + \`b\` + 'c'` 这类**纯字面量拼接**折成一个模板串。
 *
 * 只接受"字面量 + 字面量"：一旦出现三元、函数调用、成员访问，返回 `null` ——
 * 那些形态里"哪部分是文案、哪部分是数据"需要人判断，脚本不猜。
 */
function parseConcat(text) {
  const parts = []
  let i = 0
  const n = text.length
  let expectOperand = true
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++
    if (i >= n) break
    if (!expectOperand) {
      if (text[i] !== '+') return null
      i++
      expectOperand = true
      continue
    }
    const ch = text[i]
    if (ch !== "'" && ch !== '`') return null
    const quote = ch
    i++
    let buf = ''
    while (i < n) {
      if (text[i] === '\\') {
        buf += text[i] + (text[i + 1] ?? '')
        i += 2
        continue
      }
      if (text[i] === quote) {
        i++
        break
      }
      buf += text[i]
      i++
    }
    parts.push(quote === '`' ? buf : buf.replace(/`/g, '\\`').replace(/\\'/g, "'"))
    expectOperand = false
  }
  if (expectOperand || parts.length === 0) return null
  const joined = parts.join('')
  // 折完仍含 `${…}` 的，交给上层按模板处理；不含的按普通串
  return joined.includes('${') ? `\`${joined}\`` : `'${joined}'`
}

/** 从 `start` 读一个平衡的实参，返回 { text, end } */
function readArg(src, start) {
  let i = start
  let depth = 0
  let inStr = null
  const begin = i
  while (i < src.length) {
    const ch = src[i]
    if (inStr !== null) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch
      i++
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break
      depth--
    } else if (ch === ',' && depth === 0) break
    i++
  }
  return { text: src.slice(begin, i), end: i }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      walk(p, out)
    } else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const registry = readRegistry()
console.log(`登记表：${registry.size} 条模板`)

const files = walk(path.join(ROOT, 'backend/src'))
const rewritten = []
const skipped = []
let total = 0

for (const file of files) {
  const original = fs.readFileSync(file, 'utf8')
  const masked = stripComments(original)
  /** 改写操作（位置基于 masked，与原串等长，可直接套用到 original） */
  const edits = []
  const re = /AppError\.(\w+)\(/g
  let m
  while ((m = re.exec(masked))) {
    if (!FACTORIES.includes(m[1])) continue
    const open = masked.indexOf('(', m.index + 'AppError.'.length + m[1].length)
    const argStart = open + 1
    const arg = readArg(masked, argStart)
    const text = arg.text.trim()
    if (text === '') continue

    // 支持两种形态：
    //   ① 整个实参就是一个字符串/模板字面量；
    //   ② 纯字面量拼接 `'a' + \`b\``（**只允许**字面量与 `+`，出现三元 / 调用 / 成员访问就跳过）
    let lit = text.match(/^'((?:[^'\\]|\\.)*)'$/) ?? text.match(/^`((?:[^`\\]|\\.)*)`$/)
    if (lit === null) {
      // `parseConcat` 返回的是**带引号的完整字面量**（`'a'` 或 `` `a` ``），
      // 这里把它重新按单字面量形态拆一次 —— 不要直接塞进 `lit`（那会让 `lit[1]` 多出引号）。
      const concat = parseConcat(text)
      if (concat !== null) lit = concat.match(/^'((?:[^'\\]|\\.)*)'$/) ?? concat.match(/^`((?:[^`\\]|\\.)*)`$/)
    }
    if (lit === null) {
      if (/[\u4e00-\u9fff]/.test(text)) {
        skipped.push({ file: path.relative(ROOT, file), line: masked.slice(0, m.index).split('\n').length, why: '非单字面量实参', text: text.replace(/\s+/g, ' ').slice(0, 100) })
      }
      continue
    }
    const raw = lit[1]
    if (!/[\u4e00-\u9fff]/.test(raw)) continue // 已经是英文/非中文，不动

    const { tpl, exprs } = normalize(raw)
    const entry = registry.get(tpl)
    if (entry === undefined) {
      skipped.push({ file: path.relative(ROOT, file), line: masked.slice(0, m.index).split('\n').length, why: '登记表里没有这条模板', text: tpl.slice(0, 100) })
      continue
    }
    if (exprs.length !== entry.names.length) {
      skipped.push({ file: path.relative(ROOT, file), line: masked.slice(0, m.index).split('\n').length, why: `参数个数不符（字面量 ${exprs.length} / 表 ${entry.names.length}）`, text: tpl.slice(0, 100) })
      continue
    }

    const params =
      entry.names.length === 0
        ? ''
        : `, { ${entry.names.map((n, i) => `${n}: ${exprs[i]}`).join(', ')} }`
    const replacement = `appMsg('${entry.key}'${params})`
    edits.push({ start: argStart, end: arg.end, replacement })
    total++
  }

  if (edits.length === 0) continue
  let out = original
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end)
  }
  // 需要 import
  if (!/\bappMsg\b/.test(original.split('\n').slice(0, 60).join('\n'))) {
    const single = out.match(/^import \{([^}]*)\} from '@doubulea\/shared'\n/m)
    if (single !== null) {
      out = out.replace(single[0], `import { appMsg,${single[1]}} from '@doubulea/shared'\n`)
    } else {
      const multi = out.match(/^import \{\n([\s\S]*?)\n\} from '@doubulea\/shared'\n/m)
      if (multi !== null) {
        out = out.replace(multi[0], `import {\n  appMsg,\n${multi[1]}\n} from '@doubulea/shared'\n`)
      } else {
        skipped.push({ file: path.relative(ROOT, file), line: 1, why: '找不到 @doubulea/shared 的 import 语句', text: '' })
        continue
      }
    }
  }

  rewritten.push({ file: path.relative(ROOT, file), n: edits.length })
  if (!DRY) fs.writeFileSync(file, out)
}

console.log(`\n改写 ${total} 处 / ${rewritten.length} 个文件${DRY ? '（dry run，未落盘）' : ''}`)
for (const r of rewritten) console.log(`  ${String(r.n).padStart(3)}  ${r.file}`)
console.log(`\n跳过 ${skipped.length} 处（需人工处理）`)
for (const s of skipped) console.log(`  ${s.file}:${s.line}  [${s.why}]  ${s.text}`)
