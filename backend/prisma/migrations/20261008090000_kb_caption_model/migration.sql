-- ═══════════════════════════════════════════════════════════════════════════
-- 知识库：图片"含义"理解（VLM 描述）模型（P1-11 · 能力增量）
--
-- 背景：P1-11 先以"全局 env（IMAGE_CAPTION_MODEL_ID）"落地，现按用户要求改为
--   **知识库级**：每个库各自从模型池选一个 `supportsVision=true` 的 CHAT 模型来产出图片描述。
--   ⇒ 新增可空列 `caption_model_id`（FK → `models`，删模型置空）。
--
-- 与 `embedding_model_id` 是两件事，刻意与它同款（可空 + ON DELETE SET NULL）：
--   · 空 = 该库不产出图片描述（`describe-images` 阶段 no-op），既有行为不变；
--   · 删/停用该模型 ⇒ 之后的文档不再描述，**已入库内容不受影响**、不影响向量化与检索；
--   · 存量库均为空 ⇒ 行为与本列引入前一致（无需回填）。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "knowledge_bases" ADD COLUMN "caption_model_id" UUID;
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_caption_model_id_fkey"
    FOREIGN KEY ("caption_model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
