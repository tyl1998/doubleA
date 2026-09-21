/**
 * 前端入口（占位）
 *
 * P0-1-1 只落地 workspace 骨架，此处仅提供「可编译、可构建」的最小实现，
 * 用于验证三包构建链路与 `@doubulea/shared` 的解析（含纯类型 import）。
 *
 * 真实实现（Vite + React 18 + AntD 5 + Router 6 + TanStack Query + Zustand、
 * 全局布局、路由守卫、错误码→文案映射层）在 P0-1-30 落地。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_MESSAGE_BY_ERROR_CODE, ok, type ErrorCode, type Envelope } from '@doubulea/shared'

const skeletonEnvelope: Envelope<{ app: string; step: string }> = ok({
  app: 'doubulea-frontend',
  step: 'P0-1-1 骨架',
})

/** 骨架期即验证「错误码 → 文案」映射层在 shared 中可被前端消费（`03` §六 单点收敛） */
const sampleMessage: string = DEFAULT_MESSAGE_BY_ERROR_CODE.UNAUTHORIZED
const sampleCode: ErrorCode = 'UNAUTHORIZED'

function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>{skeletonEnvelope.data.app}</h1>
      <p>当前阶段：{skeletonEnvelope.data.step}</p>
      <p>
        共享契约层已接通：错误码 <code>{sampleCode}</code> → 文案「{sampleMessage}」
      </p>
    </main>
  )
}

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
