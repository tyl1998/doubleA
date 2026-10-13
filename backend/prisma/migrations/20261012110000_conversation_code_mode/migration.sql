-- P1-9 · P3：会话级 Code 模式开关（持久列）
--
-- 依据：`docs/子方案/Code模式工作区.md` §六 4（会话级 codeMode 标志；不动 AgentType 枚举）。
-- 为什么是**持久列**而不是 Redis（与 `autoApprove` 不同）：派活创建沙箱时要读到它来决定是否
-- 注入 `DOUBULEA_WORKSPACE_MEDIATION=1`，且它改变 `/work` 的语义 ⇒ 必须跨实例一致。
-- `NOT NULL DEFAULT false` = 存量会话默认关闭（行为不变，安全默认）。
ALTER TABLE "conversations" ADD COLUMN "code_mode" BOOLEAN NOT NULL DEFAULT false;
