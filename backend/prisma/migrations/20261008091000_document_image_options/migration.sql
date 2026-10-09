-- ═══════════════════════════════════════════════════════════════════════════
-- documents：图片处理由三值枚举改为**三个独立布尔选项**（2026-10-08）
--
-- 背景（用户需求）：旧 `image_mode`（NONE/OCR/MULTIMODAL）把"识别"混在一处，无法表达
--   "只做 LLM 含义识别、不向量化"这类组合，且识别应由上传者按文档决定。故拆成：
--     · image_ocr       —— 本地 OCR 文字
--     · image_describe  —— LLM 含义识别（VLM，用知识库选定的图片描述模型）
--     · image_vectorize —— 图片向量化（多模态）
--   三者互不依赖、可任意组合；全 false = 不处理图片。
--
-- 存量映射（无损、可逆）：
--   image_mode = 'OCR'        → image_ocr = true
--   image_mode = 'MULTIMODAL' → image_vectorize = true
--   image_mode = 'NONE'       → 全 false（默认）
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "documents" ADD COLUMN "image_ocr" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "documents" ADD COLUMN "image_describe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "documents" ADD COLUMN "image_vectorize" BOOLEAN NOT NULL DEFAULT false;

UPDATE "documents" SET "image_ocr" = true WHERE "image_mode" = 'OCR';
UPDATE "documents" SET "image_vectorize" = true WHERE "image_mode" = 'MULTIMODAL';

ALTER TABLE "documents" DROP COLUMN "image_mode";
DROP TYPE "image_mode";
