#!/usr/bin/env node
/**
 * serve-upstreams.mjs —— 常驻起两个**假上游**（对话 + embedding），给"**浏览器端测**"用（P0-1-32 起）
 *
 * 跑法：`node backend/scripts/serve-upstreams.mjs`（前台常驻，Ctrl-C 收工）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么端测需要它，而不是"配一个真厂商的 Key"
 * ─────────────────────────────────────────────────────────────────────
 * `docs/06` 第四档的口径（P0-1-12 定案）：凡"调用外部服务"的验收，**不接真厂商** ——
 * 凭据、网络、限额、以及"厂商今天发的报文变没变"全是噪声，而**"配置有没有接对"反而验不到**。
 * 浏览器端测要看的四件事（delta 逐字追加 / 思考块 / 引用卡 / 刷新后历史）**没有一件**依赖
 * 真模型的智能，但**每一件**都依赖"上游的时序"：几个增量、有没有 `reasoning_content`、
 * 什么时候结束。假上游把这些变成**可控**的：
 *   · `thinking: true` ⇒ 会先发一帧 `reasoning_content`（没有它就没有思考块可看）；
 *   · `deltaDelayMs: 400` ⇒ 增量慢到肉眼能看见"逐字追加"（真厂商几十毫秒就把整段吐完，
 *     浏览器端测只能看到最后结果，等于什么都没验）；
 *   · `semantic: true`（embedding 侧）⇒ 检索按**字面重叠**排序，"含关键词的那一块"排第一
 *     ⇒ 才拿得到 `citations` 事件（哈希噪声向量下排序等价于随机，引用卡可能空手而归）。
 *
 * ⚠️ 回答文本**只从请求里抄**（`defaultScriptFor`）：它去 system prompt 的检索块里找
 * 「来源：文档名」，找到就回"根据《X》……"。于是"引用卡上那张卡确实来自检索"变成
 * **回答文本上的可观测差异**，而不是"界面上碰巧出现了一张卡"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 用法上的顺序（错了不会报错，只会表现为"引用卡不来"）
 * ─────────────────────────────────────────────────────────────────────
 * 1. **先起本脚本**，抄下它打印的两个 URL；
 * 2. 把 **Provider 的 `base_url` 改成 `CHAT_UPSTREAM_URL`**（模型池接口只对 ADMIN 开放）：
 *    `PATCH /api/model-providers/<id>` body `{"baseUrl":"http://127.0.0.1:<port>/v1"}`；
 * 3. **带 embedding 三项起后端**（`EMBEDDING_API_URL` 指 embedding 上游），否则文档走不到
 *    `READY`、检索也拿不到 query 向量：
 *    ```
 *    EMBEDDING_MODE=api \
 *    EMBEDDING_API_URL=<EMBEDDING_UPSTREAM_URL> \
 *    EMBEDDING_API_KEY=dev-fake-key \
 *    EMBEDDING_API_MODEL=<知识库快照里的模型名> \
 *    pnpm dev:backend
 *    ```
 *    ⚠️ `EMBEDDING_API_MODEL` 必须与**库里知识库的 `embedding_model` 快照**同值
 *    （库里存的是 `api:<模型名>`）—— 不同值不会报错，只会让检索**降级**、
 *    于是引用卡一会儿有一会儿没有（P0-1-20 的降级路径）。
 * 4. 前端照旧：`VITE_DEV_PROXY_TARGET=http://127.0.0.1:13000 pnpm dev:frontend`。
 */

const { startFakeChatUpstream } = await import('./fixtures/chat-upstream.mjs')
const { startFakeEmbeddingUpstream } = await import('./fixtures/embedding-upstream.mjs')

// 对话侧：**必须**带 thinking（否则没有思考块可看）、增量放慢（否则看不到"逐字追加"）。
// ⚠️ 间隔可用 `UPSTREAM_DELTA_DELAY_MS` 调（默认 400）—— 想用肉眼盯"思考块展开→自动折叠"，
//     就把它调大（如 1500）；默认 400ms 对"看着它打字"来说已经偏快。
const deltaDelayMs = Number.parseInt((process.env.UPSTREAM_DELTA_DELAY_MS ?? '').trim() || '400', 10)
const chat = await startFakeChatUpstream({ thinking: true, deltaDelayMs })
// embedding 侧：词面重叠型向量 ⇒ "含关键词的块"排第一 ⇒ 才拿得到 citations
const embedding = await startFakeEmbeddingUpstream({ semantic: true })

console.log('[serve-upstreams] 两个假上游已就绪（Ctrl-C 收工）')
console.log(`[serve-upstreams] CHAT_UPSTREAM_URL=${chat.url}`)
console.log(`[serve-upstreams] EMBEDDING_UPSTREAM_URL=${embedding.url}`)
console.log(
  '[serve-upstreams] 下一步：① 把 Provider 的 baseUrl PATCH 成 CHAT_UPSTREAM_URL；' +
    '② 带 EMBEDDING_MODE=api / EMBEDDING_API_URL=<EMBEDDING_UPSTREAM_URL> / ' +
    'EMBEDDING_API_KEY=dev-fake-key / EMBEDDING_API_MODEL=<知识库快照的模型名> 起后端；' +
    '③ 起前端（5174）。详见本文件头部。',
)

/** 前台常驻：把两个上游一起关掉再退出（stall / 长连接上必须有 closeAllConnections） */
async function shutdown(signal) {
  console.log(`\n[serve-upstreams] 收到 ${signal}，正在关闭两个假上游…`)
  await Promise.allSettled([chat.close(), embedding.close()])
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
