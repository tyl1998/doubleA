-- P1-6 增量：定时任务的**通知模板**（scheduled_tasks.notify_template）
--
-- 用户定案："通知为什么不用模板语言去做" ⇒ 加一个任务级模板字段（**明文**，不含密钥）。
-- 占位符：{{task}} 任务名、{{time}} 运行时间、{{status}} 状态、{{result}} 运行结果。
-- 留空 = 用内置默认（各渠道按自身渲染）。仅自动推送使用；`send_notification` 工具的内容由模型决定。

ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_template" TEXT;
