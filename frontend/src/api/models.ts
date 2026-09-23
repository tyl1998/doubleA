/**
 * 模型池接口封装（P0-1-31 起被「智能体编辑页」消费）
 *
 * 依据：`docs/02` §4.3、`shared/src/model.ts`（`ModelOption` + `modelOptionListResultSchema`）、
 *      `docs/03` §4.2 第 2 条（模型下拉取 `GET /api/models/available?type=CHAT`，
 *      显示上下文长度/是否支持图片）。
 *
 * ## 两条口径必须记住
 *
 * ① **`?type=` 必填**（`listAvailableModelsQuerySchema`）⇒ 少传会 400「type 必填」。
 * ② 这份列表的 `data` 是 **`{ items: [...] }`**，不是裸数组 —— 写成 `.data[0]` 会**安静地**
 *    拿到 `null`（`docs/06` §六 第 ⑭ 条），一路带到建智能体时炸成 400「模型 ID 不是合法 UUID」。
 *
 * ## 为什么刻意不复用管理端的 `GET /api/models`
 *
 * 那个端点**只有 ADMIN 能读**，而编辑智能体是"登录即可"的动作；更要紧的是它的投影含停用项 ——
 * 让停用模型出现在下拉里，用户选完会被后端 409 拒（`01` §3.2 的验收要点正是"停用的模型
 * 不会出现在可选列表里，**含管理员自己建 Agent 时**"）。所以"可选列表"是按**用途**分的路径，
 * 不是按角色分投影（P0-1-11 定案）。
 */

import { useQuery } from '@tanstack/react-query'
import type { ModelOptionListResult } from '@doubulea/shared'

import { request } from './client.js'

export const AVAILABLE_CHAT_MODELS_QUERY_KEY = ['models', 'available', 'CHAT'] as const

/** 读"可直接用于对话"的模型列表（后端已保证：模型与所属 Provider 都启用、且 `type=CHAT`） */
export function useAvailableChatModels() {
  return useQuery({
    queryKey: AVAILABLE_CHAT_MODELS_QUERY_KEY,
    queryFn: () => request<ModelOptionListResult>('/api/models/available?type=CHAT'),
  })
}
