-- Skill 草稿落表（P1-24c-7a；`子方案/会话生成Skill.md` §7.2）
--
-- 形状见 schema.prisma#SkillDraft。
--   · 从 Redis 迁到表：草稿跨设备 / 跨实例恢复，不随 Redis 重启消失；
--   · payload = 整份服务端内部记录，文件仍在 S3 skill-drafts/{userId}/{draftId}/；
--   · expires_at = updated_at + SKILL_DRAFT_TTL_SEC（滑窗），读路径按它判过期并懒删；
--   · 删用户级联删草稿。

CREATE TYPE "skill_draft_kind" AS ENUM ('CREATE', 'REVISION', 'PROPOSAL', 'SESSION_OVERRIDE');

CREATE TABLE "skill_drafts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "skill_draft_kind" NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "skill_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "skill_drafts_user_id_expires_at_idx"
    ON "skill_drafts"("user_id", "expires_at");

ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;