/**
 * Provider 装配（P0-1-30）
 *
 * 装配顺序与理由：
 * 1. **QueryClientProvider 在最外**：下面每个 Provider 都可能要读服务端数据（本批没有，
 *    但 P0-1-31 起的布局层就会读）。
 * 2. **ConfigProvider(theme)** 在 AntD 组件之前 —— 这是 `design/README.md` §三
 *    要求的那一步"一一映射"，不做的话页面会退回"一眼 AntD"（`#1677ff` + 8px 圆角 + 白底）。
 * 3. **AntD `<App>`** 提供 message / notification 的上下文（`useFeedback` 依赖它）。
 *    没有它时 `App.useApp()` 会拿到静态方法，那些方法拿不到 ConfigProvider 的主题。
 * 4. **BrowserRouter 在最内**：路由是页面层的事，Provider 这层不需要知道当前 URL。
 *
 * `setUnauthorizedHandler` 让"任何接口回 401"都能把当前用户收敛成未登录：
 * 守卫据此把人送回登录页。**刻意用 `setQueryData(null)` 而不是 `invalidate`** ——
 * 后者会立刻重拉 `/auth/me`，而它同样 401 ⇒ 无限循环。
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { App as AntdApp, ConfigProvider } from 'antd'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BrowserRouter } from 'react-router-dom'

import { CURRENT_USER_QUERY_KEY } from '../api/auth.js'
import { setUnauthorizedHandler } from '../api/client.js'
import { createQueryClient } from '../api/queryClient.js'
import { useLocaleStore } from '../stores/locale.js'
import { useUiStore } from '../stores/ui.js'
import { ANTD_LOCALE } from './antdLocale.js'
import { applyDayjsLocale } from './dayjsLocale.js'
import { buildAntdTheme } from './theme.js'

export function AppProviders({ children }: { children: ReactNode }) {
  // 惰性初始化：QueryClient 必须**只建一次**，否则每次渲染都会丢掉全部缓存
  const [queryClient] = useState(createQueryClient)

  const themeMode = useUiStore((state) => state.themeMode)
  // 主题来自"读 CSS 变量"，重算成本是一次 getComputedStyle ⇒ 按模式缓存即可
  const antdTheme = useMemo(() => buildAntdTheme(themeMode), [themeMode])

  // P1-23：界面语言（AntD 组件文案 + 分页/日期等内置文案随之切换）。
  // ⚠️ 只有**当前语言**变化才需要重渲染 —— 直接选 `locale`（字符串），不要选整个 store。
  const locale = useLocaleStore((state) => state.locale)
  const antdLocale = ANTD_LOCALE[locale]

  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.setQueryData(CURRENT_USER_QUERY_KEY, null)
    })
    return () => {
      setUnauthorizedHandler(undefined)
    }
  }, [queryClient])

  // dayjs 的语言是进程级单例（不能像 AntD 那样靠 props 传）⇒ 必须在这里按 locale 同步一次。
  useEffect(() => {
    applyDayjsLocale(locale)
  }, [locale])

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={antdLocale} theme={antdTheme}>
        <AntdApp>
          <BrowserRouter>{children}</BrowserRouter>
        </AntdApp>
      </ConfigProvider>
    </QueryClientProvider>
  )
}
