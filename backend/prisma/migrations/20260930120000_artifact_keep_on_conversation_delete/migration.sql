-- ═══════════════════════════════════════════════════════════════════════════
-- artifacts —— 删除会话保留产物行（历史产物），并补归属列 user_id
--
-- 背景（`docs/子方案/TaskAgent记忆与产物.md` 块 3）：
--   原设计 `conversation_id NOT NULL + ON DELETE CASCADE`，删除会话时产物行被级联删掉，
--   "产物不跟会话删除走"（`02` §三 的原文）在删除路径上一直没成立。
--   现在改为：
--     ① `conversation_id` 可空 + 外键 `ON DELETE SET NULL` —— 删会话只把产物行的
--        `conversation_id` 置空，产物行保留、归入"历史产物"；
--     ② 新增 `user_id`（产物归属用户 = 建行时会话的 `conversations.user_id`）——
--        删除会话后 `conversation_id` 已为空，只有它能回答"这些是**我的**历史产物"。
--
-- 存量数据安全：
--   ① `DROP NOT NULL` 不改动任何现有值；
--   ② `user_id` 先加列（可空）→ 从 `conversations.user_id` 回填 → 再 `SET NOT NULL`。
--      回填不会留空：旧行都带 `conversation_id`，且原先的 `CASCADE` 保证它指向的会话必然还在；
--      `SET NOT NULL` 因此一定成功（若真有某行回填不到，迁移会在此处显式失败而不是带病上线）。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "artifacts" ALTER COLUMN "conversation_id" DROP NOT NULL;

ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_conversation_id_fkey";

ALTER TABLE "artifacts" ADD COLUMN "user_id" UUID;

-- 回填存量：user_id = 当时会话的发起者
UPDATE "artifacts"
SET "user_id" = "conversations"."user_id"
FROM "conversations"
WHERE "artifacts"."conversation_id" = "conversations"."id";

ALTER TABLE "artifacts" ALTER COLUMN "user_id" SET NOT NULL;

ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 历史产物列表（`GET /api/artifacts/history`：user_id = me AND conversation_id IS NULL）的扫描键
CREATE INDEX "artifacts_user_id_conversation_id_created_at_idx"
    ON "artifacts"("user_id", "conversation_id", "created_at" DESC);