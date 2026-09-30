-- ═══════════════════════════════════════════════════════════════════════════
-- models —— 新增 embedding_multimodal：向量模型是否走「多模态 embedding 端点」
--
-- 背景（用户 2026-09-30）：部分向量模型（如火山 `doubao-embedding-vision`）只提供
--   `POST {baseUrl}/embeddings/multimodal`，且 `input` 是 content 数组：
--     { "model": "…", "input": [{ "type": "text", "text": "…" }, { "type": "image_url", … }] }
--   而不是标准 OpenAI 的 `{ "input": ["…"] }`。本平台的知识库是**纯文本**流水线，
--   故该开关只影响**请求形状**：为 true 时对每条文本发 `{type:"text",text}` 分片。
--
-- 存量数据安全：默认 false ⇒ 既有向量模型行为**逐字不变**（标准 OpenAI 形状）。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "models" ADD COLUMN "embedding_multimodal" BOOLEAN NOT NULL DEFAULT false;
