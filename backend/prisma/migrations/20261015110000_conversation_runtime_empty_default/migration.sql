-- P1-17a 修订：会话运行时**默认值 node → 空串**（= 空环境）
--
-- 依据（产品反馈 2026-10-14）：新建会话不该默认显示 `node`（那是"本机无此镜像"的误导）。
--   未选任何环境时用**空环境** —— 只带基础工具链、不额外装语言运行时；
--   后端 `ensureSandbox` 在探测结果里找不到该 runtime（含空串）时回退 `SANDBOX_IMAGE`。
--
-- 只改**列默认值**（新行用空串）；既有行的值不动（已选的运行时保持不变）。
ALTER TABLE "conversations" ALTER COLUMN "runtime" SET DEFAULT '';
