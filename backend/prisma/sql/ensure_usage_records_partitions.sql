-- ═══════════════════════════════════════════════════════════════════════════
-- usage_records 分区续期（P0-3-12）
--
-- 用法：pnpm db:partitions        （= prisma db execute --file <本文件>，与 messages 那份一起跑）
--
-- 背景与理由与 `ensure_messages_partitions.sql` **逐字同款**（分区必须在**写入之前**存在，
--       否则插入会以 `no partition of relation "usage_records" found for row` 失败；
--       建分区是 DDL、应用账号在生产上应当只有 DML 权限 ⇒ 由运维/cron 跑本脚本，幂等）。
--
-- 窗口取 -1..12：向前 1 个月覆盖"补写历史"（回填、时钟偏差），向后 12 个月给续期留余量。
-- ═══════════════════════════════════════════════════════════════════════════

SELECT "ensure_usage_records_partition"(
    (date_trunc('month', now()) + make_interval(months => offset_months))::date
) AS ensured_partition
FROM generate_series(-1, 12) AS offset_months;
