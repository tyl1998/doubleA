-- CreateEnum
CREATE TYPE "sandbox_status" AS ENUM ('CREATING', 'RUNNING', 'RECYCLED', 'FAILED');

-- CreateTable
CREATE TABLE "sandboxes" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "container_id" VARCHAR(128),
    "status" "sandbox_status" NOT NULL DEFAULT 'CREATING',
    "image" VARCHAR(255) NOT NULL,
    "error_msg" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sandboxes_conversation_id_status_idx" ON "sandboxes"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "sandboxes_status_last_active_at_idx" ON "sandboxes"("status", "last_active_at");

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
