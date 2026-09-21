-- ═══════════════════════════════════════════════════════════════════════
-- 首次初始化时创建项目所需扩展（仅"空数据卷"时执行一次）
-- 由 postgres 官方 entrypoint 在 initdb 之后、启动服务之前执行。
--
-- 幂等说明：`IF NOT EXISTS` 保证重复执行安全；即使有人手工重建卷也不会报错。
-- 若在已有数据的卷上需要补建扩展，手工执行即可（见 infra/scripts/pg-verify.mjs）。
-- ═══════════════════════════════════════════════════════════════════════

-- 向量检索：chunks.embedding 的 vector(1024) 与 HNSW 索引（子方案① §4-4）
CREATE EXTENSION IF NOT EXISTS vector;

-- 中文全文检索：bigram 倒排索引，让 content LIKE '%词%' 可走索引
-- （决策 11；docs/01 §二）
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- pg_trgm 一并装上：给「模糊匹配 / 相似度排序」留出后路，
-- 与 pg_bigm 不冲突（前者按 3-gram 且更适合英文与拼写纠错）。
-- 当前 D 包不依赖它，装了不用，成本为零。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
