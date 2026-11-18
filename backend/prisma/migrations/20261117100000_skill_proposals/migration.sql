-- 更新建议（P1-24c-6；`子方案/会话生成Skill.md` §10.12 / §10.16）
--
-- 形状见 schema.prisma#SkillProposal。
--   · 非所属人 fork → 修改 → 提交提案 → 所属人 / ADMIN 审核；
--   · files 指向已物化到 skill-proposals/{proposalId}/ 的整版文件，草稿过期不影响审核；
--   · diff 只用于展示 / 审计，不是可执行 patch；
--   · 删目标 Skill ⇒ 级联删提案；删提交者 ⇒ RESTRICT（审计归属保留）。

CREATE TYPE "skill_proposal_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'NEEDS_REBASE', 'CLOSED');

CREATE TABLE "skill_proposals" (
    "id" UUID NOT NULL,
    "target_skill_id" UUID NOT NULL,
    "base_version" INTEGER NOT NULL,
    "proposed_by" UUID NOT NULL,
    "status" "skill_proposal_status" NOT NULL DEFAULT 'PENDING',
    "change_summary" TEXT NOT NULL,
    "diff" JSONB,
    "files" JSONB,
    "source_conversation_id" UUID,
    "source_message_ids" JSONB,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "accepted_version" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "skill_proposals_target_skill_id_status_created_at_idx"
    ON "skill_proposals"("target_skill_id", "status", "created_at" DESC);

CREATE INDEX "skill_proposals_proposed_by_created_at_idx"
    ON "skill_proposals"("proposed_by", "created_at" DESC);

ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_target_skill_id_fkey"
    FOREIGN KEY ("target_skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_proposed_by_fkey"
    FOREIGN KEY ("proposed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "skill_proposals" ADD CONSTRAINT "skill_proposals_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;