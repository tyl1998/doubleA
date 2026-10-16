/**
 * 新建对话前的**模型 Key 预检**（2026-10-16 用户定案，零依赖纯逻辑）
 *
 * 依据：`shared/src/model.ts#ModelOption`（`providerCredentialMode` / `providerUserHasKey`）、
 *      `shared/src/agent.ts#AgentModelOption.models`（Agent 的模型池，只有 `modelId`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有这一层（放在"发送/创建会话"之前）
 * ─────────────────────────────────────────────────────────────────────
 * `credentialMode=PER_USER`（各自 Key）的 Provider 每个使用者各配一把 Key；缺了，**服务端在
 * 真正调用模型时**才回 **424 `NEED_CREDENTIAL`** —— 那时会话**已经建出来**、第一条消息也发出去了，
 * 用户看到的是"发失败了"。而新建对话是这条链路的起点，**在这里先拦一下**才对得上用户的意图：
 *   · 缺 Key ⇒ 弹窗（"去配置 / 取消"）；**点取消就不创建会话**（`ChatPage.submit` 直接返回）；
 *   · 不缺 ⇒ 照旧创建。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 判据只从**模型池**出发（"这个 Agent 可能要用的模型"）
 * ─────────────────────────────────────────────────────────────────────
 * 输入是 `poolModelIds`（Agent 的 `models[].modelId`）+ `availableModels`（`GET /api/models/available`
 * 的投影 —— 它已带 `providerCredentialMode` / `providerUserHasKey`）。三个"不知道就跳过"的口径：
 *   · 池里的模型**不在可选列表**（被停用 / Provider 被停用）⇒ 跳过 —— 它本来也选不了，
 *     不该为它拦人；
 *   · Provider 是 `SHARED`（共享 Key）⇒ 能用 —— 共享 Key 是所属人的事，与"我配没配"无关；
 *   · `providerUserHasKey === true` ⇒ 能用（我已配）；否则 = 被 Key 挡住。
 * 同一个 Provider 下有多个待配模型时**归并成一条**（弹窗按 Provider 说事，别刷屏）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 2026-10-16 用户定案：**别把整段对话拦死**（只要有能用的模型就让人进）
 * ─────────────────────────────────────────────────────────────────────
 *   · {@link isConversationBlocked}：池里**一个能用的都没有**（全被 Key 挡住）⇒ 进会话前弹窗；
 *   · 否则放行。默认模型被挡住时用 {@link pickUsableModelId} 换一个能用的开起来（优先共享 Key）；
 *   · 用户在选择器里手动选到被挡住的模型 ⇒ 再用 {@link missingModelKeyProviders} 弹一次窗。
 *
 * ⚠️ 纯函数，不 import React / antd：由 `frontend/scripts/verify-chat-home.mjs` 直接喂字面量断言。
 */

import type { ModelOption } from '@doubulea/shared'

/** 一个"我还没配 Key、但它下面有池内模型"的「各自 Key」Provider */
export interface MissingModelKeyProvider {
  providerId: string
  providerName: string
  /** 归到这个 Provider 下的、命中的池内模型别名（弹窗里列出来，指明"是哪几个模型要用它"） */
  modelLabels: string[]
}

/**
 * 找出"这个 Agent 的模型池里、当前用户还没配 Key 的「各自 Key」Provider"。
 *
 * 返回空数组 = 预检通过（可以建会话）。排序按池内出现顺序（稳定，便于断言与展示）。
 */
export function missingModelKeyProviders(
  poolModelIds: readonly string[],
  availableModels: readonly ModelOption[],
): MissingModelKeyProvider[] {
  const byId = new Map(availableModels.map((model) => [model.id, model]))
  const byProvider = new Map<string, MissingModelKeyProvider>()
  for (const modelId of poolModelIds) {
    const model = byId.get(modelId)
    if (model === undefined) continue
    if (model.providerCredentialMode !== 'PER_USER') continue
    if (model.providerUserHasKey) continue
    const existing = byProvider.get(model.providerId)
    if (existing === undefined) {
      byProvider.set(model.providerId, {
        providerId: model.providerId,
        providerName: model.providerName,
        modelLabels: [model.label],
      })
    } else {
      existing.modelLabels.push(model.label)
    }
  }
  return [...byProvider.values()]
}

/**
 * 单个模型**现在能不能用**（只看凭据）：`SHARED` 能用；`PER_USER` 要我已配 Key。
 * 不在可选列表里（被停用 / Provider 停用）⇒ 这里判不了，返回 `false`（与"能不能用"无关，
 * 那种情况由「已停用 / 绑定模型不可用」那套既有提示负责）。
 */
export function isModelBlockedByKey(modelId: string, availableModels: readonly ModelOption[]): boolean {
  const model = availableModels.find((entry) => entry.id === modelId)
  if (model === undefined) return false
  return model.providerCredentialMode === 'PER_USER' && !model.providerUserHasKey
}

/** 池内模型按"现在能不能用"分成两边（都保持池内顺序） */
export interface PoolKeyPartition {
  /** 现在就能用：`SHARED`，或「各自 Key」且我已配 */
  usableModelIds: string[]
  /** 现在用不了：「各自 Key」且我未配（选了会被服务端 424 拒） */
  blockedModelIds: string[]
}

export function partitionPoolModels(
  poolModelIds: readonly string[],
  availableModels: readonly ModelOption[],
): PoolKeyPartition {
  const byId = new Map(availableModels.map((model) => [model.id, model]))
  const usableModelIds: string[] = []
  const blockedModelIds: string[] = []
  for (const modelId of poolModelIds) {
    const model = byId.get(modelId)
    if (model === undefined) continue
    if (model.providerCredentialMode === 'PER_USER' && !model.providerUserHasKey) {
      blockedModelIds.push(modelId)
    } else {
      usableModelIds.push(modelId)
    }
  }
  return { usableModelIds, blockedModelIds }
}

/**
 * **新建会话的准入判据**（2026-10-16 用户定案）：
 * 池里有能被 Key 挡住的模型、**且一个能用的都没有** ⇒ 拦（弹窗）。
 *
 * 反之（哪怕只有一个能用的）⇒ 放行 —— 进会话时再保证"本会话要用的那个模型"是能用的
 * （见 {@link pickUsableModelId}）；用户手动选到缺 Key 的模型时，再由 {@link missingModelKeyProviders} 弹窗。
 */
export function isConversationBlocked(partition: PoolKeyPartition): boolean {
  return partition.usableModelIds.length === 0 && partition.blockedModelIds.length > 0
}

/**
 * 给新会话挑一个"现在就能用"的池内模型：**优先共享 Key 的**，其次「各自 Key 且我已配」。
 *
 * 用途：默认模型是「各自 Key」而我没配时，别把整段对话拦死 —— 换一个能用的开起来
 * （用户仍可在选择器里换回去，那时会弹"去配置"）。`random` 可注入，便于断言（默认 `Math.random`）。
 */
export function pickUsableModelId(
  poolModelIds: readonly string[],
  availableModels: readonly ModelOption[],
  random: () => number = Math.random,
): string | null {
  const { usableModelIds } = partitionPoolModels(poolModelIds, availableModels)
  if (usableModelIds.length === 0) return null
  const byId = new Map(availableModels.map((model) => [model.id, model]))
  const shared = usableModelIds.filter((id) => byId.get(id)?.providerCredentialMode === 'SHARED')
  const candidates = shared.length > 0 ? shared : usableModelIds
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))
  return candidates[index] ?? candidates[0] ?? null
}

