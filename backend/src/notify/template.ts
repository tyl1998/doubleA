/**
 * 通知的**逻辑模型与各渠道文案**（P1-6 增量，`01` 场景 1）—— 纯函数
 *
 * 依据：`docs/02` §4.8（通知口径）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 一个逻辑消息，三种渲染（"好看"是渠道的能力差异，不是我们说了算）
 * ─────────────────────────────────────────────────────────────────────
 * 三条渠道对"富文本"的支持完全不同，把同一段字符串硬塞过去只会某一处难看：
 *   · **企微群机器人**：支持 `markdown`（`**粗体**`、`>` 引用）⇒ 用 markdown 渲染；
 *   · **飞书自定义机器人**：`text` 不支持任何格式；要好看得用 `interactive` **消息卡片**
 *     （`header.template` 给颜色、`lark_md` 给正文）⇒ 用卡片渲染；
 *   · **通用 webhook**：对方大概率只认 `{ text }` ⇒ **纯文本**渲染。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 通知模板（用户定案：用模板语言）
 * ─────────────────────────────────────────────────────────────────────
 * 任务是可配 `template`（明文）：用 `{{task}} / {{time}} / {{status}} / {{result}}` 占位符自定义消息；
 * **留空**则回落到内置默认（抬头 + 时间/状态 + 正文）。模板渲染结果**替代正文部分**，
 * 渠道外壳（企微 markdown / 飞书卡片头 / 通用 text）仍按渠道套上。
 * ⚠️ 只认这四个占位符；**认不出的 `{{xxx}}` 原样保留**（让写错的人一眼看见，而不是被静默吞掉）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 两种形态的文案口径**刻意不同**
 * ─────────────────────────────────────────────────────────────────────
 * · **自动推送**：带 `run`（时间 + 状态）—— 它是"系统跑完顺手告诉你一声"，用户需要"哪条任务、成没成"；
 * · **`send_notification` 工具**：不带 `run`（只有标题 + 模型给的正文）—— 那是模型在与用户对话，
 *   硬套时间/状态反而会在多轮通知里反复重复同一串元信息。
 *
 * ⚠️ 时间用**服务器本地时区**（与 cron、前端时间读数同口径，见 `06` §六 时区纪律）。
 */

/** 本地时间戳（`YYYY-MM-DD HH:mm`） */
export function localStamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 一条逻辑通知：标题（任务名）+ 正文；`run` 有值 = 自动推送（带时间/状态），无 = 工具形态；`template` = 用户模板 */
export interface NotifyMessage {
  title: string
  text: string
  run?: { at: Date; ok: boolean }
  /** 用户自定义模板（`{{task}}` 等占位符）；`null`/空串 = 用内置默认 */
  template?: string | null
}

/** 状态中文（内部用，不带 emoji） */
function statusText(ok: boolean): string {
  return ok ? '成功' : '失败'
}

/** 正文兜底（不让通知只剩抬头） */
export function bodyOf(message: NotifyMessage): string {
  return message.text.trim() === '' ? '（本次没有文本输出）' : message.text.trim()
}

/** 时间 + 状态那一行；工具形态（无 `run`）为 `null` */
export function runLine(message: NotifyMessage): string | null {
  if (message.run === undefined) return null
  return `时间：${localStamp(message.run.at)} | 状态：${message.run.ok ? '✅ 成功' : '❌ 失败'}`
}

/** 模板变量取值（`{{key}}` → 文本；未知 key 不在表里 ⇒ 原样保留） */
function templateVars(message: NotifyMessage): Record<string, string> {
  return {
    task: message.title,
    time: message.run === undefined ? '' : localStamp(message.run.at),
    status: message.run === undefined ? '' : statusText(message.run.ok),
    result: bodyOf(message),
  }
}

/**
 * 渲染用户模板：替换 `{{ key }}`（允许花括号内空格）。**未知占位符原样保留**。
 */
export function renderNotifyTemplate(template: string, message: NotifyMessage): string {
  const vars = templateVars(message)
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] as string) : whole,
  )
}

/** 是否用了自定义模板（非空） */
function hasTemplate(message: NotifyMessage): boolean {
  return message.template !== undefined && message.template !== null && message.template.trim() !== ''
}

/** 纯文本渲染（通用 webhook）：有模板用模板，否则默认抬头 +（时间 | 状态）+ 正文 */
export function plainNotification(message: NotifyMessage): string {
  if (hasTemplate(message)) return renderNotifyTemplate(message.template as string, message)
  const head =
    message.run === undefined
      ? `【定时任务】${message.title}`
      : `【定时任务】${message.title}\n时间：${localStamp(message.run.at)} | 状态：${message.run.ok ? '✅ 成功' : '❌ 失败'}`
  return `${head}\n\n${bodyOf(message)}`
}

/** 企微 markdown 渲染：有模板用模板，否则标题加粗 + 引用状态行 + 正文 */
export function markdownNotification(message: NotifyMessage): string {
  if (hasTemplate(message)) return renderNotifyTemplate(message.template as string, message)
  const head =
    message.run === undefined
      ? `**${message.title}**`
      : `**${message.title}**\n> 时间：${localStamp(message.run.at)} | 状态：${message.run.ok ? '✅ 成功' : '❌ 失败'}`
  return `${head}\n\n${bodyOf(message)}`
}

/** 飞书卡片的**颜色**（`header.template`）：成功=green、失败=red、工具形态=blue */
export function feishuCardTemplate(message: NotifyMessage): string {
  if (message.run === undefined) return 'blue'
  return message.run.ok ? 'green' : 'red'
}

/** 飞书卡片的正文元素（有模板用模板；否则"时间|状态"行 + 正文） */
export function feishuCardElements(message: NotifyMessage): unknown[] {
  if (hasTemplate(message)) {
    return [{ tag: 'div', text: { tag: 'lark_md', content: renderNotifyTemplate(message.template as string, message) } }]
  }
  const elements: unknown[] = []
  const line = runLine(message)
  if (line !== null) elements.push({ tag: 'div', text: { tag: 'lark_md', content: line } })
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: bodyOf(message) } })
  return elements
}
