-- ═══════════════════════════════════════════════════════════════════════════
-- usage_records —— 计量（**按月分区**，P0-3-12）
--
-- 依据：`docs/02-后端设计.md` §三（表清单）+ §3.1（实现口径）+ §七（TaskAgent 编排的「计量」行）、
--       `docs/子方案/沙箱与引擎集成.md` §十（计量）、`01` 决策 20。
--
-- ⚠️ **本文件是「手写 DDL」，不是 `migrate dev` 生成的**（与 `messages` 同一个理由：
--    Prisma 没有分区语法）。改动时请照抄 `0001_init` 的 `messages` 那一段的判断：
--    · 主键**必须**含分区键（PG 硬性要求）
--    · 索引/约束建在**父表**上一次即自动落每个分区，且对后续 attach 的新分区同样生效
--    · 分区用「幂等函数 + 相对时间开窗」动态建，**不写死日期**（写死会在窗口外用尽时
--      以 `no partition of relation "usage_records" found for row` 让计量写入失败）
-- ⚠️ 刻意**不建 DEFAULT 分区**（理由见 `0001_init` 末尾那一段：它会把"新月份 attach 成
--    正式分区"变成需要停机搬数据的操作，换来的是把"缺分区"从立刻报错变成静默吞掉）
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateTable（分区父表）
CREATE TABLE "usage_records" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "model" VARCHAR(255) NOT NULL,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "rounds" INTEGER NOT NULL,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");

-- CreateIndex（建在父表上 → 分区索引自动传播，新分区 attach 时也自动获得）
-- 「某个用户的用量」与「某个 Agent 的用量」是 `02` §三 写明的两个用途（都是时间窗口 + 人的形状）
CREATE INDEX "usage_records_user_id_created_at_idx" ON "usage_records"("user_id", "created_at" DESC);
CREATE INDEX "usage_records_agent_id_created_at_idx" ON "usage_records"("agent_id", "created_at" DESC);

-- AddForeignKey（PG 12+ 允许分区表引用普通表，同 `messages`）
-- ⚠️ `RESTRICT`（不是 Cascade）：计量是账，不该被谁连带删掉。本系统不删用户、Agent 只软删
-- ⇒ 这两条外键不会挡下任何合法的 P0 操作，只是把"以后硬删"变成一次显式决定。
-- 口径与 `conversations.user_id` / `conversations.agent_id` 一致（`02` §3.1 的外键表）。
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 分区维护：ensure_usage_records_partition(月份) —— 幂等建当月分区
--
-- 与 `ensure_messages_partition` 逐字同构（**不是**共用同一个函数：两张表各自的分区
-- 由各自的函数建，改一张表的分区规则时不该连带影响另一张）。
-- 续期入口：`pnpm db:partitions`（`prisma/sql/ensure_usage_records_partitions.sql`）。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE FUNCTION "ensure_usage_records_partition"(target_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    month_start DATE := date_trunc('month', target_month)::date;
    month_end   DATE := (date_trunc('month', target_month) + INTERVAL '1 month')::date;
    part_name   TEXT := 'usage_records_' || to_char(date_trunc('month', target_month), 'YYYY_MM');
BEGIN
    IF to_regclass('public.' || part_name) IS NULL THEN
        BEGIN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF "usage_records" FOR VALUES FROM (%L) TO (%L)',
                part_name, month_start, month_end
            );
        EXCEPTION WHEN duplicate_table THEN
            NULL;  -- 并发续期撞车：已由另一连接建好，按幂等处理
        END;
    END IF;
    RETURN part_name;
END;
$$;

-- 初始窗口：上个月 ~ 未来 12 个月（共 14 个分区），与 `messages` 同款。
-- 向前留 1 个月给"补写历史 / 时钟偏差"，向后 12 个月给定时任务留足续期余量。
DO $$
DECLARE
    offset_months INT;
BEGIN
    FOR offset_months IN -1..12 LOOP
        PERFORM "ensure_usage_records_partition"(
            (date_trunc('month', now()) + make_interval(months => offset_months))::date
        );
    END LOOP;
END;
$$;
