/**
 * TaskAgent 附件落盘（**P1-4 · 2026-10-01 修订**）
 *
 * 依据：`01` §3.4 需求 35「文件附件」；`02` §六「user = content + 附件」。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么 TaskAgent 的附件要"写进容器"，而不是像 ChatBot 那样发多模态
 * ═══════════════════════════════════════════════════════════════════════
 * pi 的 RPC `prompt` **原生支持 `images` 字段**（`docs/rpc.md`），所以图片由 `bridge.ts#runTurn`
 * 作为 `ImageContent` 直接发给模型（能否"看懂"取决于该 Agent 绑定的模型是否支持图片输入，
 * 闸门已按 `supportsVision` 拦过）。但**原文件仍统一落盘**，两个理由：
 *   · TaskAgent 的本职是"用工具干活"——CSV/JSON 要用 python 算、图片要转码/取尺寸；
 *   · 文本类的正文虽已拼进 prompt，原文件在容器里仍可被工具按需再读。
 * 于是处置是：
 *   · **文本类**：解析出的正文拼进 prompt（直接可读）+ 原文件落盘（可被工具处理）；
 *   · **图片**：作为 `images` 发给模型 + 原文件落盘（可被工具处理）。
 *
 * ★ **落盘位置在 `/work/attachments/`、且在拍产物基线之前**：这样它们落在基线里，
 *   **不会**被当成本轮的"agent 新产物"（`filterChangedFiles` 只报基线之后新增/变化的）。
 *
 * ⚠️ **文件名由我们重命名**（`01-<安全名>`）：用户可能传两个同名文件，或名字里带路径分隔符 /
 *   控制字符 —— 落盘名必须是我们可控的（同名会互相覆盖、路径注入会写到目录外）。
 */

import { getLogger } from '../infra/logger.js'
import { ARTIFACT_EXEC_TIMEOUT_MS, SANDBOX_WORK_DIR } from '../sandbox/index.js'
import { execInSandbox } from '../sandbox/docker.js'

/** 附件在容器里的目录（`/work` 之下；非隐藏 —— 在基线之前写入即不会被当产物，见文件头） */
export const ATTACHMENT_FILE_DIR = `${SANDBOX_WORK_DIR}/attachments`

/** 一个附件落盘所需的最小信息（与 `file.service.ts#ChatAttachmentContext` 结构兼容） */
export interface WritableAttachment {
  name: string
  kind: 'IMAGE' | 'DOCUMENT'
  /** 原始字节的 base64（`file.service.ts` 只在需要落盘时带上：图片恒有、文本类由闸门按 TaskAgent 决定） */
  dataBase64?: string
}

/** 落盘顺序前缀（`01-`、`02-`…）：保证同名文件不会互相覆盖，也便于 agent 按顺序引用 */
function ordinal(index: number): string {
  return String(index + 1).padStart(2, '0')
}

/**
 * 把用户原始文件名收干净：剥路径、去控制字符、只留"字母数字 / 中文 / `._-`"，
 * 再按**码点**截到 120（`slice` 会劈代理对）。空名退回 `attachment`。
 */
export function sanitizeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? name
  const cleaned = [...base]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
    .join('')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
  const folded = [...cleaned].slice(0, 120).join('')
  return folded === '' ? 'attachment' : folded
}

/** 第 `index` 个附件在容器里的绝对路径 */
export function attachmentStoredPath(index: number, name: string): string {
  return `${ATTACHMENT_FILE_DIR}/${ordinal(index)}-${sanitizeAttachmentName(name)}`
}

/**
 * 把附件全部写进容器，返回与 `attachments` **等长**的路径数组。
 *
 * 内容走 **base64 位置参数**、不走 `sh -c` 的字符串拼接（同 `memoryDoc.ts#writeMemoryDoc`）：
 * 文件名可能含引号，拼进脚本就是注入。逐文件一次 exec（最多 5 个，开销可忽略）。
 *
 * 任一文件写失败即抛出 —— 由调用方 `taskAgent.ts` 决定降级方式（warn 后按"没有落盘"继续，
 * 文本类正文仍已拼进 prompt）。**不在这里吞错**：吞掉会让调用方误以为文件都在。
 *
 * @throws Error exec 失败 / 非 0 退出
 */
export async function writeAttachmentFiles(
  containerId: string,
  attachments: readonly WritableAttachment[],
): Promise<string[]> {
  const paths: string[] = []
  for (let index = 0; index < attachments.length; index += 1) {
    const item = attachments[index]
    if (item === undefined) continue
    const path = attachmentStoredPath(index, item.name)
    const encoded = item.dataBase64 ?? ''
    const result = await execInSandbox(
      containerId,
      [
        'sh',
        '-c',
        'mkdir -p "$1" && printf %s "$2" | base64 -d > "$3"',
        'sh',
        ATTACHMENT_FILE_DIR,
        encoded,
        path,
      ],
      { timeoutMs: ARTIFACT_EXEC_TIMEOUT_MS },
    )
    if (result.exitCode !== 0) {
      throw new Error(
        `写入附件「${item.name}」失败（exitCode=${String(result.exitCode)}）：` +
          result.stderr.toString('utf8').slice(0, 300),
      )
    }
    paths.push(path)
  }
  getLogger().debug(
    { containerId, count: paths.length, dir: ATTACHMENT_FILE_DIR },
    '附件已写入容器 /work（本轮 agent 可用工具处理这些文件）',
  )
  return paths
}

/**
 * TaskAgent 的附件 prompt 块：说明 + 每个文件的路径（成功落盘时）+ 文本类正文。
 *
 * ⚠️ 与 ChatBot 的 {@link buildAttachmentPromptBlock} **合并不了**：这里多了"文件在容器里的路径"
 * 与"图片看不了、请用工具处理"这两句，是沙箱链路独有的信息。两条链路对"附件不是知识库、别去检索"
 * 说同一句（都引用 `ATTACHMENT_CONTEXT_NOTE`）。
 *
 * @param storedPaths 与 `attachments` 等长；`null` 表示落盘失败（降级为"只给文本类正文"）
 */
export function taskAttachmentPromptBlock(
  attachments: readonly { name: string; kind: 'IMAGE' | 'DOCUMENT'; text?: string }[],
  storedPaths: readonly string[] | null,
  note: string,
): string {
  if (attachments.length === 0) return ''
  const lines: string[] = [note]
  attachments.forEach((item, index) => {
    const path = storedPaths?.[index]
    const pathLine = path === undefined ? '' : `（原文件已放在容器内：\`${path}\`）`
    if (item.kind === 'IMAGE') {
      lines.push(
        `【附件：${item.name}】${pathLine}\n` +
          '（这张图片已随本轮消息一并提供给你，可直接查看；原文件也在上面的容器路径里，' +
          '如需转码/读取像素等处理可用工具操作它。）',
      )
    } else {
      lines.push(`【附件：${item.name}】${pathLine}\n${item.text ?? ''}`)
    }
  })
  return lines.join('\n\n')
}
