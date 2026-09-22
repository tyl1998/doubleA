/**
 * 夹具：**假 embedding 上游**（OpenAI 兼容 `POST {base}/embeddings`）
 *
 * 为什么需要它（P0-1-19 起）：流水线的 ⑥ embedding 会在**每一次** READY 之前调用 embedding。
 * 而本机 `infra/.env` 是 `EMBEDDING_MODE=api` 且三项为空（`docs/06` §七 待决事项 2 的口径：
 * 先跑 api 模式打通链路）⇒ 任何"走到 READY"的验收都会在 ⑥ 处硬报错。
 *
 * 按 `06` 的**第四档**口径处理：**不**去接真厂商（凭据/网络/限额都是噪声，而且"配置有没有
 * 接对"反而验不到），而是自己起一个真 HTTP 服务按目标协议应答，并**记录每个请求**，
 * 这样"上面接的是不是它""批大小对不对""有没有发多余字段"全都可取证。
 *
 * ⚠️ 用法上有一处必须注意：调用方要在 **import `config`/backend 模块之前** 设好
 * `EMBEDDING_API_URL`（配置在模块加载期只读一次），所以启动顺序是
 * 「起假上游 → 写 `process.env` → `await import(backend)`」，见 `verify-pipeline.mjs` 顶部。
 *
 * 向量是**由文本确定性地推出来**的（同一个文本永远得到同一个向量）：这样断言可以写
 * "被检索到的是哪一段"，而不是"有一个向量就行"。
 */

import { createHash } from 'node:crypto'
import http from 'node:http'

/** 由文本推一个稳定的 1024 维向量（值域 [-1,1)）；用 sha256 保证跨进程稳定 */
export function vectorFor(text, dim) {
  const digest = createHash('sha256').update(text).digest()
  const vector = new Array(dim)
  for (let i = 0; i < dim; i += 1) {
    // 4 字节一取，正好把 32 字节的摘要摊开成 dim 个数（dim > 32 时循环复用摘要）
    const byte = digest[i % digest.length]
    const byte2 = digest[(i * 7 + 3) % digest.length]
    vector[i] = (((byte << 8) | byte2) % 2000) / 1000 - 1
  }
  return vector
}

/**
 * **词面重叠型**向量（P0-1-20 新增；只有 `semantic: true` 时才用）。
 *
 * 为什么需要它：`vectorFor()` 是哈希噪声 —— 两条文本的余弦相似度恒在 0 附近，
 * 于是向量路**排序**在任何语料上都等价于随机排序。P0-1-19 只需要"存进去的向量能算距离"，
 * 噪声够了；但 P0-1-20 要断言"**包含关键词的那一块**被向量路排在第一"，
 * 噪声向量做不到，只能证明"链路通了"。
 *
 * 做法：把文本切成**字符 2-gram**，每个 gram 哈希到一个维度并置 1（不累加），
 * 最后按 L2 归一化。于是"查询的 2-gram 都出现在这块正文里" ⇒ 余弦相似度 ≈ sqrt(|q|/|块|)
 * （实测：8 个 2-gram 的 query 对约 55 字的块 ≈ 0.38，对不相关块 ≈ 0.05 以下）。
 *
 * ⚠️ 它的语义是**字面重叠**，不是真语义 —— 所以"向量路命中了含关键词的块"这件事
 * 在这份夹具下证明的是**链路正确**（query 向量 → `<=>` 距离 → 名次 → 融合），
 * 而不是"模型的语义质量"。后者只能靠真 embedding 模型（`docs/06` §七 待决事项 2）。
 *
 * @param {string} text
 * @param {number} dim
 * @returns {number[]}
 */
export function semanticVectorFor(text, dim) {
  const chars = [...text]
  const vector = new Array(dim).fill(0)
  for (let i = 0; i < chars.length; i += 1) {
    const gram = chars[i] + (chars[i + 1] ?? '')
    const digest = createHash('sha256').update(gram).digest()
    vector[((digest[0] << 8) | digest[1]) % dim] = 1
  }
  // 归一化（pgvector 的 cosine 距离会自己算模长，但归一化让"距离"更好读、也避免零向量）
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (norm === 0) {
    vector[0] = 1
    return vector
  }
  return vector.map((value) => value / norm)
}

/**
 * 启动假上游。
 *
 * @param {{ dim?: number, model?: string, failing?: boolean, semantic?: boolean }} [options]
 * @returns {Promise<{ baseUrl: string, url: string, requests: object[], setFailing: (v: boolean) => void, close: () => Promise<void> }>}
 *   `url` 是可直接塞进 `EMBEDDING_API_URL` 的值（带 `/v1`，与真实厂商习惯一致）；
 *   `setFailing(true)` 让**后续**请求一律 500 —— 用于验"上游挂了 → 整篇 FAILED → 修好后重试能救回"
 *   （`06` P0-1-19 的验收里"造一个 FAILED 文档 → retry 后转 READY"就是这条）；
 *   `semantic: true` 改用 {@link semanticVectorFor}（词面重叠型）；**默认仍是哈希噪声**，
 *   以免改变既有脚本（P0-1-19 起）已断言的向量性质（如"同一个文本距离为 0"）。
 */
export async function startFakeEmbeddingUpstream(options = {}) {
  const dim = options.dim ?? 1024
  const model = options.model ?? 'verify-embed-model'
  const embed = options.semantic === true ? semanticVectorFor : vectorFor
  /** 上游侧看到的每个请求（报文形状与凭据都在这里被取证） */
  const requests = []
  /** 可变开关：`setFailing(true)` 之后所有 `/embeddings` 都回 500 */
  let failing = options.failing === true

  const server = http.createServer(async (req, res) => {
    const pieces = []
    for await (const piece of req) pieces.push(piece)
    const raw = Buffer.concat(pieces).toString('utf8')
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    requests.push({
      method: req.method,
      path,
      auth: req.headers.authorization ?? null,
      contentType: req.headers['content-type'] ?? null,
      body: raw === '' ? null : JSON.parse(raw),
    })

    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    }

    if (req.method !== 'POST' || !path.endsWith('/embeddings')) {
      return send(404, { error: { message: `no such path: ${path}` } })
    }
    if (failing) {
      return send(500, { error: { message: 'fake upstream failure (toggled by setFailing)' } })
    }

    const body = raw === '' ? {} : JSON.parse(raw)
    const input = Array.isArray(body.input) ? body.input : []
    if (input.length === 0) return send(400, { error: { message: 'input must not be empty' } })

    // 标准 OpenAI 形态，且**故意倒序**（真实现常乱序，靠 index 归位）
    const rows = input.map((text, index) => ({ embedding: embed(text, dim), index })).reverse()
    return send(200, { object: 'list', model: body.model ?? model, data: rows, usage: { prompt_tokens: 1, total_tokens: 1 } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    baseUrl: base,
    url: `${base}/v1`,
    requests,
    setFailing: (value) => {
      failing = value === true
    },
    close: async () => {
      // "永不响应"的那条路径上会挂着连接 ⇒ 先断开再关，否则 close 会一直等
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
