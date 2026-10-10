/**
 * 会话记忆文档（**TaskAgent 记忆与产物 块 1**）
 *
 * 依据：`docs/子方案/TaskAgent记忆与产物.md`（问题 1「容器回收后 agent 失忆」+ §二 决策 1、
 *      §三 块 1）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它解决什么：容器是**易失**的，而"这个会话聊过什么、产出过哪些文件"不该跟着丢
 * ═══════════════════════════════════════════════════════════════════════
 * `recycleSandbox` 会把容器与具名卷一起删掉（`/work` 没了），而 pi 的记忆（`/tmp/pi-agent`）
 * 在 tmpfs 上 —— 容器一收，agent 就"失忆"了。产物本体其实**一直都在**
 * （S3 对象 + `artifacts` 行 + 消息 `content.artifacts` 段），缺的只是**把它回馈给引擎的通道**。
 *
 * ★ 判据：**记忆内容随时可从 DB 推导 ⇒ 不挑时机、不存状态。**
 *   有两种"放错地方"的写法，都会被这条判据否掉：
 *     · **回收时生成** —— 回收连同 `/work` 卷一起删，文件放容器里等于白生成；
 *     · **只在建容器时写一次** —— 复用容器跑第二轮时记忆是旧的。
 *   ⇒ 正确做法是**每次派活前从 DB 现组装**（`buildMemoryDoc`）再写进容器
 *   （`writeMemoryDoc`）：容器重建后照样写入，复用容器时也是最新的。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 顺序：写记忆 → 拍基线 → 派活 → 收产物（`taskAgent.ts` ③.5 之前的硬约束）
 * ═══════════════════════════════════════════════════════════════════════
 * 记忆文档每次派活都会变（对话又多了几轮）。若基线在写它**之后**拍，它就永远落在基线里
 * ⇒ 永远不会被当成本轮新产物收集。顺序必须钉死（调用点是 `taskAgent.ts`）。
 * ⚠️ 另有一道**结构性**保险：文件写在 `/work/.doubulea/` 下，路径里带 `.` 开头的段
 * ⇒ `sandbox/artifacts.ts#filterChangedFiles` 的"隐藏文件跳过"规则天然排除它 ——
 * 即便顺序写反，它也不会被当产物上传。两道一起，任一道单独失效都还有另一道兜着。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 失败不落轮（记忆是本轮的**赠品**）
 * ═══════════════════════════════════════════════════════════════════════
 * 写不进去（容器刚好卡死 / 卷只读 / exec 超时）只 warn：agent 这一轮少看到一份记忆，
 * 但它照样能干活。把它升级成"这一轮失败"会把一个可降级的功能变成一次不可用。
 */

import type { AttachmentItem } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { ARTIFACT_EXEC_TIMEOUT_MS, SANDBOX_WORK_DIR } from '../sandbox/index.js'
import { execInSandbox } from '../sandbox/docker.js'
import { listConversationAttachments } from '../services/file.service.js'
import { MESSAGE_CHRONO_ORDER } from '../services/conversation.service.js'
import { buildMemoryToc, buildUserProfileBlock } from '../services/memory.service.js'
import { getSummariesFor } from '../services/memorySummary.service.js'
import { textOfHistoryRow, type HistoryRow } from './chatContext.js'

/** 记忆文档里一条产物要用的读数（**窄到不能再窄** —— 纯渲染函数只认这四项，不认 Prisma 模型） */
export interface MemoryDocArtifact {
  id: string
  fileName: string
  size: number
  mime: string
}

/**
 * 记忆文档带**最近多少轮**对话（一轮 = 一问一答 ⇒ 取 `×2` 条消息）。
 *
 * 与上下文窗口（`CONTEXT_ROUNDS=20`，`02` §六）刻意不同：那一份是**喂给模型的实时上下文**，
 * 这一份是**给"失忆后重新开始的 agent"看的背景**，越短越好读（而且要连同下面的产物清单
 * 一起塞进一份 Markdown）。写死在代码里而不是做成 env：它不是"行为窗口"，改它不改变契约
 * （与 `map.ts` 的 `TOOL_SUMMARY_MEMO_LIMIT` 同款取舍）。
 */
