/**
 * SSE 帧解析（P0-1-32）
 *
 * 依据：`docs/03-前端设计.md` §一（**"fetch + ReadableStream 自实现"** —— 原生 `EventSource`
 * 不够用：本仓的 `/chat` 是 **POST + JSON body**，而 `EventSource` 只能发 GET、也不能带自定义头）、
 * §五（事件 → UI 映射表）、`docs/02` §五（协议全文）、`shared/src/sse.ts`（事件全集的唯一来源）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一层要单独拆出来（本批最该被单独测的一段）
 * ─────────────────────────────────────────────────────────────────────
 * 它要处理的**全是"边界"**，而每一条边界错了都**不会报错、只是内容少一点**：
 *   · 一帧可能被 TCP 切成任意多段（`event:` 与 `data:` 分属两个 chunk 是常态）；
 *   · 一个 chunk 里可能有多帧（后端 `flushHeaders` 之后连写几帧时会合并成一个 TCP 包）；
 *   · 帧分隔是**空行**，且分隔符本身也可能横跨两个 chunk（`\n` 在 A 段末尾、`\n` 在 B 段开头）；
 *   · 注释行（`:` 开头，如上游 stall 时的 `: stall`）按规范必须忽略；
 *   · `data:` 可以多行（规范：多行用 `\n` 连接），不能只看第一行；
 *   · 行尾可能是 CRLF（有的网关会改写）。
 * 这些都是**纯字符串处理**，与 React / fetch / store 无关 ⇒ 拆成纯函数，
 * 由 `frontend/scripts/verify-chat-sse.mjs`（无依赖档）逐条断言。
 * 混进 hook 里就只能靠浏览器手点，而手点碰到"一帧被切成 3 段"的概率约等于零。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本档第一次跑就抓到两个真 bug（P0-1-32 留痕；都是"不报错"的那一类）
 * ─────────────────────────────────────────────────────────────────────
 * ① **帧的中间态必须跨 `push()` 存活**：一帧的三行落在三次 `push` 里时，把"正在攒的那一帧"
 *    做成 `push()` 的局部变量，行一解析完就随函数返回消失（只剩 `#buffer` 里那半行）
 *    ⇒ 后到的 `data:` 行会以"没有 `event`"的状态开帧 ⇒ **事件名丢失 ⇒ 整帧被当未知事件忽略**。
 *    症状是"回答里偶尔少一段"，且要 TCP 恰好在换行之后分段才出现。现由 `#current` 持有，
 *    并由 A2 / C2（切点全扫描）/ C3（逐字节喂入）三条断言按住。
 * ② **`data` 的"缺席"不能用空串表示**：`current.data + '\n' + value` 会让每一帧的单行 `data:`
 *    凭空多一个**前导换行**。`JSON.parse` 容忍前导空白 ⇒ 这个 bug 会被完全掩盖成"能跑"，
 *    只有与原始报文**逐字**比对才看得见。现由 `PartialSseFrame.data?: string` 区分"没有"与"空"。
 * 一句话：这一层的错误**只会表现为内容少一点/多一个字符**，所以断言必须落在**字面量**上，
 * 不能只断言"能解析出事件"（那是 ① ② 都逃得过的弱断言）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条实现口径
 * ─────────────────────────────────────────────────────────────────────
 * ① **不做任何"猜测式容错"**：形状不对的事件（已知事件名 + payload 不合法）**不吞掉**，
 *    以 {@link SseParseOutcome} 的 `invalid` 交出去。理由：后端在 `emit()` 里已经用同一份
 *    `SSE_PAYLOAD_SCHEMAS` 校验过（`orchestrator/sse.ts`），走到这里说明两侧契约漂了 ——
 *    静默丢弃会让症状表现为"某张卡片偶尔不出现"，而线索全无。
 * ② **未知事件名单独归类**（`unknown`）而不是当成 `invalid`：`02` §五 的事件全集将来会扩
 *    （P0-2 的 `confirm` 应答、P0-3 的产物），前端按名字分派，遇到不认识的名字**忽略但不报错**
 *    —— 这是向前兼容，与"形状不对"是两件事。
 * ③ **`ping` 不在这里特殊处理**：它是正常事件（有 schema、要过校验），
 *    由分派层静默忽略（`03` §五 的 `ping` 行）。在这一层特判会让"事件全集"出现第二处定义。
 */

import { SSE_EVENT_NAMES, SSE_PAYLOAD_SCHEMAS, type SseEvent, type SseEventName } from '@doubulea/shared'

/** 一帧的原始形态（只有解析、还没有语义） */
export interface RawSseFrame {
  /** `event:` 行的值；省略时 SSE 规范默认 `message` */
  event: string
  /** `data:` 行的值（多行按规范用 `\n` 连接） */
  data: string
}

