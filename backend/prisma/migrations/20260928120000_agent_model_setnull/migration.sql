-- ═══════════════════════════════════════════════════════════════════════════
-- agents.model_id —— 改为可空 + 外键 ON DELETE SET NULL（删智能体/删模型商自动解绑）
--
-- 背景：原本 model_id 是 NOT NULL + ON DELETE RESTRICT，导致：
--   ① 软删智能体后 model_id 仍在，模型/Provider 仍被计入引用（"删了却还显示被绑定"）；
--   ② 删模型商时其下模型被 Agent 引用会被外键挡住（RESTRICT）。
-- 现在：模型被删（含删 Provider 级联删模型）时，DB 自动把引用它的 Agent 的 model_id 置空；
--   软删智能体时由服务层显式置空。Agent 变为「未绑定模型」，需重新绑定后才能对话。
--
-- 存量数据安全：DROP NOT NULL 不改动任何现有值；重建外键只改删除行为，不校验既有行。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "agents" ALTER COLUMN "model_id" DROP NOT NULL;

ALTER TABLE "agents" DROP CONSTRAINT "agents_model_id_fkey";

ALTER TABLE "agents" ADD CONSTRAINT "agents_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
