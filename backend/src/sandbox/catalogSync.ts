/**
 * 工具清单的**变化广播**（P1-21，2026-10-21）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它解决什么问题：容器活着时，绑定/工具缓存变了，旧会话看不到
 * ─────────────────────────────────────────────────────────────────────
 * 清单是"每个容器一份"的发布快照（`proxy.ts#ensureSandboxMcpCatalog`）——这条不变（它守的是
 * "容器注册的名字"与"后端反查用的表"必须是**同一份**）。但"什么时候该换一份新的"原先只有一个
 * 触发点：容器回收。于是"给 Agent 新绑了一台 MCP / 挂了一个知识库 / 在 `/mcp` 点了「测试」刷新
 * 工具缓存"之后，**正在跑的会话**要等到下次重建容器才看得到（用户侧体感是"必须重建会话"）。
 *
 * 现在补上"换新"的两个时机（都走同一个重发布函数，判据只有一处）：
 *   ① **事件驱动**（本文件）：`agent_components` 写入、工具缓存刷新 ⇒ 给**该 agent 名下活着的
 *      会话**重新发布清单（Redis 里那份）。容器下一轮派活时会被 {@link catalogFingerprint} 比对出来，
 *      随后在 prompt 里注入 `/doubulea:mcp-refresh` 让它按新清单增删工具；
 *   ② **派活前兜底**（`taskAgent.ts`）：就算①漏了（进程重启、Redis 抖动），派活前也再对一次指纹。
 *
 * ⚠️ **不主动"推"进容器**：容器与后端之间只有容器发起的 HTTP（出口②），后端没有反向通道；
 *    唯一的反向通道是"下一轮 prompt"（`bridge.ts` 的 RPC 是我们写给容器的 stdin）。
 *    ⇒ 所以本文件只**标记**"这份清单过期了"，真正的推送发生在下一次派活。
 * ⚠️ 失败一律只 warn：广播是"让下次派活快一点"的优化，派活前的指纹兜底仍然能兜住。
 */

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { listLiveConversationsOfAgent } from './manager.js'
import { readSandboxMcpCatalog } from './mcpMap.js'
import { republishSandboxMcpCatalog } from './proxy.js'

/**
 * 清单的**指纹**——用来回答"这一轮派活时，容器手里那份还新不新"。
 *
 * 口径刻意**粗**（只看工具名与内置工具名的集合，排序后拼接）：它要判的是"容器要不要重注册工具"，
 * 而重注册的代价是"模型这一轮多一条命令 + 一次清单拉取"。描述/schema 的细微变化不触发
 * （下一轮请求里模型看到的还是旧说明，但**参数校验在服务端**，功能不受影响）。
 */
export function catalogFingerprint(names: Iterable<string>): string {
  return [...new Set(names)].sort().join('\n')
}

/**
 * 广播：某个 Agent 的绑定 / 工具缓存变了 ⇒ 给它名下**所有活着的会话**重新发布清单。
 *
 * 调用点（都应当是"写完之后"调，失败不影响写本身）：
 *   · `services/agent.service.ts` —— `PUT /:id/components` 之后；
 *   · `services/mcpServer.service.ts` —— 工具缓存刷新成功之后（`?refresh=1` / 「测试」）；
 *   · `services/knowledgeBase.service.ts` —— 知识库文档增删后（内置工具的**说明**会变，但工具集合
 *     不变 ⇒ 这里**不调**：集合没变，重注册没有收益。要是在意说明的时效，走下一次容器重建）。
 *
 * @returns 受影响且有变化的会话数（0 = 没有活着的会话，或工具集合没变）
 */
export async function broadcastAgentMcpCatalogChange(agentId: string): Promise<number> {
  const logger = getLogger()
  let conversationIds: string[]
  try {
    conversationIds = await listLiveConversationsOfAgent(agentId)
  } catch (error) {
    logger.warn({ err: error, agentId }, '取 Agent 名下活着的会话失败 ⇒ 跳过工具清单广播（派活前仍会兜底）')
    return 0
  }
  if (conversationIds.length === 0) return 0

  // 有些会话可能根本没发布过清单（容器还没起来）—— 那时不必发：首次拉取就是最新的
  let changed = 0
  for (const conversationId of conversationIds) {
    try {
      const published = await readSandboxMcpCatalog(conversationId)
      if (published === null) continue
      const result = await republishSandboxMcpCatalog(conversationId, agentId)
      if (result.changed) changed += 1
    } catch (error) {
      logger.warn(
        { err: error, agentId, conversationId },
        '重发会话的工具清单失败（该会话下一次派活前会再对一次指纹）',
      )
    }
  }
  if (changed > 0) {
    logger.info({ agentId, conversations: conversationIds.length, changed }, '工具清单变化已广播到活着的会话')
  }
  return changed
}

/**
 * 广播的**便捷包装**：从 `mcp_servers.id` 反查"哪些 Agent 绑了它"再逐个广播。
 *
 * 为什么需要它：刷新工具缓存的入口知道的是**server id**（`POST /:id/test`、
 * `GET /:id/tools?refresh=1`），不知道哪些 Agent 在用。这一层把"server → agents"的查询留在
 * 一处（`agent_components` 是唯一事实来源）。
 */
export async function broadcastMcpServerToolCacheChange(serverId: string): Promise<number> {
  const db = getPrisma()
  const rows = await db.agentComponent.findMany({
    where: { componentType: 'MCP', refId: serverId },
    select: { agentId: true },
    distinct: ['agentId'],
  })
  let changed = 0
  for (const row of rows) changed += await broadcastAgentMcpCatalogChange(row.agentId)
  return changed
}
