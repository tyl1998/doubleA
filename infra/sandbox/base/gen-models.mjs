#!/usr/bin/env node
/**
 * gen-models.mjs —— 把「容器环境变量里的 LLM 目标」写成 pi 的 `models.json`（P0-3-4）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §五 3（模型接入 = BYOK，指向我方模型池）
 *      + `docs/02-后端设计.md` §七 第 2.5 步（`agent.model_id` → 解密 Key → 容器环境变量）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 【为什么需要这个脚本 —— 三条都是 pi 的硬事实，不是设计偏好】
 * ═══════════════════════════════════════════════════════════════════════════
 * ① **pi 认的模型来源是 agent-dir 里的 `models.json`**（上游 `docs/models.md`
 *    "Configure a compatible endpoint"）。要让它指向**我方模型池**（任意 baseUrl + 任意 model id），
 *    就必须有一份 `models.json`。而这两件事（baseUrl / 模型名）都是**每会话才知道**的
 *    （前者来自 Provider 行、后者来自 Agent 行）⇒ 它不可能烤进镜像的只读种子，
 *    只能在**容器启动时**生成。
 *
 * ② **`apiKey` 支持 `${ENV}` 模板引用，而 `baseUrl` 不支持**（源码级确认：
 *    `dist/core/provider-composer.js` 里 baseUrl 是直取、apiKey/headers 才过
 *    `resolve-config-value.js#resolveConfigValue`）。
 *    ⇒ 本脚本**只把引用写进文件、把值留在环境变量里**：磁盘上那份 `models.json`
 *    永远不含 Key，而 pi 在请求期自己从 `process.env` 取值。
 *    这正是 `子方案③` §五 3 硬约束 1（"Key 不得出现在 work 卷的任何文件里"）在
 *    **配置层**的落法 —— 顺带让"配置能不能被 agent 读"这件事不再重要（读到也没用）。
 *    ⚠️ 文件末尾有一条**自检**把这条钉死：一旦有人把 `${...}` 改成明文，容器**起不来**。
 *
 * ③ **`api` 字段决定用哪套协议实现**（`openai-completions` / `openai-responses` /
 *    `anthropic-messages`），且它**也不支持环境插值** ⇒ 后端已经把"我方协议枚举"
 *    翻译成 pi 的 api 名再传进来（`backend/src/sandbox/llm.ts#piApiForProtocol`，
 *    那是这张映射表的**唯一**落点；本脚本刻意不认识我方协议枚举）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 【输入：容器环境变量（由后端在 `docker create` 的 `Env` 里注入）】
 * ═══════════════════════════════════════════════════════════════════════════
 * | 变量 | 必需 | 说明 |
 * |------|------|------|
 * | `DOUBULEA_LLM_API_KEY`   | ✔ | Provider 明文 Key。**只被引用、不落盘** |
 * | `DOUBULEA_LLM_BASE_URL`  | ✔ | 模型池地址，**已按 pi 的语义归一过**（见后端 `sandboxBaseUrlFor`） |
 * | `DOUBULEA_LLM_API`       | ✔ | pi 的 api 名（三种之一） |
 * | `DOUBULEA_LLM_MODEL`     | ✔ | 上游 model id |
 * | `DOUBULEA_LLM_PROVIDER`  |  | provider id（缺省 `doubulea`）⇒ P0-3-5 用它拼 `--model <provider>/<model>` |
 * | `DOUBULEA_LLM_LABEL`     |  | 显示名（进 `models[].name`），可选 |
 *
 * ⚠️ **缺必需项时「跳过」而不是报错**：镜像要能直接 `docker run` 起来手工调试
 *    （没有后端注入的 env 时就该安静地不生成）。生产路径上这些变量必然齐 —— 后端在
 *    起容器**之前**就把它们算好了（拿不到就回 `MODEL_NOT_AVAILABLE`，容器根本不会建）。
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 必需项（缺一个就跳过；顺序即报错文案里的顺序） */
const REQUIRED = ['DOUBULEA_LLM_API_KEY', 'DOUBULEA_LLM_BASE_URL', 'DOUBULEA_LLM_API', 'DOUBULEA_LLM_MODEL']

/** pi 读 `models.json` 的引用语法（`$NAME` / `${NAME}`）；这里只写引用，值留在环境变量里（见 ②） */
const API_KEY_REFERENCE = '${DOUBULEA_LLM_API_KEY}'

const missing = REQUIRED.filter((name) => (process.env[name] ?? '') === '')
if (missing.length > 0) {
  // 退出码 0 是刻意的：这不是错误，是"这次没配 LLM"（见文件头）
  console.log(`[pi-models] 跳过：未注入 ${missing.join(' / ')}（手工 run 的正常形态；生产路径由后端注入）`)
  process.exit(0)
}

const providerId = process.env.DOUBULEA_LLM_PROVIDER || 'doubulea'
const modelId = process.env.DOUBULEA_LLM_MODEL
const label = process.env.DOUBULEA_LLM_LABEL
const baseUrl = process.env.DOUBULEA_LLM_BASE_URL
const api = process.env.DOUBULEA_LLM_API

const model = { id: modelId }
// `name` 只是选择器里的显示名（上游 models.md 的 model 定义里它是可选字段）
if (label !== undefined && label !== '') model.name = label

const document = {
  providers: {
    [providerId]: {
      baseUrl,
      // ⚠️ pi 的 baseUrl 语义**按 api 而不同**（OpenAI SDK 拼 `/chat/completions`、
      //    Anthropic SDK 自己加 `/v1/messages`）⇒ 归一化在后端做，这里只照抄（见文件头 ③）
      api,
      // ★ 引用而不是值（文件头 ②）—— 这一行是"Key 不落盘"的全部内容
      apiKey: API_KEY_REFERENCE,
      models: [model],
    },
  },
}

const serialized = `${JSON.stringify(document, null, 2)}\n`

/**
 * 自检：**磁盘上的内容不得含 Key 明文**。
 * 这是本文件唯一能守住的硬约束（后端侧看不到这个文件），而它一旦破了，
 * 取证成本极高（要等某个会话结束、去 work 卷里 grep）。破的方式只有一种：
 * 有人"顺手"把引用改成了 `process.env.DOUBULEA_LLM_API_KEY`。
 */
if (serialized.includes(process.env.DOUBULEA_LLM_API_KEY)) {
  console.error('[pi-models] FATAL: 生成的 models.json 里出现了 API Key 明文（应当只写 ${DOUBULEA_LLM_API_KEY} 引用）')
  process.exit(1)
}

const agentDir = process.env.PI_CODING_AGENT_DIR || '/tmp/pi-agent'
const target = join(agentDir, 'models.json')
mkdirSync(agentDir, { recursive: true })
// 先写临时文件再 rename：避免 pi 读到写了一半的 JSON（同一目录内 rename 是原子的）
const temporary = `${target}.tmp`
writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
chmodSync(temporary, 0o600)
renameSync(temporary, target)

// 摘要里**没有 Key**：baseUrl 是地址、不是秘密（与我方 `describeTarget()` 的口径一致：
// 只打"连到哪儿、用哪个模型"，绝不打凭据）
console.log(`[pi-models] ${providerId}/${modelId} api=${api} baseUrl=${baseUrl} → ${target}`)
