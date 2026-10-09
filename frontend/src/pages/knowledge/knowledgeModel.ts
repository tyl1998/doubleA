/**
 * 知识库界面的**纯逻辑**与展示口径（P0-1-35）
 *
 * 依据：`shared/src/document.ts`（白名单 / 状态机 / 四条界面规则）、`shared/src/knowledgeBase.ts`
 *      （检索配置与三态）、`docs/02` §4.6（三张端点表的契约）、`docs/03` §4.3（详情页结构）、
 *      §七（列表三态、删除分级、文案词表）、`design/knowledge.html`（视觉与结构）。
 *
 * 为什么单独一个文件（而不是写进页面）：它是"**哪些文件能上传 / 这一行的操作该不该出现 /
 * 这次保存该发什么**"的唯一判据，全部是**纯函数** —— 没有 React、没有请求、也不 import antd。
 * 于是 `frontend/scripts/verify-knowledge-ui.mjs` 能在 node 里直接跑它逐条断言（本仓
 * "纯逻辑拆进无依赖文件 ⇒ 断言进无依赖档"的同一手法：`chatContext` / `semaphore` /
 * `composerState` / `conversationList`）。
 *
 * ⚠️ 本文件里**每一个常量都可能来自别处**，抄一份就多一个会腐烂的地方：
 *   · 白名单 / `.doc` / 状态文案 → `shared/src/document.ts`
 *   · 检索模式 / 分块策略 / 默认值    → `shared/src/knowledgeBase.ts`
 * 本文件只做"把它们组织成界面用得上的形状"，不新增事实。
 */

import {
  DOCUMENT_PARSING_HINT,
  LEGACY_DOC_EXTENSION,
  LEGACY_DOC_HINT,
  UPLOAD_EXTENSIONS,
  isDocumentSearchable,
  isImageUploadExtension,
  type ChunkItem,
  type DocumentItem,
  type DocumentStatus,
  type ImageRecognition,
  type KnowledgeBaseItem,
  type RetrievalConfig,
  type RetrievalHit,
  type RetrievalMode,
  type SplitStrategy,
  type UpdateKnowledgeBaseBody,
} from '@doubulea/shared'

// ───────────────────────────── 上传白名单（accept 属性 + 发送前拦截）─────────────────────────────

/**
 * `<input type="file">` 的 `accept` 属性。
 *
 * ⚠️ **`.doc` 是故意加进来的**（看着像 bug，其实不是）：**P1-12 起 `.doc` 可能是 HTML/MIME
 * （MHTML）导出件、本可正常解析**，故它不该在选择器里被过滤掉。而且真 OLE2 `.doc` 的
 * "请另存为 .docx 后重传"提示也只有在系统选择器**放它进来**时才可能触发（`accept` 只写
 * 四个白名单会让 `.doc` 是灰的、用户根本选不中）。把它放进 `accept`，才轮到
 * {@link screenPickedFiles} + {@link screenLegacyDocContent}（读文件头）给出结论。
 *
 * 顺序与 `UPLOAD_EXTENSIONS` 一致（只此一处枚举），`.doc` 排在最后。
 */
export const UPLOAD_ACCEPT_ATTRIBUTE: string = [...UPLOAD_EXTENSIONS, LEGACY_DOC_EXTENSION]
  .map((extension) => `.${extension}`)
  .join(',')

/**
 * 取小写扩展名（无点）；没有扩展名时返回 `null`。
 *
 * ⚠️ **镜像后端** `pipeline/parse/index.ts#extensionOf` 的四条规则（逐条对着写的）：
 * ① 先剥掉路径（老式浏览器会把客户端全路径塞进 `file.name`）；② 取**最后一个**点；
 * ③ 点在开头（`.gitignore`）或结尾（`a.`）都算"没有扩展名"；④ 一律小写（`.PDF` 合法）。
 *
 * 为什么不把它提到 `shared` 做成"两处共用的唯一实现"：后端那一处是**判定入口**
 * （不合法就 400），前端这一处只是**提前给提示**。判错的最坏后果是"多跑一次往返、
 * 由后端给出更好的文案"，不会写坏数据 ⇒ 不值得为它做跨包抽取（抽取会动到
 * P0-1-16 已验收的解析入口，`06` §六 第 ② 条的取舍）。
 */
export function extensionOf(fileName: string): string | null {
  const base = fileName.split(/[\\/]/u).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return null
  return base.slice(dot + 1).toLowerCase()
}

/** 交给 {@link screenPickedFiles} 的文件形状（`File` 的子集 —— 于是验收档可以造字面量） */
export interface PickedFileLike {
  name: string
  size: number
}

/** 读多少字节做 `.doc` 内容嗅探 —— 与后端 `pipeline/parse/index.ts#HEAD_PROBE_BYTES` 同值 */
export const LEGACY_DOC_PROBE_BYTES = 4096

