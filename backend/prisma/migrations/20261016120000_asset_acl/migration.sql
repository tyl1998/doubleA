-- P1-13 资产所属人 + P1-18 可见范围重设计 / 受众组 / Provider 用户级凭据
--
-- 依据：`docs/子方案/资产所属人与权限控制.md`（⑥）+ `docs/子方案/资产共享与用户组标签.md`（⑧，P1-18）
--       + `01` 决策 29/30/31 + **决策 37**（修订 30/31）。
-- 三类可复用资产 = Agent / 知识库 / MCP Server（Provider 已无可见范围）。
--   · 所属人：Agent / MCP Server **复用** `created_by`（语义扩为"所属人"）；
--     知识库 / Provider **新增** `created_by`（存量回填**最早的 ADMIN**，无 ADMIN 时回落最早用户）。
--   · 可见范围：**Agent / 知识库 / MCP Server 三表**各加 `visibility`（枚举 `asset_visibility`），
--     新行默认 `PRIVATE`，**存量回填 `PUBLIC`**（保既有"全员可见"行为不变）。
--     ⚠️ **Provider 不加 `visibility`**（P1-18 定案）：模型只能通过 Agent 被使用，
--     全局"曝光"不承担访问控制、还制造"公开 = 用谁的 Key"歧义 ⇒ Provider 访问 = 所属人 + ADMIN。
--   · **删 `provider_shares`**（P1-18 定案）：分享 Provider 无意义，正确的做法是分享/公开那个 Agent。
--   · **Agent 受众** `agent_audiences`（P1-18）：`SHARED` 可见范围的受众主体（用户 ∪ 组，多态无 FK）。
--   · **用户组** `user_groups` + `user_group_members`（P1-18 · 子批 B；ADMIN 维护）。
--   · **Provider 用户级凭据** `provider_user_credentials` + `model_providers.credential_mode`（P1-18 · 子批 C）。
-- 三步式（加可空列 → 回填 → 置 NOT NULL + 默认值 + 索引/FK）避免对存量数据直接加 NOT NULL 的构建期风险。

-- ── 0. 枚举 ──
CREATE TYPE "asset_visibility" AS ENUM ('PRIVATE', 'SHARED', 'PUBLIC');
CREATE TYPE "audience_subject_type" AS ENUM ('USER', 'GROUP');
CREATE TYPE "provider_credential_mode" AS ENUM ('SHARED', 'PER_USER');

-- ── 1. agents.visibility（存量 → PUBLIC）──
ALTER TABLE "agents" ADD COLUMN "visibility" "asset_visibility";
UPDATE "agents" SET "visibility" = 'PUBLIC' WHERE "visibility" IS NULL;
ALTER TABLE "agents" ALTER COLUMN "visibility" SET NOT NULL;
ALTER TABLE "agents" ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';
CREATE INDEX "agents_visibility_idx" ON "agents"("visibility");

-- ── 2. mcp_servers.visibility（存量 → PUBLIC）──
ALTER TABLE "mcp_servers" ADD COLUMN "visibility" "asset_visibility";
UPDATE "mcp_servers" SET "visibility" = 'PUBLIC' WHERE "visibility" IS NULL;
ALTER TABLE "mcp_servers" ALTER COLUMN "visibility" SET NOT NULL;
ALTER TABLE "mcp_servers" ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';
CREATE INDEX "mcp_servers_visibility_idx" ON "mcp_servers"("visibility");

