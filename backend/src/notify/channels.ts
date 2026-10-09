/**
 * 通知渠道的**报文构造**（P1-6 增量，`01` 场景 1）—— 零依赖纯函数
 *
 * 依据：`docs/02` §4.8（通知口径）、`docs/03`、`shared/src/task.ts`（`NOTIFY_TYPES` / `NOTIFY_TEXT_MAX`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条渠道的 JSON 外壳**各不相同**（"好看"是渠道能力，不是我们说了算）
 * ─────────────────────────────────────────────────────────────────────
 * · **企微群机器人**：`{ msgtype:'markdown', markdown:{ content } }` —— content 用 `markdownNotification`。
 * · **飞书自定义机器人**：`{ msg_type:'interactive', card:{…} }` —— 用**消息卡片**（header 上色、
 *   `lark_md` 正文），比 `text` 好看得多；开启"签名校验"时**顶层**再加 `timestamp`+`sign`。
 * · **通用 webhook**：`{ text }` —— 纯文本。
 * 逻辑消息与三种渲染在 `template.ts`；本文件只负责"把渲染结果装进各渠道的 JSON"。
 *
 * ⚠️ 飞书签名算法：`string_to_sign = `${timestamp}\n${secret}``（`timestamp` 是**秒**），
 * 以它为 **HMAC-SHA256 密钥**、**空串为消息**，结果 base64（密钥与消息位置写反会一律 400）。
 */

import { createHmac } from 'node:crypto'

import { NOTIFY_TEXT_MAX, type NotifyType } from '@doubulea/shared'

import {
  feishuCardElements,
  feishuCardTemplate,
  markdownNotification,
  plainNotification,
  type NotifyMessage,
} from './template.js'

/** 超过上限即截断（企微 markdown 约 4096 字节；不报错，附一行省略提示） */
export function truncateNotifyText(text: string): string {
  if (text.length <= NOTIFY_TEXT_MAX) return text
  return `${text.slice(0, NOTIFY_TEXT_MAX - 1)}…`
}

/**
 * 飞书自定义机器人「签名校验」的 `sign`。
 *
 * 算法（飞书官方）：`string_to_sign = `${timestamp}\n${secret}``（`timestamp` 是**秒**），
 * 以 `string_to_sign` 为 **HMAC-SHA256 的密钥**、**空串为消息**，结果 base64。
 * ⇒ 密钥与消息位置很容易写反（写反后飞书一律 400，且看不出为什么），故单独成函数、单独实测。
 */
export function feishuSign(secret: string, timestampSec: number): string {
  const stringToSign = `${timestampSec}\n${secret}`
  return createHmac('sha256', stringToSign).update('').digest('base64')
}

/** 各个渲染结果统一截断（正文可能很长） */
function clamp(message: NotifyMessage): NotifyMessage {
  return { ...message, text: truncateNotifyText(message.text) }
}

/**
 * 造一个渠道的 POST body。
 *
 * @param type   渠道类型（`NONE` 不该走到这里；调用方先判）
 * @param message 逻辑消息（标题 + 正文 + 可选 run 元信息）
 * @param secret  飞书签名密钥（可选；仅 `FEISHU` 用）
 * @param nowMs   取时间戳用（注入以便实测）
 */
export function buildNotifyBody(
  type: Exclude<NotifyType, 'NONE'>,
  message: NotifyMessage,
  secret: string | null,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  const msg = clamp(message)
  switch (type) {
    case 'WECOM':
      return { msgtype: 'markdown', markdown: { content: markdownNotification(msg) } }
    case 'FEISHU': {
      const payload: Record<string, unknown> = {
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          header: {
            template: feishuCardTemplate(msg),
            title: { tag: 'plain_text', content: msg.title },
          },
          elements: feishuCardElements(msg),
        },
      }
      if (secret !== null && secret !== '') {
        const timestamp = Math.floor(nowMs / 1000)
        payload.timestamp = String(timestamp)
        payload.sign = feishuSign(secret, timestamp)
      }
      return payload
    }
    case 'WEBHOOK':
      return { text: plainNotification(msg) }
  }
}