/** `.doc` 按内容嗅探的结论（镜像后端 `sniffLegacyDoc`，见 `parse/index.ts`） */
export type LegacyDocKind = 'html' | 'mhtml' | 'ole2' | 'rtf' | 'other'

/** 字节 → latin1 文本（仅用于嗅探开头几个 ASCII 标记；UTF-16 BOM 另走 TextDecoder） */
function latin1Of(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

/** 取文件头文本（UTF-16 BOM 与 latin1 两种；侦探用，不做完整编码嗅探）——镜像后端 */
function legacyDocHeadText(head: Uint8Array): string {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le').decode(head.subarray(2))
    } catch {
      return ''
    }
  }
  return latin1Of(head)
}

/**
 * 按内容判断一个 `.doc` 到底是什么（P1-12；镜像后端 `sniffLegacyDoc`）。
 *
 * ⚠️ **前端这一份只是"提前给提示"**（判错最坏是多一次往返、由后端给出更准的结论，与
 * {@link extensionOf} 同一取舍）：真正把关的是后端 `pipeline/parse/index.ts`。判定顺序
 * = 确定性证据优先（OLE2 魔数 → RTF → MIME 头 → HTML 标记 → 其它）。
 */
export function sniffLegacyDocHead(head: Uint8Array): LegacyDocKind {
  if (
    head.length >= 8 &&
    head[0] === 0xd0 &&
    head[1] === 0xcf &&
    head[2] === 0x11 &&
    head[3] === 0xe0 &&
    head[4] === 0xa1 &&
    head[5] === 0xb1 &&
    head[6] === 0x1a &&
    head[7] === 0xe1
  ) {
    return 'ole2'
  }
  if (latin1Of(head.subarray(0, 5)) === '{\\rtf') return 'rtf'

  const text = legacyDocHeadText(head)
  if (
    /^[A-Za-z][A-Za-z0-9-]*:\s*.+$/mu.test(text) &&
    /(multipart\/|mime-version|content-type:\s*text\/html)/iu.test(text)
  ) {
    return 'mhtml'
  }
  if (/<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/iu.test(text)) return 'html'
  return 'other'
}

export type FileRejectionCode = 'NO_FILE' | 'MULTIPLE' | 'LEGACY_DOC' | 'UNSUPPORTED' | 'EMPTY'

export type FileScreenResult =
  | { kind: 'accept'; fileName: string }
  | {
      kind: 'reject'
      code: FileRejectionCode
      /** 给人看的一句话 */
      message: string
      /** 可操作的下一步（只有 `.doc` 需要 —— 决策 10 的验收要点就是这句） */
      hint: string | null
    }

/**
 * **发送前**的上传拦截（`子方案①` §4-1 的四道校验里，第 1/2 道在前端先做一遍）。
 *
 * 拦下的每一类都对应后端一个 400，前端的价值是**省掉一次往返并当场说清怎么办**：
 *   · `MULTIPLE` —— 本仓上传端点**只接受一个文件字段** `file`（`shared/src/document.ts`），
 *     多选不是"排队传"，而是 413。界面上一次只处理一个文件，所以这里直接拒绝多选而不是
 *     悄悄取第一个（"我明明选了 3 个，只传了 1 个"比"一次只能传一个"更难查）。
 *   · `LEGACY_DOC` —— 单独一类（不并进 `UNSUPPORTED`），因为它有**可操作**的下一步
 *     （`LEGACY_DOC_HINT` = "请另存为 .docx 后重传"）。⚠️ **P1-12 起它不再在"看扩展名"阶段产生**
 *     —— `.doc` 可能是 HTML/MIME 导出件，故这里放行，读完文件头后由 {@link screenLegacyDocContent}
 *     再判（只有真 OLE2/RTF 才落到这个 code）。
 *   · `EMPTY` —— 0 字节文件后端会 400（"上传的文件是空的（0 字节）"），提前拦。
 *   · `UNSUPPORTED` —— 其余不在白名单里的扩展名（含**没有扩展名**）。
 *
 * 大小上限**刻意不在这里判**：`UPLOAD_BODY_LIMIT` 是部署环境变量（`infra/.env`，本机 `100MB`），
 * 前端读不到 ⇒ 写死一个数字就是造一份会与部署配置分叉的事实。超限交回后端的 413 文案
 * （`errorHandler` 保留了原状态码与文案）。
 */
