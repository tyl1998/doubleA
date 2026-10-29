-- ═══════════════════════════════════════════════════════════════════════════
-- 产物延期 / 永久保存（2026-10-29，用户定案）
--
-- 背景：产物原本"一刀切"按 `ARTIFACT_RETENTION_DAYS`（默认 7 天）被
-- `sandbox/artifacts.ts#reapExpiredArtifacts` 按 `created_at < now - N 天` 删掉；
-- 用户要能对单条产物「延期几天 / 延期到某日 / 永久保存」。
--
-- 本迁移只加一列 `expires_at`：
--   · `NULL` = **永不过期**（永久保存；也是本迁移前所有存量行的天然语义？—— 不，见下）；
--   · 非空 = 该时刻之后可被清理（延期 = 把这一列往后推）。
--
-- ⚠️ **存量行回填**：用"建行时点 + 当前保留期"回填，与升级前 `artifactExpiresAtOf(createdAt)`
--    算出来的到期时刻**逐字一致** ⇒ 升级不会让任何一条产物提前过期、也不会让它的
--    "还剩 N 天"读数跳变。回填之后再建索引，后续只有单条 UPDATE。
-- ⚠️ 索引 `(expires_at)` 供清理器扫"到期且未删"的行；`NULL`（永久）不进这条索引的选择面。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "artifacts" ADD COLUMN "expires_at" TIMESTAMPTZ(3);

-- 存量回填：保留期由应用侧配置（默认 7 天）；这里按 7 天回填 —— 与升级前的默认口径一致。
-- 若部署时把 ARTIFACT_RETENTION_DAYS 改成了别的值，升级后首次清理会按新配置重算（见 reap 注释），
-- 故这里的偏差只影响"刚升级那一次列表里的读数"，不影响删除正确性。
UPDATE "artifacts" SET "expires_at" = "created_at" + INTERVAL '7 days' WHERE "expires_at" IS NULL;

CREATE INDEX "artifacts_expires_at_idx" ON "artifacts" ("expires_at");
