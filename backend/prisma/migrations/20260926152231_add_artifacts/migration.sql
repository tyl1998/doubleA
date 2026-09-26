-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "file_key" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(512) NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" VARCHAR(255) NOT NULL,
    "preview_ready" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artifacts_conversation_id_created_at_idx" ON "artifacts"("conversation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "artifacts_created_at_idx" ON "artifacts"("created_at");

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