export const MEMORY_DOC_ROUNDS = 10

/** 记忆文档里最多列几条产物（超出只给计数，避免一份 Markdown 长到读不完） */
export const MEMORY_DOC_MAX_ARTIFACTS = 50

/** 单条消息正文进记忆时的**码点**上限（超长回答只留开头，够 agent 认出"聊过这件事"即可） */
export const MEMORY_DOC_MESSAGE_MAX_CHARS = 2000

/** 记忆文档在容器里的目录与文件名（以 `.` 开头 ⇒ 产物扫描天然排除，见文件头） */
export const MEMORY_DOC_DIR = `${SANDBOX_WORK_DIR}/.doubulea`
export const MEMORY_DOC_PATH = `${MEMORY_DOC_DIR}/memory.md`

/** {@link buildMemoryDoc} 的产物：文档正文 + "这份文档值不值得让引擎去读" */
export interface MemoryDocResult {
  markdown: string
  /**
   * 文档里有没有**值得 agent 先读**的内容（历史对话或产物非空）。
   * `false` = 全新会话的第一轮：文档只有空标题，派活时**不必**让引擎白读一次
   * （见 `MEMORY_DOC_READ_INSTRUCTION`）。
   */
  hasContent: boolean
}

/**
 * 从 DB 组装一份记忆文档（**只读**；不碰容器）。
 *
 * 两份输入都是"这个会话自己的东西"（消息 + 产物），没有任何跨会话数据 ⇒ 文档里不会出现
 * 别的用户的内容。⚠️ 它是**我们拼的固定骨架 + 用户数据**：用户数据只做**转义/截断**，
 * 不做任何"猜测解析"（与 `chatContext.ts#textOfHistoryRow` 的兜底同一条口径 —— `content`
 * 是 jsonb，跨版本读，坏行当作"没有正文"而不是让整份记忆失败）。
 */
export async function buildMemoryDoc(conversationId: string): Promise<MemoryDocResult> {
  const db = getPrisma()

  // ── 最近 N 轮对话（`MESSAGE_CHRONO_ORDER` 是"新 → 旧"⇒ 取完再 reverse 成"旧 → 新"）──
  const rows = await db.message.findMany({
    where: { conversationId },
    orderBy: [...MESSAGE_CHRONO_ORDER],
    take: MEMORY_DOC_ROUNDS * 2,
    select: { role: true, content: true },
  })
  const history = [...rows].reverse() as HistoryRow[]

  // ── 该会话的产物清单（`created_at desc`，最近产出的在最上面）──
  const artifacts = await db.artifact.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: MEMORY_DOC_MAX_ARTIFACTS,
    select: { id: true, fileName: true, size: true, mime: true },
  })
  const artifactTotal = await db.artifact.count({ where: { conversationId } })

  // ── 该会话收到过的附件清单（用户上传；按消息时间先后、按 fileId 去重）──
  //    附件本体同样在 S3 里、随容器走的是副本 ⇒ 容器重建后要把"有哪些、怎么取回"讲给 agent。
  const attachments = await listConversationAttachments(conversationId)

  // ── L1 会话小结 + L2 长期记忆 v2（P1-8a）──
  //    TaskAgent 没有 system 通道（`02` §六：只有一条 `prompt`）⇒ 长期记忆经**记忆文档**注入
  //    （§4.5 的两条注入路径之一，与 ChatBot 的 system prompt 同源）。
  //    ⚠️ v2：USER 画像常驻 + AGENT 记忆**只给极简目录 TOC**（不含正文）；细节由 agent 调
  //    `recall_memory` 按需拉取（见 `子方案` §8.4/§8.4b）。
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true, agentId: true },
  })
  let profileBlock = ''
  let tocBlock = ''
  let summaryText: string | null = null
  if (conversation !== null) {
    profileBlock = (await buildUserProfileBlock({ userId: conversation.userId })).block
    tocBlock = (await buildMemoryToc({ userId: conversation.userId, agentId: conversation.agentId })).block
    summaryText = (await getSummariesFor([conversationId])).get(conversationId) ?? null
  }

  // "有没有值得读的内容"与渲染同源：历史里有**非空正文**的消息，或有产物，或有附件
  const hasHistory = history.some((row) => textOfHistoryRow(row).trim() !== '')
  return {
    markdown: renderMemoryDoc({
      conversationId,
      history,
      artifacts,
      artifactTotal,
      attachments,
      summaryText,
      profileBlock,
      tocBlock,
    }),
    hasContent:
      hasHistory ||
      artifacts.length > 0 ||
      attachments.length > 0 ||
      summaryText !== null ||
      profileBlock !== '' ||
      tocBlock !== '',
  }
}

