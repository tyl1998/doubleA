/**
 * 开放平台文档路由（**P1-22 · B4**；`docs/08` §9）
 *
 * | 方法 | 路径 | 说明 |
 * |------|------|------|
 * | GET | `/open/v1/openapi.json` | OpenAPI 3.1 spec（**入库的 `openapi/open-v1.json` 就是它的产物**） |
 * | GET | `/open/v1/docs` | 极简文档站（读上面那份 JSON 渲染，无 CDN、无额外依赖） |
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 这两条**不要 Key**
 * ─────────────────────────────────────────────────────────────────────
 * spec 是公开的接口契约（客户要能"先看文档再申请 Key"）。它们不含任何用户数据、不读库、不碰 Redis，
 * 也不经过 `requireOpenApi` —— 与 `/open/v1/**` 的其余 17 条形成对照：
 * **文档公开、调用鉴权**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 为什么 `openapi.json` 会出现在"路由表"里但不在 spec 里
 * ─────────────────────────────────────────────────────────────────────
 * 它自己的 `schema.tags = ['X-HIDDEN']`（`docs/08` §9 的"只有 /open/v1 的业务端点进 spec"）——
 * 文档端点描述自己会产生递归（spec 里有"返回 spec 的端点"），而客户真正要的是**业务契约**。
 * `openapi-regression` 的 A5 因此按 `OPEN_ROUTE_DOCS`（17 条）比对，**不含**这两条文档端点。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 文档站为什么不引 Swagger UI / Scalar
 * ─────────────────────────────────────────────────────────────────────
 * 它们要 CDN（内网部署常常出不去）或一个几十 MB 的包。开放层只需要"能查端点、看字段、复制 curl"，
 * 一个自带样式的单页足够 —— 关键是它**读的就是那份 JSON**：文档与 spec 不可能分叉。
 */

import type { FastifyInstance } from 'fastify'

import { buildOpenV1Spec } from '../openapi/openV1Spec.js'

