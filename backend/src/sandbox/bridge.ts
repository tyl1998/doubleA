/**
 * 引擎桥（P0-3-5）—— 「后端 ↔ 容器里的 pi」之间那一条 JSONL 通道
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §六（引擎桥与事件映射：桥的形态、四类记录、四条坑）、
 *      `docs/02-后端设计.md` §七 第 3 步（引擎桥：**直连 `pi --mode rpc`**，ACP 只借接口形状）、
 *      pi 包内 `docs/rpc.md`（协议权威：分帧 / 配对 / 生命周期 / 错误 / 关闭）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这一层只做四件事（协议之外的一切都不在这里）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **按 LF 切字节流**（`jsonl.ts`）—— 不许用 `readline`，理由见那里；
 *   ② **请求/应答配对**（每条命令带 `id`、应答按 `id` 回；命令处理是异步的，**不能按顺序配**）；
 *   ③ **`agent_settled` 收尾**（不是 `agent_end`，见下）；
 *   ④ **把引擎事件扇出去**（给 P0-3-6 的映射层）+ 把 stderr 收进日志（脱敏）。
 *
 * ⚠️ **不含**：事件 → 我方 SSE 的映射（`map.ts`，P0-3-6）、产物扫描（P0-3-7）、
 * MCP 工具注册 / 代理（**P0-3-9b**：容器侧是 `mcp-bridge` 扩展，后端侧是
 * `sandbox/proxy.ts` + `sandbox/token.ts`；它要用的**跨请求提问原语**在 P0-3-6b 落到
 * `orchestrator/sse.ts`）。所以本批交付完之后**用户在浏览器或命令行里看不到
 * 任何新东西** —— 这是刻意的批次切分，不是没做完。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 四条坑（`子方案③` §六 4）在本文件里的落点
 * ═══════════════════════════════════════════════════════════════════════
 * 坑 1（LF 切）      → `jsonl.ts`（单独一个文件，因为它必须是可无依赖核查的纯逻辑）
 * 坑 2（`agent_settled` 而不是 `agent_end`）→ {@link SandboxRpc.runTurn} 等的**只有**它。
 *     `agent_end` 之后还可能跟自动重试、溢出恢复、上下文压缩、跟进动作（pi `docs/rpc.md`
 *     的 "Run lifecycle" 逐字说的）⇒ 拿它当"这轮结束"会**提前落库**，症状是
 *     "回答少了一截，但历史里看着是完整的"（没有任何一处报错）。
 * 坑 3（headless 要 `--no-approve`）→ 不在本文件：那是**启动参数**，见 `spec.ts#piRpcArgv`。
 * 坑 4（运行期零安装）→ 不在本文件：镜像层已 pin 版本预烘焙（P0-3-1）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 桥接的是「容器主进程」，于是生命周期全是被推出来的
 * ═══════════════════════════════════════════════════════════════════════
 * `docker.ts#attachSandboxStdio` 的注释解释了为什么是 `attach` 而不是 `exec`。
 * 三条推论，每条都直接对应 `子方案③` §九 2 的某个判据：
 *   · **容器一死，桥必然断** ⇒ 桥不需要"探活"，**流结束就是结论**（`#wire` 的 `onGone`）；
 *   · **桥断开 ≠ 容器被回收**（`StdinOnce: false` ⇒ 容器 stdin 不关，pi 原地等下一次 attach）
 *     ⇒ `close()` **只拆连接**，要杀容器请走 `manager.ts#recycleSandbox`；
 *   · **进程一死容器里就没有对话者** ⇒ 启动对账清掉全部容器（P0-3-2 已落地，此处不重复）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * stderr：进日志、**绝不进 SSE**，而且要脱敏
 * ═══════════════════════════════════════════════════════════════════════
 * §六 3 的表里写死了"引擎 stderr → 不进 SSE，进后端日志（脱敏）"：
 *   · **不进 SSE** 是因为"前端不该看引擎的抱怨"（里面是路径、版本、内部栈）；
 *   · **脱敏** 是因为上游 401 的响应体常把 `Authorization` 回显出来，而 pi 会把它打给 stderr
 *     ⇒ 不抹掉就等于借日志把 Key 漏出去（同一个教训见 `llm/upstream.ts#redactSecret`）。
 *     Key 从哪儿来：**只有容器自己知道** ⇒ 用 `docker#readSandboxLlmApiKey` 读回来专门用来抹
 *     （那个函数注释里写了为什么它只读这一个键）。
 *
 * 默认级别是 **`debug`**：引擎 stderr 里混着大量正常噪声（启动信息、进度、警告），
 * 而真正的故障走的是**事件流**（pi `docs/rpc.md` "Errors"：prompt 被接受之后的失败
 * "appear in the message and event stream"）⇒ 一律用 `warn` 就是把噪声当故障报。
 * 需要看它时：尾巴收在 {@link SandboxRpc.stderrTail}，并在**异常收尾**（记录超限 / 命令超时 /
 * 连接断开）时随那条 warn 一起打出来。
 */

