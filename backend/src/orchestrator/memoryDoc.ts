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
 *     · **把文件当成唯一记忆来源** —— 它只是**恢复用的快照**，真值永远在 DB。
 *   ⇒ 正确做法是**需要恢复时**（容器新建，pi session 随之消失）从 DB 现组装
 *   （`buildMemoryDoc`）再写进容器（`writeMemoryDoc`）；复用容器时 session 还活着、上下文不缺
 *   ⇒ **既不重写也不让引擎读**（判据在 `taskAgent.ts` 的 `handle.reused` 分支）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 顺序：写记忆 → 对账 + 记轮次起点 → 派活 → 收产物（`taskAgent.ts` 的硬约束）
 * ═══════════════════════════════════════════════════════════════════════
 * 记忆文档只在**新容器第一轮**写入（内容是那一刻的 DB 快照；复用容器时不写，见 `taskAgent.ts`）。
 * P1-9 · R4 起，产物判据是**本轮工作区变更集**（窗口 `[轮次起点, now]`）⇒ 必须在写它**之后**先
 * `reconcileWorkspaceOnce`（把记忆文档写进工作区索引/事件）、再记**轮次起点**，它才落在窗口之外、
 * 不会被当成本轮新产物收集。顺序必须钉死（调用点是 `taskAgent.ts`）。
 * ⚠️ 另有一道**结构性**保险：文件写在 `/work/.doubulea/` 下，路径里带 `.` 开头的段
 * ⇒ `sandbox/artifactChanges.ts#filterArtifactPaths` 的"隐藏文件跳过"规则天然排除它 ——
 * 即便顺序写反，它也不会被当产物上传。两道一起，任一道单独失效都还有另一道兜着。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 失败不落轮（记忆是本轮的**赠品**）
 * ═══════════════════════════════════════════════════════════════════════
 * 写不进去（容器刚好卡死 / 卷只读 / exec 超时）只 warn：agent 这一轮少看到一份记忆，
 * 但它照样能干活。把它升级成"这一轮失败"会把一个可降级的功能变成一次不可用。
 */

import { createHash } from 'node:crypto'

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
/** 绝对路径（容器内；`writeMemoryDoc` 写盘、日志用） */
export const MEMORY_DOC_PATH = `${MEMORY_DOC_DIR}/memory.md`
/**
 * **工作区相对路径**（= 相对 `/work`）—— 给 agent 读的**唯一**形态。
 *
 * ⚠️ 必须用它、不能把 {@link MEMORY_DOC_PATH}（绝对）写进阅读指令：Code 模式下引擎的 `read`
 * 工具被 `pi-agent/extensions/workspace` **同名覆盖**（版本感知版），参数是**工作区相对路径**，
 * 后端 `normalizeWorkspacePath` 直接拒绝以 `/` 开头的绝对路径（`workspace/paths.ts:55`）
 * ⇒ agent 拿着 `/work/.doubulea/memory.md` 去 read 会**每次都失败**（`ok:false` 校验错误）。
 * 相对路径在两种形态下都对：中介 `read` 认它；非中介的内置 `read` 以 cwd=`/work` 解析它。
 */
export const MEMORY_DOC_RELATIVE_PATH = '.doubulea/memory.md'

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
 * 只给**路径与规则**、不把正文塞进 prompt：正文可能有几 KB，塞进每轮会平白烧 token；
 * 而 pi 的 `read` 工具读一个小文件很便宜。`hasContent === false`（全新会话第一轮）时不加。
 *
 * ★ **P1-21 修订（2026-10-21，真机取证）**：原先这里写的是"**在开始处理下面这条消息前，
 *   请先读取该文件**" —— 那是一道**无条件指令**，于是**每一轮**模型都会 `read` 一次
 *   `memory.md`（实测同容器连跑 3 轮、3 轮都读；`/tmp/probe4 rewrite → reads-per-round [1,2,3]`）。
 *   P1-17a 只把"新建容器那一轮才让引擎读"这个**触发时机**收窄了，但**复用容器的那一轮也
 *   仍然带着这句话**，等于每轮都催一次。而容器复用时 pi 的 session 还活着、记忆根本不需要重建。
 *   ⇒ 两头一起改：① 调用方（`taskAgent.ts`）现在**只在容器新建那一轮**既写文件、又拼这段指令
 *   （复用容器一次 exec 都不做）；② 这句话本身也降级成**条件指令**：只有确实缺上下文时
 *   （容器刚重建 / 换新 session / `/clear` 之后）才读，其余情况模型自己判断
 *   （`recall_memory` 仍然可随时查）。
 *   ⚠️ 判据仍由 `taskAgent.ts` 决定**要不要把这段拼进 prompt**；本函数只负责"拼进去时说什么"。
 */