/**
 * 攒帧过程中的**中间形态**（对外不暴露）。
 *
 * ⚠️ 这里唯一的真陷阱是"**缺席**"与"**空值**"必须分开：
 *   · `data === undefined` = **还没见过 `data:` 行**；
 *   · `data === ''` = 见过 `data:` 行，但值是空的。
 * 拿空串当"还没有"的写法是：`data = current.data + '\n' + value`
 * ⇒ 每一帧的单行 `data:` 都会悄悄多一个**前导换行**。
 * 而 `JSON.parse` **容忍前导空白**，于是这个 bug 会被完全掩盖成"能跑" ——
 * 只有把 `frame.data` 与原始文本**逐字**比对才看得见（本档 A 组两条断言就是这么抓出来的）。
 */
interface PartialSseFrame {
  event: string
  data?: string
}

/**
 * 一帧的解析结果。
 *
 * 三种结果**都**要能被调用方看见（`invalid` 要进 console/日志，`unknown` 可以只计数）——
 * 这正是它做成判别联合而不是"返回 `SseEvent | null`"的原因。
 */
export type SseParseOutcome =
  | { kind: 'event'; event: SseEvent }
  /** 不认识的事件名：忽略，但保留原始形态供排查（向前兼容，见文件头 ②） */
  | { kind: 'unknown'; name: string; data: string }
  /** 已知事件名但 payload 形状不合法：这是**契约漂移**的信号，不静默（见文件头 ①） */
  | { kind: 'invalid'; name: string; detail: string }
  /** 没有 `data:` 行的帧（例如只有注释行）—— 按规范不产生事件 */
  | { kind: 'empty' }

/** 事件名判据（`SSE_EVENT_NAMES` 是唯一来源，这里不再写一份字符串数组） */
function isKnownEventName(name: string): name is SseEventName {
  return (SSE_EVENT_NAMES as readonly string[]).includes(name)
}

/**
 * 逐 chunk 喂入的帧切分器（**有状态**，但状态只有一个字符串缓冲）。
 *
 * 用法：`push(decodedChunk)` 拿到"这一批已经完整的帧"，结束时调一次 {@link flush}
 * （处理"最后一行没有换行符"的收尾，以及解码器残留的多字节字符）。
 */
export class SseFrameParser {
  /** 尚未见到空行的**整段文本**（含不完整的最后一行） */
  #buffer = ''
  /**
   * 正在攒的那一帧 —— **必须是实例状态，不能是 `push()` 的局部变量**。
   *
   * 一帧的三行（`event:` / `data:` / 空行）完全可能落在**三次 `push`** 里，
   * 而它们之间只有"帧尚未收尾"这一个共同点。做成局部变量时，行一旦解析完就随函数返回消失，
   * 只留下 `#buffer` 里那半行 ⇒ 第二行的 `data:` 会在"没有 `current`"的状态下被当成一帧的开头，
   * 于是**事件名丢失**（`event: ''` ⇒ 认成未知事件 ⇒ 整帧被忽略）。
   * ⚠️ 这个 bug 同样**不报错**：症状只是"回答里偶尔少一段"，而且要 TCP 恰好在换行之后分段才出现
   * （本档 A2 / C2 / C3 三条断言分别用"切在换行后""逐字节切点扫描""逐字节喂入"把它按住）。
   */
  #current: PartialSseFrame | undefined
  /** 被 {@link flush} 丢弃的半帧（见那里的注释） */
  #pending = ''

