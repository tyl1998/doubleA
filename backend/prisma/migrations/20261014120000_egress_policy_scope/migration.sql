-- P1-16a：平台出网范围（`egress_policy.scope`；默认全放行）
--
-- 依据：`docs/子方案/Code模式工作区.md` §五 7.5b。
-- ⚠️ **2026-10-14 施工修订（用户定案）**：出网范围**配在平台出网策略里**（`/admin/egress`），**不在会话里配**。
--    它决定**基线放行集**，与既有黑白名单**并列补充**（范围给基线，白名单再加零散主机，黑名单永远硬拒）。
--    `NOT NULL DEFAULT 'ALL'` = 存量策略默认全放行（**行为不变**）。
--
-- ⚠️ 幂等：枚举可能被同批作废的 WIP 迁移建过 ⇒ 用 DO 块判存在；作废的会话级列也顺手清理。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'egress_scope') THEN
    CREATE TYPE "egress_scope" AS ENUM ('ALL', 'NONE', 'REGISTRY');
  END IF;
END
$$;

ALTER TABLE "egress_policy" ADD COLUMN IF NOT EXISTS "scope" "egress_scope" NOT NULL DEFAULT 'ALL';

-- 清理作废的会话级列（若早期 WIP 迁移建过）
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "egress_scope";