/**
 * 派活时**前置给引擎**的阅读指令（`TaskAgent记忆与产物` 块 1 的"让 agent 去读"那一步）。
 *
 * ⚠️ **为什么必须由后端在 prompt 里带，而不是指望 pi 自动读**（这是方案落地时最容易漏的一环）：
 *   · pi 会自动加载的上下文文件只有 `/work/AGENTS.md`（或 `CLAUDE.md`）—— 但它在**进程启动时
 *     读一次**。容器重建时 `/work` 是空的、记忆文档是在 pi 起来**之后**才写进去的 ⇒ 那条路
 *     在关键路径上必然读不到（写进去也不会被重读）；
 *   · 所以可靠的触发点只有一个：**每次派活时把"先读这份记忆"作为指令带进 prompt**。
 *     它只影响发给引擎的那份消息，**不落库**（落库仍是用户原文，见 `taskAgent.ts` 的接线）。
 *
 * 只给**路径与理由**、不把正文塞进 prompt：正文可能有几 KB，塞进每轮会平白烧 token；
 * 而 pi 的 `read` 工具读一个小文件很便宜。`hasContent === false`（全新会话第一轮）时不加。
 */
export function memoryDocReadInstruction(): string {
  return (
    '【会话记忆】本会话在容器之外保存了一份记忆文档（此前对话摘要 + 已产出文件清单 + ' +
    '用户上传过的附件清单 + 按需取回文件的方法），路径：`' +
    MEMORY_DOC_PATH +
    '`。\n' +
    '在开始处理下面这条消息前，请先用 read 工具读取该文件，以便了解本会话之前发生过什么、' +
    '已经产出过哪些文件、以及用户上传过哪些附件（需要时可按文档里的命令把它们取回 /work）。'
  )
}

/**
 * 纯渲染（**不碰 DB / Docker**）—— 单独拆出来是为了它能被逐字核对（喂一段历史 + 一份产物
 * 清单、比生成的 Markdown）。
 */
