/**
 * "现在"的节拍器（60s 一跳）—— P0-1-34 落在 `ConversationSidebar` 里，**P0-3-11 提为公共 hook**
 *
 * 相对时间读数（"3 分钟前"）**不会自己更新** —— 没有这个 tick，用户把页面开着一小时后
 * 看到的还是"3 分钟前"。60s 与读数的最小粒度一致（分档里最小的变化就是"刚刚 → N 分钟前"）；
 * 比它更细只会白白重渲染，比它更粗就会出现"明明过了两分钟还写着刚刚"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要抽出来
 * ─────────────────────────────────────────────────────────────────────
 * 产物面板（P0-3-11）是第二个需要"相对时间会自己走"的界面。抄一份的后果不是多十行，
 * 而是 `docs/06` §六 第 ⑰ 条那句话：**同一口径在两处各写一遍，必有一处先腐烂**
 * —— 只要有人把其中一份的间隔改成 30s 或 5min，两个界面上的读数就开始互相矛盾，
 * 而这**不会报任何错**。故判据（间隔）只有这一处，两处界面共用（与 P0-1-36 抽
 * `app/confirm.ts#isTypedConfirmMatch` 是同一手法：对外行为逐字未变、只挪位置）。
 */

import { useEffect, useState } from 'react'

/** 节拍间隔：60s（与相对时间读数的最小粒度一致，见文件头） */
export const MINUTE_TICK_MS = 60_000

/** @returns 一个每 60s 前进一次的 `Date`（首次渲染取当时的时刻） */
export function useMinuteTick(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date())
    }, MINUTE_TICK_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [])
  return now
}
