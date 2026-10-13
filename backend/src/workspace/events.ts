/**
 * 工作区事件总线（P1-9 · P0）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §四 3（事件总线：watcher/agent 写 → 事件 → SSE + 落库）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条出口，本文件是同一条入口
 * ─────────────────────────────────────────────────────────────────────
 *   · **实时**：进程内订阅者（P3 的 SSE 端点）—— 只对**持有该工作区的这个进程**有意义
 *     （多机下 watcher 是进程内的 ⇒ 路由必须粘性，§十六 A）；
 *   · **持久**：`workspace_events` 表 —— 断线补发与审计的来源。
 *
 * 每次 {@link emitWorkspaceEvent} 都做两件事：**落一行事件** + **把 `workspaces.headVersion` +1**
 * （工作区级事件序号；只增）。⚠️ 两件事不放进同一个事务是有意的吗？**不是** —— 见下方 `$transaction`：
 * 它们必须原子，否则"事件落了、序号没动"会让补发游标停在原地（前端永远补不齐最后一条）。
 *
 * ⚠️ 订阅者抛错**只 warn**：一个 SSE 连接写失败不能让"这一写已经成功"这件事回滚
 * （事件已经落库，重连会补发）。
 */

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import type { WorkspaceActor, WorkspaceEventItem, WorkspaceEventType } from '@doubulea/shared'

/** 发一条事件的输入（`version` 对 `claim`/`release` 留空） */
export interface WorkspaceEventInput {
  conversationId: string
  type: WorkspaceEventType
  path: string
  version?: number | null
  actor: WorkspaceActor
  actorId?: string | null
  /** 落库时刻（JS 侧显式传入，避免 DB 侧 `now()` 的时区偏移；不传则用此刻） */
  at?: Date
}

type WorkspaceEventListener = (event: WorkspaceEventItem) => void

/** 进程内订阅表（键 = conversationId）。⚠️ 模块级单例：订阅与发布必须看同一份 */
const listeners = new Map<string, Set<WorkspaceEventListener>>()

/** 订阅某个会话的工作区事件；返回取消订阅的函数 */
export function subscribeWorkspaceEvents(conversationId: string, listener: WorkspaceEventListener): () => void {
  let set = listeners.get(conversationId)
  if (set === undefined) {
    set = new Set()
    listeners.set(conversationId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(conversationId)
    if (current === undefined) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(conversationId)
  }
}

/** 当前订阅者数量（观测/验收用） */
export function workspaceEventSubscriberCount(conversationId?: string): number {
  if (conversationId !== undefined) return listeners.get(conversationId)?.size ?? 0
  let total = 0
  for (const set of listeners.values()) total += set.size
  return total
}

/**
 * 发一条工作区事件：**落库 + 递增 headVersion（同一事务）+ 通知实时订阅者**。
 *
 * @returns 落库后的事件（形状 = `shared#workspaceEventSchema`，可原样作为 SSE payload）
 */
export async function emitWorkspaceEvent(input: WorkspaceEventInput): Promise<WorkspaceEventItem> {
  const prisma = getPrisma()
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.workspaceEvent.create({
      data: workspaceEventCreateData(input),
      select: { id: true, type: true, path: true, version: true, actor: true, actorId: true, at: true },
    })
    // headVersion 只增（补发游标）：与事件行同一事务，见文件头
    await tx.workspace.updateMany({
      where: { conversationId: input.conversationId },
      data: { headVersion: { increment: 1 } },
    })
    return created
  })

  const item = toWorkspaceEventItem(row)
  publish(input.conversationId, item)
  return item
}

/**
 * 事件行的 `create({ data })` 载荷 —— 抽出来是为了让**调用方自己的事务**也能落一条事件
 * （写文件时"文件行 + 版本行 + 事件行 + headVersion"必须在**同一个事务**里，而
 * `emitWorkspaceEvent` 自带事务、不能嵌套）。
 */
export function workspaceEventCreateData(input: WorkspaceEventInput): {
  conversationId: string
  type: WorkspaceEventType
  path: string
  version: number | null
  actor: WorkspaceActor
  actorId: string | null
  at: Date
} {
  return {
    conversationId: input.conversationId,
    type: input.type,
    path: input.path,
    version: input.version ?? null,
    actor: input.actor,
    actorId: input.actorId ?? null,
    at: input.at ?? new Date(),
  }
}

/** 通知实时订阅者（供"在别处事务里已落库"的调用方在事务提交后调用） */
export function publishWorkspaceEventItem(conversationId: string, item: WorkspaceEventItem): void {
  publish(conversationId, item)
}

/** 把 DB 行转成契约形状（`at` → ISO 8601）。纯函数，便于核对 */
export function toWorkspaceEventItem(row: {
  id: string
  type: string
  path: string
  version: number | null
  actor: WorkspaceActor
  actorId: string | null
  at: Date
}): WorkspaceEventItem {
  return {
    id: row.id,
    type: row.type as WorkspaceEventType,
    path: row.path,
    version: row.version,
    actor: row.actor,
    actorId: row.actorId,
    at: row.at.toISOString(),
  }
}

/** 通知实时订阅者（**同步**，单个订阅者抛错只 warn —— 见文件头） */
function publish(conversationId: string, event: WorkspaceEventItem): void {
  const set = listeners.get(conversationId)
  if (set === undefined) return
  for (const listener of set) {
    try {
      listener(event)
    } catch (error) {
      getLogger().warn({ err: error, conversationId, path: event.path }, '工作区事件订阅者抛错（已忽略）')
    }
  }
}

/** 进程退出/测试收尾：清空订阅表（不碰 DB） */
export function resetWorkspaceEventBus(): void {
  listeners.clear()
}