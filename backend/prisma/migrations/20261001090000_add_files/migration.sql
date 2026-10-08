-- P1-4 文件附件：files 表（`02` §三 的 `files` 行；形状见 schema.prisma#File）
--
-- 一行 = 一次 POST /api/files/upload 落下的对象。`uploader_id` 是归属列（附件在上传时
-- 就存在，会话可能要等首条消息才建）；`file_key` 是 S3 对象键（不出现在对外契约里）。
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "uploader_id" UUID NOT NULL,
    "file_key" VARCHAR(512) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "files_uploader_id_created_at_idx" ON "files"("uploader_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