-- ── 3. knowledge_bases：新增 created_by + visibility ──
ALTER TABLE "knowledge_bases" ADD COLUMN "created_by" UUID;
ALTER TABLE "knowledge_bases" ADD COLUMN "visibility" "asset_visibility";
-- 所属人回填：最早的 ADMIN；没有任何 ADMIN 时回落最早的用户（存量库理论上必有用户）
UPDATE "knowledge_bases" SET "created_by" = COALESCE(
  (SELECT "id" FROM "users" WHERE "role" = 'ADMIN' ORDER BY "created_at" ASC, "id" ASC LIMIT 1),
  (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
) WHERE "created_by" IS NULL;
UPDATE "knowledge_bases" SET "visibility" = 'PUBLIC' WHERE "visibility" IS NULL;
ALTER TABLE "knowledge_bases" ALTER COLUMN "created_by" SET NOT NULL;
ALTER TABLE "knowledge_bases" ALTER COLUMN "visibility" SET NOT NULL;
ALTER TABLE "knowledge_bases" ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';
CREATE INDEX "knowledge_bases_created_by_idx" ON "knowledge_bases"("created_by");
CREATE INDEX "knowledge_bases_visibility_idx" ON "knowledge_bases"("visibility");
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. model_providers：新增 created_by + credential_mode（⚠️ P1-18：Provider **不加** visibility）──
-- 模型只能通过 Agent 被使用 ⇒ Provider 的全局"曝光"不承担访问控制、还制造"公开 = 用谁的 Key"歧义。
-- Provider 访问 = 所属人 + ADMIN（见 `shared/src/assetAcl.ts` 文件头 ①）。
ALTER TABLE "model_providers" ADD COLUMN "created_by" UUID;
ALTER TABLE "model_providers" ADD COLUMN "credential_mode" "provider_credential_mode";
UPDATE "model_providers" SET "created_by" = COALESCE(
  (SELECT "id" FROM "users" WHERE "role" = 'ADMIN' ORDER BY "created_at" ASC, "id" ASC LIMIT 1),
  (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
) WHERE "created_by" IS NULL;
UPDATE "model_providers" SET "credential_mode" = 'SHARED' WHERE "credential_mode" IS NULL;
ALTER TABLE "model_providers" ALTER COLUMN "created_by" SET NOT NULL;
ALTER TABLE "model_providers" ALTER COLUMN "credential_mode" SET NOT NULL;
ALTER TABLE "model_providers" ALTER COLUMN "credential_mode" SET DEFAULT 'SHARED';
CREATE INDEX "model_providers_created_by_idx" ON "model_providers"("created_by");
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 5. provider_user_credentials：Provider 用户级凭据（P1-18 · 子批 C；各自 Key）──
-- ⚠️ 显式删掉 P1-18 定案要移除的 `provider_shares`（若历史库上已建；新库上为 no-op）。
DROP TABLE IF EXISTS "provider_shares";
CREATE TABLE "provider_user_credentials" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "provider_user_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "provider_user_credentials_provider_id_user_id_key" ON "provider_user_credentials"("provider_id", "user_id");
CREATE INDEX "provider_user_credentials_user_id_idx" ON "provider_user_credentials"("user_id");
ALTER TABLE "provider_user_credentials" ADD CONSTRAINT "provider_user_credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_user_credentials" ADD CONSTRAINT "provider_user_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 6. agent_audiences：Agent 受众主体（P1-18；仅 `SHARED` 的 Agent 有行）──
CREATE TABLE "agent_audiences" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "subject_type" "audience_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_audiences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_audiences_agent_id_subject_type_subject_id_key" ON "agent_audiences"("agent_id", "subject_type", "subject_id");
CREATE INDEX "agent_audiences_subject_type_subject_id_idx" ON "agent_audiences"("subject_type", "subject_id");
ALTER TABLE "agent_audiences" ADD CONSTRAINT "agent_audiences_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 7. user_groups + user_group_members：用户组（P1-18 · 子批 B；ADMIN 维护）──
CREATE TABLE "user_groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_groups_name_key" ON "user_groups"("name");
CREATE TABLE "user_group_members" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_group_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_group_members_group_id_user_id_key" ON "user_group_members"("group_id", "user_id");
CREATE INDEX "user_group_members_user_id_idx" ON "user_group_members"("user_id");
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
