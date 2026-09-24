/**
 * `tool_cache` 列的读写（P0-2-2 落地最小形态；形状与刷新的正式归属是 **P0-2-5**）
 *
 * 依据：`06` §四 P0-2-5（`tool_cache` 形状 `{ fetchedAt, tools:[…] }`、缓存命中/失效/刷新）
 *      + P0-2-2 验收门槛 2（"测试成功时顺手刷新 `tool_cache`"）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么现在就要有这个文件（而不是等都等到 P0-2-5）
 * ─────────────────────────────────────────────────────────────────────
 * P0-2-2 的 `POST /:id/test` **必须**落一次缓存、`GET /:id/tools` **必须**读它、
 * 列表页的 `toolCount` 也来自它 —— 这三处都要解析同一个 jsonb。若各写一份 `?.tools?.length`，
 * 那么"库里塞了半截数据"时三处会给出**三种**不同的降级行为（其中一种很可能是 500）。
 * ⇒ 按本仓一贯手法，读取端补默认值**收在一处**（同 `shared#normalizeRetrievalConfig`）。
 *
 * ⚠️ **本模块不 import 任何运行期模块**（不碰 config / prisma / 日志 / SDK）⇒
 * `verify:app` 这一档（无依赖、可进 CI）能直接断言它 —— 与 `pipeline/chunk/`、
 * `orchestrator/chatContext.ts` 同款。P0-2-5 加"过期判定/刷新策略"时也照这个约定扩展。
 */

import { mcpToolDescriptorSchema, type McpToolDescriptor } from '@doubulea/shared'
import { z } from 'zod'

/**
 * 缓存形态：**拉取时刻 + 工具数组**。
 *
 * 时间存 ISO 字符串（不是 `Date`）：它要原样进 jsonb、原样出 HTTP 契约
 * （`GET /:id/tools` 的 `fetchedAt`），中间任何一次 `Date` round-trip 都只是多一次转换。
 */
export interface McpToolCache {
  fetchedAt: string
  tools: McpToolDescriptor[]
}

/**
 * 形状校验。⚠️ 用 `mcpToolDescriptorSchema` 逐个校验（**与 P0-2-1 的出口投影同一份 schema**，
 * 见 `shared/src/mcp.ts` 的注释）—— 自己再写一遍"工具长什么样"就是两处一起腐烂的开始。
 */
const toolCacheSchema = z.object({
  fetchedAt: z.string(),
  tools: z.array(mcpToolDescriptorSchema),
})

/**
 * jsonb → {@link McpToolCache}；**读不出来一律 `null`**（= 把这份缓存当成"没有"）。**永不抛错**。
 *
 * 为什么不做"逐条过滤"（像 `normalizeCredentialSchema` 那样）：
 * 工具数组是**一次上游响应的快照**，它的完整性本身就是"这份缓存能不能用"的判据 ——
 * 留下半份工具列表，结果是"模型能调到的工具少了几个"，而**界面上看不出来**
 * （工具数会显示成一个小一点的数字，没人会察觉）。宁可整体作废、让用户重测一次。
 */
export function parseToolCache(raw: unknown): McpToolCache | null {
  if (raw === null || raw === undefined) return null
  const parsed = toolCacheSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** 由一次成功的 `tools/list` 构造缓存值（`fetchedAt` 由调用方给，便于验收注入固定时刻） */
export function buildToolCache(tools: McpToolDescriptor[], fetchedAt: string): McpToolCache {
  return { fetchedAt, tools }
}

/**
 * 列表页要的"工具数（缓存）"。
 *
 * ⚠️ `0` 有两种含义：**没拉过 / 缓存已失效** 与 **真的没有工具**。界面据此显示 `—` 还是 `0`
 * （`03` §4.4 的"工具数（缓存）"列）—— 说不出数字时**宁可留白也不要编一个**
 * （P0-1-34/35 连踩四处"界面上的数字拿不到"的老口径）。
 */
export function toolCountOf(raw: unknown): number {
  return parseToolCache(raw)?.tools.length ?? 0
}
