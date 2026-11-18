-- 从会话抽取 Skill 的模型（平台级单例；P1-24c-2）
--
-- 形状见 schema.prisma#SkillExtractModelConfig。
--   · 单行 seed（id='default'）：默认**开** + 未配模型（model_id=NULL）
--     ⇒ 抽取时回落到标题模型（TitleModelConfig）；标题模型也没有 ⇒ 502 EXTRACT_MODEL_UNAVAILABLE。
--   · 选定一个 CHAT 模型后，抽取走它；模型被删（onDelete SET NULL）自动置空、退回回落。
-- ⚠️ 无历史数据：新表、单行 seed。

CREATE TABLE "skill_extract_model_config" (
    "id" VARCHAR(32) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "model_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "skill_extract_model_config_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey：删模型时置空（之后抽取退回标题模型 / 明确报错，不 500）
ALTER TABLE "skill_extract_model_config" ADD CONSTRAINT "skill_extract_model_config_model_id_fkey"
    FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 单行 seed：开 + 未配模型 ⇒ 回落到标题模型
INSERT INTO "skill_extract_model_config" ("id", "enabled", "model_id", "updated_at")
VALUES ('default', true, NULL, CURRENT_TIMESTAMP);