export function screenPickedFiles(files: readonly PickedFileLike[]): FileScreenResult {
  if (files.length === 0) {
    return { kind: 'reject', code: 'NO_FILE', message: '没有选中文件。', hint: null }
  }
  if (files.length > 1) {
    return {
      kind: 'reject',
      code: 'MULTIPLE',
      message: `一次只能上传一个文件（本次选中 ${files.length} 个）。`,
      hint: '上传接口只接受单个 file 字段：请逐个上传。',
    }
  }

  const file = files[0] as PickedFileLike
  const extension = extensionOf(file.name)

  // ⚠️ **`.doc` 是唯一"扩展名不定生死"的格式（P1-12）**：它可能是 HTML/MIME（MHTML）导出件，
  //    本可正常解析 ⇒ 这里放行，内容判定由调用方读文件头走 {@link screenLegacyDocContent}。
  //    真正的把关始终在后端 `detectFormat`（前端这份只是提前提示）。
  if (extension === null || (extension !== LEGACY_DOC_EXTENSION && !(UPLOAD_EXTENSIONS as readonly string[]).includes(extension))) {
    return {
      kind: 'reject',
      code: 'UNSUPPORTED',
      message:
        extension === null
          ? `无法从文件名「${file.name}」识别格式（缺少扩展名）。支持的格式：${UPLOAD_EXTENSIONS.join(' / ')}`
          : `不支持的文件类型 .${extension}。支持的格式：${UPLOAD_EXTENSIONS.join(' / ')}`,
      hint: null,
    }
  }
  if (file.size === 0) {
    return { kind: 'reject', code: 'EMPTY', message: `「${file.name}」是空文件（0 字节）。`, hint: null }
  }

  return { kind: 'accept', fileName: file.name }
}

/**
 * `.doc` 的**内容判定**（P1-12）—— 读完文件头后调用，决定它是"网页导出件（放行）"
 * 还是"真 OLE2/RTF（拦下，给可操作的下一步）"。
 *
 * ⚠️ 与 {@link screenPickedFiles} **分两步**是刻意的：文件头要读字节（异步），而
 * `screenPickedFiles` 是同步纯函数（验收档直接跑）。判定口径镜像后端 `sniffLegacyDoc`。
 */
export function screenLegacyDocContent(fileName: string, head: Uint8Array): FileScreenResult {
  const kind = sniffLegacyDocHead(head)
  if (kind === 'html' || kind === 'mhtml') {
    return { kind: 'accept', fileName }
  }
  return {
    kind: 'reject',
    code: 'LEGACY_DOC',
    message: `「${fileName}」是旧版 Word 二进制格式（.doc）：本平台只解析 ${UPLOAD_EXTENSIONS.join(' / ')} 这些格式，旧版 .doc 需先转换。`,
    hint: LEGACY_DOC_HINT,
  }
}

/** 扩展名（用于表格里那个等宽小标）—— 识别不出时给 `—`，**不编**一个格式出来 */
export function documentExtensionLabel(fileName: string): string {
  return extensionOf(fileName) ?? '—'
}

/** 这个文件是不是独立图片文件（`png`/`jpg`/…）—— 上传时它必须选一个图片解析方式 */
export function isImageFile(fileName: string): boolean {
  const extension = extensionOf(fileName)
  return extension !== null && isImageUploadExtension(extension)
}

/** 图片选项各自是否**可选**的能力前置（与后端 `assertImageOptionsUsable` 同口径） */
export interface ImageOptionCapabilities {
  /** 该库 embedding 模型是否支持多模态 → 决定「图片向量化」可否选 */
  multimodalSupported: boolean
  /** 该库是否已选「图片描述模型」→ 决定识别方式「大模型识别（LLM）」可否选 */
  describeSupported: boolean
}

/**
 * 某个识别方式此刻是否可用（不可用时前端 disabled；后端也会再拦一道）。
 * `NONE`/`OCR` 恒可用（本机离线、无依赖）；`LLM` 需该库已选描述模型。
 */
export function isRecognitionAllowed(recognition: ImageRecognition, caps: ImageOptionCapabilities): boolean {
  return recognition !== 'LLM' || caps.describeSupported
}

// ───────────────────────────── 文档状态展示 ─────────────────────────────

/** 状态灯的三种颜色（`styles/app.css` 的 `.led--*`）；三态各自对应一个真实状态，不合并 */
export type DocumentLed = 'run' | 'ok' | 'fail'

export interface DocumentStatusMeta {
  led: DocumentLed
  label: string
  /**
   * 该状态下必须显示的一句说明；`null` = 无。
   *
   * `PARSING` 那句来自 `shared`（`DOCUMENT_PARSING_HINT` = "更新中，暂不参与检索"）：
   * "先删后建"的覆盖重建有一段检索空窗，不提示的话用户会以为"文档在、就是搜不到"是 bug。
   * 这里是**搬用**而不是重写 —— 那句话是前后端共用的一条契约（后端注释同款）。
   */
  hint: string | null
}

/**
 * 三态 → 界面。**不能合并成"成功 / 其他"**：`PARSING` 是"我们还在干活"（别急），
 * `FAILED` 是"要你处理"（去点重试）—— 混成一种"失败"会让用户去重试一件正在正常进行的事。
 */
export const DOCUMENT_STATUS_META: Readonly<Record<DocumentStatus, DocumentStatusMeta>> = {
  PARSING: { led: 'run', label: '解析中', hint: DOCUMENT_PARSING_HINT },
  READY: { led: 'ok', label: '已完成', hint: null },
  FAILED: { led: 'fail', label: '失败', hint: null },
}