/** 文档站的 HTML（读 `/open/v1/openapi.json`，纯前端渲染；无外链资源） */
const DOCS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>开放平台 · 智能体 OpenAPI v1</title>
<style>
  :root { --ink:#1b1b1f; --muted:#6b6b76; --line:#e3e3e8; --bg:#fbfbfc; --accent:#7a2e2e; --code:#f3f3f6; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); background:var(--bg); }
  header { padding:28px 32px 18px; border-bottom:1px solid var(--line); background:#fff; }
  h1 { margin:0 0 6px; font-size:20px; letter-spacing:-.01em; }
  header p { margin:0; color:var(--muted); white-space:pre-line; max-width:80ch; }
  main { display:grid; grid-template-columns:260px minmax(0,1fr); gap:0; }
  nav { position:sticky; top:0; align-self:start; max-height:100vh; overflow:auto; padding:18px 14px; border-right:1px solid var(--line); }
  nav a { display:block; padding:4px 8px; color:var(--ink); text-decoration:none; border-radius:6px; font-size:13px; }
  nav a:hover { background:#f0f0f4; }
  nav .m { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; color:var(--accent); margin-right:6px; }
  section { padding:18px 32px 40px; }
  article { border:1px solid var(--line); border-radius:10px; background:#fff; padding:16px 18px; margin:0 0 16px; }
  article h3 { margin:0 0 4px; font-size:15px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .mth { display:inline-block; min-width:52px; font-size:11px; font-weight:700; letter-spacing:.04em; color:#fff; background:var(--accent); border-radius:5px; padding:2px 7px; margin-right:8px; vertical-align:2px; }
  .mth.post { background:#1f5f3f; } .mth.delete { background:#8a2b2b; } .mth.get { background:#1f4a7a; }
  .scope { display:inline-block; font-size:11px; border:1px solid var(--line); border-radius:999px; padding:1px 8px; color:var(--muted); margin-left:8px; }
  .desc { color:var(--muted); white-space:pre-line; margin:8px 0; }
  table { width:100%; border-collapse:collapse; margin:8px 0 0; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-top:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background:var(--code); padding:10px 12px; border-radius:8px; overflow:auto; font-size:12px; }
  .err { color:#8a2b2b; }
  @media (max-width:900px){ main{grid-template-columns:1fr} nav{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line)} }
</style>
</head>
<body>
<header><h1 id="t">正在读取契约…</h1><p id="d"></p></header>
<main><nav id="nav"></nav><section id="body"></section></main>
<script>
(async function () {
  const res = await fetch('openapi.json')
  const spec = await res.json()
  document.getElementById('t').textContent = spec.info.title + ' · ' + spec.info.version
  document.getElementById('d').textContent = spec.info.description || ''
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
  const nav = document.getElementById('nav'); const body = document.getElementById('body')
  const resolve = (schema) => {
    if (!schema || typeof schema !== 'object') return schema
    if (schema.$ref) {
      const path = schema.$ref.replace(/^#\\//, '').split('/')
      let cur = spec
      for (const p of path) cur = cur && cur[p]
      return resolve(cur)
    }
    return schema
  }
  const typeOf = (schema) => {
    const s = resolve(schema) || {}
    if (s.type) return Array.isArray(s.type) ? s.type.join('|') : s.type
    if (s.oneOf) return s.oneOf.map(typeOf).join(' | ')
    return s.enum ? 'enum' : 'object'
  }
  const fields = (schema) => {
    const s = resolve(schema) || {}
    if (!s.properties) return []
    const req = s.required || []
    return Object.entries(s.properties).map(([name, prop]) => ({ name, prop: resolve(prop) || {}, required: req.includes(name) }))
  }
  const table = (rows) => rows.length === 0 ? '' :
    '<table><thead><tr><th>字段</th><th>类型</th><th>必填</th><th>说明</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td><code>' + esc(r.name) + '</code></td><td>' + esc(typeOf(r.prop)) + (r.prop.enum ? ' = ' + esc(r.prop.enum.join(' / ')) : '') + '</td><td>' + (r.required ? '是' : '') + '</td><td>' + esc(r.prop.description || '') + '</td></tr>').join('') +
    '</tbody></table>'
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const a = document.createElement('a'); a.href = '#' + method + path.replace(/[^a-z0-9]/gi, '-')
      a.innerHTML = '<span class="m">' + method.toUpperCase() + '</span>' + esc(path)
      nav.appendChild(a)
      const art = document.createElement('article')
      art.id = method + path.replace(/[^a-z0-9]/gi, '-')
      const scope = op['x-open-scope'] ? '<span class="scope">scope: ' + esc(op['x-open-scope']) + '</span>' : '<span class="scope">仅需有效 Key</span>'
      let html = '<h3><span class="mth ' + method + '">' + method.toUpperCase() + '</span>' + esc(path) + scope + '</h3>'
      html += '<p class="desc">' + esc(op.description || op.summary || '') + '</p>'
      const params = op.parameters || []
      if (params.length) html += '<h4>参数</h4>' + table(params.map((p) => ({ name: p.name + ' (' + p.in + ')', prop: p.schema || {}, required: p.required })))
      const rb = op.requestBody && op.requestBody.content
      if (rb) {
        const ct = Object.keys(rb)[0]
        html += '<h4>请求体 · ' + esc(ct) + '</h4>' + table(fields(rb[ct].schema))
      }
      const ok = op.responses && (op.responses['200'] || op.responses['201'])
      if (ok && ok.content && ok.content['application/json']) {
        const env = resolve(ok.content['application/json'].schema) || {}
        const data = resolve((env.properties || {}).data)
        const rows = fields(data)
        if (rows.length) html += '<h4>成功响应 data</h4>' + table(rows)
      } else if (ok) {
        html += '<h4>响应</h4><p class="desc">' + esc(ok.description || '') + '</p>'
      }
      const errs = Object.entries(op.responses || {}).filter(([code]) => code !== '200' && code !== '201')
      if (errs.length) html += '<h4>错误</h4><table><tbody>' + errs.map(([code, r]) => '<tr><td><code class="err">' + code + '</code></td><td>' + esc(r.description || '') + '</td></tr>').join('') + '</tbody></table>'
      const example = 'curl -sS -H "Authorization: Bearer $OPEN_API_KEY" \\\\\\n  "' + location.origin + path.replace(/\\{[^}]+\\}/g, '{id}') + '"'
      html += '<h4>示例</h4><pre>' + esc(example) + '</pre>'
      art.innerHTML = html
      body.appendChild(art)
    }
  }
})().catch((e) => { document.getElementById('t').textContent = '读取契约失败'; document.getElementById('d').textContent = String(e) })
</script>
</body>
</html>`

export function registerOpenApiDocRoutes(app: FastifyInstance): void {
  /**
   * 返回 `buildOpenV1Spec()` 的结果（**手写契约源**，见 `src/openapi/openV1Spec.ts` 文件头 ①：
   * 本仓校验器是 zod，`@fastify/swagger` 扫不进去，所以契约束在一张表上）。
   *
   * ★ 为什么不是"从真实路由表生成"：那需要 `@fastify/swagger` 能读懂 zod schema —— 它读不懂，
   * 而"能读懂"的那条路（zod → JSON Schema 库）会让契约多一条链路且那条链路本身又需要维护
   * 一套字段映射。**反向的护栏**放在 `openapi-regression` 的 A5：spec 的路径集合必须与
   * Fastify 真实注册的 17 条**逐条一致** —— 于是"写了接口没写文档"和"写了文档没实现"
   * 两侧都会被抓到，一次也不用信"生成器"。
   */
  app.get('/open/v1/openapi.json', async (_request, reply) => {
    void reply.header('cache-control', 'no-cache')
    return buildOpenV1Spec()
  })

  app.get('/open/v1/docs', async (_request, reply) => {
    void reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache')
    return DOCS_HTML
  })
}
