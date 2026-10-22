/**
 * TanStack Query 底座（P0-1-30）
 *
 * 职责：把"什么该重试、什么算新鲜"这两个口径收在一处 —— 页面里不再各自写 `retry`。
 * 缓存失效的时机由各 mutation 的 `onSuccess` 决定（谁改的谁负责失效），不在底座里猜。
 */

import { QueryClient } from '@tanstack/react-query'

import { ApiError } from './client.js'

/**
 * 默认重试策略：**4xx 不重试**。
 * "参数不对 / 没权限 / 不存在"这类结论重试一百次也一样，只会把用户的等待时间乘三；
 * 而 429（BUSY）与 5xx 是"现在不行"，值得退避重试 —— 这正是 `02` §四 把 BUSY
 * 单独给一个错误码的意义（`docs/03` §六 也把它列为需要专门处理的一类）。
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  if (error instanceof ApiError) {
    if (error.code === 'BUSY') return true
    if (error.status >= 400 && error.status < 500) return false
  }
  return true
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        /**
         * 30s：内网工具的数据变化不频繁，而每次切标签页都重新拉一遍会让列表"自己抖"
         * （`docs/03` §七「列表三态」要的是稳定，不是实时）。需要刷新时由显式操作触发失效，
         * 需要轮询的页面（如 `03` §4.3 的解析中文档）用 `refetchInterval` 单独声明。
         */
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        /**
         * 5 分钟（与库里默认值一致，但**写出来**）：长会话里真正会囤积的不是"过期多久"，
         * 而是"没人再看的数据要多久才能被回收"—— 内存优化 P5 的实测口径要求这一项是**显式的**
         * （`docs/子方案/前端长会话内存优化.md`）。单个查询另有更短的 `gcTime` 时以自己的为准
         * （例如工作区文件正文是 60s，见 `WorkspacePanel`）。
         */
        gcTime: 5 * 60_000,
      },
      mutations: {
        // 写操作**绝不自动重试**：POST /api/auth/login 重试会白白多消耗一次限速额度
        retry: false,
      },
    },
  })
}
