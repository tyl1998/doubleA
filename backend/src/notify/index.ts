/**
 * 通知发送 + 会话↔渠道登记（P1-6 增量，`01` 场景 1）
 *
 * 依据：`docs/02` §4.8（通知口径 + 内置工具 `send_notification`）、`shared/src/task.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 渠道从哪来：一个**进程内登记表** `conversationId → NotifyTarget`
 * ─────────────────────────────────────────────────────────────────────
 * 定时任务运行前，调度器把"这条任务的渠道"登记到本次会话 id 上（`setNotifyTarget`），结束后清除。
 * 两个消费方都按 `conversationId` 取：
 *   · **跑完自动推送**（`scheduler/scheduledTasks.ts`）；
 *   · **`send_notification` 工具**（ChatBot 在进程内、TaskAgent 经沙箱代理 —— 同一进程）。
 * 为什么不落库/不加会话列：渠道是**任务**的属性、只在"这一轮运行"里有效；加一列会引出"会话删了
 * 渠道怎么办"这类本不存在的问题。进程重启时那一轮本就随之中断，登记表为空是对的。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 发送**永不抛错**（只返回结果）
 * ─────────────────────────────────────────────────────────────────────
 * 通知是**尽力而为**的副作用：发失败不该让任务记 `FAILED`、更不该让 `send_notification` 工具把这一轮
 * 带崩。失败只记日志 + 让工具返回 `isError`（模型自己能决定要不要再试/换个说法）。
 */

import { SEND_NOTIFICATION_TOOL_NAME, type NotifyType } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { parseToolArguments } from '../llm/client.js'
import { buildNotifyBody } from './channels.js'
import type { NotifyMessage } from './template.js'

/** 工具卡上显示的「来自哪」标签（与知识库内置工具的 `KNOWLEDGE_TOOL_SERVER_NAME` 同一用途） */
export const NOTIFY_TOOL_SERVER_NAME = '通知'

/** 一个可用的通知目标（`type` 已排除 `NONE`；`url`/`secret` 已是**明文**，只进内存；`title` = 任务名） */
export interface NotifyTarget {
  type: Exclude<NotifyType, 'NONE'>
  url: string
  secret: string | null
  /** 任务名（自动推送的抬头、工具形态的标题都用它） */
  title: string
}

/** 发送结果（`ok:false` 只落日志/工具卡，不上抛） */
export interface NotifyOutcome {
  ok: boolean
  status?: number
  error?: string
}

// ───────────────────────────── 登记表 ─────────────────────────────

const targets = new Map<string, NotifyTarget>()

export function setNotifyTarget(conversationId: string, target: NotifyTarget): void {
  targets.set(conversationId, target)
}

export function clearNotifyTarget(conversationId: string): void {
  targets.delete(conversationId)
}

export function getNotifyTarget(conversationId: string): NotifyTarget | undefined {
  return targets.get(conversationId)
}

// ───────────────────────────── 发送 ─────────────────────────────

/**
 * POST 一条通知到目标渠道。**永不抛错**（见文件头）。
 *
 * `message` 是逻辑消息（标题 + 正文 + 可选运行元信息）；各渠道的渲染与外壳在
 * `channels.ts`/`template.ts`（企微 markdown / 飞书卡片 / 通用纯文本）。
 */
export async function sendNotification(target: NotifyTarget, message: NotifyMessage): Promise<NotifyOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, config.scheduledTask.notifyTimeoutMs)
  timer.unref()
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildNotifyBody(target.type, message, target.secret)),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      getLogger().warn(
        { status: response.status, type: target.type, detail: detail.slice(0, 200) },
        '通知发送失败（HTTP 非 2xx）',
      )
      return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    }
    // 企微/飞书在 200 里也可能带业务错误码（errcode != 0 / code != 0），但格式随渠道而异；
    // 只记一笔响应体便于排查，不据此判失败（避免把"成功但有提示"误判成失败）
    const text2 = await response.text().catch(() => '')
    getLogger().info({ type: target.type, body: text2.slice(0, 200) }, '通知已发送')
    return { ok: true, status: response.status }
  } catch (error) {
    getLogger().warn({ err: error, type: target.type }, '通知发送异常')
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────────── 内置工具 ─────────────────────────────

/** `send_notification` 的描述（两种形态共用，避免两处文案漂移） */
const TOOL_DESCRIPTION =
  '把一条消息发送到本定时任务配置的通知渠道（企微/飞书/通用 webhook）。仅在需要主动通知运行结果或关键信息时调用；不传整段过程，只说结论。'

/** 工具入参的 JSON Schema（沙箱目录与 ChatBot 的 function 定义共用） */
const TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '要发送的正文（纯文本或 markdown）' },
  },
  required: ['text'],
  additionalProperties: false,
}

/** 沙箱内置工具目录项（`catalog.builtins` 的形状；TaskAgent 用） */
export function notifyBuiltinDescriptor(): { name: string; description: string; inputSchema: unknown } {
  return { name: SEND_NOTIFICATION_TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_PARAMETERS }
}

/** ChatBot 的 function 定义（OpenAI 形状，与 `OpenAiFunctionTool` 同形） */
export function notifyOpenAiTool(): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
} {
  return {
    type: 'function',
    function: { name: SEND_NOTIFICATION_TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS },
  }
}

/** 工具执行结果（与 `knowledgeTools` 的 outcome 同形：`{output,isError}`） */
export interface NotifyToolOutcome {
  output: string
  isError: boolean
}

/**
 * 执行 `send_notification`：解析入参 → 取该会话的渠道 → 发送 → 回工具文案。
 *
 * ChatBot 与沙箱代理**共用这一个执行体**（`06` §六 第 ⑰ 条：同一口径不写第二份）。
 */
export async function executeSendNotification(input: {
  conversationId: string
  arguments: string
}): Promise<NotifyToolOutcome> {
  const parsed = parseToolArguments(input.arguments)
  const text = parsed.ok ? parsed.value.text : undefined
  if (typeof text !== 'string' || text.trim() === '') {
    return { output: 'send_notification 需要非空的 text 参数。', isError: true }
  }
  const target = getNotifyTarget(input.conversationId)
  if (target === undefined) {
    return { output: '本次运行没有配置通知渠道，无法发送。', isError: true }
  }
  // 工具形态：只有标题（任务名）+ 模型给的正文，**不带**时间/状态（见 `template.ts` 文件头）
  const outcome = await sendNotification(target, { title: target.title, text })
  return outcome.ok
    ? { output: `已发送到通知渠道（${target.type}）。`, isError: false }
    : { output: `发送失败：${outcome.error ?? '未知错误'}`, isError: true }
}
