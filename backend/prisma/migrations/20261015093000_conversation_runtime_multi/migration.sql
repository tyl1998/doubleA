-- P1-17a 增量：运行时枚举加 `MULTI`（多栈并存 / polyglot：node + python + go）
--
-- 依据：`docs/子方案/Code模式工作区.md` §五之二 2（一栈一份镜像；本项是"多栈合一"的补充项）。
-- 为什么单独一条迁移：`20261015090000_conversation_runtime` 可能已经在本机/其他环境跑过
-- ⇒ 改那条不会重跑。这里用 `ADD VALUE IF NOT EXISTS`，无论枚举是否已建都幂等。
--
-- ⚠️ PG 允许在事务里 `ALTER TYPE ... ADD VALUE`（只要同一事务内不使用该新值）；Prisma 每条迁移
--    一个事务，这里只加值、不写数据，安全。
ALTER TYPE "conversation_runtime" ADD VALUE IF NOT EXISTS 'MULTI';
