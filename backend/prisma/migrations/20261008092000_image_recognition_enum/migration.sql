-- ═══════════════════════════════════════════════════════════════════════════
-- documents：图片"识别方式"由两个布尔改为**三选一枚举**（OCR 与大模型识别互斥）
--
-- 背景（用户 2026-10-08 定案）：OCR 与大模型识别应**互斥**（VLM 本就会读图上文字，叠加本地 OCR
--   是重复劳动）。故 `image_ocr` + `image_describe` 两个布尔合并为单个枚举 `image_recognize`：
--     NONE / OCR / LLM
--   `image_vectorize` 保持不变（与识别方式正交，可独立开关）。
--
-- 存量映射（091000 迁移刚落下的两个布尔）：
--   image_describe = true → 'LLM'（大模型识别优先，VLM 已覆盖文字）
--   image_ocr      = true → 'OCR'
--   否则                   → 'NONE'
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "image_recognition" AS ENUM ('NONE', 'OCR', 'LLM');

ALTER TABLE "documents" ADD COLUMN "image_recognize" "image_recognition" NOT NULL DEFAULT 'NONE';

UPDATE "documents" SET "image_recognize" = CASE
    WHEN "image_describe" THEN 'LLM'::"image_recognition"
    WHEN "image_ocr" THEN 'OCR'::"image_recognition"
    ELSE 'NONE'::"image_recognition"
END;

ALTER TABLE "documents" DROP COLUMN "image_ocr";
ALTER TABLE "documents" DROP COLUMN "image_describe";
