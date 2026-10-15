-- P1-20：用户级 git 提交身份（name/email）
--
-- 背景（用户反馈 2026-10-15）：容器里原本没有 git 身份 ⇒ agent 只能自己猜（沿用 SSH key 的身份）
--   并写进仓库本地 config，出问题还得 `git commit --amend` + 强推。改为**平台按会话发起者注入**：
--   派活时把这两个值经 `GIT_CONFIG_*` 交给容器 git 的 `user.name`/`user.email`。
--
-- 两列都可空（默认不注入，行为与引入前一致）；值用户级（同 git 凭据），不进 workspace、不落盘容器。
ALTER TABLE "users" ADD COLUMN "git_name" VARCHAR(128);
ALTER TABLE "users" ADD COLUMN "git_email" VARCHAR(255);
