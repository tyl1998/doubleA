-- 会话标题生成模型（平台级单例；2026-10-22）
--
-- 形状见 schema.prisma#TitleModelConfig。
--   · 单行 seed（id='default'）：默认**关**（enabled=false）+ 未配模型（model_id=NULL）
--     ⇒ 未配置状态下会话标题维持原有的"首条消息原文截断"逻辑，行为零变化。
--   · 开启且选定一个 CHAT 模型后，落库时异步用该模型把首条消息压成短标题；
--     调用不通 / 模型被删（onDelete SET NULL）/ 未配置 时一律回落确定性截断。
-- ⚠️ 无历史数据：新表、单行 seed。

CREATE TABLE "title_model_config" (
    "id" VARCHAR(32) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "model_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "title_model_config_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey：删模型时置空（之后会话标题退回确定性截断，不报错）
ALTER TABLE "title_model_config" ADD CONSTRAINT "title_model_config_model_id_fkey"
    FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 单行 seed：关 + 未配模型 ⇒ 默认走原有确定性逻辑
INSERT INTO "title_model_config" ("id", "enabled", "model_id", "updated_at")
VALUES ('default', false, NULL, CURRENT_TIMESTAMP);