import { getLogger } from '../infra/logger.js'
import { redactSecret } from '../llm/upstream.js'
import { attachSandboxStdio, readSandboxLlmApiKey, type SandboxStdio } from './docker.js'
import { JsonlRecordTooLargeError, PI_RPC_STDIO_MAX_BYTES, createJsonlDecoder, type JsonlDecoder } from './jsonl.js'
import { touchSandbox } from './manager.js'

// ───────────────────── 代码常量（`子方案③` §二 表尾那几条）─────────────────────

/**
 * 一条命令的应答超时。
 *
 * **代码常量、不进 env**：它不是"行为窗口"（那种要能注入小值才验得了，如空闲回收的 30 分钟），
 * 而是**防呆上界** —— 命令只有"派活 / 中断 / 查状态"这三类，正常应答都在毫秒级；
 * 30 秒还不回只可能是引擎卡死或协议漂移，那时**报错比继续等有用**。
 * 取值与 pi 官方 `RpcClient` 的内部超时一致（30s）。
 */
const RPC_REQUEST_TIMEOUT_MS = 30_000

/**
 * 引擎事件刷新 `sandboxes.last_active_at` 的**节流**间隔。
 *
 * 为什么必须节流：一次回答会产出成百上千条 `text_delta`，每条写一次库毫无意义
 * （回收窗口是 30 分钟）。为什么不进 env：它不改语义，只改"回收判据的滞后量" ——
 * 30 秒的滞后落在 30 分钟的噪声里（同 `manager.ts#SLOT_POLL_INTERVAL_MS` 的取舍）。
 */
const ACTIVITY_TOUCH_INTERVAL_MS = 30_000

/**
 * 中断之后等 `agent_settled` 的宽限。
 *
 * pi 的 `abort` 应答**本身**就是"等到空闲之后才回"（`docs/rpc-commands.md#abort`），
 * 所以正常情况下 `agent_settled` 几乎同时到。宽限是为了兜住"引擎卡在某个工具里不响应中断"
 * —— 那时桥**如实回"被中断"**，卡死的引擎由停止路径的容器回收（P0-3-8 已定案：
 * `taskAgent.ts` 收尾时 `force` 删除 = SIGKILL；桥自己仍然不杀容器）。
 */
const ABORT_SETTLE_GRACE_MS = 15_000

/** stderr 尾巴保留的字符数（只留尾部：排障用，不该被一个话多的引擎把内存吃掉） */
const STDERR_TAIL_CHARS = 8 * 1024

/** 引擎明确说"这一轮到此为止"的唯一事件名（`子方案③` §六 3 / §六 4 坑 2） */
const AGENT_SETTLED = 'agent_settled'

// ───────────────────── 协议形状（结构类型，刻意不依赖 pi 的包）─────────────────────

/** 发往引擎的命令（`docs/rpc-commands.md`；`id` 由 {@link SandboxRpc.send} 自动补上） */
export type PiRpcCommand = { type: string } & Record<string, unknown>

/** 引擎对一条命令的应答（按 `id` 配对） */
export interface PiRpcResponse {
  type: 'response'
  id?: string
  command?: string
  success?: boolean
  /** `success === false` 时引擎给的原因 */
  error?: string
  data?: unknown
}

/**
 * 引擎的会话事件（`docs/json.md`）。
 *
 * ⚠️ 刻意**不用** pi 导出的 `JsonAgentSessionEvent` 类型：那个包只存在于**容器里**，
 * 后端 node_modules 里没有它，而"为了一个类型装一份引擎"是本末倒置。同款取舍见 MCP 那一族
 * （`mcp/` 的错误码常量各写一份，别让上游升级改我们的文案）。
 */
export type PiSessionEvent = { type: string } & Record<string, unknown>

