-- P1-6 定时任务（2026-10-09 需求变更：任务中心 = 定时任务）：scheduled_tasks 表 + 枚举
--
-- 形状见 schema.prisma#ScheduledTask。一行 = 一条定时任务（owner + TaskAgent + 指令 + cron）。
-- 到点由 `scheduler/scheduledTasks.ts` 新建一个会话把指令发给该 TaskAgent（复用既有 TaskAgent 链路）。
-- ⚠️ `next_run_at` / `last_run_at` 由 JS 侧显式写入（不用 DB 默认），与调度比较的时区口径一致。

CREATE TYPE "scheduled_run_status" AS ENUM ('NEVER', 'RUNNING', 'SUCCESS', 'FAILED');

CREATE TABLE "scheduled_tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "prompt" TEXT NOT NULL,
    "cron_expr" VARCHAR(120) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMPTZ(3),
    "last_run_at" TIMESTAMPTZ(3),
    "last_run_status" "scheduled_run_status" NOT NULL DEFAULT 'NEVER',
    "last_conversation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex（调度器扫描键：enabled AND next_run_at <= now）
CREATE INDEX "scheduled_tasks_enabled_next_run_at_idx" ON "scheduled_tasks"("enabled", "next_run_at");

-- CreateIndex（本人的列表，按最近创建倒序）
CREATE INDEX "scheduled_tasks_user_id_created_at_idx" ON "scheduled_tasks"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey（删会话只置空，不级联删任务）
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_last_conversation_id_fkey" FOREIGN KEY ("last_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
