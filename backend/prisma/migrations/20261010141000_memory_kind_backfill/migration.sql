-- P1-8a 长期记忆 v2（2/2）：旧数据 backfill + 每用户画像上限列 + 检索索引
--
-- 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §8.2（迁移映射）/§8.6。
-- ⚠️ 本迁移**使用** `20261010140000` 新加的枚举值 ⇒ 必须排在它**之后**（见前一个迁移的文件头）。

-- 旧 kind → v2 kind（映射见 §8.2）：
--   FACT + 全局(agent_id 空) → PROFILE ；FACT + agent 专属 → HIGHLIGHT
--   PREFERENCE → PREFERENCE ；TASK → HIGHLIGHT ；OTHER → OTHER
UPDATE "memories" SET "kind" = 'PROFILE'
 WHERE "kind" = 'FACT' AND "agent_id" IS NULL;
UPDATE "memories" SET "kind" = 'HIGHLIGHT'
 WHERE "kind" = 'FACT' AND "agent_id" IS NOT NULL;
UPDATE "memories" SET "kind" = 'HIGHLIGHT'
 WHERE "kind" = 'TASK';

-- 每用户 USER 画像常驻注入上限（P1-8a；默认 10，存量用户开箱即用）
ALTER TABLE "users" ADD COLUMN "memory_profile_max" INTEGER NOT NULL DEFAULT 10;

-- 检索索引：`recall_memory` 按"作用域(agent_id)/类型(kind) + 时间"扫描
CREATE INDEX "memories_user_id_agent_id_kind_created_at_idx"
  ON "memories"("user_id", "agent_id", "kind", "created_at" DESC);
