#!/usr/bin/env node
/**
 * notify-regression.ts —— 通知渠道渲染/报文的**无依赖**自证（P1-6 增量）
 *
 * 跑法：`pnpm --filter @doubulea/backend notify:regression`（= `node --import tsx scripts/notify-regression.ts`）
 *
 * 依据：`docs/06` §六 第 8 条（计算值实测）/ 第 9 条（脚本用 Node）；被测对象 =
 *      `backend/src/notify/{channels,template}.ts`（纯函数；经 `tsx` 直接跑源码）。
 *
 * ⚠️ 它验的是**渲染与报文形状**：三种渠道的 body、飞书卡片颜色/元素、飞书签名、超长截断、
 *    模板抬头。它**验不了**真发到企微/飞书（那要真 webhook URL ⇒ 交给用户真跑）。
 */

import { buildNotifyBody, feishuSign, truncateNotifyText } from '../src/notify/channels.js'
import {
  feishuCardTemplate,
  localStamp,
  markdownNotification,
  plainNotification,
  renderNotifyTemplate,
  type NotifyMessage,
} from '../src/notify/template.js'
import { NOTIFY_TEXT_MAX } from '@doubulea/shared'

let passed = 0
let failed = 0
function it(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  [PASS] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

const toolMsg: NotifyMessage = { title: '每日汇总', text: '今天新增 3 单' }
const runMsg: NotifyMessage = { title: '每日汇总', text: '今天新增 3 单', run: { at: new Date(2026, 9, 9, 9, 0), ok: true } }

console.log('── A 截断 ──')
it('A1 不超限 ⇒ 原样', () => {
  eq(truncateNotifyText('hello'), 'hello', '短文本')
})
it('A2 超限 ⇒ 截到上限（以 … 结尾）', () => {
  const out = truncateNotifyText('x'.repeat(NOTIFY_TEXT_MAX + 500))
  eq(out.length, NOTIFY_TEXT_MAX, '长度')
  assert(out.endsWith('…'), '应以省略号结尾')
})

console.log('── B 三种渲染 ──')
it('B1 纯文本：抬头（+时间|状态）+ 正文', () => {
  assert(plainNotification(toolMsg).includes('【定时任务】每日汇总'), '工具形态抬头')
  const run = plainNotification(runMsg)
  assert(run.includes('2026-10-09 09:00'), '时间')
  assert(run.includes('✅ 成功'), '状态')
})
it('B2 markdown（企微）：标题加粗、状态用引用行', () => {
  const run = markdownNotification(runMsg)
  assert(run.startsWith('**每日汇总**'), '标题加粗')
  assert(run.includes('> 时间：2026-10-09 09:00 | 状态：✅ 成功'), '引用行')
  eq(markdownNotification(toolMsg).startsWith('**每日汇总**'), true, '工具形态也是加粗标题')
})
it('B3 飞书卡片颜色：成功 green / 失败 red / 工具 blue', () => {
  eq(feishuCardTemplate(runMsg), 'green', '成功')
  eq(feishuCardTemplate({ ...runMsg, run: { at: new Date(), ok: false } }), 'red', '失败')
  eq(feishuCardTemplate(toolMsg), 'blue', '工具')
})

console.log('── C 三种渠道的报文 ──')
it('C1 企微：`{msgtype:markdown, markdown:{content}}`（content = markdown 渲染）', () => {
  const body = buildNotifyBody('WECOM', runMsg, null) as { msgtype: string; markdown: { content: string } }
  eq(body.msgtype, 'markdown', 'msgtype')
  eq(body.markdown.content, markdownNotification(runMsg), 'content')
})
it('C2 通用 webhook：`{text}`（纯文本渲染）', () => {
  eq(buildNotifyBody('WEBHOOK', toolMsg, null), { text: plainNotification(toolMsg) }, 'WEBHOOK')
})
it('★ C3 飞书：`interactive` 卡片（header 上色 + lark_md 正文），非纯 text', () => {
  const body = buildNotifyBody('FEISHU', runMsg, null) as {
    msg_type: string
    card: { header: { template: string; title: { content: string } }; elements: unknown[] }
  }
  eq(body.msg_type, 'interactive', 'msg_type')
  eq(body.card.header.template, 'green', 'header 颜色')
  eq(body.card.header.title.content, '每日汇总', 'header 标题')
  // 自动推送：第一段是"时间|状态"，第二段是正文
  eq(body.card.elements.length, 2, 'elements 数')
})

console.log('── D 飞书签名 ──')
it('D1 带密钥 ⇒ 顶层加 timestamp（秒字符串）+ sign', () => {
  const body = buildNotifyBody('FEISHU', runMsg, 'SECRET', 1_700_000_000_000) as { timestamp?: string; sign?: string }
  eq(body.timestamp, '1700000000', 'timestamp = 秒')
  assert(typeof body.sign === 'string' && body.sign.length > 0, 'sign 非空')
})
it('D2 同一 (secret, timestamp) ⇒ sign 确定；不同则不同', () => {
  const a = feishuSign('SECRET', 1_700_000_000)
  assert(a === feishuSign('SECRET', 1_700_000_000), '确定性')
  assert(a !== feishuSign('SECRET', 1_700_000_001), '时间戳变 ⇒ sign 变')
  assert(a !== feishuSign('OTHER', 1_700_000_000), '密钥变 ⇒ sign 变')
})
it('D3 HMAC-SHA256 base64（32 字节 ⇒ 44 字符，含等号）', () => {
  const sign = feishuSign('SECRET', 1_700_000_000)
  eq(sign.length, 44, '长度')
  assert(sign.endsWith('='), '结尾 =')
})
it('D4 无密钥 ⇒ 不出现 timestamp/sign', () => {
  const body = buildNotifyBody('FEISHU', toolMsg, null) as { timestamp?: string; sign?: string }
  eq(body.timestamp, undefined, '无 timestamp')
  eq(body.sign, undefined, '无 sign')
})

console.log('── E 模板抬头与截断 ──')
it('E1 `localStamp` 补零', () => {
  eq(localStamp(new Date(2026, 0, 2, 3, 4)), '2026-01-02 03:04', '补零')
})
it('E2 空正文 ⇒ 占位', () => {
  assert(plainNotification({ title: 'X', text: '   ' }).includes('（本次没有文本输出）'), '占位')
})
it('E3 超长经企微正文也截断', () => {
  const body = buildNotifyBody('WECOM', { title: 'X', text: 'y'.repeat(NOTIFY_TEXT_MAX + 10) }, null) as {
    markdown: { content: string }
  }
  assert(body.markdown.content.endsWith('…'), '被截断')
})

console.log('── F 通知模板语言 ──')
it('F1 替换四个占位符', () => {
  const out = renderNotifyTemplate('任务 {{task}} 在 {{time}} {{status}}：{{result}}', runMsg)
  eq(out, '任务 每日汇总 在 2026-10-09 09:00 成功：今天新增 3 单', '替换')
})
it('F2 花括号内空格也认（`{{ task }}`）', () => {
  eq(renderNotifyTemplate('{{ task }}', toolMsg), '每日汇总', '带空格')
})
it('F3 未知占位符**原样保留**（写错要看得见，不被静默吞掉）', () => {
  eq(renderNotifyTemplate('{{task}}/{{nope}}', toolMsg), '每日汇总/{{nope}}', '未知')
})
it('F4 工具形态无 run ⇒ time/status 渲染成空串', () => {
  eq(renderNotifyTemplate('[{{time}}][{{status}}]', toolMsg), '[][]', '空串')
})
it('F5 模板经渠道生效：企微 content = 渲染结果', () => {
  const msg: NotifyMessage = { ...runMsg, template: '{{status}}！{{result}}' }
  const body = buildNotifyBody('WECOM', msg, null) as { markdown: { content: string } }
  eq(body.markdown.content, '成功！今天新增 3 单', 'content')
})
it('F6 模板经渠道生效：飞书模板时正文只 1 个元素（不再叠默认抬头）', () => {
  const msg: NotifyMessage = { ...runMsg, template: '{{task}}' }
  const body = buildNotifyBody('FEISHU', msg, null) as { card: { elements: unknown[] } }
  eq(body.card.elements.length, 1, 'elements 数')
})
it('F7 空模板 ⇒ 回落内置默认', () => {
  const msg: NotifyMessage = { ...runMsg, template: '   ' }
  assert(markdownNotification(msg).startsWith('**每日汇总**'), '回落默认')
})

console.log(
  failed === 0
    ? `\n✅ 通知渲染自证通过（P1-6 增量）：${passed} 项全通过`
    : `\n❌ 通知渲染自证未通过：${failed} 项失败 / ${passed} 项通过`,
)
process.exit(failed === 0 ? 0 : 1)
