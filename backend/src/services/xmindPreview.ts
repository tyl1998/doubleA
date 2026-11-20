/**
 * XMind 解析 —— 把 `.xmind` 的**原始字节**解成一份结构化大纲（`GET …/outline` 的数据源）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么是"解 zip + 读 content.json"，而不是引一个思维导图渲染库
 * ─────────────────────────────────────────────────────────────────────
 * `.xmind`（XMind Zen / 8 及以后）本质是 **zip 包**：`content.json` 里是一棵
 * `[{ title, children: { attached: [...] }, notes }]` 的树，其余是 `metadata.json` / 缩略图 / 资源。
 * 与 `xlsxPreview.ts` 同款取舍：手写零依赖读取器，不引第三方解析器。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么只给"大纲"、不在服务端画图
 * ─────────────────────────────────────────────────────────────────────
 * 早先试过两条服务端出图的路，都被真实数据否掉了（2026-11-20，933 节点的端到端用例导图）：
 *   · 左右分叉画布 —— 7 层深、单支 394 节点，视口里必然溢出，缩到能看全就已读不清；
 *   · mermaid mindmap —— 节点文字不能换行，`预期结果` 那种多行 DB 断言压成一行等于丢信息。
 * 结论：**结构化数据交给前端按"左树 + 右阅读区"渲染**（`XmindOutlinePreview`），
 * 服务端只负责"把 xmind 解成 JSON"，安全面因此只剩"读 zip、别越界、别炸内存"。
 *
 * ⚠️ 老版（XMind 8 之前的 `content.xml`）暂不支持：缺 `content.json` 时报错，由调用方兜成 4xx
 * （文案要说"不是有效的 xmind"，而不是笼统一句"解析失败"—— 与 docx 口径一致）。
 *
 * ★ 安全：解压四道闸（条目数 / 单条目 / 整份字符总量 / 节点总数），防 zip bomb 与内存放大；
 *   产物 / 工作区 / Skill 三条出口还会先按 `ARTIFACT_PREVIEW_MAX_INLINE_BYTES` 拦一道压缩后体积。
 */

import { inflateRawSync } from 'node:zlib'

/** 单个节点的正文字符上限（**不再是 500**：用例的预期结果含整段 DB 断言，砍掉就读不完整） */
export const XMIND_NODE_TEXT_MAX_CHARS = 4000
/** 整份大纲的字符总量上限（2 MiB，与文本预览闸门同量级；超了按节点序截断并置 `truncated`） */
export const XMIND_OUTLINE_MAX_TOTAL_CHARS = 2 * 1024 * 1024
/** 节点总数上限（超大导图截断并明示，不静默） */
export const XMIND_PREVIEW_MAX_NODES = 5000
/** 树的嵌套深度上限（防御畸形的自引用 / 极深结构撑爆递归栈） */
export const XMIND_PREVIEW_MAX_DEPTH = 64
/** `content.json` 解压后的字节上限（8 MiB；正常导图最大也就几百 KB） */
export const XMIND_CONTENT_MAX_BYTES = 8 * 1024 * 1024
/** zip 条目数上限（xmind 正常 5~20 条） */
const ZIP_MAX_ENTRIES = 512

// ───────────────────────────── ZIP（零依赖：node:zlib 解压）─────────────────────────────

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * 从 zip 字节里取出**一个指定条目**（只解它，其余连字节都不碰）。
 *
 * ⚠️ 用**中央目录**里的 `compressedSize` / `localOffset`（本地头在"数据描述符"模式下尺寸字段为 0）。
 * ⚠️ 不支持 ZIP64（条目数 / 偏移为 0xFFFF / 0xFFFFFFFF 时直接报错）—— 与 `xlsxPreview` 同口径。
 *
 * @returns 条目解压后的字节；zip 里没有这个名字时 `null`
 */
function readZipEntry(buffer: Buffer, wanted: string): Buffer | null {
  let eocd = -1
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('不是有效的 zip（找不到 EOCD）')

  const totalLe = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (totalLe === 0xffff || centralOffset === 0xffffffff) throw new Error('不支持 ZIP64 格式的 xmind')
  if (totalLe > ZIP_MAX_ENTRIES) throw new Error(`zip 条目过多（${totalLe}）`)

  let offset = centralOffset
  for (let index = 0; index < totalLe; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('zip 中央目录损坏')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)
    offset += 46 + nameLen + extraLen + commentLen

    if (name !== wanted) continue

    if (uncompressedSize > XMIND_CONTENT_MAX_BYTES) throw new Error(`zip 条目过大：${name}`)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`zip 本地头损坏：${name}`)
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    if (raw.length !== compressedSize) throw new Error(`zip 条目数据越界：${name}`)

    if (method === 0) return Buffer.from(raw)
    if (method === 8) {
      // `maxOutputLength` 让 zlib 自己兜"声明 1KB 实际炸 500MB"的那种条目
      return inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1) + 1024 })
    }
    throw new Error(`zip 压缩方式不支持：${method}（${name}）`)
  }
  return null
}

// ───────────────────────────── 模型 ─────────────────────────────

