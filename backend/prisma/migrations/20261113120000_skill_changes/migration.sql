-- P1-24a-2 · Skill 变更记录（版本历史）
--
-- 依据：`docs/子方案/会话生成Skill.md` §10.7（模型定义）+ `docs/子方案/Skill能力.md` §5.1
--       （`GET /api/skills/:id/changes`）+ `06` P1-24a-2。
-- ⚠️ 原计划把 `skill_changes` 放 c-1，本批提前：管理面的「重新导入」就是一次版本切换，
--    没有这张表，「版本历史」页无数据可读。表跟功能走（与 `conversation_skill_overrides`
--    随 c-4b 落地同一条纪律）。本迁移**只建表**，不动 `skills` / `skill_files`。

CREATE TYPE "skill_change_source" AS ENUM ('MANUAL', 'CONVERSATION_CORRECTION', 'PROPOSAL');

CREATE TABLE "skill_changes" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "from_version" INTEGER NOT NULL,
    "to_version" INTEGER NOT NULL,
    "change_summary" TEXT NOT NULL,
    "diff" JSONB,
    "source" "skill_change_source" NOT NULL DEFAULT 'MANUAL',
    "source_conversation_id" UUID,
    "source_message_ids" JSONB,
    "proposed_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skill_changes_skill_id_to_version_key" ON "skill_changes"("skill_id", "to_version");
CREATE INDEX "skill_changes_skill_id_created_at_idx" ON "skill_changes"("skill_id", "created_at" DESC);

ALTER TABLE "skill_changes" ADD CONSTRAINT "skill_changes_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_changes" ADD CONSTRAINT "skill_changes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