/**
 * 片段数那一列显示什么。
 *
 * `PARSING` / `FAILED` 时 `chunkCount` **恒为 0**（`documentItemSchema` 的注释：它是"已入库的
 * chunk 数"，非 `READY` 时没有可用 chunk）⇒ 直接显示 `0` 会让用户读成"这篇文档有 0 个片段"，
 * 而事实是"现在还不能检索"。原型这里写的也是 `—`（`design/knowledge.html` 第 136 行）。
 * 判据用 `shared` 的 `isDocumentSearchable`（`READY ⟺ 可检索`），**不写字面量比较**：
 * 这条语义变过一次（P0-1-17 时 `READY` 只是"解析完成"）。
 */
export const CHUNK_COUNT_PLACEHOLDER = '—'

export function chunkCountText(item: Pick<DocumentItem, 'status' | 'chunkCount'>): string {
  return isDocumentSearchable(item.status) ? String(item.chunkCount) : CHUNK_COUNT_PLACEHOLDER
}

/** 一行文档能做哪些操作 */
export interface DocumentActions {
  canDownload: boolean
  canReupload: boolean
  canRetry: boolean
  /** 「查看片段」—— 只有 `READY` 才有块可看（见下方矩阵） */
  canPreviewChunks: boolean
  canDelete: boolean
  /** 「重试」按钮的说明（两种状态下的含义不同，见下） */
  retryHint: string
}

/**
 * 按状态决定行内操作（**这是本页最容易"多做一步"的地方**）。
 *
 * | 状态 | 下载 | 覆盖重传 | 重试 | 查看片段 | 删除 |
 * |------|------|---------|------|---------|------|
 * | `PARSING` | ✅ | ❌ | ✅ | ❌ | ✅ |
 * | `READY` | ✅ | ✅ | ❌ | ✅ | ✅ |
 * | `FAILED` | ✅ | ✅ | ✅ | ❌ | ✅ |
 *
 * 三处判据的理由（**都不是"看着更整齐"**）：
 *   · **下载 / 删除任何状态都可用**：原始文件在上传成功那一刻就在 S3 里了（`PARSING` 是"内容
 *     还没进库"，不是"文件还没到"）；删除同理 —— 后端不按状态拦，用户要能清理自己的东西。
 *   · **`READY` 不给「重试」**：后端对它回 **409**（"没有东西可重试"）。摆一个必然失败的按钮
 *     比不摆更糟 —— 用户会以为"点了没反应"是页面坏了。
 *   · **`PARSING` 给「重试」**：这是 `子方案①` §三 刻意留的**恢复入口**（worker 崩了 / 入队丢了
 *     时，那一篇会永远停在"解析中"），后端对它**放行**。所以它的说明文案是"长时间停在解析中
 *     时可重新入队"而不是"重试失败"。**不因为"解析中看着像在忙"就禁用** —— 那会让唯一的
 *     恢复入口在界面上消失。
 *   · **`PARSING` 不给「覆盖重传」**：后端虽然允许（`PARSING → PARSING` 是合法迁移），但那是
 *     "排队里已有一个 job 时再插一个" —— 语义是"换内容"，而用户此刻看到的是"正在解析"，
 *     提供它只会制造两次流水线抢同一行。要换内容，先等它落定或先删掉重传（两者都在行内）。
 *   · **「查看片段」只在 `READY` 给**：`PARSING` / `FAILED` 时 `chunk_count` 恒为 0
 *     （覆盖重建是"先删后建"、失败也可能已在删除阶段清过块）⇒ 打开只会是空抽屉。
 *     判据用 `isDocumentSearchable`（与「片段数」列**同源**，不写字面量比较）——
 *     两处若各写一份 `status === 'READY'`，将来语义再变时会先腐烂一处。
 */
export function documentActions(status: DocumentStatus): DocumentActions {
  return {
    canDownload: true,
    canReupload: status !== 'PARSING',
    canRetry: status !== 'READY',
    canPreviewChunks: isDocumentSearchable(status),
    canDelete: true,
    retryHint:
      status === 'PARSING' ? '长时间停在「解析中」时可重新入队' : '重新入队解析（失败原因多来自扫描件或格式问题）',
  }
}

/**
 * 一页文档的状态分布（详情页右侧的"体量"卡用）。
 *
 * ⚠️ **只有"文档总数"能拿权威值**（`KnowledgeBaseItem.documentCount`，服务端 `count` 出来的），
 * 这个函数算出来的是**当前这一页**的分布 —— 所以页面上的文案必须写明"按本页 N 篇统计"，
 * 不能写成"库里有 3 篇失败"（那是在说全库，而我们从没查过全库）。
 * 原型上那句"213 个片段"同理取不到：没有任何端点回答"这个库一共有多少 chunk"
 * （文档列表只给每篇的 `chunkCount`）—— 取不到的数字就如实不显示。
 */
export interface DocumentSummary {
  total: number
  readable: number
  parsing: number
  failed: number
}

