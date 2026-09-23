-- CreateEnum
CREATE TYPE "upstream_protocol" AS ENUM ('OPENAI_COMPAT', 'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES');

-- AlterTable
ALTER TABLE "model_providers" ADD COLUMN     "protocol" "upstream_protocol" NOT NULL DEFAULT 'OPENAI_COMPAT';
