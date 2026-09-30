-- ═══════════════════════════════════════════════════════════════════════════
-- model_providers —— 新增 custom_url：第三方端点不按规范时的"原样 URL"逃生口
--
-- 背景：我方对话/探测走**字符串拼接**（`${base_url}${path}`，path 由协议写死为
--   `/chat/completions` / `/responses` / `/messages` / `/models` / `/embeddings`），
--   隐含假设 base_url 是"host + 版本段"。部分第三方直接给一条**完整端点**
--   （已含路径、甚至带 query），此时固定拼接会拼出错误路径（如 .../chat/completions/chat/completions）。
--   custom_url=true 时后端**原样**用 base_url 发请求，不再拼后缀
--   （见 `backend/src/llm/upstream.ts#resolveUpstreamUrl`）。
--
-- 存量数据安全：带默认值 false 的新列，既有行行为**逐字不变**（= 继续拼接）。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "model_providers" ADD COLUMN "custom_url" BOOLEAN NOT NULL DEFAULT false;