/** 桥失败的分类（**枚举**而不是文案：调用方要按它决定回什么事件） */
export type SandboxRpcFailureCode =
  /** 桥已经关了（`close()` 之后，或流已经断了） */
  | 'closed'
  /** 引擎没了（流结束 / socket 出错 / 接不上容器） */
  | 'engine-exited'
  /** 命令没在 {@link RPC_REQUEST_TIMEOUT_MS} 内得到应答 */
  | 'timeout'
  /** 写命令失败（stdin 不可写） */
  | 'write-failed'
  /** 单条记录超过 {@link PI_RPC_STDIO_MAX_BYTES}（桥已断流并按故障收尾） */
  | 'too-large'
  /** 引擎拒绝了这条命令（应答 `success: false`，`message` 是 pi 的原文） */
  | 'rejected'

export class SandboxRpcError extends Error {
  constructor(
    readonly code: SandboxRpcFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'SandboxRpcError'
  }
}

/** 一轮的结局（**没有"跑完了但不知道成没成"这种状态**：要么真收尾，要么给出原因） */
export type TurnOutcome =
  | { ok: true }
  | { ok: false; reason: TurnFailureReason; message: string }

export type TurnFailureReason = 'aborted' | 'timeout' | 'engine-exited' | 'closed' | 'rejected'

export interface RunTurnOptions {
  /** 取消信号（SSE 层的停止信号 / 客户端断开都会触发它） */
  signal?: AbortSignal
  /**
   * 这一轮的硬上限（等 `agent_settled` 的时限）。
   * 缺省**不限** —— 任务型 Agent 的一轮可能跑很久，真正的刹车是停止信号与空闲回收；
   * 给一个默认上限只会变成"长任务被莫名的超时打断"。
   */
  timeoutMs?: number
}

export interface SandboxRpc {
  readonly conversationId: string
  readonly containerId: string
  /** 桥还活着吗（流没断、也没被 `close()` 过） */
  readonly alive: boolean
  /** 发一条命令并等它的应答（按 `id` 配对；`success: false` 会 reject 成 `SandboxRpcError('rejected')`） */
  send(command: PiRpcCommand, options?: { timeoutMs?: number }): Promise<PiRpcResponse>
  /** 订阅引擎事件（P0-3-6 的映射层消费）。返回退订函数 */
  onEvent(listener: (event: PiSessionEvent) => void): () => void
  /** 派活并等**这一轮真的收尾**（= 发 prompt + 等 `agent_settled`，见文件头坑 2） */
  runTurn(message: string, options?: RunTurnOptions): Promise<TurnOutcome>
  /** 中断当前运行（P0-3-8 的停止路径）。⚠️ 只发中断，**不杀容器** */
  abort(): Promise<void>
  /** 拆掉连接（不关容器；幂等 —— 收尾路径与进程退出路径各会调一次） */
  close(reason?: string): void
  /** 脱敏后的 stderr 尾巴（排障用：引擎抱怨了什么，看这里） */
  stderrTail(): string
}

export interface OpenSandboxRpcOptions {
  conversationId: string
  /** 容器 id（由 `ensureSandbox()` 给出；桥**不自己查库**） */
  containerId: string
  /** 覆盖单条记录上限（核查脚本用；生产走 `jsonl.ts` 的默认值） */
  maxRecordBytes?: number
  /** 覆盖命令应答超时（核查脚本用） */
  requestTimeoutMs?: number
}

// ───────────────────────────── 实现 ─────────────────────────────

