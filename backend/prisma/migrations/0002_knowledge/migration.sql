-- ═══════════════════════════════════════════════════════════════════════════
-- 0002_knowledge —— 知识库三表 + 向量/中文全文两扩展（P0-1-14）
--
-- 覆盖：knowledge_bases / documents / chunks（3 张表 + 1 个枚举 document_status）
--       + CREATE EXTENSION vector / pg_bigm + chunks 的两个特殊索引（HNSW / gin_bigm_ops）
-- 依据：docs/02-后端设计.md §三 + §4.6、docs/子方案/知识库流水线.md §4-4
--
-- ── 这份迁移是怎么来的（改它之前必读）────────────────────────────────────
-- 主体（extension → 枚举 → 3 张表 → 3 个普通索引 → 2 个外键）由
--     pnpm --filter @doubulea/backend exec prisma migrate diff \
--       --from-config-datasource --to-schema prisma/schema.prisma --script
-- 从 `prisma/schema.prisma` 生成，**改 schema 后请重新生成再比对**，不要手改这段。
-- 唯一人工调整：把两条 `CREATE EXTENSION` 提到了最前面（`chunks.embedding vector(1024)`
-- 依赖 `vector` 类型，扩展必须先建；Prisma 生成的顺序里没有扩展这一步，因为它不知道）。
--
-- 下半部分（chunks 的两个特殊索引）是**手写**的：Prisma 表达不了
-- `USING hnsw ... WITH (m, ef_construction)` 与算子类 `gin_bigm_ops`。
-- 手写 DDL 在这里有个**必须处理的副作用**（P0-1-5 的 messages 分区**没有**这个问题，
-- 别被那份结论误导）：Prisma 认不出的索引，会被它当成"库里多出来的对象"而**生成 DROP**。
-- 实测（`migrate dev --create-only`，探针记录见 issue_fix/问题记录-P0-1-14-知识库数据模型.md）：
--      -- DropIndex
--      DROP INDEX "idx_chunks_bigram";
--      -- DropIndex
--      DROP INDEX "idx_chunks_embedding";
--   ⇒ 即"下一个批次动 schema 时，这两条索引会被静默删掉、检索退化成全表扫描"。
--   两条的处置不同（缘由见文件末"两个特殊索引"段）：
--     · `idx_chunks_bigram` —— 在 `schema.prisma` 里用
--       `@@index([content(ops: raw("gin_bigm_ops"))], type: Gin, map: "idx_chunks_bigram")`
--       声明，Prisma 能表达它，于是 diff 归零；
--     · `idx_chunks_embedding` —— Prisma 表达不了，改为建**部分索引**
--       （`WHERE kb_id IS NOT NULL`，恒真谓词）把它藏进"Prisma 忽略部分索引"这一类。
--   两条机制都有断言守着（`verify:knowledge` 里的 `migrate diff --exit-code = 0`）。
-- ⚠️ 迁移目录名刻意是 `0002_knowledge` 而非 Prisma 默认的 `<时间戳>_knowledge`：
--    与 `0001_init` 同一约定 —— 代码演进顺序比墙上时钟更该决定先后。
--    Prisma 按目录名字典序应用，且会把目录名记进 `_prisma_migrations.migration_name`，
--    因此**一旦应用就不能改名**（改了会被当成新迁移重跑）。
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 扩展（P0-1-2 已在镜像里编译进去，这里只是"在本库启用"）
--
-- vector  —— pgvector：`chunks.embedding vector(1024)` 与 HNSW 索引都用它
-- pg_bigm —— 中文 bigram 倒排：`content LIKE '%词%'` 可走索引，`bigm_similarity()` 排序用
--
-- `IF NOT EXISTS`：迁移可能重放（迁移 reset / 新环境），且这两条在库级只该有一次。
-- 版本下限说明：镜像里实测 vector 0.8.6 / pg_bigm 1.2（PG 16.15），
-- HNSW 需要 pgvector >= 0.5、`gin_bigm_ops` 需要 pg_bigm >= 1.1。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_bigm";