/**
 * 一棵大纲节点（`.xmind` 的结构 → 前端左树 + 右阅读区）。
 *
 * ⚠️ 这里**不再按"字符数"截断标题**：原先 500 字符的闸门会把用例的 `预期结果`（含 DB 终态断言）
 * 与 `操作步骤` 的整段正文砍掉一半，而那正是读用例时最要看的部分。改为：
 *   · **单节点正文**上限 {@link XMIND_NODE_TEXT_MAX_CHARS}（4000）；
 *   · **整份大纲**的字符总量上限 {@link XMIND_OUTLINE_MAX_TOTAL_CHARS}（2 MiB），超了按节点序截断并置 `truncated`。
 */
export interface XmindOutlineNode {
  title: string
  /** XMind 的备注（`notes.plain.content`），没有时省略 */
  note?: string
  children: XmindOutlineNode[]
}

export interface XmindOutline {
  /** 画布 / 页签名（`sheet.title`，缺省 `SheetN`） */
  title: string
  /** 画布的根主题（没有 rootTopic 时为 `null`） */
  root: XmindOutlineNode | null
}

function clipText(value: string, max: number): { text: string; truncated: boolean } {
  const chars = [...value]
  if (chars.length <= max) return { text: value, truncated: false }
  return { text: `${chars.slice(0, max).join('')}…`, truncated: true }
}

interface ParseBudget {
  nodes: number
  chars: number
  truncated: boolean
}

/** 取备注纯文本（XMind Zen 的 `notes.plain.content`；`realHTML` 不取 —— 它是带标签的 HTML） */
function noteOf(raw: Record<string, unknown>): string | undefined {
  const notes = raw['notes']
  if (notes === null || typeof notes !== 'object') return undefined
  const plain = (notes as Record<string, unknown>)['plain']
  if (plain === null || typeof plain !== 'object') return undefined
  const content = (plain as Record<string, unknown>)['content']
  return typeof content === 'string' && content.trim() !== '' ? content : undefined
}

/**
 * 一个 XMind 主题对象 → {@link XmindOutlineNode}（递归）。
 *
 * XMind 的 `children` 里最常出现的是 `attached`（子主题）；`detached` 是**游离主题**（浮在画布上、
 * 视觉上也属于这张导图），一并收进来。其余键（`summaries` / `boundaries` / `markers`）不参与树形。
 */
function toNode(raw: unknown, depth: number, budget: ParseBudget): XmindOutlineNode | null {
  if (raw === null || typeof raw !== 'object') return null
  if (depth > XMIND_PREVIEW_MAX_DEPTH) {
    budget.truncated = true
    return null
  }
  if (budget.nodes >= XMIND_PREVIEW_MAX_NODES) {
    budget.truncated = true
    return null
  }
  budget.nodes += 1

  const record = raw as Record<string, unknown>
  const rawTitle = typeof record.title === 'string' ? record.title : ''
  const clipped = clipText(rawTitle, XMIND_NODE_TEXT_MAX_CHARS)
  budget.chars += clipped.text.length
  if (clipped.truncated) budget.truncated = true

  const node: XmindOutlineNode = { title: clipped.text, children: [] }
  const note = noteOf(record)
  if (note !== undefined) node.note = note

  const rawChildren = record['children']
  if (rawChildren !== null && typeof rawChildren === 'object' && budget.chars < XMIND_OUTLINE_MAX_TOTAL_CHARS) {
    const groups = rawChildren as Record<string, unknown>
    for (const key of ['attached', 'detached'] as const) {
      const list = groups[key]
      if (!Array.isArray(list)) continue
      for (const child of list) {
        if (budget.chars >= XMIND_OUTLINE_MAX_TOTAL_CHARS) {
          budget.truncated = true
          break
        }
        const parsed = toNode(child, depth + 1, budget)
        if (parsed !== null) node.children.push(parsed)
      }
    }
  } else if (rawChildren !== undefined) {
    budget.truncated = true
  }
  return node
}

/**
 * `.xmind` 字节 → 大纲模型（见文件头；失败时抛错，调用方兜成 4xx）。
 *
 * 两种顶层形状都认：XMind Zen / 2020+ 是 `[{ title, rootTopic }]`，更老的版本顶层直接是主题对象。
 */
export function parseXmind(bytes: Buffer): { sheets: XmindOutline[]; truncated: boolean } {
  const contentBytes = readZipEntry(bytes, 'content.json')
  if (contentBytes === null) throw new Error('不是有效的 xmind（缺 content.json）')

  let parsed: unknown
  try {
    parsed = JSON.parse(contentBytes.toString('utf8'))
  } catch {
    throw new Error('content.json 不是合法 JSON（文件可能损坏，或不是 XMind Zen 及以上格式）')
  }

  const budget: ParseBudget = { nodes: 0, chars: 0, truncated: false }

  if (Array.isArray(parsed)) {
    const sheets: XmindOutline[] = parsed.map((raw, index) => {
      const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const title = typeof record['title'] === 'string' && record['title'] !== '' ? record['title'] : `Sheet${String(index + 1)}`
      // 顶层数组里也可能直接是主题对象（老版本）：有 `rootTopic` 按画布取，否则把这一项当根节点
      const topic = 'rootTopic' in record ? record['rootTopic'] : record
      return { title, root: toNode(topic, 0, budget) }
    })
    return { sheets, truncated: budget.truncated }
  }

  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    const topic = 'rootTopic' in record ? record['rootTopic'] : record
    return { sheets: [{ title: 'Sheet1', root: toNode(topic, 0, budget) }], truncated: budget.truncated }
  }

  throw new Error('content.json 不是可识别的思维导图结构')
}
