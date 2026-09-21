-- ═══════════════════════════════════════════════════════════════════════════
-- messages 分区续期（P0-1-5）
--
-- 用法：pnpm db:partitions        （= prisma db execute --file <本文件>）
--
-- 背景：`messages` 按月分区（docs/02 §三）。分区必须在**写入之前**存在，
--       否则插入会以 `no partition of relation "messages" found for row` 失败 ——
--       对用户而言就是"发不出消息"。0001_init 已经建好了「上个月 ~ 未来 12 个月」的窗口，
--       本脚本用来把窗口往后滚（每月/每季跑一次即可，**幂等**）。
--
-- 为什么不做成后端起进程时自动跑：建分区是 DDL，需要建表权限。
-- 应用账号在生产上应当只有 DML 权限（docs/02 §十 最小权限），
-- 由运维在部署流程里跑本脚本（或挂 cron）比让应用自带 DDL 能力更安全。
--
-- 为什么窗口是 -1..12：向前留 1 个月覆盖"补写历史"（数据回填、时钟偏差），
--       向后 12 个月给续期留足余量。调大不会有害，只是多几个空分区。
-- ═══════════════════════════════════════════════════════════════════════════

SELECT "ensure_messages_partition"(
    (date_trunc('month', now()) + make_interval(months => offset_months))::date
) AS ensured_partition
FROM generate_series(-1, 12) AS offset_months;
