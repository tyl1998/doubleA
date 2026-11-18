-- 会话级 Skill 覆写（P1-24c-4b；`子方案/Skill能力.md` §5.16）
--
-- 形状见 schema.prisma#ConversationSkillOverride。
--   · **不改上游**：不写 skills / skill_files，不递增 skills.version；
--   · @@unique(conversation_id, skill_id) ⇒ 一个会话对一个 Skill 最多一份生效覆写；
--   · revision 是覆写自己的递增号（不是 skills.version），storage_key 指
--     skill-overrides/{conversationId}/{skillId}/r{revision}/；
--   · 删会话 ⇒ 级联删行；删上游 Skill ⇒ 级联删行（不保留孤儿覆写）。

CREATE TABLE "conversation_skill_overrides" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "based_on_version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "storage_key" VARCHAR(512) NOT NULL,
    "files" JSONB,
    "change_summary" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversation_skill_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_skill_overrides_conversation_id_skill_id_key"
    ON "conversation_skill_overrides"("conversation_id", "skill_id");

CREATE INDEX "conversation_skill_overrides_skill_id_idx"
    ON "conversation_skill_overrides"("skill_id");

ALTER TABLE "conversation_skill_overrides" ADD CONSTRAINT "conversation_skill_overrides_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_skill_overrides" ADD CONSTRAINT "conversation_skill_overrides_skill_id_fkey"
    FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_skill_overrides" ADD CONSTRAINT "conversation_skill_overrides_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