interface PendingRequest {
  resolve: (response: PiRpcResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface SettledWaiter {
  resolve: (outcome: TurnOutcome) => void
  /** 这一轮**被取消过**：即使之后收到 `agent_settled`，结论也是"被中断"而不是"成功" */
  aborted: boolean
  timer: NodeJS.Timeout | undefined
  abortListener: (() => void) | undefined
  signal: AbortSignal | undefined
}

class SandboxRpcSession implements SandboxRpc {
  readonly conversationId: string
  readonly containerId: string

  readonly #stdio: SandboxStdio
  readonly #requestTimeoutMs: number
  readonly #decoder: JsonlDecoder

  /** 在飞命令（按 `id` 配对） */
  readonly #pending = new Map<string, PendingRequest>()
  /** 这一轮收尾的等待者（正常只会有一个：同一个容器不接受并发 prompt） */
  readonly #settleWaiters = new Set<SettledWaiter>()
  readonly #eventListeners = new Set<(event: PiSessionEvent) => void>()

  #commandSeq = 0
  #alive = true
  /** 引擎 stderr 的尾巴（**已脱敏**） */
  #stderrTail = ''
  /** 注入容器的那把 Key —— 只用于把 stderr 里可能回显的它抹掉 */
  #secret: string | null = null
  #lastTouchedAt = 0
  #closing = false

  constructor(input: {
    conversationId: string
    containerId: string
    stdio: SandboxStdio
    requestTimeoutMs: number
    maxRecordBytes: number
    /**
     * 注入容器的那把 Key（只用于抹掉 stderr 里可能回显的它）。
     * `null` = 不知道 ⇒ 少抹一层，不影响任何别的事（见 {@link openSandboxRpc}）。
     */
    secret: string | null
  }) {
    this.conversationId = input.conversationId
    this.containerId = input.containerId
    this.#stdio = input.stdio
    this.#requestTimeoutMs = input.requestTimeoutMs
    this.#secret = input.secret
    // 上限就是 `子方案③` §二 表尾那个常量（调用方可以覆盖，只为核查脚本）
    this.#decoder = createJsonlDecoder({ maxRecordBytes: input.maxRecordBytes })
    this.#wire()
  }

  get alive(): boolean {
    return this.#alive
  }

  // ── 接线：三个流 ──────────────────────────────────────────────

  #wire(): void {
    // stdout：**唯一**的协议来源（stderr 已被 demux 分走，见 `docker.ts`）
    this.#stdio.stdout.on('data', (chunk: Buffer | string) => {
      let lines: string[]
      try {
        lines = this.#decoder.push(chunk)
      } catch (error) {
        // 单条记录超限 ⇒ 断流并按故障收尾（`子方案③` §二 表尾那一行）
        this.#fail(
          new SandboxRpcError(
            'too-large',
            error instanceof JsonlRecordTooLargeError ? error.message : `解析引擎输出失败：${String(error)}`,
          ),
        )
        return
      }
      for (const line of lines) this.#handleLine(line)
    })

    // stderr：进日志（debug）+ 留尾巴，**不进 SSE**（文件头那一段）
    this.#stdio.stderr.on('data', (chunk: Buffer | string) => {
      this.#appendStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })

    /**
     * 裸连接：容器/引擎没了就是它先知道。
     *
     * ⚠️ **顺序即正确性**：必须**先**把解码器缓冲区里最后那一行处理掉，**再**宣告断开 ——
     * 引擎常常是"说完最后一句（`agent_settled`）就退出"，先宣告断开会让那一轮
     * 从"成功收尾"变成"引擎退出"。三种事件（end/close/error）都走同一条路。
     */
    const onGone = (why: string): void => {
      if (!this.#alive) return
      for (const line of this.#decoder.flush()) this.#handleLine(line)
      // flush 出来的最后一行可能正是 `agent_settled` ⇒ 它已经把等待者结掉了，此时 `#alive` 已是 false
      if (this.#alive) this.#fail(new SandboxRpcError('engine-exited', `引擎已退出（${why}）`))
    }
    this.#stdio.stream.on('end', () => onGone('stdout 结束'))
    this.#stdio.stream.on('close', () => onGone('连接关闭'))
    this.#stdio.stream.on('error', (error: Error) => onGone(`连接出错：${error.message}`))
  }

  // ── 命令 ──────────────────────────────────────────────────────

  send(command: PiRpcCommand, options: { timeoutMs?: number } = {}): Promise<PiRpcResponse> {
    if (!this.#alive) return Promise.reject(new SandboxRpcError('closed', '引擎桥已关闭'))

    const id = `${this.conversationId.slice(0, 8)}-${++this.#commandSeq}`
    const record = `${JSON.stringify({ ...command, id })}\n`
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new SandboxRpcError(
            'timeout',
            `引擎在 ${timeoutMs}ms 内没有应答 ${command.type}（stderr：${this.#tailForLog()}）`,
          ),
        )
      }, timeoutMs)
      // ⚠️ **先登记再写**：应答可能在 `write()` 返回之前就被读到（同一个 tick 里的事件）
      this.#pending.set(id, { resolve, reject, timer })
      try {
        // ⚠️ 这里**不等 `drain`**（与 pi 文档那句 "Honor stdin backpressure when writing commands"
        //    有意偏离）：命令只有"派活 / 中断 / 查状态"三类、报文是几百字节到几 KB，
        //    而 socket 自己的写队列会把它们排好。真要等 `drain` 就得把 `send` 变成
        //    "排队 + 回压"两件事，代价大于收益。**带图片的 prompt（P1）会改变这个判断**。
        this.#stdio.stream.write(record)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(
          new SandboxRpcError(
            'write-failed',
            `写引擎 stdin 失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    })
  }

  onEvent(listener: (event: PiSessionEvent) => void): () => void {
    this.#eventListeners.add(listener)
    return () => {
      this.#eventListeners.delete(listener)
    }
  }

  async runTurn(message: string, options: RunTurnOptions = {}): Promise<TurnOutcome> {
    if (!this.#alive) return { ok: false, reason: 'closed', message: '引擎桥已关闭' }
    if (options.signal?.aborted === true) return { ok: false, reason: 'aborted', message: '派活之前就已被取消' }

    // ★ **订阅先于派活**（pi `docs/rpc.md`："Subscribe before sending a prompt to avoid missing
    //   a fast completion"）。顺序反过来，一次极快的收尾会在我们挂上监听之前就过去
    //   ⇒ 这一轮永远等不到 `agent_settled`（症状：请求挂到天荒地老）。
    const { waiter, outcome } = this.#armSettled(options)

    try {
      await this.send({ type: 'prompt', message })
    } catch (error) {
      // 派活本身失败 ⇒ 撤掉等待者（否则它会一直挂着，也没人会取消它），按错误分类回结论
      this.#finishWaiter(waiter, { ok: false, reason: 'closed', message: '派活失败' })
      return outcomeFromError(error)
    }
    return outcome
  }

  async abort(): Promise<void> {
    if (!this.#alive) return
    // 忽略失败：中断是"尽力而为 + 有宽限"的路径（abort 命令被拒 —— 例如本来就没在跑 ——
    // 不该变成一个异常）。真正的判据是"`agent_settled` 有没有来"。
    await this.send({ type: 'abort' }).catch((error: unknown) => {
      getLogger().debug({ err: error, conversationId: this.conversationId }, '发中断命令失败（继续等 agent_settled）')
    })
  }

  close(reason = 'closed'): void {
    if (this.#closing) return
    this.#closing = true
    this.#fail(new SandboxRpcError('closed', `引擎桥已关闭（${reason}）`))
  }

  stderrTail(): string {
    return this.#stderrTail
  }

  // ── 内部：收行 / 配对 / 收尾 ────────────────────────────────────

  #handleLine(line: string): void {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      // ℹ️ **不是**事件：pi 的 stdout 只写 JSONL，出现非 JSON 只可能是协议漂移
      //    （分帧错的可能已被 `jsonl.ts` 的"只认 LF"排除）。留痕但**不派发** ——
      //    把一行噪声当事件推给映射层，症状是"前端收到一张来源不明的卡"。
      if (line.trim() !== '') {
        getLogger().warn(
          { conversationId: this.conversationId, line: truncate(line, 200) },
          '引擎 stdout 上出现非 JSON 行（已忽略）',
        )
      }
      return
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      getLogger().warn({ conversationId: this.conversationId }, '引擎 stdout 上出现非对象记录（已忽略）')
      return
    }

    const type = (record as { type?: unknown }).type
    if (type === 'response') {
      this.#resolvePending(record as PiRpcResponse)
      return
    }

    // 会话事件：① 刷活跃（`sandbox.last_active_at` 的**唯一写入口**的调用时机）
    //           ② 派给订阅者（P0-3-6 的映射层）
    //           ③ `agent_settled` ⇒ 结掉这一轮
    this.#touchActivity()
    const event = record as PiSessionEvent
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(event)
      } catch (error) {
        // 一个订阅者抛错不该把桥带走（订阅者是编排层，它的 bug 是它自己的问题）
        getLogger().error(
          { err: error, conversationId: this.conversationId, type },
          '引擎事件订阅者抛错（只忽略该订阅者本次回调）',
        )
      }
    }
    if (type === AGENT_SETTLED) this.#settle()
  }

  #resolvePending(response: PiRpcResponse): void {
    const id = response.id
    const pending = id === undefined ? undefined : this.#pending.get(id)
    if (pending === undefined || id === undefined) {
      // ⚠️ 与上游 `RpcClient` **刻意不同**：它把"配不上号的应答"当事件派出去
      //    （`handleLine` 里那一支 `else`）。那种行不是会话事件，派出去只会让映射层
      //    收到一个 `type:'response'` 的怪东西。可能的来源：我们已经超时并删掉了那条 pending。
      getLogger().warn(
        { conversationId: this.conversationId, id: id ?? null, command: response.command ?? null },
        '收到配不上号的引擎应答（已丢弃）',
      )
      return
    }
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (response.success === false) {
      pending.reject(new SandboxRpcError('rejected', response.error ?? `引擎拒绝执行 ${response.command ?? ''}`))
      return
    }
    pending.resolve(response)
  }

  /**
   * 挂一个"等 `agent_settled`"的等待者（**在派活之前**调用 —— 见 `runTurn` 的注释）。
   *
   * 返回 `{ waiter, outcome }` 而不是只返回 Promise：`outcome` 在**登记进集合之后**就已经
   * 可以被别人 resolve，而 `runTurn` 还要先 `await send(...)`。写成"先 await send 再等"
   * 就是文件头坑 2 后面注释里说的那个竞态。
   */
  #armSettled(options: RunTurnOptions): { waiter: SettledWaiter; outcome: Promise<TurnOutcome> } {
    let settle!: (outcome: TurnOutcome) => void
    const outcome = new Promise<TurnOutcome>((resolve) => {
      settle = resolve
    })
    const waiter: SettledWaiter = {
      resolve: settle,
      aborted: false,
      timer: undefined,
      abortListener: undefined,
      signal: options.signal,
    }

    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs
      waiter.timer = setTimeout(() => {
        this.#finishWaiter(waiter, {
          ok: false,
          reason: 'timeout',
          message: `这一轮超过 ${timeoutMs}ms 仍未收尾`,
        })
      }, timeoutMs)
    }

    const signal = options.signal
    if (signal !== undefined) {
      waiter.abortListener = () => {
        waiter.aborted = true
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        // 中断之后**继续等 `agent_settled`**（那才是"真的停了"），但加一个宽限：
        // 引擎卡在不响应中断的工具里时，桥如实回"被中断"；卡死的引擎由停止路径的
        // 容器回收收走（P0-3-8 定案，见文件头 `ABORT_SETTLE_GRACE_MS`）。
        waiter.timer = setTimeout(() => {
          this.#finishWaiter(waiter, { ok: false, reason: 'aborted', message: '已请求中断，但引擎未在宽限内收尾' })
        }, ABORT_SETTLE_GRACE_MS)
        void this.abort()
      }
      signal.addEventListener('abort', waiter.abortListener, { once: true })
      // 信号可能在我们挂监听**之前**就触发了（`addEventListener` 不会补发）
      if (signal.aborted) waiter.abortListener()
    }

    this.#settleWaiters.add(waiter)
    return { waiter, outcome }
  }

  /** 收尾：所有等待者都被结掉（`agent_settled` 到了） */
  #settle(): void {
    for (const waiter of [...this.#settleWaiters]) {
      if (waiter.aborted) {
        this.#finishWaiter(waiter, { ok: false, reason: 'aborted', message: '这一轮被中断，引擎已收尾' })
      } else {
        this.#finishWaiter(waiter, { ok: true })
      }
    }
  }

  /** 结掉一个等待者（**幂等**：清定时器、摘 abort 监听、移出集合、resolve） */
  #finishWaiter(waiter: SettledWaiter, outcome: TurnOutcome): void {
    if (!this.#settleWaiters.has(waiter)) return
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abortListener)
    }
    waiter.abortListener = undefined
    waiter.timer = undefined
    this.#settleWaiters.delete(waiter)
    waiter.resolve(outcome)
  }

  /** 异常/主动收尾：结掉等待者与在飞命令、拆连接、留一条日志（异常时带 stderr 尾巴） */
  #fail(error: SandboxRpcError): void {
    if (!this.#alive) return
    this.#alive = false
    const reason: TurnFailureReason = error.code === 'closed' ? 'closed' : 'engine-exited'
    for (const waiter of [...this.#settleWaiters]) {
      this.#finishWaiter(waiter, { ok: false, reason, message: error.message })
    }
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(error)
    }

    if (this.#closing) {
      getLogger().info(
        { conversationId: this.conversationId, containerId: this.containerId, code: error.code },
        '引擎桥已关闭',
      )
    } else {
      // 不是我们主动关的 ⇒ 这一轮/这个容器出事了，把 stderr 尾巴一起带上（文件头那一段）
      getLogger().warn(
        {
          conversationId: this.conversationId,
          containerId: this.containerId,
          code: error.code,
          stderr: this.#tailForLog(),
        },
        `引擎桥断开：${error.message}`,
      )
    }
    this.#stdio.detach()
    this.#eventListeners.clear()
  }

  /**
   * 刷新 `last_active_at`（**节流**，见 {@link ACTIVITY_TOUCH_INTERVAL_MS}）。
   *
   * ⚠️ 一律 `catch`：这条路径在**收尾时**也会走到（容器可能刚被回收），
   * 而"记不上活跃"绝不该把桥带下去（`touchSandbox` 自己也是"不抛错"的语义）。
   */
  #touchActivity(): void {
    const now = Date.now()
    if (now - this.#lastTouchedAt < ACTIVITY_TOUCH_INTERVAL_MS) return
    this.#lastTouchedAt = now
    void touchSandbox(this.conversationId).catch((error: unknown) => {
      getLogger().debug({ err: error, conversationId: this.conversationId }, '刷新沙箱活跃时间失败（忽略）')
    })
  }

  #appendStderr(text: string): void {
    const redacted = redactSecret(text, this.#secret)
    this.#stderrTail = `${this.#stderrTail}${redacted}`
    if (this.#stderrTail.length > STDERR_TAIL_CHARS) this.#stderrTail = this.#stderrTail.slice(-STDERR_TAIL_CHARS)
    for (const line of redacted.split('\n')) {
      if (line.trim() !== '') getLogger().debug({ conversationId: this.conversationId }, `引擎 stderr：${line}`)
    }
  }

  /** 进日志的 stderr 尾巴（截断；**已脱敏** —— 见 `#appendStderr`） */
  #tailForLog(): string {
    const trimmed = this.#stderrTail.trim()
    return truncate(trimmed === '' ? '（空）' : trimmed, 600)
  }
}

// ───────────────────────────── 对外：建 / 取 / 关 ─────────────────────────────

/**
 * 用**已经拿到的一对 stdio 流**建一条桥（P0-3-5 的可注入形态）。
 *
 * 与 {@link openSandboxRpc} 分开是刻意的：`openSandboxRpc` 只多干两件事 ——
 * ① `attachSandboxStdio()`（真连 Docker）、② 读回 Key 用于 stderr 脱敏。
 * 把"协议逻辑"与"从哪儿拿流"拆开之后，配对 / 收尾 / 超时 / 关闭这几条**最容易写错的顺序**
 * 可以在**不连 Docker**的情况下逐条跑（`subprocess` 那侧换成一对内存流即可）。
 */
export function createSandboxRpc(input: {
  conversationId: string
  containerId: string
  stdio: SandboxStdio
  requestTimeoutMs?: number
  maxRecordBytes?: number
  /** 已知的 Key（用于 stderr 脱敏）；不知道就传 `null`/省略 */
  secret?: string | null
}): SandboxRpc {
  return new SandboxRpcSession({
    conversationId: input.conversationId,
    containerId: input.containerId,
    stdio: input.stdio,
    requestTimeoutMs: input.requestTimeoutMs ?? RPC_REQUEST_TIMEOUT_MS,
    maxRecordBytes: input.maxRecordBytes ?? PI_RPC_STDIO_MAX_BYTES,
    secret: input.secret ?? null,
  })
}

/**
 * 接上容器主进程的 stdio 并建桥（生产路径）。
 *
 * 失败一律抛 `SandboxRpcError('engine-exited')`：容器被回收之后 `attach` 会 404，
 * 这是**业务上正常的**情形 ⇒ 调用方应当回去重新 `ensureSandbox`，而不是把它当异常吞掉。
 *
 * ⚠️ 顺序：**先 attach、再读 Key**（读 Key 要 inspect，而 attach 才是真正的硬故障）。
 * 读 Key 失败只降级（少抹一层 stderr），**不让建桥失败**。
 */
export async function openSandboxRpc(options: OpenSandboxRpcOptions): Promise<SandboxRpc> {
  let stdio: SandboxStdio
  try {
    stdio = await attachSandboxStdio(options.containerId)
  } catch (error) {
    throw new SandboxRpcError(
      'engine-exited',
      `接不上容器 ${options.containerId} 的引擎：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let secret: string | null = null
  try {
    secret = (await readSandboxLlmApiKey(options.containerId)) ?? null
  } catch (error) {
    getLogger().debug({ err: error, containerId: options.containerId }, '读容器 LLM Key 失败（跳过 stderr 脱敏）')
  }

  return createSandboxRpc({
    conversationId: options.conversationId,
    containerId: options.containerId,
    stdio,
    requestTimeoutMs: options.requestTimeoutMs,
    maxRecordBytes: options.maxRecordBytes,
    secret,
  })
}

/**
 * 进程内**一个会话一条桥**（键 = `conversationId`）。
 *
 * ★ 为什么必须复用而不是"每轮开一条"：`attach` 断开时容器 stdin **不会**关
 * （`StdinOnce: false`），而 pi 的 stdout 是一条**有背压**的管道 —— 每轮换一条连接，
 * 两轮之间引擎写下的事件就落进一条没人读的管道（要么堆着、要么把引擎卡住，
 * pi `docs/rpc.md` 明说"a client that stops reading can stall the process"）。
 * 与其在"谁来读两轮之间的输出"上做文章，不如让桥活得和容器一样久。
 *
 * ⚠️ 键用 `conversationId` 而不是 `containerId`：容器换了（模型变更 / 回收重建）之后，
 * 会话应当拿到**新容器**的桥 ⇒ 下面显式比对 `containerId`，不一致就换。
 */
const bridges = new Map<string, SandboxRpc>()
/** 正在建立中的桥：防同一会话并发 attach 出两条（两条读者会互相吃掉对方读到的字节） */
const opening = new Map<string, Promise<SandboxRpc>>()

/** 取（必要时建）某个会话的桥。容器换了就换桥 */
export async function getSandboxRpc(conversationId: string, containerId: string): Promise<SandboxRpc> {
  const existing = bridges.get(conversationId)
  if (existing !== undefined) {
    if (existing.alive && existing.containerId === containerId) return existing
    // 容器换了（或桥已经死了）⇒ 主动关一下，好让在飞命令立刻失败而不是等超时
    existing.close('container-changed')
    bridges.delete(conversationId)
  }

  const inFlight = opening.get(conversationId)
  if (inFlight !== undefined) {
    const bridge = await inFlight
    // 建立期间容器又换了 ⇒ 重来一次（最多一次：上面那条 `opening` 已被 `finally` 清掉）
    return bridge.containerId === containerId ? bridge : getSandboxRpc(conversationId, containerId)
  }

  const promise = openSandboxRpc({ conversationId, containerId })
    .then((bridge) => {
      bridges.set(conversationId, bridge)
      getLogger().debug({ conversationId, containerId }, '引擎桥已建立')
      return bridge
    })
    .finally(() => {
      opening.delete(conversationId)
    })
  opening.set(conversationId, promise)
  return promise
}

/** 关掉某个会话的桥（幂等）。⚠️ **只拆连接，不碰容器** —— 杀容器走 `recycleSandbox` */
export function closeSandboxRpc(conversationId: string, reason = 'closed'): void {
  const bridge = bridges.get(conversationId)
  bridges.delete(conversationId)
  bridge?.close(reason)
}

/** 关掉全部桥（进程优雅退出的路径；同样**不碰容器**） */
export function closeAllSandboxRpcs(reason = 'shutdown'): void {
  const all = [...bridges.values()]
  bridges.clear()
  for (const bridge of all) bridge.close(reason)
}

/** 观测用（日志 / 排障；**不发起任何 IO**） */
export interface SandboxRpcStats {
  /** 此刻活着的桥数 */
  open: number
  conversations: string[]
}

export function getSandboxRpcStats(): SandboxRpcStats {
  const conversations = [...bridges.keys()]
  return { open: conversations.length, conversations }
}

// ───────────────────────────── 小工具 ─────────────────────────────

/** 派活失败的错误 → 一轮的结局（把"桥的失败分类"翻成"这一轮为什么没成"） */
function outcomeFromError(error: unknown): TurnOutcome {
  if (error instanceof SandboxRpcError) {
    const reason: TurnFailureReason =
      error.code === 'rejected'
        ? 'rejected'
        : error.code === 'closed'
          ? 'closed'
          : error.code === 'timeout'
            ? 'timeout'
            : 'engine-exited'
    return { ok: false, reason, message: error.message }
  }
  return { ok: false, reason: 'engine-exited', message: error instanceof Error ? error.message : String(error) }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text
}
