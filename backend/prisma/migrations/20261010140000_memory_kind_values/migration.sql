-- P1-8a 长期记忆 v2（1/2）：memory_kind 枚举加值
--
-- 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §八（§8.2 / §8.6）。
-- ⚠️ **必须与 backfill 分成两个迁移**：PostgreSQL 规定"同一事务里 ADD VALUE 后不能立刻使用该值"
--    ⇒ 加值（本迁移）与使用新值的数据 backfill（`20261010141000_memory_kind_backfill`）分开。
-- ⚠️ v1 的 `FACT` / `TASK` **刻意保留**（PG 删枚举值成本高）；应用层取值域见 `shared#MEMORY_KINDS`。

ALTER TYPE "memory_kind" ADD VALUE IF NOT EXISTS 'PROFILE';
ALTER TYPE "memory_kind" ADD VALUE IF NOT EXISTS 'HABIT';
ALTER TYPE "memory_kind" ADD VALUE IF NOT EXISTS 'HIGHLIGHT';
