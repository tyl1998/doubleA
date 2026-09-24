-- CreateEnum
CREATE TYPE "mcp_auth_type" AS ENUM ('NONE', 'OAUTH');

-- CreateEnum
CREATE TYPE "mcp_server_status" AS ENUM ('UNKNOWN', 'OK', 'ERROR');

-- CreateTable
CREATE TABLE "mcp_servers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(32) NOT NULL,
    "endpoint_url" VARCHAR(2048) NOT NULL,
    "auth_type" "mcp_auth_type" NOT NULL DEFAULT 'NONE',
    "oauth_config" JSONB,
    "credential_schema" JSONB NOT NULL DEFAULT '[]',
    "tool_cache" JSONB,
    "status" "mcp_server_status" NOT NULL DEFAULT 'UNKNOWN',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_servers_created_by_idx" ON "mcp_servers"("created_by");

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
