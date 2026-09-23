/**
 * 知识库接口封装（P0-1-31 起被「智能体编辑页」消费）
 *
 * 依据：`docs/02` §4.4 / `shared/src/knowledgeBase.ts`（`KnowledgeBaseItem` + 列表契约）、
 *      `docs/03` §4.2 第 4 条（组件绑定区要"列出全部 KB"）。
 *
 * 本批**只落地读取侧**（一条列表）：知识库的建/改/删与详情属 **P0-1-35**。
 * 在 P0-1-31 就把写侧一起实现，等于把 P0-1-35 的活提前做掉一半，还会让两批各自维护一套
 * 表单（`docs/03` §七：同一实体创建与编辑同形态）。
 *
 * 权限口径：`/api/knowledge-bases` 是**登录即可**（不是 ADMIN）—— 与模型池相反，
 * 照抄模型池的 `requireAdmin` 会把普通用户的多选框变成空的（`docs/06` §六 第 ③ 条）。
 */

import { useQuery } from '@tanstack/react-query'
import type { KnowledgeBaseListResult } from '@doubulea/shared'

import { request } from './client.js'

export const KNOWLEDGE_BASES_QUERY_KEY = ['knowledge-bases'] as const

/** 多选框要"列出全部 KB" ⇒ 直接取 `limit` 的上限（100，与 `listKnowledgeBasesQuerySchema` 同源） */
export const KNOWLEDGE_BASES_PICKER_LIMIT = 100

/**
 * 读取知识库列表。排序由后端定（`createdAt asc`，`docs/02` §4.6 的列表口径）——
 * 前端**不再排一次**，否则同一个列表在两处各有一个顺序，迟早对不上。
 */
export function useKnowledgeBases(limit: number = KNOWLEDGE_BASES_PICKER_LIMIT) {
  return useQuery({
    queryKey: [...KNOWLEDGE_BASES_QUERY_KEY, 'list', 0, limit] as const,
    queryFn: () => request<KnowledgeBaseListResult>(`/api/knowledge-bases?offset=0&limit=${limit}`),
  })
}
