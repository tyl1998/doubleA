-- P1-24a-1 · Skill 数据模型与契约（无运行时）
--
-- 依据：`docs/子方案/Skill能力.md` §三（3.1 枚举与表）+ `docs/02-后端设计.md` §三（契约增量 · SKILL）
--       + `01` 决策 39（修订决策 7：组件范围扩为 知识库 + MCP + Skill）。
-- 范围：① `component_type` 枚举加 `SKILL`；② `skill_runtime` / `skill_source_type` 两个新枚举；
--       ③ `skills` / `skill_files` 两张新表；④ `skills` 的两条**部分唯一索引**（未删除范围内唯一）。
-- ⚠️ **本迁移不建 `conversation_skill_overrides`**（会话级覆写随 P1-24c-4b 单独迁移，表跟功能走）。

-- ── 1. component_type 加 SKILL ──
-- `ALTER TYPE ... ADD VALUE` 在老版本 PG 里不能在事务块中使用；本仓迁移器（Prisma migrate）
-- 对每个迁移文件**逐条执行**，且 PG 12+ 已允许在事务内新增枚举值 ⇒ 直接 ALTER 即可。
ALTER TYPE "component_type" ADD VALUE IF NOT EXISTS 'SKILL';

-- ── 2. 枚举 ──
CREATE TYPE "skill_runtime" AS ENUM ('INLINE', 'SANDBOX');
CREATE TYPE "skill_source_type" AS ENUM ('MANUAL', 'IMPORT', 'CONVERSATION');

-- ── 3. skills ──
CREATE TABLE "skills" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "description" TEXT NOT NULL,
    "runtime" "skill_runtime" NOT NULL DEFAULT 'INLINE',
    "requires_bins" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "source_type" "skill_source_type" NOT NULL DEFAULT 'MANUAL',
    "source_conversation_id" UUID,
    "source_message_ids" JSONB,
    "storage_key" VARCHAR(512) NOT NULL,
    "parent_skill_id" UUID,
    "parent_version" INTEGER,
    "created_by" UUID NOT NULL,
    "visibility" "asset_visibility" NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "skills_deleted_at_updated_at_idx" ON "skills"("deleted_at", "updated_at" DESC);
CREATE INDEX "skills_created_by_name_idx" ON "skills"("created_by", "name");
CREATE INDEX "skills_visibility_idx" ON "skills"("visibility");
CREATE INDEX "skills_parent_skill_id_idx" ON "skills"("parent_skill_id");

-- ★ 两条**部分唯一索引**（刻意不用 Prisma `@unique`，见 schema 里 `Skill` 的头注释）：
--   只约束"未删除"的行 ⇒ 软删一条 Skill 后，它占用的 slug / name 立刻可以复用。
CREATE UNIQUE INDEX "skills_slug_active_key" ON "skills"("slug") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "skills_created_by_name_active_key" ON "skills"("created_by", "name") WHERE "deleted_at" IS NULL;

ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. skill_files（`version` ≡ `skills.version` 的整版快照索引）──
CREATE TABLE "skill_files" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" VARCHAR(255) NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skill_files_skill_id_version_path_key" ON "skill_files"("skill_id", "version", "path");
CREATE INDEX "skill_files_skill_id_version_idx" ON "skill_files"("skill_id", "version");

ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