export function renderMemoryDoc(input: {
  conversationId: string
  history: readonly HistoryRow[]
  artifacts: readonly MemoryDocArtifact[]
  artifactTotal: number
  attachments: readonly AttachmentItem[]
  /** L1 会话小结正文（P1-8；`null` = 还没有小结） */
  summaryText?: string | null
  /** USER 画像常驻段（P1-8a；空串 = 无画像/未启用） */
  profileBlock?: string
  /** AGENT 记忆极简目录 TOC（P1-8a；空串 = 无可记内容/未启用） */
  tocBlock?: string
}): string {
  const lines: string[] = []

  lines.push('# 会话记忆（系统自动维护，请勿删除本文件）')
  lines.push('')
  lines.push(
    '> 这是本会话在**容器之外**保存的一份记忆。容器被回收后 `/work` 与引擎的临时记忆都会清空，' +
      '但这份文档会在每次派活前重新生成 —— 于是你（agent）**始终知道**这个会话聊过什么、产出过哪些文件。',
  )
  lines.push('')

  // ── 会话小结（L1，P1-8）──
  const summaryText = input.summaryText ?? null
  if (summaryText !== null && summaryText.trim() !== '') {
    lines.push('## 本会话小结')
    lines.push('')
    lines.push(summaryText.trim())
    lines.push('')
  }

  // ── 用户画像（USER 常驻，P1-8a）──
  const profileBlock = input.profileBlock ?? ''
  if (profileBlock !== '') {
    lines.push('## 用户画像（跨会话）')
    lines.push('')
    lines.push(profileBlock)
    lines.push('')
  }

  // ── Agent 记忆目录（AGENT，P1-8a；只给主题线索，细节用 recall_memory 查）──
  const tocBlock = input.tocBlock ?? ''
  if (tocBlock !== '') {
    lines.push('## 本 Agent 记忆目录')
    lines.push('')
    lines.push(tocBlock)
    lines.push('')
  }

  // ── 对话摘要 ──
  lines.push('## 最近的对话')
  lines.push('')
  if (input.history.length === 0) {
    lines.push('（暂无历史对话）')
  } else {
    let emitted = 0
    for (const row of input.history) {
      if (row.role === 'SYSTEM') continue
      const text = textOfHistoryRow(row).trim()
      if (text === '') continue
      const speaker = row.role === 'USER' ? '用户' : '助手'
      lines.push(`- **${speaker}**：${truncateByCodePoint(text, MEMORY_DOC_MESSAGE_MAX_CHARS)}`)
      emitted += 1
    }
    if (emitted === 0) lines.push('（暂无历史对话）')
  }
  lines.push('')

  // ── 产物清单 ──
  lines.push('## 本会话产出过的文件')
  lines.push('')
  if (input.artifacts.length === 0) {
    lines.push('（本会话还没有产出过文件）')
  } else {
    lines.push('| 产物 ID | 文件名 | 大小 | 类型 |')
    lines.push('|---------|--------|------|------|')
    for (const artifact of input.artifacts) {
      lines.push(
        `| \`${artifact.id}\` | \`${escapeCell(artifact.fileName)}\` | ${formatBytes(artifact.size)} | \`${escapeCell(artifact.mime)}\` |`,
      )
    }
    if (input.artifactTotal > input.artifacts.length) {
      lines.push('')
      lines.push(
        `（以上是最新的 ${input.artifacts.length} 个，本会话共 ${input.artifactTotal} 个产物；更早的未列出）`,
      )
    }
  }
  lines.push('')

  // ── 附件清单（用户上传过、被引用在本会话消息里的文件）──
  lines.push('## 本会话收到过的附件（用户上传）')
  lines.push('')
  if (input.attachments.length === 0) {
    lines.push('（本会话还没有收到过附件）')
  } else {
    lines.push('| 附件 ID | 文件名 | 大小 | 类型 |')
    lines.push('|---------|--------|------|------|')
    for (const attachment of input.attachments) {
      lines.push(
        `| \`${attachment.fileId}\` | \`${escapeCell(attachment.name)}\` | ${formatBytes(attachment.size)} | ${attachment.kind} |`,
      )
    }
  }
  lines.push('')

  // ── 如何按需取回（块 2 的下载通道）──
  lines.push('## 如何取回某个产物 / 附件')
  lines.push('')
  lines.push(
    '产物与附件本体都存在对象存储里，容器内**没有**这些文件（容器重建后 `/work` 会被清空）。' +
      '需要时用下面的命令按需下载回 `/work`：',
  )
  lines.push('')
  lines.push('```bash')
  lines.push(NODE_FETCH_DOWNLOAD_COMMAND)
  lines.push('```')
  lines.push('')
  lines.push(
    '- `<产物ID>` 用上表「产物 ID」那一列；`<保存路径>` 是相对 `/work` 的目标路径（例如 `out/report.csv`）。',
  )
  lines.push('')
  lines.push('```bash')
  lines.push(NODE_FETCH_ATTACHMENT_COMMAND)
  lines.push('```')
  lines.push('')
  lines.push('- `<附件ID>` 用上表「附件 ID」那一列（用户上传的文件用它取回；`<保存路径>` 同上）。')
  lines.push(
    '- 环境变量 `SANDBOX_BACKEND_URL`（后端地址）与 `SANDBOX_TOKEN`（本容器身份令牌）**已经注入**，命令里直接引用即可，不要打印或外传。',
  )
  lines.push(
    '- 镜像**刻意没装 `curl` / `wget`**，上面这两条用容器里已有的 `node` + 内置 `fetch`（这也是它们长这样的原因）。',
  )
  lines.push('')

  return lines.join('\n')
}

/**
 * 容器内按需下载产物的命令（**给 agent 照着抄**，不是我们执行的代码）。
 *
 * 写成"单引号包住整段 node 脚本 + 两个位置参数"而不是把 id 拼进字符串，是为了让 agent
 * **替换位置参数**即可，不必手改脚本正文；同时脚本里没有反引号、没有 `$` 展开，
 * agent 无论用什么方式粘贴都不会被 shell 二次解释。
 */
