-- ═══════════════════════════════════════════════════════════════════════════
-- agent_models —— Agent 的可选模型池（对话时可在其中选具体模型）
--
-- 背景：原设计"Agent 绑定单一模型、运行时不可切换"实际使用不便。现在 Agent 绑定一个
-- 模型集合（池），发消息时可在池内选一个具体模型；请求不指定时走 agents.model_id（默认模型）。
--
-- · 复合主键 (agent_id, model_id) 天然防重复入池；
-- · 两侧外键都 ON DELETE CASCADE：删 Agent、删模型（含删 Provider 级联删模型）时，
--   对应池成员行随之消失。默认模型被删时另由 agents.model_id 的 SET NULL 外键置空。
--
-- 存量数据回填：把每个"已绑定默认模型"的智能体，其默认模型写入池（保证既有 Agent 至少
-- 有一个可选模型）。未绑定模型（model_id IS NULL）的智能体不回填。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "agent_models" (
    "agent_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_models_pkey" PRIMARY KEY ("agent_id", "model_id")
);

CREATE INDEX "agent_models_model_id_idx" ON "agent_models"("model_id");

ALTER TABLE "agent_models" ADD CONSTRAINT "agent_models_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_models" ADD CONSTRAINT "agent_models_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 回填：既有智能体的默认模型进池（幂等：ON CONFLICT DO NOTHING）
INSERT INTO "agent_models" ("agent_id", "model_id", "created_at")
SELECT "id", "model_id", CURRENT_TIMESTAMP
FROM "agents"
WHERE "model_id" IS NOT NULL
ON CONFLICT ("agent_id", "model_id") DO NOTHING;