-- ═══════════════════════════════════════════════════════════════════════════
-- 以下为 Prisma 生成部分（枚举 → 3 张表 → 普通索引 → 外键）
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('PARSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "knowledge_bases" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "embedding_model" VARCHAR(255) NOT NULL,
    "chunk_size" INTEGER NOT NULL DEFAULT 512,
    "chunk_overlap" INTEGER NOT NULL DEFAULT 64,
    "retrieval_config" JSONB NOT NULL DEFAULT '{"topK":5,"score":0.3,"mode":"HYBRID","splitStrategy":"hybrid","rrfK":60,"weights":{"vector":1.0,"fulltext":1.0}}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "kb_id" UUID NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'PARSING',
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "error_msg" TEXT,
    "content_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- ⚠️ `embedding` 是 pgvector 列。Prisma 侧对应 `Unsupported("vector(1024)")?` ——
--    「可空」不是随手写的：可空才能让 Prisma 的 `create` 省略该列（模型里有必填的
--    unsupported 字段会让整个模型无法建行），也与 `子方案①` §4-4 的 DDL 一致。
--    真正的写入在 P0-1-19（`INSERT ... SELECT unnest(...)`，因为要写 vector）。
-- ⚠️ `id` 无 DB 默认值：`@default(uuid(7))` 是**客户端**默认值，不进 DDL
--    （P0-1-5 实测的函数型默认值口径）。所以 P0-1-19 的手写 INSERT 必须自带 id 数组。
CREATE TABLE "chunks" (
    "id" UUID NOT NULL,
    "doc_id" UUID NOT NULL,
    "kb_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_kb_id_created_at_idx" ON "documents"("kb_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "chunks_kb_id_idx" ON "chunks"("kb_id");

-- CreateIndex
-- `doc_id` 上的外键不会由 PG 自动建索引，这条同时补上它（覆盖重建的 DELETE 也用它）
CREATE INDEX "chunks_doc_id_seq_idx" ON "chunks"("doc_id", "seq");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_kb_id_fkey" FOREIGN KEY ("kb_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- chunks 的两个特殊索引（手写，见文件头"下半部分"）
--
-- ⚠️ 这两条 DDL 有一个非显然的约束：**不能出现在 `migrate dev` 生成的 diff 里**。
--    Prisma 7.10.0 表达不了 `USING hnsw`（`type: Hnsw` 直接报 Unknown index type）
--    与 `gin_bigm_ops` 算子类，于是它会把这两个索引当成"库里多出来的对象"并生成 DROP。
--    实测（探针记录见 issue_fix/问题记录-P0-1-14-知识库数据模型.md）：
--      · 反手建一个**普通 btree 索引**或**表达式索引**（不在 schema 里）→ 立即 `DROP INDEX`；
--      · 建一个**部分索引**（带 `WHERE` 谓词）→ Prisma **忽略**（一条 diff 都不出）。
--    ⇒ 因此：
--      · GIN 那条**在 schema.prisma 里声明了**（`type: Gin` + `ops: raw("gin_bigm_ops")`
--        + `map` 固定名字），Prisma 能表达它，就不需要藏；
--      · HNSW 那条**藏进"部分索引"这一类**：谓词写 `WHERE "kb_id" IS NOT NULL`。
--        它不是语义上的过滤 —— `kb_id` 是 NOT NULL 列，谓词恒真、覆盖全部行，
--        **索引内容与全量 HNSW 完全等价**，纯粹是"让 Prisma 看不见"的形状。
--        代价（已在验收里守住）：规划器只有在查询**能推出该谓词**时才会用它，
--        而向量路本来就必须按库收窄（`子方案①` §6-1「绑定某 Agent 的每个库各查一次」，
--        `WHERE kb_id = $2 ORDER BY embedding <=> $1`），`kb_id = $2` 蕴含
--        `kb_id IS NOT NULL` ⇒ 照常走索引。
--        `verify:knowledge` 里有两条断言盯这件事：`migrate diff --exit-code` 必须为 0
--        （即"藏"的机制仍然有效），以及 `EXPLAIN` 那个查询形状真的命中本索引。
--
-- ⚠️⚠️ 另一条必测坑：**GIN 索引必须显式写算子类 `gin_bigm_ops`**（`06` P0-1-14 点名的坑）。
--      该预判经实测**部分不成立**：写成 `USING gin (content)` 不会"静默建错算子类"，
--      PG 16 会在**建索引时立刻报错** ——
--        ERROR: data type text has no default operator class for access method "gin"
--      （实测：`text` 没有任何默认 GIN 算子类，连 pg_bigm 装上也一样 —— `gin_bigm_ops`
--        的 `opcdefault` 是 false）。真正的风险因此变成"报错文案不含 gin_bigm_ops，
--      容易被误读成 pg_bigm 没编进镜像"。故验收不止断言索引存在，还要：
--        ① `pg_indexes.indexdef` 里出现 `gin_bigm_ops`；
--        ② `EXPLAIN` 中文 `LIKE '%中文%'` 真的能命中这条 GIN（P0-1-20 复验）。
--
-- 参数来源（`子方案①` §4-4，逐字）：
--   向量路 HNSW，cosine 距离：m=16 / ef_construction=64（建索引参数；查询期 ef_search
--   用 PG 默认 40，需要调再说）。HNSW 是**近似**索引，参数越小建得越快、召回越低。
--   全文路 pg_bigm GIN：中文按 2-gram 建倒排，`LIKE '%词%'` 与 `bigm_similarity()` 都走它。
--   注意 pg_bigm 的倒排是 **2-gram**：单字查询（`LIKE '%中%'`）用不上索引，
--   这是 `子方案①` §6-1「< 2 字跳过全文路」的由来。
-- 为什么 HNSW 不用 ivfflat：ivfflat 需要先有数据再定聚类中心（建索引时表必须非空才有意义），
--   且 `lists` 要随数据量调；HNSW 支持空表建索引、增量插入质量稳定，更适合"边传边检索"。
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateIndex（向量路；`WHERE kb_id IS NOT NULL` 是"让 Prisma 看不见"的形状，不是业务过滤）
CREATE INDEX "idx_chunks_embedding" ON "chunks"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE "kb_id" IS NOT NULL;

-- CreateIndex（全文路；算子类必须写 gin_bigm_ops，见上）
CREATE INDEX "idx_chunks_bigram" ON "chunks"
    USING gin ("content" gin_bigm_ops);
