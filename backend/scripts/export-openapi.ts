#!/usr/bin/env node
/**
 * export-openapi.ts —— 把契约表导出成入库的 `openapi/open-v1.json`（**P1-22 · B4**；`docs/08` §9）
 *
 * 跑法：`pnpm --filter @doubulea/backend openapi:export`（或根目录 `pnpm openapi:export`）
 * 产出：`openapi/open-v1.json`（**入库**，review 时能看 diff；`GET /open/v1/docs` 读的就是同源数据）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它**不连库、不建 Fastify 实例**（因此也不需要 env）
 * ─────────────────────────────────────────────────────────────────────
 * 契约源是 `src/openapi/openV1Spec.ts` 的 `OPEN_ROUTE_DOCS`（纯数据 + 纯函数），导出就是
 * "序列化成 JSON"。这带来一个有用的性质：**CI 里导出永远成功**，不会因为某个环境变量缺失而
 * 让"文档检查"变成一次假绿或假红。
 *
 * 与真实路由表的一致性**不在这里保证**，而在 `openapi-regression.ts` 的 A5（它真的 `buildApp()`
 * 并把 `printRoutes()` 的 17 条与 spec 逐条比对）—— 生成与校验刻意分开：
 * 生成要能在没有依赖的环境里跑，校验要碰真东西。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildOpenV1Spec } from '../src/openapi/openV1Spec.js'

/** 仓库根（脚本在 `backend/scripts/` 下；spec 落在根 `openapi/`） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUTPUT = resolve(ROOT, 'openapi/open-v1.json')

const spec = buildOpenV1Spec()
const paths = (spec as { paths?: Record<string, unknown> }).paths ?? {}

mkdirSync(dirname(OUTPUT), { recursive: true })
// 两空格缩进 + 尾随换行：与仓库其它 JSON 事实源一致，diff 可读
writeFileSync(OUTPUT, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
console.log(`已导出 ${Object.keys(paths).length} 条路径 → ${OUTPUT}`)
