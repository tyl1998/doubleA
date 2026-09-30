-- ═══════════════════════════════════════════════════════════════════════════
-- documents —— 新增 image_mode：文档内图片的处理方式
--
-- 背景（用户 2026-09-30）：知识库解析文档时，若文档内含图片，此前一律丢弃（PDF 只取文本、
--   DOCX 丢弃 <img>、MD 图片当正文）。本次支持按文档选择图片处理方式：
--     · NONE       —— 不解析图片（历史行为，默认）
--     · OCR        —— 抽取图片后本地 OCR 成文字，作为普通文本块进链路
--     · MULTIMODAL —— 抽取图片转 base64，作为 content part 交给多模态 embedding 模型直接向量化
--
-- 存量数据安全：默认 NONE ⇒ 既有文档行为**逐字不变**。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "image_mode" AS ENUM ('NONE', 'OCR', 'MULTIMODAL');

ALTER TABLE "documents" ADD COLUMN "image_mode" "image_mode" NOT NULL DEFAULT 'NONE';
