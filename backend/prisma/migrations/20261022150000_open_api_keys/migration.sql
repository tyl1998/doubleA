-- ═══════════════════════════════════════════════════════════════════════════
-- P1-22 开放平台（智能体 OpenAPI + API Key）
--
-- 依据：`docs/08-开放平台-智能体OpenAPI(APIKey).md` §4.1（新表）/ §4.3（usage_records 两列）
--
-- 本迁移只有两件事（结构性增量收敛到这一步，R5）：
--   ① 建 `open_api_keys` —— Key 的归属是 `(user_id, agent_id)`；明文不落库，只存 sha256；
--   ② `usage_records` 加 `channel` / `open_key_id` 两列（X1：报表要能分内外、按 Key 归集），
--      并按 `(open_key_id, created_at desc)` 建索引供"一把 Key 的用量"（X6 / `/open/v1/usage`）。
--
-- ⚠️ `usage_records` 是**按月分区**表：
--   · `channel` 带**常量默认值** `'INTERNAL'` —— PG 11+ 不会因此重写全表（只改目录），
--     存量行读出来就是 `INTERNAL`，无需回填；
--   · 索引建在**父表**上一次即自动落每个分区（与 `20260927165305_add_usage_records` 同一手法），
--     新 attach 的分区同样会继承。分区表上 Concurrently 建索引在 PG 里不支持，
--     故这里沿用既有的"父表建索引"口径（迁移期短暂持锁可接受，内存件与表大小同阶）。
-- ⚠️ `open_key_id` **刻意不建外键**：Key 被硬删（`open_api_keys → users ON DELETE CASCADE`）时
--    计量行要保留 —— 账不该被谁连带删掉（与 user/agent 两列的 RESTRICT 同源）。
-- ═══════════════════════════════════════════════════════════════════════════

-- ═════════════ ① open_api_keys ═════════════

CREATE TABLE "open_api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "key_suffix" VARCHAR(8) NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "allow_auto_approve" BOOLEAN NOT NULL DEFAULT true,
    "confirm_timeout_sec" INTEGER,
    "max_concurrency" INTEGER,
    "rate_limit_per_min" INTEGER,
    "daily_token_limit" INTEGER,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "open_api_keys_pkey" PRIMARY KEY ("id")
);

-- 「我在这把 Agent 下的 Key」（列表端点）；同用户多 Key 共享会话池（X5）⇒ 这个形状是热路径
CREATE INDEX "open_api_keys_user_id_agent_id_idx" ON "open_api_keys"("user_id", "agent_id");
-- 「这个 Agent 下还有哪些有效 Key」（管理面 + 将来 Agent 转移时的排查）
CREATE INDEX "open_api_keys_agent_id_revoked_at_idx" ON "open_api_keys"("agent_id", "revoked_at");
-- 请求侧按 sha256 查 Key（鉴权第一步），必须唯一
CREATE UNIQUE INDEX "open_api_keys_key_hash_key" ON "open_api_keys"("key_hash");

-- 归属用户：删用户时 Key 一并消失（Q5：被收回后外部一律进不来）
ALTER TABLE "open_api_keys" ADD CONSTRAINT "open_api_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- 智能体：硬删时 Key 一并消失（软删由服务层校验链 ④b 拦）
ALTER TABLE "open_api_keys" ADD CONSTRAINT "open_api_keys_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- 签发人：只留痕，不参与判权 ⇒ RESTRICT（不因为"删了签发人"把别人的 Key 弄没了）
ALTER TABLE "open_api_keys" ADD CONSTRAINT "open_api_keys_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═════════════ ② usage_records 加两列（X1）═════════════

ALTER TABLE "usage_records" ADD COLUMN "channel" VARCHAR(16) NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE "usage_records" ADD COLUMN "open_key_id" UUID;

-- 分区表：建在父表上 ⇒ 每个分区各自有一份（与既有两条索引同款）
CREATE INDEX "usage_records_open_key_id_created_at_idx" ON "usage_records"("open_key_id", "created_at" DESC);