export function summarizeDocuments(
  items: readonly Pick<DocumentItem, 'status'>[],
): DocumentSummary {
  const summary: DocumentSummary = { total: items.length, readable: 0, parsing: 0, failed: 0 }
  for (const item of items) {
    if (item.status === 'READY') summary.readable += 1
    else if (item.status === 'PARSING') summary.parsing += 1
    else summary.failed += 1
  }
  return summary
}

// ───────────────────────────── 状态轮询 ─────────────────────────────
/**
 * 轮询间隔（`06` P0-1-35 的坑预判：`PARSING` 中的文档要自己刷新）。
 *
 * 2s 是 `docs/06` §七 待决事项 5 写下的口径（"2s 间隔 + 终止条件（全部终态即停）"），
 * 本批把它落成常量 —— 窗口类参数写成常量才能被断言（"有解析中 ⇒ 2000；全终态 ⇒ false"）。
 */
export const DOCUMENT_POLL_INTERVAL_MS = 2000

/** 这一页里还有没有正在解析的文档 */
export function shouldPollDocuments(items: readonly Pick<DocumentItem, 'status'>[] | undefined): boolean {
  if (items === undefined) return false
  return items.some((item) => item.status === 'PARSING')
}

/**
 * `refetchInterval` 的返回值：**有解析中的文档就 2s 轮询，否则停**。
 *
 * ⚠️ 终止条件是这一段的意义所在：不写它就会**永远每 2s 打一次后端**（页面停在知识库详情页
 * 开着过夜也一样）。反过来，`items === undefined`（还没取到第一页数据）也不轮询
 * —— 首次加载由 `useQuery` 自己发起，不需要再叠一层定时器。
 */
export function documentRefetchInterval(items: readonly Pick<DocumentItem, 'status'>[] | undefined): number | false {
  return shouldPollDocuments(items) ? DOCUMENT_POLL_INTERVAL_MS : false
}

// ───────────────────────────── 检索配置的展示 ─────────────────────────────

export const RETRIEVAL_MODE_LABEL: Readonly<Record<RetrievalMode, string>> = {
  HYBRID: '向量 + 全文',
  VECTOR: '仅向量',
  FULLTEXT: '仅全文',
}

export const SPLIT_STRATEGY_LABEL: Readonly<Record<SplitStrategy, string>> = {
  hybrid: '按标题切（回退定长）',
  fixed: '定长切分',
}

/** 一句话说清这个库的检索口径（详情页头部与「检索测试」抽屉的 tag 都用它） */
export function describeRetrieval(config: RetrievalConfig): string {
  const weights = config.weights
  return (
    `${RETRIEVAL_MODE_LABEL[config.mode]} · topK ${config.topK} · 相似度下限 ${config.score} · ` +
    `RRF k=${config.rrfK}（权重 ${weights.vector}/${weights.fulltext}）`
  )
}

/** 分块口径（`chunkSize` / `chunkOverlap` 的单位是**字符**，不是 token —— `shared` 的注释） */
export function describeChunking(kb: Pick<KnowledgeBaseItem, 'chunkSize' | 'chunkOverlap' | 'retrievalConfig'>): string {
  return `${kb.chunkSize} 字 / 重叠 ${kb.chunkOverlap} 字 · ${SPLIT_STRATEGY_LABEL[kb.retrievalConfig.splitStrategy]}`
}

export interface EmbeddingNotice {
  tone: 'warn' | 'info'
  text: string
}

/**
 * `embeddingModelChanged` 的三态 → 一句提示（`null` = 一切正常）。
 *
 * ⚠️ **三态不能压成布尔**（`shared/src/knowledgeBase.ts` 的字段注释）：`true` 是"该库需重建"
 * （业务的活），`null` 是"服务端 embedding 未就绪、判断不了"（运维的活）。合报会让用户去
 * 重做一个治不好的动作（P0-1-20 已为同一对原因立过规矩：**两条原因分开报**）。
 */
export function embeddingChangedNotice(changed: boolean | null): EmbeddingNotice | null {
  if (changed === true) {
    return {
      tone: 'warn',
      text: '该库快照的 embedding 模型与当前服务端不一致：向量路会被跳过（需要重建该库才能恢复向量检索）。',
    }
  }
  if (changed === null) {
    return {
      tone: 'info',
      text: '当前无法判定 embedding 模型是否变更（服务端 embedding 未就绪）。这不影响全文检索。',
    }
  }
  return null
}

// ───────────────────────────── 检索测试结果 ─────────────────────────────

/**
 * **未命中的一路显示 `—`（不是 0）**。
 *
 * `docs/02` §4.6 的 `null` 语义："某一路没命中 ⇒ 该路的 `score`/`rank` 都是 `null`
 * （**不是 0**）：RRF 的规则是'缺失即无贡献'；显示 0 会让人以为'两路都算了，只是很低'"。
 * 原型那一行也是 `—`（`design/knowledge.html` 第 310 行）。
 */
export const SCORE_PLACEHOLDER = '—'

