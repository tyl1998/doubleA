-- P1-18.x（2026-10-16 用户定案）：知识库开放「指定用户」档 —— 受众主体表 knowledge_base_audiences
--
-- 依据：用户 2026-10-16 提出「知识库也需要按组分享」⇒ 知识库与 Agent 一致，支持三档可见范围
--       （私有 / 指定用户 / 公开），受众 = 用户 ∪ 组（并集）。
-- `asset_visibility` 枚举已含 `SHARED`（`20261016120000_asset_acl` 建的），本迁移只加受众表。
-- 口径与 `agent_audiences` 同构：
--   · `subject_id` 多态、**无 FK**（删组/删用户由服务层清理）；
--   · `knowledge_base_id` 有 FK（删库 ⇒ 受众行 Cascade）；
--   · 唯一键与索引**显式命名**（默认名超 63 字节会被 Postgres 截断，导致每次 diff 都想改名）。
CREATE TABLE "knowledge_base_audiences" (
    "id" UUID NOT NULL,
    "knowledge_base_id" UUID NOT NULL,
    "subject_type" "audience_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_base_audiences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "kb_audiences_kb_subject_type_subject_key" ON "knowledge_base_audiences"("knowledge_base_id", "subject_type", "subject_id");
CREATE INDEX "kb_audiences_subject_type_subject_idx" ON "knowledge_base_audiences"("subject_type", "subject_id");
ALTER TABLE "knowledge_base_audiences" ADD CONSTRAINT "knowledge_base_audiences_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
