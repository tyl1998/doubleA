/**
 * 沙箱的 LLM 目标解析（P0-3-4）—— 「谁把 Key 交给容器」的**唯一落点**
 *
 * 依据：`docs/02-后端设计.md` §七 第 2.5 步（`agent.model_id` → 解析 provider → 后端解密
 *      API Key → 容器环境变量注入）+ `docs/子方案/沙箱与引擎集成.md` §五 3（模型接入 BYOK）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么这一步必须有、且必须在这里
 * ─────────────────────────────────────────────────────────────────────
 * 容器里的引擎（pi）要调模型池，而**它自己读不到我们库里的 Provider 行**：
 * 地址、Key、模型名、协议四件事都只有后端知道 ⇒ 只能由后端在**起容器之前**解出来，
 * 以容器环境变量注入（`spec.ts#sandboxLlmEnv`），容器侧再由 `gen-models.mjs` 拼成 pi 的
 * `models.json`（那里**只写 `${DOUBULEA_LLM_API_KEY}` 引用**，值留在环境变量里）。
 *
 * ★ 复用 `services/model.service.ts#resolveChatTarget()` 而**不另写一份解密**：
 * 那是"模型 → 可调用的上游目标"的唯一实现，四道前置校验（模型存在 / 是 CHAT / 模型与 Provider
 * 都启用 / Provider 配了 Key）都在里面，且 AAD 绑定与降级口径也在那儿。
 * 另写一份的后果是"两个地方各有一套校验"，而 `model_providers.api_key_enc` 的解密参数
 * （`providerKeyAad(id)`）写错一次就是一个查半天的 401。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本模块产出的是**含明文 Key 的对象**
 * ─────────────────────────────────────────────────────────────────────
 * `env` 只许交给 `buildSandboxContainerSpec`（进 `docker create` 的 `Env`）。
 * **不许**打日志、不许落库、不许拼进错误消息 —— 落库那条尤其要克制：`sandboxes` 表里多一列
 * "当时的配置快照"看着很有用，但那等于把 Key 复制到一份保留期远长于容器的记录里
 * （`02` §九 的"密钥零下发"不变式管的就是这类"顺手抄一份"）。
 * 需要"这个容器是哪一轮用哪个模型起的"时看**标签** `doubulea.model`（`spec.ts`），它只存 id。
 */

import { getLogger } from '../infra/logger.js'
import { resolveChatTarget } from '../services/model.service.js'
import { sandboxLlmEnv } from './spec.js'

/** 解析失败的原因 —— 只有一个：这一轮用的模型不可用（模型/Provider 被删、停用、没配 Key…） */
export type SandboxLlmFailureCode = 'MODEL_NOT_AVAILABLE'

export type SandboxLlmResult =
  | {
      ok: true
      /** `agents.model_id` —— 同时是容器标签 `doubulea.model` 的值（复用比对的判据） */
      modelId: string
      /**
       * **上游**模型名（`models.model_name`，≠ {@link modelId}）。
       *
       * P0-3-5 加的：引擎的命令行要的是**这个名字**（`pi --provider doubulea --model <它>`）。
       * 单独留一个字段而不是让调用方去 `env[SANDBOX_LLM_ENV.model]` 里掏 —— 那是"两个模块
       * 约定同一个字符串键"，而这里要的是"给我模型名"，直接给。
       */
      modelName: string
      /** 含明文 Key；**只许进容器 Env**（见文件头） */
      env: Record<string, string>
    }
  | { ok: false; code: SandboxLlmFailureCode; message: string }

/**
 * 把"某个模型"解析成"要注入容器的那组环境变量"。
 *
 * @param modelId `agents.model_id`（由调用方从会话行里取出来，见 `manager.ts` 的那一次查询）。
 *   **可空**：智能体可能因所属模型商/模型被删除而被自动解绑（`model_id = null`）——
 *   这种情况由 `resolveChatTarget` 抛可读 409，在这里同样映射成 `MODEL_NOT_AVAILABLE`。
 *
 * 失败一律映射成 {@link SandboxLlmFailureCode} 而不是把 `AppError` 抛出去：调用方
 * （`ensureSandbox`）要按 `code` 决定回什么事件，而 `resolveChatTarget` 的四种 AppError
 * （404 / 409 / 424 / 500）在**这个上下文里是同一件事** —— "这一轮的模型用不了"，
 * 用户能做的动作也一样（去模型池/智能体页改一改）。文案原样透传（它本来就是给人看的）。
 */
export async function resolveSandboxLlm(modelId: string | null): Promise<SandboxLlmResult> {
  try {
    const target = await resolveChatTarget(modelId)
    // `resolveChatTarget` 已经保证了非 null（缺 Key 会抛 `needCredential`）——
    // 这里再判一次是为了让类型收窄，不是"双重校验"
    if (target.apiKey === null) {
      return unavailable(`Provider「${target.providerName}」尚未配置 API Key，无法派活到沙箱`)
    }
    return {
      ok: true,
      modelId: target.modelId,
      // 上游模型名（`pi --model` 要的就是它；P0-3-5 起由 `piRpcArgv` 消费）
      modelName: target.modelName,
      env: sandboxLlmEnv({
        modelName: target.modelName,
        label: target.label,
        protocol: target.protocol,
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
      }),
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    // 文案前缀点明"这一轮为什么起不来"：`resolveChatTarget` 的那几句话都是"怎么修"
    // （去模型池启用 / 去配 Key / 换个能用的模型），光看它们看不出发生在**起沙箱**这一步
    const message = `这一轮的模型无法用于沙箱：${raw}`
    getLogger().warn({ modelId, err: error }, '解析沙箱 LLM 目标失败')
    return unavailable(message)
  }
}

/** 统一的失败构造（把"给人看的一句话"截断到与大沙箱侧同口径的长度） */
function unavailable(message: string): SandboxLlmResult {
  const oneLine = message.replace(/\s+/gu, ' ').trim()
  return { ok: false, code: 'MODEL_NOT_AVAILABLE', message: oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine }
}
