-- ═══════════════════════════════════════════════════════════════════════════
-- 知识库 embedding 改用「模型池选定的模型」+ 支持任意维度
--
-- 背景（用户 2026-09-30 需求）：
--   ① 知识库的 embedding 不再走进程级环境变量（EMBEDDING_MODE / EMBEDDING_API_* / 本地模式），
--      而是在**建库时从模型池选一个 EMBEDDING 模型**，绑定到该库；入库与检索都用它。
--   ② 因此每个库的向量维度可能不同 ⇒ `chunks.embedding` 不能再写死 `vector(1024)`，
--      改为**无固定维度**的 `vector`，维度记在 `chunks.embedding_dim`（并快照到 `knowledge_bases.embedding_dim`）。
--
-- ⚠️ 代价：无固定维度的 `vector` 列**无法建 HNSW 索引**（pgvector 的 ANN 索引要求固定维度），
--   故本迁移**删除**原 `idx_chunks_embedding`。向量路退化为「按 kb_id + 维度收窄后的精确扫描」——
--   对本项目的库规模足够；将来若要恢复 ANN，应按维度建**表达式部分索引**
--   （`USING hnsw ((embedding::vector(N)) vector_cosine_ops) WHERE embedding_dim = N`）。
--
-- 存量数据安全：
--   ① 原列全是 1024 维 ⇒ `USING embedding::vector` 是无损类型放宽；`embedding_dim` 回填 1024；
--   ② 老库的 `embedding_model_id` 为 NULL（本列引入前建的库）⇒ 其向量路不可用、退化为纯全文检索，
--      需重建后才参与向量检索（检索层会给明确告警）。
-- ═══════════════════════════════════════════════════════════════════════════

-- ① 维度自适应：先删 HNSW（它绑死 1024 维），再把列放宽为无固定维度
DROP INDEX IF EXISTS "idx_chunks_embedding";
ALTER TABLE "chunks" ALTER COLUMN "embedding" TYPE vector USING "embedding"::vector;
ALTER TABLE "chunks" ADD COLUMN "embedding_dim" INTEGER;
UPDATE "chunks" SET "embedding_dim" = 1024 WHERE "embedding" IS NOT NULL;

-- ② 知识库：选定模型（FK，删模型置空）+ 维度快照
ALTER TABLE "knowledge_bases" ADD COLUMN "embedding_model_id" UUID;
ALTER TABLE "knowledge_bases" ADD COLUMN "embedding_dim" INTEGER;
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_embedding_model_id_fkey"
    FOREIGN KEY ("embedding_model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
