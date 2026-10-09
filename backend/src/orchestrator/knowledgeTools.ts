/**
 * 内置知识库工具的**执行体**（检索 / 目录 / 整篇阅读）—— P0-3-9b 扩展：TaskAgent 也能用知识库
 *
 * 依据：`docs/01-整体需求与实施步骤.md` 决策 12（知识库引用：未命中不编造）+
 *      `docs/子方案/沙箱与引擎集成.md` §七（MCP / 内置工具一律经后端代理，凭据不进容器）+
 *      `infra/sandbox/base/pi-agent/extensions/mcp-bridge/index.ts`（容器侧只做瘦转发）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么抽出来（而不是在 chatBot / proxy 里各写一份）
 * ─────────────────────────────────────────────────────────────────────
 * `knowledge_search` / `list_knowledge` / `read_document` 这一族工具原先只在 ChatBot 的工具循环里
 * （`chatBot.ts`）。TaskAgent（沙箱里的 pi 引擎）绑定知识库后要拿到**同一族**工具与**同一套**结果口径 ——
 * 若在 `sandbox/proxy.ts` 再写一份，两处的"库名/文件名解析、逐库检索、结果排版、错误文案"
 * 就会各走各的（`06` §六 第 ⑰ 条：同一口径只留一处）。
 *
 * ⇒ 本文件是这一族工具的**唯一实现**：
 *   · ChatBot（`orchestrator/chatBot.ts`）在工具循环里直接调 {@link executeKnowledgeTool}；
 *   · TaskAgent（`sandbox/proxy.ts` 的内置工具端点）经代理调**同一个**函数。
 *
 * ⚠️ 本文件**不 import `llm/client.ts` 的 `chatStream`**，只借它的纯函数 `parseToolArguments`
 *    （解析模型给的 `arguments` 原文）—— 与 `mcpCall.service.ts` 同一条取舍。
 */

import { AppError, DEFAULT_MESSAGE_BY_ERROR_CODE, type RetrievalHit } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { parseToolArguments } from '../llm/client.js'
import { searchKnowledgeBase } from '../services/retrieval.js'
import {
  KNOWLEDGE_LIST_MAX_DOCS,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  LIST_KNOWLEDGE_TOOL_NAME,
  READ_DOCUMENT_MAX_PAGE_CHUNKS,
  READ_DOCUMENT_PAGE_CHAR_BUDGET,
  READ_DOCUMENT_TOOL_NAME,
  formatKnowledgeCatalog,
  formatRetrievalBlock,
  mergeRetrievalHits,
  truncateToolResult,
  type KnowledgeCatalogEntry,
} from './chatContext.js'

/**
 * 读"这个 Agent 绑定了哪几个知识库"的文档概览（库名 + 文档名）。
 *
 * ⚠️ 排序与文档列表端点一致（`createdAt desc, id desc`）：prompt 概览里看到的头几篇
 * 与用户在知识库页面上看到的头几篇是同一批（口径来自 `chatBot.ts` 的同名逻辑）。
 */