/** 相似度（0~1）两位小数：`0.88`。**与下面的 RRF 分不是同一个量级，不能共用一个格式** */
export function similarityText(score: number | null): string {
  return score === null ? SCORE_PLACEHOLDER : score.toFixed(2)
}

/**
 * RRF 融合分四位小数：`0.0320`。
 *
 * ⚠️ 为什么必须与相似度分开：RRF 分是 `w/(k+rank)` 之和，量级在 `0.01~0.05`。用两位小数
 * 会把一屏结果**全部显示成 `0.03`** —— 用户看不出名次差别，会以为"融合没起作用"
 * （`06` P0-1-20 已把文档里那个 `0.0323` 实测订正为 `0.0320`，同一族的"数字要实测再写"）。
 */
export function rrfScoreText(score: number): string {
  return score.toFixed(4)
}

/** 名次：`#1`；未命中该路时为 `—` */
export function rankText(rank: number | null): string {
  return rank === null ? SCORE_PLACEHOLDER : `#${rank}`
}

/**
 * 结果表的「来源」列。
 *
 * ⚠️ **原型写的是「命中库」，本页改成「来源文档」（并另加页码/块号）**：
 * 这个端点是 `POST /api/knowledge-bases/:id/search` —— **库是路径参数给定的**，
 * 所以"命中库"这一列的信息量恒等于当前库名（一屏全是同一个值）。响应里真正带来源信息的
 * 字段是 `docName` / `page` / `seq`（`retrievalHitSchema`）。显示一列恒定值不是"忠于原型"，
 * 而是把一列有用信息换成了一句废话（`03` §七：不造假；`06` §六：原型的**数值与口径**以契约
 * 为准）。库名已经在页面标题与抽屉副标题上了。
 */
export function hitSourceText(hit: Pick<RetrievalHit, 'docName' | 'page' | 'seq'>): string {
  return hit.page === null ? `${hit.docName} · 块 #${hit.seq}` : `${hit.docName} · 第 ${hit.page} 页`
}

// ───────────────────────────── 片段预览（P0-1-35 增量）─────────────────────────────

/**
 * 片段预览里一行的位置说明：块号（必有）+ 页码（PDF 才有）+ 标题层级（可空）。
 *
 * 三段各自**按数据有无**决定是否出现，而不是拼一个固定模板：非 PDF 没有页码、定长切分没有
 * 标题层级 —— 给它们补一个 `第 — 页` / `（无标题）` 只是噪音（与 `hitSourceText` 同款取舍）。
 * `headingPath` 用 ` / ` 连接，对应流水线写入的层级数组（`子方案①` §4-4）。
 */
export function chunkLocationText(chunk: Pick<ChunkItem, 'seq' | 'page' | 'headingPath'>): string {
  const parts = [`块 #${chunk.seq}`]
  if (chunk.page !== null) parts.push(`第 ${chunk.page} 页`)
  if (chunk.headingPath.length > 0) parts.push(chunk.headingPath.join(' / '))
  return parts.join(' · ')
}

/**
 * 片段字数（预览里用等宽小字标出）—— 让人一眼看出"这块是不是被切得太碎/太长"。
 * 用 `[...text].length` 码点数而不是 `text.length`：与后端分块/窗口的**码点口径**一致
 * （`retrieval.ts#buildSnippet` 同款），否则含 emoji 的块会数出偏移的字数。
 */
export function chunkLengthText(content: string): string {
  return `${[...content].length} 字`
}

export interface SearchNotice {
  tone: 'info' | 'warn'
  text: string
}

/**
 * 检索结果上方的横幅（`null` = 不显示）。
 *
 * 三条互斥的结论，**顺序即优先级**：
 *   ① 向量路被跳过（`vectorPathSkipped`）—— 必须说，否则"只有全文路在起作用"这件事
 *      会表现为"某些该出现的结果没出现"，而用户会去怀疑库里没内容；
 *   ② 一条都没命中 —— 说明是"库里可能没有相关内容"，不是"页面坏了"；
 *   ③ 其余正常 —— 不显示。
 *
 * 文案取自 `warnings`（服务端已经写好的中文，如"该知识库使用的 embedding 模型已变更…"
 * 或"服务端 embedding 未就绪…"）—— **前端不重新拼一句**：那两个原因对应两种完全不同的
 * 下一步动作（重建库 vs 找运维）。
 */
export function searchNotice(result: {
  items: readonly unknown[]
  vectorPathSkipped: boolean
  warnings: readonly string[]
}): SearchNotice | null {
  if (result.vectorPathSkipped) {
    const reason = result.warnings[0]
    return {
      tone: 'warn',
      text:
        reason === undefined
          ? '本次没有走向量路（服务端未说明原因），结果只来自全文检索。'
          : `本次没有走向量路：${reason}`,
    }
  }
  if (result.items.length === 0) {
    return { tone: 'info', text: '没有命中任何内容。全文路是字面匹配，长问句很难命中 —— 可以换更短的关键词再试。' }
  }
  return null
}

