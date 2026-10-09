-- P1-6 增量：定时任务的**通知渠道**（scheduled_tasks.notify_type / notify_url / notify_secret）
--
-- 场景（`01` 场景 1）：定时获取信息后经企微 / 飞书等消息渠道通知我。
-- 每条任务自带一个 webhook（用户定案：不做全局渠道库）。URL 与签名密钥都是**密文**
-- （`infra/crypto.ts#encryptSecret`，AES-256-GCM + credentialMasterKey）—— 地址里含 key。

CREATE TYPE "notify_type" AS ENUM ('NONE', 'WECOM', 'FEISHU', 'WEBHOOK');

ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_type" "notify_type" NOT NULL DEFAULT 'NONE';
ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_url" TEXT;
ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_secret" TEXT;