  /**
   * 喂一段**已解码的文本**。
   *
   * ⚠️ 调用方必须用 `TextDecoder` 的 `{ stream: true }` 模式解码字节 —— UTF-8 的一个汉字
   * 占 3 字节，**会被 TCP 切在两段之间**；用 `decode(bytes)`（非流式）会在边界上产出
   * `\uFFFD`（替换字符），而症状是"回答里偶尔多一个问号方块"、"JSON 解析失败"这类
   * 与"网络"看起来毫无关系的问题。本函数只处理字符串，不对字节负责。
   */
  push(chunk: string): RawSseFrame[] {
    this.#buffer += chunk
    const frames: RawSseFrame[] = []

    // 按换行切；**最后一段一定是不完整的行**（除非它以换行结尾），留在缓冲里等下一次
    let start = 0
    for (;;) {
      const newline = this.#buffer.indexOf('\n', start)
      if (newline === -1) break
      const line = stripTrailingCr(this.#buffer.slice(start, newline))
      start = newline + 1
      if (line === '') {
        // 空行 = 帧结束。`#current` 里的字段攒到这里才成帧
        const frame = finishFrame(this.#current)
        if (frame !== undefined) frames.push(frame)
        this.#current = undefined
        continue
      }
      this.#current = applyFieldLine(this.#current, line)
    }

    this.#buffer = this.#buffer.slice(start)
    return frames
  }

  /**
   * 流结束时的收尾。
   *
   * 两个作用：① 把"还没有被空行确认"的部分（**正在攒的字段 + 最后那一行不完整文本**）
   * 交出来；② 清空状态（解析器一次性使用）。
   *
   * ⚠️ 因此这里**刻意只返回空数组**：半帧**不该被当成一个完整事件**，因为它的 `data`
   * 很可能是被截断的 JSON（正常路径不会有残留 —— 后端每条流都以 `done`/`error` + `\n\n` 收尾；
   * 但**客户端 abort / 服务端被 kill** 时会留下半个帧）。尾部残留由 {@link SseFrameParser.pending}
   * 暴露给调用方记日志。
   */
  flush(): RawSseFrame[] {
    const tail = `${describePartialFrame(this.#current)}${this.#buffer}`
    this.#buffer = ''
    this.#current = undefined
    this.#pending = tail.trim() === '' ? '' : tail
    return []
  }

  /** 被丢弃的半帧原文（正常情况下是空串；非空说明流是被**截断**的） */
  get pending(): string {
    return this.#pending
  }
}

/** 一行 `field: value` 应用到当前帧上；不认识的字段按规范忽略 */
function applyFieldLine(
  current: PartialSseFrame | undefined,
  line: string,
): PartialSseFrame | undefined {
  // 注释行（`:` 开头）—— 规范要求忽略。上游 stall 时的 `: stall` 就走这条路
  if (line.startsWith(':')) return current

  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  // 规范：冒号后**至多**剥掉一个空格（多剥会把内容里的前导空格吃掉）
  let value = colon === -1 ? '' : line.slice(colon + 1)
  if (value.startsWith(' ')) value = value.slice(1)

  if (field === 'event') {
    // 保留已经攒到的 `data`（规范不要求字段顺序）；`data === undefined` 时才真的"没有"
    return current?.data === undefined
      ? { event: value }
      : { event: value, data: current.data }
  }
  if (field === 'data') {
    // ⚠️ `current?.data === undefined` 而不是 `current === undefined` —— 见 {@link PartialSseFrame}
    const data = current?.data === undefined ? value : `${current.data}\n${value}`
    return { event: current?.event ?? '', data }
  }
  // `id:` / `retry:` 等：本系统不做重放（`shared/src/sse.ts` 文件头 ②），收到就忽略
  return current
}

/** 收尾一帧：**没有 `data:` 行**的帧不产出（规范如此，同时也是"只有注释行 / 只有 event 行"的帧的归宿） */
function finishFrame(current: PartialSseFrame | undefined): RawSseFrame | undefined {
  if (current === undefined) return undefined
  if (current.data === undefined) return undefined
  return { event: current.event, data: current.data }
}

/** 把未被确认的半帧还原成"接近原始报文"的形态（只用于 `pending` 的日志与排查） */
function describePartialFrame(frame: PartialSseFrame | undefined): string {
  if (frame === undefined) return ''
  const lines: string[] = []
  if (frame.event !== '') lines.push(`event: ${frame.event}\n`)
  if (frame.data !== undefined) lines.push(`data: ${frame.data}\n`)
  return lines.join('')
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 原始帧 → 语义结果（见 {@link SseParseOutcome}）。
 *
 * `JSON.parse` 失败与 schema 失败都归 `invalid`：对调用方来说它们是同一件事
 * （**这一帧不能用**），而 `detail` 足以定位（前者给 `SyntaxError.message`，后者给 zod 明细）。
 */
export function parseSseFrame(frame: RawSseFrame): SseParseOutcome {
  // 没有 `data:` 行的帧按规范**不产生事件**。`SseFrameParser` 在成帧时就已经把这类帧丢掉了
  // （`finishFrame`），所以正常路径走不到这里；这里再挡一次是为了让 `SseParseOutcome` 的
  // `empty` 成员**真的可达** —— 联合类型里留一个"没有任何路径能产生"的分支，等于一处会骗人的
  // 声明：读代码的人会以为分派层必须处理它，而真去 `parseSseFrame({event:'ping', data:''})`
  // 时却会掉进 JSON 解析失败、被报成 `invalid`（把"无事发生"说成"契约漂了"）。
  if (frame.data === '') return { kind: 'empty' }

  if (!isKnownEventName(frame.event)) {
    return { kind: 'unknown', name: frame.event, data: frame.data }
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(frame.data)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'invalid', name: frame.event, detail: `data 不是合法 JSON：${detail}` }
  }

  const parsed = SSE_PAYLOAD_SCHEMAS[frame.event].safeParse(decoded)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('；')
    return { kind: 'invalid', name: frame.event, detail }
  }

  // ⚠️ 序列化/透传用**原对象**（`parsed.data`）而不是 `frame.data`：SSE 的 payload schema
  //    刻意全是"纯形状"（无 `.transform()`），两者逐字段相等；将来若加了 transform，
  //    这里自然就是生效点（与后端 `orchestrator/sse.ts#emit` 的注释同款提醒）。
  return { kind: 'event', event: { name: frame.event, data: parsed.data } as SseEvent }
}

/** 一段（或多段）文本 → 结果数组。测试与"一次性响应体"用得上；流式读用 {@link SseFrameParser} */
export function parseSseText(text: string): SseParseOutcome[] {
  const parser = new SseFrameParser()
  const frames = parser.push(text)
  frames.push(...parser.flush())
  return frames.map(parseSseFrame)
}
