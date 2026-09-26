/**
 * 严格 JSONL 分帧（**只按 LF 切**）—— 引擎桥的解码层（P0-3-5）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §六 4 坑 1 + pi 包内 `docs/rpc.md`「Framing」一节
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 为什么不能图省事用 `node:readline`（这一条是 pi 官方点名警告的）
 * ─────────────────────────────────────────────────────────────────────
 * `readline` 除了 `\n` / `\r\n`，还会把 **U+2028（LINE SEPARATOR）** 与 **U+2029
 * （PARAGRAPH SEPARATOR）** 当成行边界。而这两个字符**在 JSON 字符串里是合法内容**
 * （JSON 只把 `"`、`\`、控制字符 U+0000–U+001F 列为必须转义的东西，U+2028/U+2029 不在其中）。
 *
 * 后果是**静默**的：模型输出里一旦出现 U+2028（某些模型真的会输出它来排版），
 * 一条合法的 `message_update` 会被 readline 从中间切开 ⇒ 两边都 `JSON.parse` 失败 ⇒
 * 按"忽略非 JSON 行"丢掉 ⇒ **正文少了一截，而历史里看着是完整的**（与 §六 4 坑 2 的症状同族，
 * 但连事件都看不出来）。pi 自己的 `jsonl.js` 之所以手写这段，理由逐字就是这个。
 *
 * ⇒ 本模块只认 `\n`（0x0A），并把行尾**可选**的一个 `\r` 剥掉（接受 CRLF 输入）。
 *   ⚠️ 在**字节**层面找 0x0A 是安全的：UTF-8 的多字节序列里不会出现 0x0A，
 *   所以按字节切不会劈开任何字符 —— 这也是为什么下面直接攒 `Buffer` 而不是先 `toString()`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件（而不是塞进 `bridge.ts`）
 * ─────────────────────────────────────────────────────────────────────
 * 与上游把这段拆成 `jsonl.js` 同一个理由：它是**纯逻辑**（无 IO、不读配置、不 import 业务模块），
 * 于是"U+2028 不切行""跨 chunk 的多字节字符不坏""超长记录要炸"这几条判据可以在**不连 Docker、
 * 不连库**的情况下逐条比对。`bridge.ts` 那层要连 Docker，做不到这一点。
 */

import { StringDecoder } from 'node:string_decoder'

/**
 * 单条 JSONL 记录的字节上限（`子方案③` §二 表的最后一行）。
 *
 * **代码常量、不进 env** —— 它不是"行为窗口"（那种要能注入小值才验得了，如空闲回收的 30 分钟），
 * 而是**防呆上界**：引擎某天吐出一条天文数字长度的记录时，桥要**断流并按故障收尾**，
 * 而不是把宿主的堆吃掉。同一条取舍见 `manager.ts` 的 `SLOT_POLL_INTERVAL_MS`。
 */
export const PI_RPC_STDIO_MAX_BYTES = 8 * 1024 * 1024

/** LF / CR 的字节值（写出来是为了让"只认 LF"这件事在代码里也是字面的） */
const LF = 0x0a
const CR = 0x0d

/**
 * 一条记录超过 {@link PI_RPC_STDIO_MAX_BYTES} 时抛出。
 *
 * 单独一个类而不是 `Error`：桥要**只对**这一种情况做"断流 + 按故障收尾"，
 * 而对别的解析问题只记日志。用 message 字符串去区分是迟早会腐烂的做法。
 */
export class JsonlRecordTooLargeError extends Error {
  constructor(
    readonly pendingBytes: number,
    readonly maxBytes: number,
  ) {
    super(`JSONL 记录超过上限：已缓冲 ${pendingBytes} 字节 > ${maxBytes} 字节`)
    this.name = 'JsonlRecordTooLargeError'
  }
}

/** 增量式的 JSONL 解码器（有状态，但**只吃字节、只吐字符串**，不碰任何 IO） */
export interface JsonlDecoder {
  /**
   * 追加一段 stdout 字节（或字符串），返回**这一次**切出来的完整行。
   * 末尾没有 LF 的那一段留在内部缓冲里，等下一次 push。
   *
   * @throws {JsonlRecordTooLargeError} 缓冲里的**半条**记录超过上限
   */
  push(chunk: Uint8Array | string): string[]
  /**
   * 流结束：把缓冲里最后那一段（没有以 LF 结尾的）也吐出来。
   * 上游 `attachJsonlLineReader` 同款：进程被 kill 时最后一行常常没有换行，
   * 丢掉它就等于丢掉"引擎说的最后一句话"（往往正是崩溃原因）。
   */
  flush(): string[]
  /** 当前缓冲的字节数（超限诊断用；正常路径不需要读它） */
  pendingBytes(): number
}

export interface JsonlDecoderOptions {
  /** 覆盖默认上限（只在核查脚本里用；生产走 {@link PI_RPC_STDIO_MAX_BYTES}） */
  maxRecordBytes?: number
}

/**
 * 造一个 JSONL 解码器。
 *
 * 三条语义写死在这里（核查脚本逐条断言）：
 *   ① **只按 `\n` 切** —— U+2028 / U+2029 是普通内容，不是边界；
 *   ② 行尾**一个**可选的 `\r` 剥掉（CRLF 输入与 LF 都吃）；
 *   ③ **空行不产出**（连续的 `\n`、开头就是 `\n` 都跳过）—— 空行不是记录，
 *      让它冒出去只会让上层每收到一个空行就打一条"解析失败"，把真正的故障淹掉。
 *   ④ 跨 chunk 的多字节字符**不坏**：`StringDecoder` 把半个字符留在内部，
 *      等下一段补齐再吐出来（这是我们自己没有的坑 —— 上游用 StringDecoder 也是为它）。
 */
export function createJsonlDecoder(options: JsonlDecoderOptions = {}): JsonlDecoder {
  const maxBytes = options.maxRecordBytes ?? PI_RPC_STDIO_MAX_BYTES
  /** 行内字节解码器（把"最后一个字符跨 chunk"这件事收在它内部） */
  const decoder = new StringDecoder('utf8')
  let pending: Buffer = Buffer.alloc(0)

  const decode = (bytes: Buffer): string => decoder.write(bytes)

  return {
    push(chunk) {
      const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
      const combined = pending.length === 0 ? incoming : Buffer.concat([pending, incoming])

      const lines: string[] = []
      let start = 0
      for (;;) {
        const nl = combined.indexOf(LF, start)
        if (nl === -1) break
        // 行尾可选的一个 CR（`\r\n`）：只剥一个，`\r\r\n` 里的第一个 `\r` 是内容
        const end = nl > start && combined[nl - 1] === CR ? nl - 1 : nl
        if (end > start) lines.push(decode(combined.subarray(start, end)))
        start = nl + 1
      }

      // 一份 copy，避免留着大 buffer 的视图（subarray 会让整块内存活着）
      pending = Buffer.from(combined.subarray(start))
      if (pending.length > maxBytes) throw new JsonlRecordTooLargeError(pending.length, maxBytes)
      return lines
    },

    flush() {
      // ⚠️ 与 `push` 走**同一个**解码器：混用 `pending.toString()` 会让"半条记录里跨 chunk 的
      //    半个字符"在两条路径上表现不一致（一条留着、一条变成替换字符）
      const tail = `${decode(pending)}${decoder.end()}`
      pending = Buffer.alloc(0)
      return tail.length > 0 ? [tail.endsWith('\r') ? tail.slice(0, -1) : tail] : []
    },

    pendingBytes() {
      return pending.length
    },
  }
}
