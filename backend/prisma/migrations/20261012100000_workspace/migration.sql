-- P1-9 Code 模式工作区（工作区索引 / 版本 / 软锁 / 事件）
--
-- 依据：`docs/子方案/Code模式工作区.md` §三（数据模型草案）。
-- 本批**只加表 + 一个枚举**，不改任何既有列（可逆：删五张表与枚举即回到 P1-8a 形态）。
-- ⚠️ 本表**不存文件内容**（字节在宿主 FS / S3）—— 见 schema.prisma#Workspace 的说明。
-- DDL 由 `prisma migrate diff --from-schema(旧) --to-schema(新) --script` 生成，逐字未改。

-- CreateEnum
CREATE TYPE "workspace_actor" AS ENUM ('AGENT', 'USER', 'SYSTEM');

-- CreateTable
CREATE TABLE "workspaces" (
    "conversation_id" UUID NOT NULL,
    "root_path" TEXT NOT NULL,
    "head_version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("conversation_id")
);

-- CreateTable
CREATE TABLE "workspace_files" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "size" BIGINT NOT NULL,
    "mime" VARCHAR(255) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "s3_key" VARCHAR(512),
    "updated_by" "workspace_actor" NOT NULL,
    "updated_by_id" VARCHAR(128),
    "deleted_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_file_versions" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "s3_key" VARCHAR(512),
    "actor" "workspace_actor" NOT NULL,
    "actor_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_claims" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "holder" "workspace_actor" NOT NULL,
    "holder_id" VARCHAR(128) NOT NULL,
    "turn_id" VARCHAR(128),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_events" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "version" INTEGER,
    "actor" "workspace_actor" NOT NULL,
    "actor_id" VARCHAR(128),
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_files_conversation_id_path_idx" ON "workspace_files"("conversation_id", "path");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_files_conversation_id_path_key" ON "workspace_files"("conversation_id", "path");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_file_versions_file_id_version_key" ON "workspace_file_versions"("file_id", "version");

-- CreateIndex
CREATE INDEX "workspace_claims_conversation_id_expires_at_idx" ON "workspace_claims"("conversation_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_claims_conversation_id_path_holder_key" ON "workspace_claims"("conversation_id", "path", "holder");

-- CreateIndex
CREATE INDEX "workspace_events_conversation_id_at_idx" ON "workspace_events"("conversation_id", "at");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "workspaces"("conversation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_versions" ADD CONSTRAINT "workspace_file_versions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_claims" ADD CONSTRAINT "workspace_claims_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "workspaces"("conversation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "workspaces"("conversation_id") ON DELETE CASCADE ON UPDATE CASCADE;