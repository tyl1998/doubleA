-- P1-17a：会话级**运行时**（Code 模式的运行时镜像选择）
--
-- 依据：`docs/子方案/Code模式工作区.md` §五之二 2（方案 B：一栈一份运行时镜像，按会话选）。
-- 为什么是**持久列**而不是 Redis（与 `code_mode` 同族）：`ensureSandbox` 建容器时要读到它来选镜像，
-- 且同一会话跨实例必须一致（多机下换机重建不能换了一个运行时）。
--
-- 枚举 = **运行时白名单**（有限、可预烘焙）；**依赖不在其中**（无限 ⇒ 运行期经注册表拉，P1-17b）。
-- `NOT NULL DEFAULT 'NODE'` = 存量会话默认 node 运行时（node 由 base 层提供、恒可用，最保守的默认）。
--
-- ⚠️ 幂等：用 DO 块判枚举是否已存在（重放/手工改库时不炸）。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_runtime') THEN
    CREATE TYPE "conversation_runtime" AS ENUM ('NONE', 'NODE', 'PYTHON', 'GO', 'JAVA', 'RUST');
  END IF;
END
$$;

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "runtime" "conversation_runtime" NOT NULL DEFAULT 'NODE';
