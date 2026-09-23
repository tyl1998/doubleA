/**
 * 用户反馈通道（P0-1-30）
 *
 * `docs/03-前端设计.md` §七「反馈通道」：**成功 = message 轻提示；失败 = notification（含错误码）；
 * 全局封装于 api 层**。§六 的坑预判进一步点名："错误码映射层要收在一处，否则各页面各写一遍
 * toast 文案，后续改口径要全仓搜"。
 *
 * 所以页面里**不应该**出现 `message.success(...)` / `notification.error(...)` 的直接调用，
 * 一律走 `useFeedback()`。这样"失败长什么样"是全局一个口径，将来要加"复制错误码"按钮、
 * 或按错误码分流到不同处理，只改这一个文件。
 */

import { App } from 'antd'
import { useMemo } from 'react'

import { ApiError, describeError } from '../api/client.js'

export interface Feedback {
  /** 成功：轻提示。文案由调用方给（它才知道自己做成了什么），格式统一在这里 */
  ok: (text: string) => void
  /**
   * 失败：带错误码的通知。
   * @param title 覆盖标题 —— 只在"服务端文案说不出这是什么操作"时才传
   *              （如「保存失败」「登录失败」），错误本身的说明仍来自服务端。
   */
  fail: (error: unknown, title?: string) => void
}

/** 通知里"错误码"的呈现：与 `design/*.html` 的 toast 一致，等宽、括在文案后 */
function withCode(text: string, code: string): string {
  return code === 'UNKNOWN' ? text : `${text}（${code}）`
}

export function useFeedback(): Feedback {
  const { message, notification } = App.useApp()

  return useMemo<Feedback>(
    () => ({
      ok: (text) => {
        void message.success(text)
      },
      fail: (error, title) => {
        const { code, message: text } = describeError(error)

        // 字段级错误（`data.fields`）在这里汇总展示：页面**愿意**标在输入框上的已经标了，
        // 剩下"没地方放"的（`.refine()` 的空路径、以及页面没实现的字段）至少要说出来，
        // 而不是只留一句"请求参数有误"。见 `api/client.ts` 的规则 2。
        const fieldLines =
          error instanceof ApiError
            ? [...error.formMessages, ...error.fields.filter((i) => i.path !== '').map((i) => i.message)]
            : []

        void notification.error({
          message: title ?? (code === 'UNKNOWN' ? '操作失败' : text),
          // 用 ` · ` 串成一行而不是 `\n`：AntD 的 description 是普通 div，换行会被折叠成空格，
          // 看起来像"文案里多打了一个空格"。要真正的多行就得自带 white-space，不值得为它引入样式。
          description: [withCode(text, code), ...fieldLines].join(' · '),
          duration: 6,
        })
      },
    }),
    [message, notification],
  )
}
