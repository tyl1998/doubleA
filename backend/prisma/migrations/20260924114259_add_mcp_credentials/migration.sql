-- CreateTable
CREATE TABLE "mcp_credentials" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "values_enc" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mcp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_credentials_user_id_idx" ON "mcp_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_credentials_server_id_user_id_key" ON "mcp_credentials"("server_id", "user_id");

-- AddForeignKey
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
