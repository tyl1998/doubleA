-- egress 策略（2026-10-13）：平台级沙箱出网黑白名单（单例行）
--
-- 形状见 schema.prisma#EgressPolicy。mode 不存、由两张表推导（shared#deriveEgressMode）。
-- 规则形状：host / host:port / *.host（与 infra/scripts/egress-proxy.mjs#matchRule 逐字一致）。
-- ⚠️ 无历史数据：新表、单行 seed（id='default'，两张表都空 = 默认全放行）。

CREATE TABLE "egress_policy" (
    "id" VARCHAR(32) NOT NULL,
    "allow_hosts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "deny_hosts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "egress_policy_pkey" PRIMARY KEY ("id")
);

-- 单行 seed：两张表都空 ⇒ 推导为 ALLOW_ALL（默认全放行）
INSERT INTO "egress_policy" ("id", "allow_hosts", "deny_hosts", "updated_at")
VALUES ('default', ARRAY[]::TEXT[], ARRAY[]::TEXT[], CURRENT_TIMESTAMP);