export function memoryDocReadInstruction(): string {
  return (
    '【会话记忆】本会话在容器之外保存了一份记忆文档（此前对话摘要 + 已产出文件清单 + ' +
    '用户上传过的附件清单 + 按需取回文件的方法），路径：`' +
    MEMORY_DOC_RELATIVE_PATH +
    '`（**工作区相对路径**，即 `/work/` 下的 ' +
    MEMORY_DOC_RELATIVE_PATH +
    '）。\n' +
    '**何时读它**：只有当这一轮你**缺少**此前对话/产物的上下文时（例如容器刚重建、这是本次运行的第一轮、' +
    '或用户提到的内容在上下文里找不到）才用 read 工具读一次；**上下文还在时不要重复读** —— 它在同一轮内' +
    '不会变化，重复读只会浪费 token。需要回忆具体事实时优先用 `recall_memory` 按关键词检索。\n' +
    '⚠️ read 工具只接受**工作区相对路径**：请传 `' +
    MEMORY_DOC_RELATIVE_PATH +
    '`，不要传 `/work/.doubulea/memory.md` 这类绝对路径（会被拒绝）。'
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

  // ── git 使用提示（拉取仓库走 SSH；HTTPS 需先配 token，否则静默认证失败）──
  lines.push('## Git 使用提示')
  lines.push('')
  lines.push(
    '拉取 / 克隆仓库**优先用 SSH**（`git@<host>:<owner>/<repo>.git`）—— 本环境默认可用的 git 凭据就是 SSH key。' +
      'HTTPS（`https://<host>/...`）需要先在平台「设置 → Git 凭据」配置 HTTPS token，**未配置时会认证失败**' +
      '（凭据按需拉取，失败不会打印原因，只会是一个笼统的认证错误）。',
  )
  lines.push('')
  // ★ 2026-10-27：SSH 的**出网**与**DNS** 都经 ProxyCommand 隧道，`getent hosts` / `ping` 必然失败
  //   —— 只有 `ssh` / `git` 自己会走代理。面里不写这一条，模型会拿 `getent`/`ssh` 的解析失败当
  //   "没有网络出口"并让用户上传压缩包（真机日志里就是这么绕远的）。
  lines.push(
    '**容器没有 DNS、也没有直连出口**：`getent hosts <host>` / `ping` / `ssh <host>`（不经 git）一律' +
      '`Temporary failure in name resolution`，这不代表没网 —— 出网只经平台代理，' +
      '`git clone` / `git pull` 已由平台自动接上隧道（`GIT_SSH_COMMAND`），**直接跑 git 即可**，' +
      '不要自己查 DNS、不要自己写 ProxyCommand。',
  )
  lines.push('')
  lines.push('本地还没有仓库时 `pull` 会失败（没有 `.git`）：先 `git clone <地址> <目录>`（如 `git clone <地址> repo`）。')
  lines.push(
    '⚠️ 把代码 clone 到 **`/work` 下**（不要 clone 到 `/tmp`）：`/tmp` 只有 64MB tmpfs，' +
      '真实仓库会 `fatal: unable to checkout working tree`。',
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
 * ★ **P1-21（2026-10-21）：内容没变就不写**。
 *   ⚠️ 先说清调用时机：`taskAgent.ts` 现在**只在容器新建那一轮**调它（复用容器既不写也不读，
 *   见文件头与 `handle.reused` 注释）。正常路径上新容器的 `/work` 是空的，不存在"重复写"。
 *   保留这道判据是为了**卷没删干净**的兜底（`docker volume rm` 失败 → 对账器稍后清；此时新容器
 *   可能挂到同一份旧卷）：若旧文件内容恰好与本次完全一致，重复覆盖只会把 mtime 刷成"刚刚更新"，
 *   而 mtime 是**模型最信的一条"有新东西"线索**（真机取证：`/work` 里唯一的变动就是它，
 *   模型下一轮就去 `read` 一遍，`ls -la /work/.doubulea` 也出现在轨迹里）。
 *   ⇒ 先比**内容哈希**（同一份字节才保证内容相同，不比对 mtime/大小之类的弱判据）：
 *     相同 ⇒ **一次写都不做**，原文件连 mtime 都不动；不同 ⇒ 覆盖写。
 *   ⚠️ 判据放在**容器内**（`md5sum` 现算现比）而不是后端内存里记一张表：后端重启、换实例、
 *      容器被外部改过，都会让内存表说假话，而 `md5sum` 读的是那份真文件的真内容。
 *   ⚠️ `md5sum` 缺失（精简镜像）时 `$same` 为空 ⇒ 按"变了"处理（写一次），功能不受影响。
 *
 * @throws Error exec 失败 / 非 0 退出（调用方 `taskAgent.ts` 会吞成 warn，见文件头）
 */
export async function writeMemoryDoc(
  containerId: string,
  doc: string,
): Promise<{ written: boolean }> {
  const encoded = Buffer.from(doc, 'utf8').toString('base64')
  // 期望哈希以**位置参数**传入（32 位十六进制，直接拼也安全 —— 但仍走位置参数，
  // 保持"正文与判据都到不了 shell 的解析面"这一条）
  const expected = createHash('md5').update(doc, 'utf8').digest('hex')
  const result = await execInSandbox(
    containerId,
    [
      'sh',
      '-c',
      [
        'set -e',
        'mkdir -p "$1"',
        'same=""',
        'if [ -f "$1/memory.md" ]; then',
        '  cur=$(md5sum "$1/memory.md" | cut -d" " -f1) || cur=""',
        '  [ "$cur" = "$3" ] && same=1',
        'fi',
        'if [ -z "$same" ]; then',
        '  printf %s "$2" | base64 -d > "$1/memory.md"',
        '  echo wrote',
        'else',
        '  echo unchanged',
        'fi',
      ].join('\n'),
      'sh',
      MEMORY_DOC_DIR,
      encoded,
      expected,
    ],
    { timeoutMs: ARTIFACT_EXEC_TIMEOUT_MS },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `写入记忆文档失败（exitCode=${String(result.exitCode)}）：${result.stderr.toString('utf8').slice(0, 300)}`,
    )
  }
  const written = result.stdout.toString('utf8').trim() === 'wrote'
  getLogger().debug(
    {
      containerId,
      path: MEMORY_DOC_PATH,
      bytes: Buffer.byteLength(doc, 'utf8'),
      written,
    },
    written
      ? '记忆文档已写入容器 /work（本轮 agent 会看到会话历史与产物清单）'
      : '记忆文档内容未变，跳过重写（保留原文件的 mtime，避免被当成“有新内容”）',
  )
  return { written }
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
