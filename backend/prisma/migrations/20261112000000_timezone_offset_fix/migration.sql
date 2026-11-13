-- ═══════════════════════════════════════════════════════════════════════════
-- 时区偏移遗留修复（2026-11-12）：把「由 JS 侧写入」的 timestamptz 一次性 +8h
--
-- 背景（docs/02 §三「已知问题：timestamptz 与 Prisma 的时区偏移」）：
--   旧部署的 PG 会话时区是 Asia/Shanghai（infra/.env 的 TZ=Asia/Shanghai），
--   而 @prisma/adapter-pg 按**会话时区**序列化 JS Date ⇒ Prisma 写 JS
--   `2026-02-01T00:00:00Z` 落库物理值是 `2026-01-31T16:00:00Z`（早 8 小时）；
--   读回时又按同一会话时区解释 ⇒ 往返恒等、平时看不出来。
--   DB 侧 `now()` / `CURRENT_TIMESTAMP` 写的是**真实 UTC**，所以只有 JS 侧写过的行偏。
--
-- 连接层修法已在同一批落地（DATABASE_URL 追加
--   `options=-c%20TimeZone%3DUTC`，新装环境的 PG 容器 TZ 也固定 UTC）。
--   本迁移只负责**存量数据**：只动「写入方 = B（纯 JS/Prisma 写）」的列。
--
-- 逐列清点（完整清单见 docs/02 §三 的「时区偏移修复清单」）：
--   · A（DB 默认 now()）—— **不动**（物理值本来就是真 UTC）；
--   · B（纯 JS/Prisma 写，含 @updatedAt / 显式传值）—— 本迁移 +8h；
--   · C（同一列既有 DB 写、又有 JS 写）—— **不迁移**，无法按行判定来源：
--       · conversations.last_message_at —— 多数由 JS `new Date()` 写，但「删消息后回算」
--         那一处写的是 Prisma **读回**的 message.created_at（物理已正确）⇒ 逐行不可判；
--       · egress_policy.updated_at / title_model_config.updated_at —— 迁移 seed 行由
--         `CURRENT_TIMESTAMP` 写（物理正确），之后的应用更新由 @updatedAt 写（偏 8h）。
--     处置方案见 docs/02 §三（残留清单）：这些列**不参与「JS 时间 vs DB now()」比较**，
--     只影响展示/排序，后续用「一次性按 id/时间窗修正」或「随写自愈」处理，不在这里硬搬。
--
-- ⚠️ 执行前提：该库确实跑过 `TZ=Asia/Shanghai`（本仓旧部署都是）。若某环境本来就是 UTC，
--    本迁移会让数据偏 +8h —— 执行前先确认 `_prisma_migrations` 的历史与旧 `.env`。
-- ⚠️ 只在 `backend/prisma/migrations` 里；**不得**在任何共享/生产库手工执行。
-- ⚠️ `usage_records` 是月分区表：UPDATE 分区键会让 PG 自动把行搬到目标月分区，
--    执行前确认 `ensure_usage_records_partition` 的窗口覆盖得到（正常提前 12 个月）。
-- ═══════════════════════════════════════════════════════════════════════════

-- ── ① 所有 @updatedAt 列（Prisma 在每次写时由客户端生成，纯 JS 侧）────────
UPDATE "users"       SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "model_providers" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "provider_user_credentials" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "models"      SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "agents"      SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "user_groups" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "conversations" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "knowledge_bases" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "documents"   SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "mcp_servers" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "mcp_credentials" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "scheduled_tasks" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "conversation_summaries" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "workspaces"  SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "workspace_files" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;
UPDATE "git_credentials" SET "updated_at" = "updated_at" + interval '8 hours' WHERE "updated_at" IS NOT NULL;

-- ── ② 显式由 JS 写入的列 ────────────────────────────────────────────────
-- agents.deleted_at：软删时 `new Date()`（agent.service.ts）
UPDATE "agents" SET "deleted_at" = "deleted_at" + interval '8 hours' WHERE "deleted_at" IS NOT NULL;

-- sandboxes.created_at / last_active_at：createSandbox / touchSandbox 显式传入 JS 时间
-- （DDL 的 `DEFAULT now()` 只是兜底，仓内没有省略这两列的写入路径）
UPDATE "sandboxes" SET "created_at" = "created_at" + interval '8 hours' WHERE "created_at" IS NOT NULL;
UPDATE "sandboxes" SET "last_active_at" = "last_active_at" + interval '8 hours' WHERE "last_active_at" IS NOT NULL;

-- scheduled_tasks.next_run_at / last_run_at：cron 边界由 JS 计算（调度比较正是 JS 侧边界）
UPDATE "scheduled_tasks" SET "next_run_at" = "next_run_at" + interval '8 hours' WHERE "next_run_at" IS NOT NULL;
UPDATE "scheduled_tasks" SET "last_run_at" = "last_run_at" + interval '8 hours' WHERE "last_run_at" IS NOT NULL;

-- artifacts.created_at / expires_at：建行由 JS 显式传入；expires_at 以它为基准并支持「延期」
UPDATE "artifacts" SET "created_at" = "created_at" + interval '8 hours' WHERE "created_at" IS NOT NULL;
UPDATE "artifacts" SET "expires_at" = "expires_at" + interval '8 hours' WHERE "expires_at" IS NOT NULL;

-- usage_records.created_at：persist.ts 显式传入（月分区表，行可能被搬到相邻分区）
UPDATE "usage_records" SET "created_at" = "created_at" + interval '8 hours' WHERE "created_at" IS NOT NULL;

-- open_api_keys：expires_at 来自请求里的 ISO 时刻、revoked_at 是吊销时的 `new Date()`；
-- last_used_at 目前没有写入点（恒 NULL，这里保留语句以便将来有值时不漏）
UPDATE "open_api_keys" SET "expires_at" = "expires_at" + interval '8 hours' WHERE "expires_at" IS NOT NULL;
UPDATE "open_api_keys" SET "last_used_at" = "last_used_at" + interval '8 hours' WHERE "last_used_at" IS NOT NULL;
UPDATE "open_api_keys" SET "revoked_at" = "revoked_at" + interval '8 hours' WHERE "revoked_at" IS NOT NULL;

-- files.created_at：file.service.ts 显式传入
UPDATE "files" SET "created_at" = "created_at" + interval '8 hours' WHERE "created_at" IS NOT NULL;

-- memories.last_used_at：注入/打开时 `new Date()`
UPDATE "memories" SET "last_used_at" = "last_used_at" + interval '8 hours' WHERE "last_used_at" IS NOT NULL;

-- workspace_files.deleted_at：墓碑由 JS 传入
UPDATE "workspace_files" SET "deleted_at" = "deleted_at" + interval '8 hours' WHERE "deleted_at" IS NOT NULL;

-- workspace_claims.expires_at / heartbeat_at：无 DB 默认，只能由 JS 传入
UPDATE "workspace_claims" SET "expires_at" = "expires_at" + interval '8 hours' WHERE "expires_at" IS NOT NULL;
UPDATE "workspace_claims" SET "heartbeat_at" = "heartbeat_at" + interval '8 hours' WHERE "heartbeat_at" IS NOT NULL;

-- workspace_events.at：workspaceEventCreateData 显式传 `now`（缺省才用 `new Date()`）
UPDATE "workspace_events" SET "at" = "at" + interval '8 hours' WHERE "at" IS NOT NULL;