// ───────────────────────────── 建库 / 改库的表单 ─────────────────────────────

/**
 * 建库表单。
 *
 * ⚠️ `chunkSize` / `chunkOverlap` 的 `null` = **"留空，交给服务端的环境默认值"**
 * （`shared` 的 `createKnowledgeBaseBodySchema` 注释：省略时服务层用
 * `CHUNK_SIZE_DEFAULT` / `CHUNK_OVERLAP_DEFAULT` 快照）。
 *
 * **前端刻意不预填数字**：那两个默认值来自部署环境（`infra/.env`），前端读不到 ——
 * 预填一个"看起来合理"的 800/64 就等于把前端的猜测当成用户的选择提交上去，
 * 悄悄覆盖掉部署环境的默认值，而且用户完全看不出来（字段里明明是他没动过的数字）。
 */
export interface KnowledgeCreateFormValues {
  name: string
  description: string
  /** 建库时**选定**的 embedding 模型 id（模型池 `type=EMBEDDING`）；必填 */
  embeddingModelId: string
  /** 图片描述模型 id（P1-11，可选；空串 = 不启用图片描述） */
  captionModelId: string
  chunkSize: number | null
  chunkOverlap: number | null
}

export const EMPTY_KNOWLEDGE_FORM_VALUES: KnowledgeCreateFormValues = {
  name: '',
  description: '',
  embeddingModelId: '',
  captionModelId: '',
  chunkSize: null,
  chunkOverlap: null,
}

/**
 * 建库请求体。
 *
 * · `description` 空串 ⇒ **不带这个键**（建库时 `null` 与省略同义，省略更干净）；
 * · `chunkSize` / `chunkOverlap` 为 `null` ⇒ **不带**（见上）；
 * · 只填了其中一个时**前端无法**做跨字段校验（另一个是服务端的环境默认值）⇒ 交给后端
 *   （`assertChunkWindow` 会回 400 + 明确文案）。这不是"漏了校验"，而是前端**没有**这个信息。
 */
export function buildCreateBody(values: KnowledgeCreateFormValues): {
  name: string
  embeddingModelId: string
  captionModelId?: string
  description?: string
  chunkSize?: number
  chunkOverlap?: number
} {
  const body: {
    name: string
    embeddingModelId: string
    captionModelId?: string
    description?: string
    chunkSize?: number
    chunkOverlap?: number
  } = { name: values.name.trim(), embeddingModelId: values.embeddingModelId }

  const description = values.description.trim()
  if (description !== '') body.description = description
  // 图片描述模型为空 ⇒ 不带这个键（建库时 null 与省略同义，省略更干净）。
  // `?? ''` 兜住"夹具/老调用方没给该字段"（undefined）的情形。
  const captionModelId = values.captionModelId ?? ''
  if (captionModelId !== '') body.captionModelId = captionModelId
  if (values.chunkSize !== null) body.chunkSize = values.chunkSize
  if (values.chunkOverlap !== null) body.chunkOverlap = values.chunkOverlap
  return body
}

/** 详情页"编辑基本信息"的表单值（值都已知，所以是 `number` 而不是 `number | null`） */
export interface KnowledgeEditFormValues {
  name: string
  description: string
  /** 当前选定的向量模型 id（老库为 `''`，表示没有） */
  embeddingModelId: string
  /** 当前选定的图片描述模型 id（`''` = 未启用图片描述） */
  captionModelId: string
  chunkSize: number
  chunkOverlap: number
}

export function editValuesOf(kb: KnowledgeBaseItem): KnowledgeEditFormValues {
  return {
    name: kb.name,
    description: kb.description ?? '',
    embeddingModelId: kb.embeddingModelId ?? '',
    captionModelId: kb.captionModelId ?? '',
    chunkSize: kb.chunkSize,
    chunkOverlap: kb.chunkOverlap,
  }
}

/**
 * 编辑表单里是否**换了向量模型**（P1-5）。
 *
 * 判据只有"选中的 id 与库当前的不同"这一条 —— 空串（老库没绑模型）与某个 id 比较时也算换。
 * 弹窗据此：① 显示"换模型需重建"的告警；② 保存成功后直接引导触发整库重建。
 */
export function isEmbeddingModelChanged(baseline: KnowledgeBaseItem, embeddingModelId: string): boolean {
  return embeddingModelId !== '' && embeddingModelId !== (baseline.embeddingModelId ?? '')
}

/**
 * 跨字段校验：重叠必须小于分块（与后端 `assertChunkWindow` 同义）。
 *
 * 前端判是为了**当场**把错误指到输入框上；即便这里漏判，后端也会 400
 * （`chunkOverlap（N）必须小于 chunkSize（M），否则分块无法前进`）。
 */
export function validateChunking(chunkSize: number, chunkOverlap: number): string | null {
  if (chunkOverlap >= chunkSize) {
    return `重叠字符数（${chunkOverlap}）必须小于分块字符数（${chunkSize}），否则分块无法前进`
  }
  return null
}

