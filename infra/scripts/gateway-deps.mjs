#!/usr/bin/env node
/**
 * gateway-deps.mjs —— 打印**路由网关的运行期依赖闭包**（`infra/gateway/Dockerfile` 的 COPY 清单来源）
 *
 * 跑法：`node infra/scripts/gateway-deps.mjs`
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 网关镜像只装 fastify / ioredis / zod（`backend/src/router/*` 的外部 import 就这几个），
 * 但它依赖的包**存在嵌套**：`fastify/node_modules/find-my-way`、`ajv/node_modules/fast-uri`、
 * `light-my-request/node_modules/cookie`、`thread-stream/node_modules/real-require` …
 * 只拷顶层包会漏掉这些，症状是**运行期** `Cannot find module 'ret'`（构建期一条错都没有）。
 *
 * ⇒ 本脚本按 Node 的解析规则（从包目录逐层向上找 `node_modules/<name>`）算出完整闭包，
 *    `infra/gateway/Dockerfile` 里的 COPY 行必须与它的输出一致。
 *
 * ⚠️ 升级 fastify / ioredis / zod 之后重跑本脚本，按输出更新 Dockerfile（缺的包会在容器启动时报错）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ROOTS = ['fastify', 'ioredis', 'zod']

/** 从 `fromDir` 逐层向上找 `node_modules/<name>`（Node 的解析顺序） */
function resolveFrom(name, fromDir) {
  let cursor = fromDir
  for (;;) {
    const candidate = join(cursor, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(cursor)
    if (parent === cursor) return undefined
    cursor = parent
  }
}

const seen = new Map()
function walk(name, fromDir) {
  const directory = resolveFrom(name, fromDir)
  if (directory === undefined) {
    console.error(`[gateway-deps] 缺依赖：${name}（从 ${fromDir} 向上找不到）—— 先 pnpm install`)
    process.exit(1)
  }
  if (seen.has(directory)) return
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  seen.set(directory, pkg.name ?? name)
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, directory)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) walk(dep, directory)
}

for (const root of ROOTS) walk(root, REPO_ROOT)

const entries = [...seen.keys()].map((path) => path.slice(REPO_ROOT.length + 1)).sort()
console.log(`# ${entries.length} 个目录（含嵌套 node_modules）`)
for (const entry of entries) console.log(`COPY --from=build --chown=doubulea:doubulea /app/${entry} ./${entry}`)
