-- P1-6 附加：定时任务的「允许执行危险工具」开关（scheduled_tasks.auto_approve）
--
-- 一条定时任务无人值守运行；对危险 MCP 工具（破坏性操作）的处置做成**每条任务可配**：
--   auto_approve = true（默认）  ⇒ `awaitConfirm` 自动按"已确认"放行；
--   auto_approve = false         ⇒ 一律拒绝。
-- 原因：定时任务本就要能干活，「一刀切拒绝」会把需要危险工具的定时任务整条废掉；但策略
-- 应随任务持久化、由任务 owner 决定，而不是平台替他决定。默认 true（会话级 chat.autoapprove 的既有默认是"关"，
-- 两者是**任务策略** vs **运行时开关**之别）。

ALTER TABLE "scheduled_tasks" ADD COLUMN "auto_approve" BOOLEAN NOT NULL DEFAULT true;
