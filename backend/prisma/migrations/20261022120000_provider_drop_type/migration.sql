-- Provider 与模型类型解耦：**删除 `model_providers.type` 列**（2026-10-22）
--
-- 背景（详见 `docs/子方案/Provider与模型类型解耦.md`）：
-- `model_providers.type` 原先是"这条 Provider 只能放这类模型"的硬约束（方案A：模型 type 跟随
-- Provider type，`createModel` 强校验一致）。但同一个 baseUrl（one-api / new-api / vLLM 那类网关）
-- 往往**同时**提供对话与向量模型，只是模型名不同 —— 那条约束逼着管理员把同一个上游配两遍
-- （`api_key_enc` 存两份密文、AAD 按 providerId 绑定 ⇒ 密文不可互换 ⇒ 轮换要改两处、漏一处就
-- 一半模型静默 401）。改造后 `models.type` 是**模型自己的用途**，Provider 只是"上游终点"
-- （baseUrl + Key + protocol），`type` 列因此**失去全部语义** —— 它原本还能当"新建模型的默认类型"，
-- 但那一点用处不值得占一列 + 一个契约字段 + 一个前端选择器，故**整列删除**。
--
-- ⚠️ 遗留约束转移到**模型侧**（本次一并落地、非本迁移的一部分）：
--   ① 建/改模型：`type=EMBEDDING` 时该 Provider 的协议必须是 OpenAI 兼容
--      （embedding 只有 `/embeddings` 一条路，判据 = `shared#embeddingModelAllowedOnProtocol`）；
--   ② 改 Provider 协议：该 Provider 下**存在 EMBEDDING 模型**时只能配默认协议
--      （判据 = `shared#vectorModelRequiresCompatProtocol`）。
--   两条都只看"有没有向量模型"这一事实，与 Provider 自身不再有任何类型列无关。
--
-- ⚠️ 零数据依赖：`type` 列不含任何无法从 `models` 推导的信息（原先的约束已由上面的模型侧判据
-- 接管），删列不影响任何既有行可用性。`enum model_type` **保留**（`models.type` 仍在用）。

-- ① 先删索引（它建在 (type, enabled) 上，列没了索引自然要一起删）
DROP INDEX "model_providers_type_enabled_idx";

-- ② 再删列
ALTER TABLE "model_providers" DROP COLUMN "type";