export async function loadKnowledgeCatalog(
  kbIds: readonly string[],
  maxDocsPerKb: number,
): Promise<KnowledgeCatalogEntry[]> {
  if (kbIds.length === 0) return []
  const db = getPrisma()
  const rows = await db.knowledgeBase.findMany({
    where: { id: { in: [...kbIds] } },
    orderBy: { createdAt: 'asc' },
    select: {
      name: true,
      _count: { select: { documents: true } },
      documents: {
        select: { fileName: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: maxDocsPerKb,
      },
    },
  })
  return rows.map((row) => ({
    name: row.name,
    documents: row.documents.map((document) => document.fileName),
    documentTotal: row._count.documents,
  }))
}

/** 查一个 Agent 绑定的知识库 id（与 ChatBot 同源：`agent_components` 里 `componentType=KNOWLEDGE`） */
export async function boundKnowledgeBaseIds(agentId: string): Promise<string[]> {
  const components = await getPrisma().agentComponent.findMany({
    where: { agentId, componentType: 'KNOWLEDGE' },
    select: { refId: true },
    orderBy: { refId: 'asc' },
  })
  return [...new Set(components.map((row) => row.refId))]
}

/** 一次内置知识库工具调用的结果（**恒不抛**：失败也翻成模型读得懂的 `isError`） */
export interface KnowledgeToolOutcome {
  isError: boolean
  /** 交给模型看的文本（成功是检索块 / 目录，失败是一句可读的原因） */
  output: string
  /** 本轮命中的片段（供 ChatBot 攒引用卡；沙箱路径不消费） */
  hits: RetrievalHit[]
}

/** 日志上下文（两条调用路径都能给；只用于 warn，不影响结果） */
export interface KnowledgeToolLogContext {
  conversationId?: string
  agentId?: string
}

/**
 * 执行一次内置知识库工具（`knowledge_search` / `list_knowledge` / `read_document`）。
 *
 * ★ **与 ChatBot 工具循环逐条同口径**（这是抽出来的原意）：
 *   · `list_knowledge`：列全（每库上限 {@link KNOWLEDGE_LIST_MAX_DOCS}），无入参；
 *   · `knowledge_search`：`query` 必填，`kb` / `doc` 可选（都收"名字或 id"）；
 *   · `read_document`：`doc` 必填、`kb` / `offset` 可选 ⇒ **整篇按 `seq` 分页读出**（见
 *     {@link executeReadDocument}）；
 *   · 参数解析失败 / 查不到库或文档 ⇒ `isError:true` + **把可选值列回去**（让模型自愈）；
 *   · 检索降级（warnings）只 warn，不影响结果。
 *
 * ⚠️ **不抛**：任何内部异常都翻成 `isError:true` 的一段文案 —— 单条工具失败不拖垮整轮，
 *    交给模型自己解释（`01` §3.6；与 MCP 工具同款）。
 */
export async function executeKnowledgeTool(input: {
  kbIds: readonly string[]
  /** 工具名（`knowledge_search` / `list_knowledge` / `read_document`） */
  name: string
  /** 模型给的 `arguments` **原文**（JSON 串；与 ChatBot 拿到的 `call.arguments` 同形） */
  arguments: string
  log?: KnowledgeToolLogContext
}): Promise<KnowledgeToolOutcome> {
  const logger = getLogger()
  const { kbIds, name, log } = input
  const db = getPrisma()

  try {
    if (name === LIST_KNOWLEDGE_TOOL_NAME) {
      const entries = await loadKnowledgeCatalog(kbIds, KNOWLEDGE_LIST_MAX_DOCS)
      const output = entries.length === 0 ? '（当前没有绑定任何知识库）' : formatKnowledgeCatalog(entries)
      return { isError: false, output, hits: [] }
    }

    // ── 整篇阅读（read_document）：按 seq 顺序分页读出某一篇（2026-10-08）──
    if (name === READ_DOCUMENT_TOOL_NAME) {
      const parsed = parseToolArguments(input.arguments)
      if (!parsed.ok) {
        return {
          isError: true,
          output: `工具调用失败：${parsed.reason}。模型给出的原文：${truncateToolResult(input.arguments)}`,
          hits: [],
        }
      }
      return executeReadDocument({ kbIds, args: parsed.value })
    }

    // name === KNOWLEDGE_SEARCH_TOOL_NAME（调用方已按白名单分流）
    const parsed = parseToolArguments(input.arguments)
    if (!parsed.ok) {
      return {
        isError: true,
        output: `工具调用失败：${parsed.reason}。模型给出的原文：${truncateToolResult(input.arguments)}`,
        hits: [],
      }
    }
    const query = typeof parsed.value['query'] === 'string' ? parsed.value['query'].trim() : ''
    if (query === '') {
      return {
        isError: true,
        output: '工具调用失败：缺少 query 参数（请在 query 里给出要检索的关键词或问题）。',
        hits: [],
      }
    }

    // ① 解析 `kb`：收"库名或 id"（模型看到的是库名，库里用的是 id）。
    const kbArg = typeof parsed.value['kb'] === 'string' ? parsed.value['kb'].trim() : ''
    const docArg = typeof parsed.value['doc'] === 'string' ? parsed.value['doc'].trim() : ''
    const boundKbs = await db.knowledgeBase.findMany({
      where: { id: { in: [...kbIds] } },
      select: { id: true, name: true },
    })
    const targetKbs =
      kbArg === ''
        ? boundKbs
        : boundKbs.filter(
            (kb) =>
              kb.id === kbArg ||
              kb.name === kbArg ||
              kb.name.toLowerCase() === kbArg.toLowerCase(),
          )
    if (targetKbs.length === 0) {
      return {
        isError: true,
        output: `工具调用失败：没有找到知识库「${kbArg}」。可用的知识库：${
          boundKbs.map((kb) => kb.name).join('、') || '（无）'
        }`,
        hits: [],
      }
    }

    // ② 解析 `doc`：同样收"文件名或 id"，在目标库里找。
    let docIds: string[] | undefined
    if (docArg !== '') {
      const docs = await db.document.findMany({
        where: { kbId: { in: targetKbs.map((kb) => kb.id) } },
        select: { id: true, fileName: true },
      })
      const matched = docs.filter(
        (doc) =>
          doc.id === docArg ||
          doc.fileName === docArg ||
          doc.fileName.toLowerCase() === docArg.toLowerCase(),
      )
      if (matched.length === 0) {
        return {
          isError: true,
          output: `工具调用失败：在知识库（${targetKbs
            .map((kb) => kb.name)
            .join('、')}）里没有找到文档「${docArg}」。可用文档：${
            docs.slice(0, 50).map((doc) => doc.fileName).join('、') || '（无）'
          }`,
          hits: [],
        }
      }
      docIds = matched.map((doc) => doc.id)
    }

    const toolPerKb: RetrievalHit[][] = []
    for (const kb of targetKbs) {
      const result = await searchKnowledgeBase({
        kbId: kb.id,
        query,
        ...(docIds === undefined ? {} : { docIds }),
      })
      toolPerKb.push(result.items)
      if (result.warnings.length > 0) {
        logger.warn(
          { conversationId: log?.conversationId, kbId: kb.id, warnings: result.warnings },
          '知识库检索发生降级（已记入警告）',
        )
      }
    }
    const found = mergeRetrievalHits(toolPerKb)
    return { isError: false, output: truncateToolResult(formatRetrievalBlock(found)), hits: found }
  } catch (error) {
    logger.warn(
      { conversationId: log?.conversationId, agentId: log?.agentId, toolName: name, err: error },
      '内置知识库工具执行失败（已作为错误结果回填，本轮不因此失败）',
    )
    return {
      isError: true,
      output: truncateToolResult(
        `工具调用失败：${error instanceof AppError ? error.message : DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL}`,
      ),
      hits: [],
    }
  }
}

/**
 * 整篇阅读（`read_document`）的执行体：解析文档 → 按 `seq` 取一页 → 拼"页头 + 块 + 页尾"。
 *
 * ★ 与 `knowledge_search` 的分工：检索回 topK **相关片段**，本函数回**按顺序的整篇分页**。
 *   分页的关键是**页尾那句"还有 N 块、下次带 offset"**——它把"读完"变成一个模型能自己推进的循环
 *   （而不是让它以为这一页就是全部）。
 *
 * 四条口径：
 *   · **`doc` 收"文件名或 id"**（与检索同款）；`kb` 可选，仅在重名文档时用于消歧；
 *   · **重名 ⇒ 报错并列候选**（而不是随便挑一篇）：读错整篇比检索错一块严重得多；
 *   · **一页多大由两道闸决定**（{@link READ_DOCUMENT_MAX_PAGE_CHUNKS} 与
 *     {@link READ_DOCUMENT_PAGE_CHAR_BUDGET}），且**至少带一块** —— 否则 offset 永远不动、卡死；
 *   · **恒不产生检索命中（`hits: []`）**：引用卡的 `score` 是 RRF 融合分，整篇读取没有"命中排名"
 *     可填，编一个 0 会让卡片显示 "rrf 0.0000"（`frontend/src/features/chat/CitationCard.tsx`）。
 *     代价如实写明：**通读一篇后不会有引用卡**（要引用卡请用 `knowledge_search`）。
 *
 * ⚠️ 边界（如实记下）：若单块内容本身就超过字符预算，这一页会被 {@link truncateToolResult} 截断，
 *    页尾提示可能一起被截掉 —— 此时模型可能带着同一 offset 重读。默认 `chunk_size=512` 下不会发生；
 *    真要根治得按字符切块，而不是把"整块不切"的既定口径在这里破掉。
 */
async function executeReadDocument(params: {
  kbIds: readonly string[]
  /** 解析后的参数（`parseToolArguments` 的 `value`） */
  args: Record<string, unknown>
}): Promise<KnowledgeToolOutcome> {
  const db = getPrisma()
  const { kbIds } = params
  const docArg = typeof params.args['doc'] === 'string' ? params.args['doc'].trim() : ''
  if (docArg === '') {
    return {
      isError: true,
      output: `工具调用失败：缺少 doc 参数（请在 doc 里给出要阅读的文档名或 id）。`,
      hits: [],
    }
  }
  const kbArg = typeof params.args['kb'] === 'string' ? params.args['kb'].trim() : ''
  const offset = normalizeReadOffset(params.args['offset'])

  // ① 解析 kb（与检索同口径：库名或 id；省略 = 绑定的全部库）
  const boundKbs = await db.knowledgeBase.findMany({
    where: { id: { in: [...kbIds] } },
    select: { id: true, name: true },
  })
  const targetKbs =
    kbArg === ''
      ? boundKbs
      : boundKbs.filter(
          (kb) =>
            kb.id === kbArg ||
            kb.name === kbArg ||
            kb.name.toLowerCase() === kbArg.toLowerCase(),
        )
  if (targetKbs.length === 0) {
    return {
      isError: true,
      output: `工具调用失败：没有找到知识库「${kbArg}」。可用的知识库：${
        boundKbs.map((kb) => kb.name).join('、') || '（无）'
      }`,
      hits: [],
    }
  }
  const kbNameById = new Map(targetKbs.map((kb) => [kb.id, kb.name]))

  // ② 解析 doc：同样收"文件名或 id"，在目标库里找
  const docs = await db.document.findMany({
    where: { kbId: { in: targetKbs.map((kb) => kb.id) } },
    select: { id: true, fileName: true, kbId: true, status: true },
  })
  const matched = docs.filter(
    (doc) =>
      doc.id === docArg ||
      doc.fileName === docArg ||
      doc.fileName.toLowerCase() === docArg.toLowerCase(),
  )
  if (matched.length === 0) {
    return {
      isError: true,
      output: `工具调用失败：在知识库（${targetKbs
        .map((kb) => kb.name)
        .join('、')}）里没有找到文档「${docArg}」。可用文档：${
        docs.slice(0, 50).map((doc) => doc.fileName).join('、') || '（无）'
      }`,
      hits: [],
    }
  }
  if (matched.length > 1) {
    const candidates = matched
      .map((doc) => `《${doc.fileName}》@${kbNameById.get(doc.kbId) ?? '未知库'}（id: ${doc.id}）`)
      .join('；')
    return {
      isError: true,
      output: `工具调用失败：文档名「${docArg}」匹配到多篇，请用 kb 指定知识库、或用 doc 传文档 id 精确指定：${candidates}`,
      hits: [],
    }
  }
  const doc = matched[0]!

  const total = await db.chunk.count({ where: { docId: doc.id } })
  if (total === 0) {
    return {
      isError: false,
      output: `文档《${doc.fileName}》当前没有可读内容（可能尚未完成解析，状态：${doc.status}）。`,
      hits: [],
    }
  }
  if (offset >= total) {
    return {
      isError: false,
      output: `已经读到文档《${doc.fileName}》的末尾（共 ${total} 块，offset=${offset} 超出范围）。`,
      hits: [],
    }
  }

  const rows = await db.chunk.findMany({
    where: { docId: doc.id },
    select: { seq: true, content: true },
    // `id` 兜底同 `seq` 的意外重复（与 `chunk.service.ts` 同一排序口径，分页才确定）
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    skip: offset,
    take: READ_DOCUMENT_MAX_PAGE_CHUNKS,
  })

  const header = `文档《${doc.fileName}》全文（按顺序分块，共 ${total} 块；本页从第 ${offset + 1} 块起）：`
  const blocks: string[] = []
  let used = header.length
  for (const row of rows) {
    const block = `[第 ${row.seq + 1} 块]\n${row.content}`
    // 至少带一块（见本函数注释："否则 offset 永远不动"）
    if (blocks.length > 0 && used + block.length > READ_DOCUMENT_PAGE_CHAR_BUDGET) break
    blocks.push(block)
    used += block.length
  }
  const nextOffset = offset + blocks.length
  const remaining = total - nextOffset
  const footer =
    remaining > 0
      ? `\n\n…（本页之后还有 ${remaining} 块。要继续读完，请再次调用 ${READ_DOCUMENT_TOOL_NAME}：doc="${doc.fileName}", offset=${nextOffset}）`
      : '\n\n（已读完全文）'
  return {
    isError: false,
    output: truncateToolResult([header, ...blocks].join('\n\n') + footer),
    hits: [],
  }
}

/**
 * `read_document` 的 `offset` 归一：非负整数，非法/缺失一律 0。
 *
 * 刻意**不报错**：offset 是"翻页游标"，模型偶尔给个字符串数字或被省略都很常见，退回 0
 * 只是"从头上读"，比因一个游标格式失败、让模型放弃通读划算得多。
 */
function normalizeReadOffset(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed))
  }
  return 0
}

/** 白名单：这个工具名是不是内置知识库工具（两条调用路径分流时的**唯一**判据） */
export function isKnowledgeToolName(name: string): boolean {
  return (
    name === KNOWLEDGE_SEARCH_TOOL_NAME ||
    name === LIST_KNOWLEDGE_TOOL_NAME ||
    name === READ_DOCUMENT_TOOL_NAME
  )
}
