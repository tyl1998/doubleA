#!/usr/bin/env node
/**
 * infra.mjs —— infra 启停的**跨平台入口**
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 启停逻辑有两份实现，各自贴合本机：
 *   Windows → dev-up.ps1 / dev-down.ps1（原生 PowerShell，见各文件头注）
 *   macOS / Linux → dev-up.sh / dev-down.sh（bash）
 * 本脚本只做「选哪个 + 透传参数 + 透传退出码」，不含任何业务逻辑，
 * 这样 `pnpm infra:up` / `pnpm infra:down` 在任何平台都成立。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   pnpm infra:up                     等价于 dev-up
 *   pnpm infra:down                   等价于 dev-down
 *   pnpm infra:down -- --purge        参数原样透传（删数据卷，慎用）
 *
 * 需要直接调脚本时，用平台对应的那个即可，不必经过本文件。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const isWindows = process.platform === 'win32'

const action = process.argv[2]
if (action !== 'up' && action !== 'down') {
  console.error('用法: node infra/scripts/infra.mjs <up|down> [-- <透传给脚本的参数>]')
  process.exit(2)
}

// process.argv 形如: [node, infra.mjs, up, --, --purge] —— 去掉 node/脚本名/动作，
// 再丢掉 npm 传入的分隔符 `--`
const passthrough = process.argv.slice(3).filter((a) => a !== '--')

let cmd
let args

if (isWindows) {
  cmd = 'powershell'
  args = ['-ExecutionPolicy', 'Bypass', '-File', join(scriptDir, `dev-${action}.ps1`)]
} else {
  cmd = 'bash'
  args = [join(scriptDir, `dev-${action}.sh`)]
}

const target = args[args.length - 1]
if (!existsSync(target)) {
  console.error(`[infra] 找不到脚本：${target}`)
  process.exit(2)
}

console.log(`[infra] ${isWindows ? 'Windows' : process.platform} → ${cmd} ${target}\n`)

const r = spawnSync(cmd, [...args, ...passthrough], { stdio: 'inherit' })

if (r.error) {
  console.error(`[infra] 启动失败：${r.error.message}`)
  process.exit(1)
}
process.exit(r.status ?? 1)
