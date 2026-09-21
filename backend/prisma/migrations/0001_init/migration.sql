-- ═══════════════════════════════════════════════════════════════════════════
-- 0001_init —— 数据模型第一批（P0-1-5）
--
-- 覆盖：users / model_providers / models / agents / agent_components /
--       conversations / messages（7 张表 + 7 个枚举）
-- 依据：docs/02-后端设计.md §三
--
-- ── 这份迁移是怎么来的（改它之前必读）────────────────────────────────────
-- 上半部分（枚举 → 6 张普通表 → 索引 → 外键）由
--     pnpm --filter @doubulea/backend exec prisma migrate diff \
--       --from-empty --to-schema prisma/schema.prisma --script
-- 从 `prisma/schema.prisma` 生成，**改 schema 后请重新生成再比对**，不要手改这段。
--
-- 下半部分（"messages" 分区表 + 分区维护函数）是**手写**的，因为 Prisma 没有分区语法。
-- 之所以能安全地手写而不被后续 `migrate dev` 冲掉：Prisma 7 的内省能识别分区关系，
-- 既不会把 14 个月度子表当成"多余对象"去 DROP，也不会尝试重建父表（实测见
-- issue_fix/问题记录-P0-1-5-数据模型与Prisma基线.md 的「反向探针」段）——
-- 即 docs/06 P0-1-5 坑预判点名的风险**经实测不存在**。
-- 于是：以后改 Message 模型照常 `migrate dev`（会生成 ALTER TABLE messages ...，
-- PG 自动下推到各分区）；只有牵涉分区键的操作（改主键、加唯一约束）才需要继续手写。
--
-- ⚠️ 迁移目录名刻意是 `0001_init` 而非 Prisma 默认的 `<时间戳>_init`：
--    代码演进顺序比墙上时钟更该决定先后（多人/多分支下时间戳会乱序）。
--    Prisma 按目录名字典序应用，且会把目录名记进 `_prisma_migrations.migration_name`，
--    因此**一旦应用就不能改名**（改了会被当成新迁移重跑）。
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "model_type" AS ENUM ('CHAT', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "agent_type" AS ENUM ('CHATBOT', 'TASK_AGENT');

-- CreateEnum
CREATE TYPE "component_type" AS ENUM ('KNOWLEDGE', 'MCP');

-- CreateEnum
CREATE TYPE "conversation_status" AS ENUM ('ACTIVE', 'FINISHED');

-- CreateEnum
CREATE TYPE "message_role" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "nickname" VARCHAR(64),
    "role" "user_role" NOT NULL DEFAULT 'MEMBER',
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_providers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key_enc" TEXT,
    "type" "model_type" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "models" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "model_name" VARCHAR(128) NOT NULL,
    "label" VARCHAR(128) NOT NULL,
    "type" "model_type" NOT NULL,
    "max_context" INTEGER,
    "supports_vision" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(255),
    "type" "agent_type" NOT NULL,
    "system_prompt" TEXT,
    "opening_remarks" TEXT,
    "guide_questions" JSONB NOT NULL DEFAULT '[]',
    "model_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_components" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "component_type" "component_type" NOT NULL,
    "ref_id" UUID NOT NULL,
    "config" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "topic" VARCHAR(255),
    "status" "conversation_status" NOT NULL DEFAULT 'ACTIVE',
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "model_providers_type_enabled_idx" ON "model_providers"("type", "enabled");

-- CreateIndex
CREATE INDEX "models_type_enabled_idx" ON "models"("type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "models_provider_id_model_name_type_key" ON "models"("provider_id", "model_name", "type");

-- CreateIndex
CREATE INDEX "agents_deleted_at_updated_at_idx" ON "agents"("deleted_at", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "agents_created_by_idx" ON "agents"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "agent_components_agent_id_component_type_ref_id_key" ON "agent_components"("agent_id", "component_type", "ref_id");

-- CreateIndex
CREATE INDEX "conversations_user_id_last_message_at_idx" ON "conversations"("user_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_agent_id_last_message_at_idx" ON "conversations"("agent_id", "last_message_at" DESC);

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_components" ADD CONSTRAINT "agent_components_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- messages —— 按月分区（RANGE (created_at)）
--
-- 依据：docs/02-后端设计.md §三「分区说明」——messages 与 usage_records 按月分区；
--       chunks 不分区（分区表无法建全局 HNSW 索引）。
--
-- 手工 DDL 而非 Prisma 生成，原因与「为什么能安全手写」见文件头。
-- 三处与普通表的差异，改动时都必须同时照顾：
--   1. 主键必须含分区键：PRIMARY KEY (id, created_at)。
--      → Prisma 侧表现为 @@id([id, createdAt])，findUnique 要用复合键
--        `where: { id_createdAt: { id, createdAt } }`（见 schema.prisma 的注释）。
--   2. 索引与约束在**父表**上建一次即可，PG 会自动在每个分区上落同名对象，
--      且对后续新 attach 的分区同样生效。
--   3. 分区本身由下方 ensure_messages_partition() 创建，不在本文件里逐个写死。
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateTable（分区父表）
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversation_id" UUID NOT NULL,
    "role" "message_role" NOT NULL,
    "content" JSONB NOT NULL,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");

-- CreateIndex（会话内按时间倒序分页：docs/02 §4.5 的 `?beforeId=&limit=` 游标）
-- 建在父表上 → 分区索引自动传播，新分区 attach 时也自动获得
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at" DESC);

-- AddForeignKey（PG 12+ 允许分区表引用普通表；删会话必删其消息，docs/02 §4.5）
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 分区维护：ensure_messages_partition(月份) —— 幂等建当月分区
--
-- 为什么要有这个函数（而不是在迁移里写死一串 CREATE TABLE）：
--   迁移在**什么时候被应用**取决于部署时间，写死 2026_09…2027_09 这类名字，到了窗口外
--   就会以 "no partition of relation messages found for row" 让对话直接写不进去。
--   函数按「传入月份」动态生成 `messages_YYYY_MM`，于是同一份迁移在任何时间应用都成立，
--   而且后续月份可以由定时任务（或运维手动）反复调用来续期。
--
-- 幂等性：先 to_regclass 判存，再兜一层 duplicate_table 异常 —— 两个连接同时续期时
-- 后到者不会报错（迁移/定时任务重跑是常态，必须幂等）。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE FUNCTION "ensure_messages_partition"(target_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    month_start DATE := date_trunc('month', target_month)::date;
    month_end   DATE := (date_trunc('month', target_month) + INTERVAL '1 month')::date;
    part_name   TEXT := 'messages_' || to_char(date_trunc('month', target_month), 'YYYY_MM');
BEGIN
    IF to_regclass('public.' || part_name) IS NULL THEN
        BEGIN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF "messages" FOR VALUES FROM (%L) TO (%L)',
                part_name, month_start, month_end
            );
        EXCEPTION WHEN duplicate_table THEN
            NULL;  -- 并发续期撞车：已由另一连接建好，按幂等处理
        END;
    END IF;
    RETURN part_name;
END;
$$;

-- 初始窗口：上个月 ~ 未来 12 个月（共 14 个分区）。
-- 向前留 1 个月是为了让"补写昨天/上个月的消息"这类场景（导入、回填、时钟偏差）也有归属；
-- 向后 12 个月给定时任务留足续期余量，见 prisma/sql/ensure_messages_partitions.sql。
DO $$
DECLARE
    offset_months INT;
BEGIN
    FOR offset_months IN -1..12 LOOP
        PERFORM "ensure_messages_partition"(
            (date_trunc('month', now()) + make_interval(months => offset_months))::date
        );
    END LOOP;
END;
$$;

-- ⚠️ 刻意**不建 DEFAULT 分区**：
--   DEFAULT 分区看似能兜住"某个忘了续期的月份"，但它埋了一个只在生产才炸的雷 ——
--   之后把一个月份 attach 成正式分区时，若该月的数据已经落进 DEFAULT，
--   PG 会以 "updated partition constraint for default partition would be violated" 拒绝 attach，
--   届时必须先停机把数据从 DEFAULT 搬出来再 attach。
--   本方案改用「按需生成 + 可反复调用的续期脚本」：缺分区时插入会立刻报
--   "no partition of relation \"messages\" found for row" —— 吵，但清晰、可自愈。
