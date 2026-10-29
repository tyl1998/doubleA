/**
 * 工作区硬化纯判据（P1-9 · P6 · R6）—— 二进制识别 + 更严的大小/数量/类型闸门 + 写入限流
 *
 * 依据：`docs/子方案/Code模式工作区.md` §九（安全与配额：
 *      「配额：单会话文件数、单文件大小、总字节上限；超限拒绝并留痕」
 *      「二进制：只读预览 / 下载，编辑器只开文本」）+ §十二 P6（配额 / 二进制硬化）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件（同 `reapModel.ts` / `coldModel.ts`）
 * ─────────────────────────────────────────────────────────────────────
 * 本文件**零 `config` / 零 DB / 零 FS**：判据可以在自证脚本（`workspace-regression.ts`）里
 * 逐条核对，不必连库、不必起服务。真消费方是 `service.ts`（写闸门）与 `store.ts`（字节嗅探）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条判据，各自回答一个"能不能写"
 * ─────────────────────────────────────────────────────────────────────
 *   ① **二进制识别**（{@link looksBinaryWorkspaceContent}）：内容**看起来是不是二进制**。
 *      扩展名（`workspaceMimeOf`）只是"叫什么"，这里看"字节长什么样"—— 一个叫 `notes.txt`
 *      但含 NUL 的文件，编辑器打开只会是乱码（§九 二进制行：编辑器只开文本）；
 *   ② **数量 / 大小闸门**（{@link decideWorkspaceQuota}）：单文件大小、活文件数、**总行数**
 *      （含墓碑）、总字节。总行数这一条是"更严"的关键 —— `workspace_files` 的唯一键是
 *      `(会话, 路径)`，agent 若"建了删、建了删"不同路径，活文件数永远为 0 而墓碑行无限涨；
 *   ③ **写入限流**（{@link isWorkspaceWriteRateExceeded} + {@link workspaceWriteRateWindowStart}）：
 *      固定窗口计数（真计数在 Redis，见 `workspace/rateLimit.ts`），挡"失控 agent 每秒几百次写"。
 *
 * ⚠️ 判据只做"判"，不做"记"：拒绝留痕（日志）在各调用方，这里保持无副作用以便逐条核对。
 */

/** 二进制嗅探的采样上限（字节）—— 只读文件头部这一小段（`head -c` 同款手法） */
export const WORKSPACE_BINARY_SAMPLE_BYTES = 8192

/**
 * 内容"看起来是二进制"吗（**唯一判据**，读路径与写路径共用）。
 *
 * 口径 = **采样窗口内出现 NUL（`0x00`）**（git 的 `buffer_contains_NUL` 同款启发式）：
 *   · 文本文件（含 UTF-8 中文）几乎不会含 NUL ⇒ 不会误判；
 *   · 真正的二进制（PNG / PDF / 可执行…）头几个字节里就有 NUL ⇒ 稳定判出。
 *
 * ★ 2026-10-28（用户反馈「txt 文件在 Code 模式下打不开 / 不能展示」）：
 *   **带 BOM 的 UTF-16 文本**是纯文本，但它的 ASCII 字符后面**每两个字节就有一个 NUL**
 *   （`a\0l\0l\0…`）⇒ 只按 NUL 判会被误判成二进制，于是编辑器只给下载、不给展示。
 *   BOM 是文件自己的编码声明（`parse/txt.ts#decodeTextBuffer` 同款判据）⇒ **先认 BOM**：
 *   `FF FE` / `FE FF` 一律当文本，跳过 NUL 判据。无 BOM 的 UTF-16 仍是二进制（无从判定，保守）。
 *
 * 只看前 {@link WORKSPACE_BINARY_SAMPLE_BYTES} 字节：避免为一个 10MB 文件做整份扫描，
 * 且真实二进制几乎都在头部暴露 NUL。
 */
export function looksBinaryWorkspaceContent(data: Uint8Array): boolean {
  if (data.byteLength >= 2) {
    const [b0, b1] = [data[0], data[1]]
    // UTF-16LE BOM / UTF-16BE BOM（UTF-8 BOM `EF BB BF` 不含 NUL，不必特判）
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return false
  }
  const end = Math.min(data.byteLength, WORKSPACE_BINARY_SAMPLE_BYTES)
  for (let index = 0; index < end; index += 1) {
    if (data[index] === 0) return true
  }
  return false
}

// ═════════════════════════════ 配额 / 类型闸门 ═════════════════════════════

/** 写入被拒的原因（落 `AppError.data.violation`，供前端/引擎分流文案） */
export const WORKSPACE_QUOTA_VIOLATIONS = [
  /** 内容含二进制字节（写接口只接受文本）—— 类型闸门 */
  'BINARY_CONTENT',
  /** 超过单文件上限 */
  'FILE_TOO_LARGE',
  /** 活文件数达上限 */
  'TOO_MANY_FILES',
  /** 行数（含墓碑）达上限 */
  'TOO_MANY_ROWS',
  /** 总字节达上限 */
  'TOTAL_TOO_LARGE',
] as const
export type WorkspaceQuotaViolation = (typeof WORKSPACE_QUOTA_VIOLATIONS)[number]

