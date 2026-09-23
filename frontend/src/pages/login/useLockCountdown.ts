/**
 * 登录锁定倒计时（P0-1-30）
 *
 * 触发条件：`POST /api/auth/login` 回 **429 BUSY**，且信封 `data.retryAfterSec` 带剩余秒数
 * （`backend/src/services/auth.service.ts` 的 `login`：达到 5 次失败即锁 10 分钟）。
 *
 * 为什么要在前端再做一次倒计时：服务端文案是"请 N 分钟后再试"（粗到分钟），
 * 而用户在最后 60 秒里最想知道的恰恰是"还有几秒"。倒计时归零前提交按钮保持禁用，
 * 否则用户会反复点、每次都白吃一次请求（也会把限速计数继续推高）。
 *
 * ⚠️ 这个倒计时**不替代服务端判断**：它以服务端给的秒数为准，到点也只是"允许再试"，
 * 真正能不能登还是服务端说了算。
 */

import { useCallback, useEffect, useState } from 'react'

export interface LockCountdown {
  /** 剩余秒数；0 = 未锁定 */
  remaining: number
  /** 用服务端给的秒数开始倒计时 */
  start: (seconds: number) => void
  /** 归零（登录成功、用户切换视图时调用） */
  clear: () => void
}

export function useLockCountdown(): LockCountdown {
  const [remaining, setRemaining] = useState(0)

  const start = useCallback((seconds: number) => {
    setRemaining(Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0)
  }, [])
  const clear = useCallback(() => {
    setRemaining(0)
  }, [])

  const locked = remaining > 0
  useEffect(() => {
    if (!locked) return
    const timer = window.setInterval(() => {
      setRemaining((value) => (value <= 1 ? 0 : value - 1))
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [locked])

  return { remaining, start, clear }
}

/** `754` → `12:34`（等宽数字，配 `.num` 用） */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}
