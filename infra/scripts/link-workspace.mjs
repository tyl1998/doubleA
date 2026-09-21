#!/usr/bin/env node
/**
 * 补齐 workspace 包链接（postinstall 自动执行）
 *
 * ── 为什么需要这个脚本 ──────────────────────────────────────────────
 * 本机 pnpm 12.4.2 在 Windows 上创建**目录符号链接**会静默失败：
 *   - Windows 的 symlink 需「开发者模式」（或管理员权限）；
 *   - 条件不满足时，`fs.symlinkSync(target, path, 'dir')` **不抛错**，
 *     而是留下一个 **0 项的空目录**；
 *   - pnpm 对此不告警，install 报「成功」，直到构建时才暴露
 *     `Cannot find module '.../node_modules/@doubulea/shared'`。
 *
 * 实测证据：
 *   fs.symlinkSync('shared', '.t', 'junction') → 正常，可读到 4 项
 *   fs.symlinkSync('shared', '.t', 'dir')      → 得到 0 项空目录（无报错）
 *
 * ── 本脚本做什么 ───────────────────────────────────────────────────
 * 把 `backend/node_modules/@doubulea/shared`、`frontend/node_modules/@doubulea/shared`
 * 这些**空目录**替换成 **junction**（junction 不需要开发者模式，可指向目录）。
 *
 * ── 何时不再需要 ───────────────────────────────────────────────────
 * 若 CI/其他机器上 pnpm 的符号链接正常（Linux，或已开启开发者模式的 Windows），
 * 本脚本会因为链接已有效而直接跳过，无副作用。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件位于 <repoRoot>/infra/scripts/，故上溯两级即仓库根
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 需要建立链接的 [消费方包目录, 被依赖包目录] */
const LINKS = [
  ['backend', 'shared'],
  ['frontend', 'shared'],
]

const readPkgName = (pkgDir) => JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name

/** 判断路径是否为「可用的」链接或目录（空目录视为 pnpm 静默失败的残留） */
function isUsable(path) {
  try {
    const st = lstatSync(path)
    if (st.isDirectory()) return readdirSync(path).length > 0
    return true
  } catch {
    return false
  }
}

let fixed = 0
let skipped = 0

for (const [consumer, targetRel] of LINKS) {
  const consumerDir = join(repoRoot, consumer)
  const targetDir = join(repoRoot, targetRel)

  if (!existsSync(join(consumerDir, 'package.json')) || !existsSync(join(targetDir, 'package.json'))) {
    console.warn(`[link-workspace] 跳过 ${consumer} -> ${targetRel}（package.json 不存在）`)
    continue
  }

  const targetName = readPkgName(targetDir) // 例：@doubulea/shared
  const slash = targetName.indexOf('/')
  if (slash === -1) {
    console.warn(`[link-workspace] 跳过 ${targetName}（非 scope 包名，本脚本只处理 @scope/name 形态）`)
    continue
  }
  const scope = targetName.slice(0, slash) // @doubulea
  const shortName = targetName.slice(slash + 1) // shared

  const linkPath = join(consumerDir, 'node_modules', scope, shortName)

  if (isUsable(linkPath)) {
    skipped++
    continue
  }

  // 清掉空目录/失效链接后重建为 junction（junction 无需开发者模式）
  rmSync(linkPath, { recursive: true, force: true })
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(targetDir, linkPath, 'junction')
  fixed++
  console.log(`  [link] ${consumer}/node_modules/${scope}/${shortName} -> ${targetRel}`)
}

console.log(`[link-workspace] 完成：修复 ${fixed} 个，跳过 ${skipped} 个有效链接`)
