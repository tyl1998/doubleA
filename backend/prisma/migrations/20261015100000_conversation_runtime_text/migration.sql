-- P1-17a 修订：会话运行时 **枚举 → 自由字符串**（后端从本机镜像探测出的运行时 id）
--
-- 依据（用户 2026-10-14 定案）：运行时可选项应由**后端能探测到的镜像**决定 ——
--   "有就提供、没有就不提供"，而不是编译期写死的枚举。故 `conversations.runtime` 由
--   `conversation_runtime` 枚举改为 `text`，值 = 运行时 id（如 `node` / `python310` /
--   `node22-python38`），与镜像 tag `doubulea/sandbox-runtime:<id>-v<层版本>` 的 `<id>` 一致。
--
-- 为什么**新开一条迁移**而不是改前面那条：`20261015090000_conversation_runtime` 可能已在
--   本机（`dev-run.sh` 会跑 `db:deploy`）应用过 ⇒ 改它会导致 Prisma 迁移漂移。这里只做
--   类型转换 + 回填 + 删枚举，无论前面是否应用都按顺序成立。
--
-- 回填口径：旧枚举名 `lower()` 即新 id（`NODE`→`node`、`PYTHON`→`python`、`MULTI`→`multi`…）。
--   ⚠️ 这些 id 要有对应镜像才选得动；没有就由 `ensureSandbox` 回退 `SANDBOX_IMAGE`。
--
-- ⚠️ 幂等：全程 `IF EXISTS` / `IF NOT EXISTS`（重放不炸；只在首次真跑时做转换）。

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "runtime_tmp" text NOT NULL DEFAULT 'node';

DO $$
BEGIN
  -- 仅当旧枚举列还在时才回填（重放/新库已转换过时跳过）
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'runtime'
      AND data_type = 'USER-DEFINED'
  ) THEN
    EXECUTE 'UPDATE "conversations" SET "runtime_tmp" = lower("runtime"::text)';
  END IF;
END
$$;

ALTER TABLE "conversations" DROP COLUMN IF EXISTS "runtime";
ALTER TABLE "conversations" RENAME COLUMN "runtime_tmp" TO "runtime";

-- 删掉不再使用的枚举类型（列已不再引用它）
DROP TYPE IF EXISTS "conversation_runtime";
