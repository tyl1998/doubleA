-- P1-8 长期记忆（L1 会话小结 / L2 用户记忆）+ 记忆开关
--
-- 依据：`docs/子方案/TaskAgent会话持久化与长期记忆.md` §4.1/§4.3/§5（HCI）。
-- 形状见 schema.prisma#ConversationSummary / #Memory，以及 User/Conversation 的记忆列。
-- ⚠️ 本批**不改任何既有列**，只加列 + 两张新表（可逆：删列删表即回到 P1-7 形态）。

-- CreateEnum
CREATE TYPE "memory_kind" AS ENUM ('FACT', 'PREFERENCE', 'TASK', 'OTHER');

-- AlterTable：用户记忆开关（三项，均带默认值 ⇒ 存量用户开箱即用）
ALTER TABLE "users" ADD COLUMN "memory_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "memory_auto_extract" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "memory_full_auto" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable：会话级「不记入记忆」
ALTER TABLE "conversations" ADD COLUMN "memory_excluded" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable：L1 会话小结（一个会话一行；与 ChatBot 滚动摘要 CB-2 共用）
CREATE TABLE "conversation_summaries" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "up_to_message_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversation_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex（1:1：一个会话只有一行）
CREATE UNIQUE INDEX "conversation_summaries_conversation_id_key" ON "conversation_summaries"("conversation_id");

-- AddForeignKey（删会话级联删小结：它是会话的派生物）
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable：L2 用户记忆条目
CREATE TABLE "memories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_id" UUID,
    "kind" "memory_kind" NOT NULL,
    "text" TEXT NOT NULL,
    "source_conversation_id" UUID,
    "source_message_id" UUID,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex（面板列表：本人 + 创建时间倒序）
CREATE INDEX "memories_user_id_created_at_idx" ON "memories"("user_id", "created_at" DESC);

-- CreateIndex（注入扫描：本人 + 置顶优先）
CREATE INDEX "memories_user_id_pinned_created_at_idx" ON "memories"("user_id", "pinned", "created_at" DESC);

-- AddForeignKey（删账号级联删条目）
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey（删 Agent 置空：条目保留、降级为通用）
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