export const NODE_FETCH_DOWNLOAD_COMMAND =
  'node -e \'const id=process.argv[1],out=process.argv[2];' +
  'fetch(process.env.SANDBOX_BACKEND_URL+"/api/sandbox/artifacts/"+id,' +
  '{headers:{"x-sandbox-token":process.env.SANDBOX_TOKEN}})' +
  '.then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.arrayBuffer()})' +
  '.then(b=>require("fs").writeFileSync(out,Buffer.from(b)))' +
  '.catch(e=>{console.error(e);process.exit(1)})\' <产物ID> <保存路径>'

/**
 * 容器内按需下载**用户上传附件**的命令（与 {@link NODE_FETCH_DOWNLOAD_COMMAND} 同款，
 * 只把路径从 `/api/sandbox/artifacts/` 换成 `/api/sandbox/attachments/`）。
 *
 * 为什么附件与产物分成两条命令而不是一条带类型参数的命令：两个端点的**归属判据不同**
 * （产物按 `conversation_id`、附件按"消息里引用过 + uploader"），命令正文对 agent 而言
 * 越直白越好 —— 多写一行代码，换 agent 少一次猜。
 */
export const NODE_FETCH_ATTACHMENT_COMMAND =
  'node -e \'const id=process.argv[1],out=process.argv[2];' +
  'fetch(process.env.SANDBOX_BACKEND_URL+"/api/sandbox/attachments/"+id,' +
  '{headers:{"x-sandbox-token":process.env.SANDBOX_TOKEN}})' +
  '.then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.arrayBuffer()})' +
  '.then(b=>require("fs").writeFileSync(out,Buffer.from(b)))' +
  '.catch(e=>{console.error(e);process.exit(1)})\' <附件ID> <保存路径>'

/**
 * 把记忆文档写进容器 `/work/.doubulea/memory.md`（**唯一**的容器写入点）。
 *
 * ⚠️ **内容走 base64 位置参数、不走 `sh -c` 里的字符串拼接**：文档里有用户/模型的原文
 * （可能含引号、换行、`$`），拼进脚本就是注入。`execInSandbox` 的 `cmd` 是数组、不经过 shell，
 * 这里再叠一层"正文只在位置参数里出现" ⇒ 正文里的任何字节都到不了 shell 的解析面。
 * （`base64` 来自 Debian 的 coreutils，本仓镜像必有。）
 *
 * @throws Error exec 失败 / 非 0 退出（调用方 `taskAgent.ts` 会吞成 warn，见文件头）
 */
export async function writeMemoryDoc(containerId: string, doc: string): Promise<void> {
  const encoded = Buffer.from(doc, 'utf8').toString('base64')
  const result = await execInSandbox(
    containerId,
    [
      'sh',
      '-c',
      'mkdir -p "$1" && printf %s "$2" | base64 -d > "$1/memory.md"',
      'sh',
      MEMORY_DOC_DIR,
      encoded,
    ],
    { timeoutMs: ARTIFACT_EXEC_TIMEOUT_MS },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `写入记忆文档失败（exitCode=${String(result.exitCode)}）：${result.stderr.toString('utf8').slice(0, 300)}`,
    )
  }
  getLogger().debug(
    { containerId, path: MEMORY_DOC_PATH, bytes: Buffer.byteLength(doc, 'utf8') },
    '记忆文档已写入容器 /work（本轮 agent 会看到会话历史与产物清单）',
  )
}

// ───────────────────────────── 内部小工具 ─────────────────────────────

/** 按**码点**截断（不用 `slice`：它按 UTF-16 码元切会把 emoji 劈成两半，产出非法字符串） */
function truncateByCodePoint(text: string, max: number): string {
  if (text.length <= max) return text
  return [...text].slice(0, max).join('')
}

/** Markdown 表格单元格里的 `|` 会撑破表格 ⇒ 转义（换行也压成空格，保持"一行一条"） */
function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ')
}

/** 人类可读的体积（记忆文档里只做展示，不做任何计算） */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