/** 闸门阈值（由 `config.workspace` 提供；这里是"判据要的数字"，不含来源） */
export interface WorkspaceQuotaLimits {
  maxFileBytes: number
  maxFiles: number
  maxRows: number
  maxTotalBytes: number
}

/** 一次写之前工作区的现状（`live*` 只算未删文件；`totalRowCount` 含墓碑） */
export interface WorkspaceQuotaSnapshot {
  /** 本次要写入的字节数 */
  incomingBytes: number
  /** 内容看起来是二进制（{@link looksBinaryWorkspaceContent} 的结论） */
  binary: boolean
  /** 这次写会**新增一个活文件**吗（路径不存在、或路径是墓碑） */
  isNewFile: boolean
  /** 这次写会**新增一行**吗（路径完全不存在；覆盖/复活既有行都是 `false`） */
  createsRow: boolean
  /** 当前活文件数（`workspace_files` 中 `deleted_at IS NULL`） */
  liveFileCount: number
  /** 当前总行数（含墓碑）；`createsRow=false` 时可传 `0`（不参与判定） */
  totalRowCount: number
  /** 当前活文件总字节 */
  liveTotalBytes: number
}

/** 判定结论：`ok:true` 放行；否则带上**明确原因**（调用方据此抛 `AppError`） */
export type WorkspaceQuotaDecision =
  | { ok: true }
  | { ok: false; violation: WorkspaceQuotaViolation; message: string }

/** 字节 → MB（取整，只给文案用；阈值本身用字节比较） */
function mbOf(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

/**
 * 逐条判定一次写是否越过闸门（顺序 = 报告原因的优先级；首个命中的即结论）。
 *
 * ⚠️ **总量用"当前活总量 + 新大小"作保守上界**（不减去被覆盖文件的旧大小）：宁严勿宽 ——
 *    覆盖写很少把工作区推向边界，而"以为还有空间、其实已经满了"比"偶尔多拒一次"更坏。
 */
export function decideWorkspaceQuota(
  snapshot: WorkspaceQuotaSnapshot,
  limits: WorkspaceQuotaLimits,
): WorkspaceQuotaDecision {
  if (snapshot.binary) {
    return {
      ok: false,
      violation: 'BINARY_CONTENT',
      message: '内容含二进制字节；工作区写接口只接受文本（二进制请用 git / bash 落地后用只读预览查看）',
    }
  }
  if (snapshot.incomingBytes > limits.maxFileBytes) {
    return {
      ok: false,
      violation: 'FILE_TOO_LARGE',
      message: `文件超过单文件上限（${mbOf(limits.maxFileBytes)}MB）`,
    }
  }
  if (snapshot.isNewFile && snapshot.liveFileCount >= limits.maxFiles) {
    return {
      ok: false,
      violation: 'TOO_MANY_FILES',
      message: `工作区文件数已达上限（${limits.maxFiles}）`,
    }
  }
  if (snapshot.createsRow && snapshot.totalRowCount >= limits.maxRows) {
    return {
      ok: false,
      violation: 'TOO_MANY_ROWS',
      message: `工作区文件行数（含已删除）已达上限（${limits.maxRows}），请清理后再写`,
    }
  }
  const totalBytes = snapshot.liveTotalBytes + snapshot.incomingBytes
  if (totalBytes > limits.maxTotalBytes) {
    return {
      ok: false,
      violation: 'TOTAL_TOO_LARGE',
      message: `工作区总字节已达上限（${mbOf(limits.maxTotalBytes)}MB）`,
    }
  }
  return { ok: true }
}

// ═════════════════════════════ 写入限流（纯判据） ═════════════════════════════

/** 写入限流的窗口长度（毫秒，**代码常量**）—— 固定窗口 = 1 分钟 */
export const WORKSPACE_WRITE_RATE_WINDOW_MS = 60_000

/** 把时刻折算到它所在固定窗口的起点（epoch ms）—— 键名据此每窗口翻转一次 */
export function workspaceWriteRateWindowStart(
  nowMs: number,
  windowMs: number = WORKSPACE_WRITE_RATE_WINDOW_MS,
): number {
  return Math.floor(nowMs / windowMs) * windowMs
}

/**
 * 计数是否超过阈值。`limit <= 0` 一律**不限流**（放行）—— 这是"关掉限流"的显式口径
 * （与 `config.workspace.writePerMin = 0` 对应），不是"漏判"。
 */
export function isWorkspaceWriteRateExceeded(count: number, limit: number): boolean {
  return limit > 0 && count > limit
}
