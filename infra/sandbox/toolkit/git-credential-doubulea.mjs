#!/usr/bin/env node
/**
 * git credential helper（P1-9 · R11 修订）—— 按需向平台换取 HTTPS 凭据
 *
 * ─────────────────────────────────────────────────────────────────────
 * git 怎么用它（标准 git-credential 协议）
 * ─────────────────────────────────────────────────────────────────────
 *   ① 容器 env 里 `credential.helper=/opt/sandbox-git/git-credential-doubulea.mjs`（`gitCredentialHelperEnv`）；
 *   ② git 需要认证时执行 `… <this> get`，把 `protocol=…` / `host=…`（可能还有 `path` / `url`）写在 **stdin**；
 *   ③ 本脚本 POST 到 `{SANDBOX_BACKEND_URL}/api/sandbox/git/credential`（头 `x-sandbox-token`）；
 *   ④ 拿到 `{kind:'https', username, password}` 就把 `username=…\npassword=…` 写到 **stdout**。
 * `store` / `erase` 什么都不做（凭据不在容器里，没得存也没得擦）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条纪律
 * ─────────────────────────────────────────────────────────────────────
 *   ① **失败不吐凭据、不报错**（退出 0）：git 因此走自己的失败路径；绝不打印半截凭据。
 *      ⚠️ 唯一例外是"**没有匹配的凭据**"（后端 404）—— 这时往 **stderr** 打一句**不含密钥**的提示
 *      （建议改用 SSH 或去平台配置 token），让 agent / 用户看得到"为什么拉不动"，而不是一个笼统的
 *      认证失败。stderr 不是凭据通道，打印它不违反"不吐凭据"；
 *   ② **不落盘**：token 只在本进程内存里过一下，容器回收即无痕；
 *   ③ 依赖 **node 自带的 `fetch`**（base 镜像 = node，无需 curl —— 镜像刻意不装 curl）。
 *
 * ⚠️ 跨边界契约：路径 / 头名 / 回包形状与后端 `backend/src/sandbox/gitProxy.ts` 逐字对应。
 */

const BACKEND_URL_ENV = 'SANDBOX_BACKEND_URL'
const TOKEN_ENV = 'SANDBOX_TOKEN'
const TIMEOUT_ENV = 'SANDBOX_PROXY_TIMEOUT_MS'
const HEADER = 'x-sandbox-token'
const PATH = '/api/sandbox/git/credential'

const action = process.argv[2] ?? ''
if (action !== 'get') process.exit(0)

const base = process.env[BACKEND_URL_ENV]
const token = process.env[TOKEN_ENV]
if (!base || !token) process.exit(0)

/** 读 stdin（git 的凭据请求；一段 `key=value` 行） */
function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

/** `protocol=https\nhost=github.com\n` → `{protocol, host}` */
function parseFields(text) {
  const fields = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return fields
}

async function main() {
  const input = await readStdin()
  const fields = parseFields(input)
  const protocol = (fields.protocol ?? '').toLowerCase()
  const host = fields.host ?? ''
  if (protocol !== 'https' && protocol !== 'http') process.exit(0)

  const timeoutMs = Number(process.env[TIMEOUT_ENV] ?? '180000')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let body
  try {
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER]: token },
      body: JSON.stringify({ protocol: 'https', host }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // 404 = 平台里没有匹配这条 (https, host) 的凭据。**只提示、不吐凭据**：git 仍走自己的失败路径。
      // 为什么必须提示：否则 agent 只看到笼统的 "Authentication failed"，不知道是该配 token 还是换 SSH。
      if (res.status === 404) {
        process.stderr.write(
          `[doubulea] 没有为 ${host} 配置 HTTPS 凭据：请在平台「设置 → Git 凭据」配置 HTTPS token，` +
            `或改用 SSH（git@${host}:...，推荐）。\n`,
        )
      }
      process.exit(0) // 401/403/… ⇒ 安静退出，让 git 走自己的失败路径
    }
    body = await res.json()
  } catch {
    process.exit(0)
  } finally {
    clearTimeout(timer)
  }

  if (body && body.kind === 'https' && typeof body.username === 'string' && typeof body.password === 'string') {
    process.stdout.write(`username=${body.username}\npassword=${body.password}\n`)
  }
  process.exit(0)
}

void main()
