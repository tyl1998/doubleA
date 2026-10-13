-- P1-9 · R11 git 凭据（2026-10-12）：git_credentials 表 + 枚举
--
-- 形状见 schema.prisma#GitCredential。一行 = 一个用户的一条凭据（一把私钥 / 一个 PAT）。
-- 用户级、不绑 server（与 mcp_credentials 刻意不同）；secret_enc 是 AES-256-GCM 密文（AAD = userId:kind:label）。
-- ⚠️ 无数据回填：新表、新枚举，存量行为不变（没人配过 git 凭据 = 容器不注入任何 git 相关 env / 文件）。

CREATE TYPE "git_credential_kind" AS ENUM ('SSH_KEY', 'HTTPS_TOKEN');

CREATE TABLE "git_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "git_credential_kind" NOT NULL,
    "label" VARCHAR(128) NOT NULL,
    "host" VARCHAR(255),
    "secret_enc" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "git_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex（用户内唯一：label 同时进 AAD，唯一性由这里保证）
CREATE UNIQUE INDEX "git_credentials_user_id_label_key" ON "git_credentials"("user_id", "label");

-- CreateIndex（"我的凭据"列表按 user_id 取）
CREATE INDEX "git_credentials_user_id_idx" ON "git_credentials"("user_id");

-- AddForeignKey
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
