/**
 * 内置知识库工具的**执行体**（检索 / 目录）—— P0-3-9b 扩展：TaskAgent 也能用知识库
 *
 * 依据：`docs/01-整体需求与实施步骤.md` 决策 12（知识库引用：未命中不编造）+
 *      `docs/子方案/沙箱与引擎集成.md` §七（MCP / 内置工具一律经后端代理，凭据不进容器）+
 *      `infra/sandbox/base/pi-agent/extensions/mcp-bridge/index.ts`（容器侧只做瘦转发）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么抽出来（而不是在 chatBot / proxy 里各写一份）
 * ─────────────────────────────────────────────────────────────────────
 * `knowledge_search` / `list_knowledge` 两个工具原先只在 ChatBot 的工具循环里（`chatBot.ts`）。
 * TaskAgent（沙箱里的 pi 引擎）绑定知识库后要拿到**同一族**工具与**同一套**结果口径 ——
 * 若在 `sandbox/proxy.ts` 再写一份，两处的"库名/文件名解析、逐库检索、结果排版、错误文案"
 * 就会各走各的（`06` §六 第 ⑰ 条：同一口径只留一处）。
 *
 * ⇒ 本文件是这两个工具的**唯一实现**：
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
 * 执行一次内置知识库工具（`knowledge_search` / `list_knowledge`）。
 *
 * ★ **与 ChatBot 工具循环逐条同口径**（这是抽出来的原意）：
 *   · `list_knowledge`：列全（每库上限 {@link KNOWLEDGE_LIST_MAX_DOCS}），无入参；
 *   · `knowledge_search`：`query` 必填，`kb` / `doc` 可选（都收"名字或 id"）；
 *   · 参数解析失败 / 查不到库或文档 ⇒ `isError:true` + **把可选值列回去**（让模型自愈）；
 *   · 检索降级（warnings）只 warn，不影响结果。
 *
 * ⚠️ **不抛**：任何内部异常都翻成 `isError:true` 的一段文案 —— 单条工具失败不拖垮整轮，
 *    交给模型自己解释（`01` §3.6；与 MCP 工具同款）。
 */
export async function executeKnowledgeTool(input: {
  kbIds: readonly string[]
  /** 工具名（`knowledge_search` / `list_knowledge`） */
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

/** 白名单：这个工具名是不是内置知识库工具（两条调用路径分流时的**唯一**判据） */
export function isKnowledgeToolName(name: string): boolean {
  return name === KNOWLEDGE_SEARCH_TOOL_NAME || name === LIST_KNOWLEDGE_TOOL_NAME
}