/**
 * `PATCH /api/knowledge-bases/:id` 的请求体：**只放真的变了的字段**（三态，见下）。
 *
 * 三态与 `description` 的语义（`shared/src/knowledgeBase.ts` 的注释）：
 * **不带 = 不动 ｜ `null` = 清空 ｜ 值 = 设置**。所以"把描述清空"必须提交 `null`，
 * 而"只改了名字"绝不能带上 `description` —— 带上 `null` 会把描述清掉（这是最坏的一种）。
 *
 * 没有任何变化时返回 `null`，调用方据此**不发请求**（省一次写，也省掉一次
 * "保存成功"其实什么都没改的误导）。
 */
export function buildKnowledgeUpdateBody(
  baseline: KnowledgeBaseItem,
  values: KnowledgeEditFormValues,
): UpdateKnowledgeBaseBody | null {
  const body: UpdateKnowledgeBaseBody = {}

  const name = values.name.trim()
  if (name !== baseline.name) body.name = name

  const currentDescription = baseline.description ?? ''
  if (values.description.trim() !== currentDescription) {
    // 空串 ⇒ `null`（清空）；非空 ⇒ 归一化后的值
    body.description = values.description.trim() === '' ? null : values.description.trim()
  }

  if (values.chunkSize !== baseline.chunkSize) body.chunkSize = values.chunkSize
  if (values.chunkOverlap !== baseline.chunkOverlap) body.chunkOverlap = values.chunkOverlap
  // 换模型：只在真的选了新模型时带上（空串不是"清空模型"，schema 也不接受 null）
  if (isEmbeddingModelChanged(baseline, values.embeddingModelId)) {
    body.embeddingModelId = values.embeddingModelId
  }

  // 图片描述模型（P1-11）三态：空串 = 清除（仅当原来有值时提交 `null`）/ 选了新值 = 设值
  const captionModelId = values.captionModelId ?? ''
  if (captionModelId === '') {
    // `?? null` 兜住"老契约/夹具里没有该字段"（undefined）的情形 —— 与 null 同义，都表示"原本没有"
    if ((baseline.captionModelId ?? null) !== null) body.captionModelId = null
  } else if (captionModelId !== baseline.captionModelId) {
    body.captionModelId = captionModelId
  }

  return Object.keys(body).length === 0 ? null : body
}

/** 详情页"检索配置"弹窗的表单值（weights 摊成两个字段，AntD 的表单控件不接受嵌套对象） */
export interface RetrievalFormValues {
  mode: RetrievalMode
  topK: number
  score: number
  rrfK: number
  splitStrategy: SplitStrategy
  vectorWeight: number
  fulltextWeight: number
}

export function retrievalValuesOf(kb: KnowledgeBaseItem): RetrievalFormValues {
  return {
    mode: kb.retrievalConfig.mode,
    topK: kb.retrievalConfig.topK,
    score: kb.retrievalConfig.score,
    rrfK: kb.retrievalConfig.rrfK,
    splitStrategy: kb.retrievalConfig.splitStrategy,
    vectorWeight: kb.retrievalConfig.weights.vector,
    fulltextWeight: kb.retrievalConfig.weights.fulltext,
  }
}

/**
 * 检索配置的 `PATCH` 体：**逐键比较，只带变了的键**。
 *
 * `retrievalConfig` 在服务端是**局部合并**（给的键覆盖当前值，没给的保持不动）⇒
 * 逐键提交与"提交完整对象"结果相同，但逐键能让请求体本身说明"用户动了什么"。
 * **两个权重必须一起给**（schema 里 `weights` 的 `.object()` 要求两个键都在，
 * 给一半会被 400 —— 而"只改了一个权重"在界面上是常见操作，所以这里只要任一权重变了
 * 就把整个 `weights` 带上）。
 */
export function buildRetrievalPatch(
  baseline: KnowledgeBaseItem,
  values: RetrievalFormValues,
): UpdateKnowledgeBaseBody | null {
  const current = baseline.retrievalConfig
  const patch: NonNullable<UpdateKnowledgeBaseBody['retrievalConfig']> = {}
  let changed = false

  if (values.mode !== current.mode) {
    patch.mode = values.mode
    changed = true
  }
  if (values.splitStrategy !== current.splitStrategy) {
    patch.splitStrategy = values.splitStrategy
    changed = true
  }
  if (values.topK !== current.topK) {
    patch.topK = values.topK
    changed = true
  }
  if (values.score !== current.score) {
    patch.score = values.score
    changed = true
  }
  if (values.rrfK !== current.rrfK) {
    patch.rrfK = values.rrfK
    changed = true
  }
  if (values.vectorWeight !== current.weights.vector || values.fulltextWeight !== current.weights.fulltext) {
    patch.weights = { vector: values.vectorWeight, fulltext: values.fulltextWeight }
    changed = true
  }

  return changed ? { retrievalConfig: patch } : null
}

