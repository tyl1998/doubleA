-- ═══════════════════════════════════════════════════════════════════════════
-- models.supports_reasoning —— 模型是否支持"深度思考"（reasoning / thinking），模型池优化
--
-- 与 supports_vision 同款：默认 false（新模型默认不声明支持思考），既是选模型侧的读数，
-- 也在对话链路上决定"是否向上游请求思考"（见 backend/src/llm/protocol.ts 各协议 buildBody）。
-- NOT NULL + DEFAULT false ⇒ 存量行安全回填 false，不需要停机。
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "models" ADD COLUMN "supports_reasoning" BOOLEAN NOT NULL DEFAULT false;
