#!/usr/bin/env node
/**
 * workspace-regression.ts —— Code 模式工作区（P1-9 · P0）的**无 DB / 无 Docker** 自证
 *
 * 跑法：`pnpm --filter @doubulea/backend workspace:regression`
 *      （= `node --import tsx scripts/workspace-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/06` §六 第 8/9 条；被测对象 = `shared/src/workspace.ts`（路径/MIME/撤销折叠/变更集）
 *      + `backend/src/workspace/paths.ts`（归一化 + realpath 包含性）
 *      + `backend/src/workspace/{reapModel,coldModel,quotaModel}.ts`（保留期 / 冷备键 / 硬化判据，均纯函数）。
 *
 * ⚠️ 它验的是**纯判据 + 只读 FS 探测**（临时目录）：路径逃逸、MIME/可编辑判定、事件取值域、
 *    变更集折叠、撤销计划、冷备键/恢复计划、保留期、以及 P6 · R6 的二进制嗅探 / 配额 / 限流判据。
 *    它**验不了**端到端（要 PG + 真容器）：写 CAS 冲突、watcher 事件上屏、bind mount 生效
 *    —— 那些按 §六 第 30 条留给用户真跑。
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  AppError,
  WORKSPACE_CONTENT_EVENT_TYPES,
  foldWorkspaceEvents,
  isWorkspaceTextMime,
  normalizeWorkspacePath,
  planWorkspaceRevert,
  workspaceMimeOf,
} from '@doubulea/shared'

import { resolveWorkspacePath } from '../src/workspace/paths.js'
import { parseGitDirFile, parseGitHead, scanGitReposUnder } from '../src/workspace/git.js'
import { writeWorkspaceBytes } from '../src/workspace/store.js'
import { applyWorkspaceEdit, applyWorkspaceEdits } from '../src/workspace/edit.js'
import { workspaceEditSteerMessage } from '../src/workspace/steerMessage.js'
import { serializeWorkspaceSseEvent } from '../src/workspace/sse.js'
import {
  planWorkspaceRestore,
  workspaceColdKey,
  workspaceColdPrefix,
  WORKSPACE_COLD_ROOT,
} from '../src/workspace/coldModel.js'
import { previewHeadersFor, workspaceRawHeadersFor } from '../src/services/previewHeaders.js'
import { ARTIFACT_EXCLUDED_DIRS, artifactChangePaths, filterArtifactPaths } from '../src/sandbox/artifactChanges.js'
import { filterGitCleanPaths, parsePorcelainPaths } from '../src/sandbox/gitArtifacts.js'
import { isWorkspaceExpired, workspaceRetentionCutoff } from '../src/workspace/reapModel.js'
import {
  lineDiffWorkspace,
  splitWorkspaceDiffLines,
  WORKSPACE_DIFF_CONTEXT_LINES,
} from '../src/workspace/diff.js'
import {
  decideWorkspaceQuota,
  isWorkspaceWriteRateExceeded,
  looksBinaryWorkspaceContent,
  workspaceWriteRateWindowStart,
  WORKSPACE_BINARY_SAMPLE_BYTES,
  WORKSPACE_WRITE_RATE_WINDOW_MS,
} from '../src/workspace/quotaModel.js'
import { isWorkspacePathInDir, selectWorkspaceDirPaths, workspaceDirPrefix } from '../src/workspace/dirModel.js'

let passed = 0
let failed = 0
function it(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  [PASS] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

// ───────────────────────────── A 路径归一化 ─────────────────────────────

console.log('── A 路径归一化（shared#normalizeWorkspacePath）──')
it('A1 常规相对路径原样（分隔符折叠 / 空段 / `.` 段去掉）', () => {
  eq(normalizeWorkspacePath('a/b.txt'), 'a/b.txt', 'a/b')
  eq(normalizeWorkspacePath('a//b'), 'a/b', '双斜杠')
  eq(normalizeWorkspacePath('./a/./b'), 'a/b', '. 段')
  eq(normalizeWorkspacePath('a\\b\\c'), 'a/b/c', '反斜杠')
  eq(normalizeWorkspacePath('  out/report.csv  '), 'out/report.csv', 'trim')
})
it('A2 非法路径一律 null（绝对 / `..` / 空 / NUL / 超长）', () => {
  eq(normalizeWorkspacePath('/etc/passwd'), null, '绝对路径')
  eq(normalizeWorkspacePath('../x'), null, '前导 ..')
  eq(normalizeWorkspacePath('a/../../x'), null, '内嵌 ..')
  eq(normalizeWorkspacePath('a/b/..'), null, '尾部 ..')
  eq(normalizeWorkspacePath(''), null, '空串')
  eq(normalizeWorkspacePath('   '), null, '纯空白')
  eq(normalizeWorkspacePath('.'), null, '仅 .')
  eq(normalizeWorkspacePath('a\u0000b'), null, 'NUL')
  eq(normalizeWorkspacePath('a'.repeat(1025)), null, '超长')
  eq(normalizeWorkspacePath(123), null, '非字符串')
})

// ───────────────────────────── B 包含性（realpath） ─────────────────────────────

console.log('── B 路径包含性（paths#resolveWorkspacePath）──')
const root = await mkdtemp(join(tmpdir(), 'ws-reg-'))
try {
  await mkdir(join(root, 'out'), { recursive: true })
  await writeFile(join(root, 'out', 'report.csv'), 'a,b\n')
  // 造一个逃逸用的符号链接：root/escape -> 系统临时根（root 的父级）
  await symlink(tmpdir(), join(root, 'escape'))

  it('B1 根内文件解析成"在根内"的绝对路径', () => {
    const r = resolveWorkspacePath(root, 'out/report.csv')
    eq(r.relative, 'out/report.csv', '相对路径')
    assert(r.absolute.startsWith(root + sep), `应落在根内：${r.absolute}`)
  })
  it('B2 非法相对路径抛 VALIDATION', () => {
    let code = ''
    try {
      resolveWorkspacePath(root, '../escape/whatever')
    } catch (error) {
      code = error instanceof AppError ? error.code : 'not-app-error'
    }
    eq(code, 'VALIDATION', '错误码')
  })
  it('★ B3 符号链接逃逸抛 FORBIDDEN（只有 realpath 判据能拦住）', () => {
    let code = ''
    try {
      resolveWorkspacePath(root, 'escape/passwd.md')
    } catch (error) {
      code = error instanceof AppError ? error.code : 'not-app-error'
    }
    eq(code, 'FORBIDDEN', '错误码')
  })
  it('B4 尚不存在的根内新文件也放行（取最深存在祖先判定）', () => {
    const r = resolveWorkspacePath(root, 'out/new/deep.txt')
    eq(r.relative, 'out/new/deep.txt', '相对路径')
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

// ───────────────────────────── C MIME / 可编辑判定 ─────────────────────────────

console.log('── C MIME / 可编辑判定（shared#workspaceMimeOf / isWorkspaceTextMime）──')
it('C1 代码扩展名认得出', () => {
  eq(workspaceMimeOf('src/app.ts'), 'text/typescript', 'ts')
  eq(workspaceMimeOf('main.go'), 'text/x-go', 'go')
  eq(workspaceMimeOf('a/b.json'), 'application/json', 'json')
  eq(workspaceMimeOf('logo.png'), 'image/png', 'png')
  eq(workspaceMimeOf('noext'), 'application/octet-stream', '无扩展')
})
it('C2 文本可编辑判据（text/* 与显式白名单）', () => {
  eq(isWorkspaceTextMime('text/plain; charset=utf-8'), true, 'text/plain 带参数')
  eq(isWorkspaceTextMime('application/json'), true, 'json')
  eq(isWorkspaceTextMime('text/typescript'), true, 'ts')
  eq(isWorkspaceTextMime('image/png'), false, 'png 不可编辑')
  eq(isWorkspaceTextMime('application/octet-stream'), false, 'octet 不可编辑')
  eq(isWorkspaceTextMime(null), false, 'null')
})

// ───────────────────────────── D 事件取值域 ─────────────────────────────

console.log('── D 事件取值域 ──')
it('D1 内容事件不含 claim/release（它们不改字节）', () => {
  eq([...WORKSPACE_CONTENT_EVENT_TYPES], ['created', 'updated', 'deleted', 'renamed'], '内容事件集合')
})

// ───────────────────────────── E 字节出口响应头分派 ─────────────────────────────

console.log('── E 响应头分派（services#previewHeadersFor / workspaceRawHeadersFor）──')
it('E1 HTML/SVG 走 inline + CSP sandbox；text 一律 text/plain', () => {
  const html = previewHeadersFor('text/html')
  eq(html.contentType, 'text/html; charset=utf-8', 'html content-type')
  eq(html.disposition, 'inline', 'html disposition')
  assert(html.csp !== null && html.csp.includes('sandbox'), 'HTML 必须带 CSP sandbox')
  const text = previewHeadersFor('text/plain')
  eq(text.contentType, 'text/plain; charset=utf-8', 'text')
  const pdf = previewHeadersFor('application/pdf')
  eq(pdf.csp, null, 'PDF 刻意不加 CSP（加了渲染不出来）')
})
it('★ E2 工作区字节出口：代码类当文本 inline（previewKindOf 认不出的也要能看源码）', () => {
  const ts = workspaceRawHeadersFor('text/typescript', true)
  eq(ts.contentType, 'text/plain; charset=utf-8', 'ts → text/plain')
  eq(ts.disposition, 'inline', 'ts inline')
  const png = workspaceRawHeadersFor('image/png', false)
  eq(png.disposition, 'inline', 'png inline（图片）')
  const zip = workspaceRawHeadersFor('application/zip', false)
  eq(zip.disposition, 'attachment', '未知类型 → attachment')
})

// ───────────────────────────── F 局部编辑（applyWorkspaceEdit） ─────────────────────────────

console.log('── F 局部编辑（workspace#applyWorkspaceEdit）──')
it('F1 唯一匹配替换；找不到 / 多处匹配拒绝', () => {
  eq(applyWorkspaceEdit('hello world', 'world', 'there'), { ok: true, text: 'hello there' }, '唯一替换')
  eq(applyWorkspaceEdit('abc', 'zzz', 'y').ok, false, '找不到 ⇒ 拒绝')
  eq(applyWorkspaceEdit('a a', 'a', 'b').ok, false, '多处匹配 ⇒ 拒绝（默认）')
  eq(applyWorkspaceEdit('a a', 'a', 'b', true), { ok: true, text: 'b b' }, 'replaceAll=true ⇒ 全量替换')
})
it('F2 空 old / 相同 new 拒绝', () => {
  eq(applyWorkspaceEdit('abc', '', 'x').ok, false, '空 oldString')
  eq(applyWorkspaceEdit('abc', 'a', 'a').ok, false, '新旧相同')
})
it('F3 原子多改（applyWorkspaceEdits，R8 对齐 pin 0.87.1 的 edits[]）', () => {
  eq(
    applyWorkspaceEdits('hello world', [{ oldText: 'hello', newText: 'HI' }, { oldText: 'world', newText: 'there' }]),
    { ok: true, text: 'HI there' },
    '两处互不重叠 ⇒ 一次替换',
  )
  eq(
    applyWorkspaceEdits('aaa', [{ oldText: 'a', newText: 'b' }]).ok,
    false,
    '单处 oldText 在文件里出现多次 ⇒ 拒绝',
  )
  eq(
    applyWorkspaceEdits('abc', [{ oldText: 'zzz', newText: 'q' }]).ok,
    false,
    '找不到 ⇒ 拒绝',
  )
  eq(
    applyWorkspaceEdits('abcd', [{ oldText: 'abc', newText: 'x' }, { oldText: 'bc', newText: 'y' }]).ok,
    false,
    '两处区域重叠 ⇒ 整次拒绝（不半改）',
  )
  eq(applyWorkspaceEdits('abc', []).ok, false, '空 edits[] ⇒ 拒绝')
  eq(
    applyWorkspaceEdits('abc', [{ oldText: 'a', newText: 'a' }]).ok,
    false,
    '新旧相同 ⇒ 拒绝',
  )
})

// ───────────────────────────── G SSE 帧序列化 ─────────────────────────────

console.log('── G SSE 帧序列化（workspace#serializeWorkspaceSseEvent）──')
it('G1 帧格式正确（event + 单行 data + 结尾空行）', () => {
  const frame = serializeWorkspaceSseEvent({ id: 'e1', type: 'updated', path: 'a.txt', version: 2 })
  assert(frame.startsWith('event: workspace\ndata: '), 'event 行')
  assert(frame.endsWith('\n\n'), '结尾帧分隔符')
  // data 正文必须是单行（SSE 硬要求）
  const dataLine = frame.split('\n')[1] ?? ''
  assert(dataLine.startsWith('data: '), 'data 行')
  eq(dataLine.includes('\n'), false, 'data 单行')
  eq(JSON.parse(dataLine.slice('data: '.length)).type, 'updated', 'payload 可解析')
})

// ───────────────────────────── H 变更集折叠（foldWorkspaceEvents） ─────────────────────────────

console.log('── H 变更集折叠（shared#foldWorkspaceEvents）──')
const ev = (path, type, at, version = 1) => ({
  id: `e-${path}-${at}`,
  type,
  path,
  version,
  actor: 'AGENT',
  actorId: 'a1',
  at,
})
it('H1 同路径多次事件只留最后一条（后写者胜），结果按时间倒序', () => {
  const folded = foldWorkspaceEvents([
    ev('a.txt', 'created', '2026-10-12T00:00:00.000Z', 1),
    ev('b.txt', 'created', '2026-10-12T00:00:01.000Z', 1),
    ev('a.txt', 'updated', '2026-10-12T00:00:02.000Z', 2),
  ])
  eq(folded.length, 2, '去重后条数')
  eq(folded[0].path, 'a.txt', '最近的在前')
  eq(folded[0].type, 'updated', 'a.txt 留最后一条')
  eq(folded[1].path, 'b.txt', '其余在后')
})
it('H2 同 at 时后出现者胜（不做预排序也正确）', () => {
  const at = '2026-10-12T00:00:00.000Z'
  const folded = foldWorkspaceEvents([ev('x', 'created', at, 1), ev('x', 'deleted', at, 1)])
  eq(folded[0].type, 'deleted', '同 at 后写者胜')
})

// ───────────────────────────── I 主动感知插话文案（P1-9 · P4 · R1） ─────────────────────────────

console.log('── I 主动感知插话文案（workspace#workspaceEditSteerMessage）──')
/** 造一个工作区事件（`actor` / `type` / `version` 都可控） */
const ev2 = (path, type, actor, version) => ({
  id: `e-${path}`,
  type,
  path,
  version,
  actor,
  actorId: 'u1',
  at: '2026-10-12T00:00:00.000Z',
})
it('I1 USER 的内容事件 → 按类型给文案（含版本号 / "重新读取"）', () => {
  const updated = workspaceEditSteerMessage(ev2('a.md', 'updated', 'USER', 7))
  assert(
    updated !== null && updated.includes('a.md') && updated.includes('v7') && updated.includes('重新读取'),
    `updated 文案应含路径 / 版本 / "重新读取"：${String(updated)}`,
  )
  const created = workspaceEditSteerMessage(ev2('b.txt', 'created', 'USER', 1))
  assert(created !== null && created.includes('新建') && created.includes('b.txt'), `created 文案：${String(created)}`)
  const deleted = workspaceEditSteerMessage(ev2('c.txt', 'deleted', 'USER', 2))
  assert(deleted !== null && deleted.includes('删除') && deleted.includes('c.txt'), `deleted 文案：${String(deleted)}`)
})
it('I2 非 USER 或不改字节的事件一律不回喂（返回 null）', () => {
  eq(workspaceEditSteerMessage(ev2('a.md', 'updated', 'AGENT', 3)), null, 'AGENT 自己写的不回喂')
  eq(workspaceEditSteerMessage(ev2('a.md', 'updated', 'SYSTEM', 3)), null, 'SYSTEM（bash 兜底）不回喂')
  eq(workspaceEditSteerMessage(ev2('a.md', 'claim', 'USER', 3)), null, 'claim 不回喂（不改字节）')
  eq(workspaceEditSteerMessage(ev2('a.md', 'release', 'USER', 3)), null, 'release 不回喂（不改字节）')
})
it('I3 version 为 null 时省略括注，不编造版本号', () => {
  const message = workspaceEditSteerMessage(ev2('d.txt', 'updated', 'USER', null))
  assert(message !== null && !message.includes('（v') && message.includes('d.txt'), `应省略版本括注：${String(message)}`)
})

// ───────────────────────────── J 撤销本轮计划（planWorkspaceRevert，P1-9 · P4 · R2） ─────────────────────────────

console.log('── J 撤销本轮计划（shared#planWorkspaceRevert）──')
const evAt = (path, type, at, version = 1) => ({
  id: `r-${path}-${at}`,
  type,
  path,
  version,
  actor: 'AGENT',
  actorId: 'a1',
  at,
})
it('J1 本轮内两次更新：beforeVersion = 首次 -1，expect = 末次版本', () => {
  const plan = planWorkspaceRevert([
    evAt('a.txt', 'updated', '2026-10-12T00:00:01.000Z', 6),
    evAt('a.txt', 'updated', '2026-10-12T00:00:02.000Z', 7),
  ])
  eq(plan.length, 1, '每路径一条')
  eq(plan[0].beforeVersion, 5, '轮初版本')
  eq(plan[0].expect, { deleted: false, version: 7 }, '轮末应处于 v7')
})
it('J2 本轮新建：beforeVersion = null（撤销 = 删除）', () => {
  const plan = planWorkspaceRevert([evAt('b.txt', 'created', '2026-10-12T00:00:01.000Z', 1)])
  eq(plan[0].beforeVersion, null, '轮初不存在')
  eq(plan[0].expect, { deleted: false, version: 1 }, '轮末 v1')
})
it('J3 本轮删除：beforeVersion = 被删前版本，expect = 已删', () => {
  const plan = planWorkspaceRevert([evAt('c.txt', 'deleted', '2026-10-12T00:00:01.000Z', 5)])
  eq(plan[0].beforeVersion, 5, '被删前版本')
  eq(plan[0].expect, { deleted: true }, '轮末应已删')
})
it('J4 更新后删除：beforeVersion = 首次 -1，expect = 已删', () => {
  const plan = planWorkspaceRevert([
    evAt('d.txt', 'updated', '2026-10-12T00:00:01.000Z', 4),
    evAt('d.txt', 'deleted', '2026-10-12T00:00:02.000Z', 4),
  ])
  eq(plan[0].beforeVersion, 3, '轮初版本')
  eq(plan[0].expect, { deleted: true }, '轮末已删')
})
it('J5 改名/移动 → unsupported（旧路径不明，不贸然撤）', () => {
  const plan = planWorkspaceRevert([evAt('new.ts', 'renamed', '2026-10-12T00:00:01.000Z', 2)])
  eq(plan[0].unsupported !== undefined, true, '应标 unsupported')
})
it('J6 claim/release 不进计划（不改字节）', () => {
  const plan = planWorkspaceRevert([
    evAt('e.txt', 'claim', '2026-10-12T00:00:01.000Z', null),
    evAt('e.txt', 'release', '2026-10-12T00:00:02.000Z', null),
  ])
  eq(plan.length, 0, '无内容事件')
})

// ───────────────────────────── K S3 冷备键与恢复计划（P1-9 · P5 · R3） ─────────────────────────────

console.log('── K S3 冷备键与恢复计划（workspace/coldModel）──')
it('K1 冷备键内容寻址且按会话隔离（前缀带尾斜杠，防跨会话误删）', () => {
  eq(WORKSPACE_COLD_ROOT, 'workspaces', '冷备根名')
  eq(workspaceColdKey('c1', 'abc123'), 'workspaces/c1/blobs/abc123', '键 = 根/会话/blobs/hash')
  eq(workspaceColdPrefix('c1'), 'workspaces/c1/blobs/', '前缀带尾斜杠')
  assert(workspaceColdPrefix('ws-1') !== workspaceColdPrefix('ws-10'), 'ws-1 与 ws-10 前缀必须不同（防前缀误匹配）')
})
it('K2 恢复计划取每路径最新内容（= 行 contentHash），按路径升序', () => {
  const plan = planWorkspaceRestore([
    { path: 'b.txt', contentHash: 'h2', mime: 'text/plain', size: 20n },
    { path: 'a.txt', contentHash: 'h1', mime: 'text/plain', size: 10 },
  ])
  eq(plan.items.map((item) => item.path), ['a.txt', 'b.txt'], '按路径升序')
  eq(plan.items[0].hash, 'h1', '取行的 contentHash（最新版本）')
  eq(plan.items[1].size, 20, 'bigint → number')
  eq(plan.skipped.length, 0, '无跳过')
})
it('K3 无 contentHash 的行进 skipped（如实告知，不猜）', () => {
  const plan = planWorkspaceRestore([
    { path: 'ok.txt', contentHash: 'h' },
    { path: 'bad.txt', contentHash: '   ' },
  ])
  eq(plan.items.length, 1, '只保留有 hash 的')
  eq(plan.skipped.length, 1, '残缺行进 skipped')
  eq(plan.skipped[0].path, 'bad.txt', '跳过的是 bad.txt')
})

// ───────────────────────────── L 产物路径判据（P1-9 · R4） ─────────────────────────────

console.log('── L 产物 = 工作区变更集（sandbox/artifactChanges）──')
/** 造一条工作区变更集条目（`type` / `path` 可控） */
const chg = (path, type, version = 1) => ({ path, type, version, actor: 'AGENT', actorId: 'a1', at: '2026-10-12T00:00:00.000Z' })
const pathOptions = { excludedDirs: ARTIFACT_EXCLUDED_DIRS, maxFiles: 200 }
it('L1 只认内容事件：created/updated/renamed 保留，claim/release/deleted 丢弃', () => {
  const paths = artifactChangePaths(
    [
      chg('a.txt', 'created'),
      chg('b.txt', 'updated', 2),
      chg('c.txt', 'renamed', 2),
      chg('d.txt', 'deleted', 3),
      chg('e.txt', 'claim', null),
      chg('f.txt', 'release', null),
    ],
    pathOptions,
  )
  eq(paths, ['a.txt', 'b.txt', 'c.txt'], '新建/改动/改名留下，删除与 claim/release 丢弃')
})
it('L2 隐藏路径（含 .git / .doubulea）与 node_modules 排除，结果按路径排序', () => {
  const paths = filterArtifactPaths(
    [
      'out/report.csv',
      '.git/config',
      '.doubulea/memory.md',
      'src/.hidden/keep.txt',
      'node_modules/pkg/index.js',
      'attachments/1-a.png',
    ],
    pathOptions,
  )
  eq(paths, ['attachments/1-a.png', 'out/report.csv'], '隐藏段 / node_modules 排除，其余升序')
})
it('L3 超单轮上限即截断并留痕（不静默丢）', () => {
  let noted = null
  const paths = filterArtifactPaths(['b.txt', 'a.txt', 'c.txt'], {
    excludedDirs: ARTIFACT_EXCLUDED_DIRS,
    maxFiles: 2,
    onTruncate: (accepted, kept, maxFiles) => {
      noted = { accepted, kept, maxFiles }
    },
  })
  eq(paths, ['a.txt', 'b.txt'], '截断后按路径升序取前 2 条')
  eq(noted, { accepted: 3, kept: 2, maxFiles: 2 }, '截断要留痕')
})

// ─────────────────── L4/L5 git 感知产物过滤（sandbox/gitArtifacts，#3） ───────────────────

console.log('── L4/L5 git 感知产物过滤（sandbox/gitArtifacts）──')
it('L4 parsePorcelainPaths：只认 `XY<空格>path`，rename 的裸原路径被丢弃', () => {
  eq(
    parsePorcelainPaths([' M a.txt', '?? b.txt', 'R  c.txt', 'c.txt', '', '?? dir/']),
    ['a.txt', 'b.txt', 'c.txt', 'dir/'],
    '脏路径集合（rename 的第二段裸路径不计）',
  )
})

/** git 是否可用（不可用就跳过 L5，不让本档在没装 git 的机器上误红） */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (gitAvailable()) {
  const gitRoot = await mkdtemp(join(tmpdir(), 'ws-git-'))
  try {
    const run = (args: string[]): void => {
      execFileSync('git', args, {
        cwd: gitRoot,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      })
    }
    run(['init', '-q'])
    await writeFile(join(gitRoot, 'committed.txt'), 'v1\n')
    await writeFile(join(gitRoot, 'clean.txt'), 'c\n')
    run(['add', 'committed.txt', 'clean.txt'])
    run(['commit', '-q', '-m', 'init'])
    // committed.txt 提交后被改（脏）；untracked.txt 未跟踪；clean.txt 提交后没再动（干净）
    await writeFile(join(gitRoot, 'committed.txt'), 'v2\n')
    await writeFile(join(gitRoot, 'untracked.txt'), 'new\n')

    const result = await filterGitCleanPaths(gitRoot, ['committed.txt', 'clean.txt', 'untracked.txt'])
    it('L5 filterGitCleanPaths：干净的 tracked 剔除；改动 / 未跟踪保留', () => {
      eq(result.excluded, ['clean.txt'], '干净的 tracked 被剔除（clone/pull 初始填充）')
      eq(result.kept.sort(), ['committed.txt', 'untracked.txt'], '改过的 tracked 与未跟踪新文件保留')
    })
  } finally {
    await rm(gitRoot, { recursive: true, force: true })
  }
} else {
  console.log('  [SKIP] L5 本机没有 git，跳过 git 过滤的集成核对')
}

// ───────────────────────────── M 保留期判据（P1-9 · P5 · R5） ─────────────────────────────

console.log('── M 保留期判据（workspace/reapModel）──')
it('M1 截止时刻 = 现在 - 保留期天数（跨天按 24h×天算）', () => {
  const now = new Date('2026-10-12T00:00:00.000Z')
  eq(workspaceRetentionCutoff(now, 7).toISOString(), '2026-10-05T00:00:00.000Z', '7 天')
  eq(workspaceRetentionCutoff(now, 0).toISOString(), '2026-10-12T00:00:00.000Z', '0 天 = 现在')
})
it('M2 恰好等于 cutoff 不算过期（严格 <）：早 1ms 过期、等于/晚 1ms 不过期', () => {
  const now = new Date('2026-10-12T00:00:00.000Z')
  const cutoff = workspaceRetentionCutoff(now, 7)
  eq(isWorkspaceExpired(new Date(cutoff.getTime() - 1), now, 7), true, '早 1ms ⇒ 过期')
  eq(isWorkspaceExpired(cutoff, now, 7), false, '恰好等于 ⇒ 不过期')
  eq(isWorkspaceExpired(new Date(cutoff.getTime() + 1), now, 7), false, '晚 1ms ⇒ 不过期')
})
it('M3 同一时刻、不同保留期得出不同结论（纯比较，无副作用）', () => {
  const now = new Date('2026-10-12T00:00:00.000Z')
  const idle = new Date('2026-10-05T12:00:00.000Z')
  eq(isWorkspaceExpired(idle, now, 7), false, '7 天内（cutoff=10-05T00:00）⇒ 未过期')
  eq(isWorkspaceExpired(idle, now, 6), true, '超 6 天（cutoff=10-06T00:00）⇒ 过期')
})

// ───────────────────────────── N 硬化：二进制 / 配额 / 限流（P1-9 · P6 · R6） ─────────────────────────────

console.log('── N 硬化判据（workspace/quotaModel）──')
it('N1 二进制嗅探：含 NUL ⇒ 二进制；纯文本（UTF-8 中文）⇒ 文本', () => {
  eq(looksBinaryWorkspaceContent(Buffer.from('hello world\n')), false, '纯 ASCII 文本')
  eq(looksBinaryWorkspaceContent(Buffer.from('中文内容也很正常\n', 'utf8')), false, 'UTF-8 中文')
  eq(looksBinaryWorkspaceContent(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x62])), true, '含 NUL ⇒ 二进制')
})
it('N2 二进制嗅探只看采样窗口（前 8KB 之外的 NUL 不算二进制）', () => {
  const beyondSample = Buffer.alloc(WORKSPACE_BINARY_SAMPLE_BYTES + 8, 0x61) // 'a' * (8192+8)
  beyondSample[WORKSPACE_BINARY_SAMPLE_BYTES + 4] = 0 // 窗口之外的 NUL
  eq(looksBinaryWorkspaceContent(beyondSample), false, '窗口外 NUL 不影响判定')
  const inSample = Buffer.alloc(4, 0x61)
  inSample[1] = 0 // 窗口内的 NUL
  eq(looksBinaryWorkspaceContent(inSample), true, '窗口内 NUL ⇒ 二进制')
})

/** 一组宽松阈值（默认值量级），用例只需改被测的那一项 */
const limits = { maxFileBytes: 10 * 1024 * 1024, maxFiles: 2000, maxRows: 20000, maxTotalBytes: 512 * 1024 * 1024 }
/** 一份"处处合规"的现状快照，用例只需覆盖被测字段 */
const snapshot = {
  incomingBytes: 100,
  binary: false,
  isNewFile: true,
  createsRow: true,
  liveFileCount: 0,
  totalRowCount: 0,
  liveTotalBytes: 0,
}
it('N3 二进制**优先**于一切配额（类型闸门）：即便体积/数量都合规也拒', () => {
  const d = decideWorkspaceQuota({ ...snapshot, binary: true }, { ...limits, maxFileBytes: 1 })
  eq(d.ok, false, '二进制直接拒')
  eq(d.ok === false ? d.violation : null, 'BINARY_CONTENT', 'violation = BINARY_CONTENT')
})
it('N4 单文件上限（严格 > ：恰好等于放行）', () => {
  eq(decideWorkspaceQuota({ ...snapshot, incomingBytes: 10 * 1024 * 1024 }, limits).ok, true, '恰好等于上限 ⇒ 放行')
  const d = decideWorkspaceQuota({ ...snapshot, incomingBytes: 10 * 1024 * 1024 + 1 }, limits)
  eq(d.ok === false ? d.violation : null, 'FILE_TOO_LARGE', '超 1 字节 ⇒ 拒')
})
it('N5 文件数上限：仅**新增活文件**时判（覆盖写不增文件数）', () => {
  const at = { ...snapshot, isNewFile: true, liveFileCount: 2000 }
  eq(decideWorkspaceQuota(at, limits).ok, false, '新增且已达上限 ⇒ 拒')
  eq(decideWorkspaceQuota({ ...at, isNewFile: false }, limits).ok, true, '覆盖写不受文件数上限约束')
})
it('★ N6 行数上限（含墓碑）：仅**新增行**时判（复活墓碑行不增行数）', () => {
  const at = { ...snapshot, createsRow: true, totalRowCount: 20000, liveFileCount: 0, isNewFile: true }
  const d = decideWorkspaceQuota(at, limits)
  eq(d.ok === false ? d.violation : null, 'TOO_MANY_ROWS', '新增行且达上限 ⇒ 拒')
  eq(decideWorkspaceQuota({ ...at, createsRow: false }, limits).ok, true, '不新增行（复活墓碑）⇒ 不受行数上限约束')
})
it('N7 总字节上限：当前活总量 + 新大小 的**保守上界**', () => {
  const near = { ...snapshot, liveTotalBytes: 512 * 1024 * 1024 - 50, incomingBytes: 50 }
  eq(decideWorkspaceQuota(near, limits).ok, true, '恰好触及上限 ⇒ 放行')
  const over = { ...near, incomingBytes: 51 }
  eq(decideWorkspaceQuota(over, limits).ok === false ? decideWorkspaceQuota(over, limits).violation : null, 'TOTAL_TOO_LARGE', '超 1 字节 ⇒ 拒')
})
it('N8 写入限流：窗口起点按 1 分钟对齐', () => {
  eq(WORKSPACE_WRITE_RATE_WINDOW_MS, 60_000, '窗口 = 60s')
  const now = Date.parse('2026-10-12T00:00:42.500Z')
  eq(workspaceWriteRateWindowStart(now), Date.parse('2026-10-12T00:00:00.000Z'), '折算到本分钟起点')
  eq(workspaceWriteRateWindowStart(Date.parse('2026-10-12T00:00:59.999Z')), Date.parse('2026-10-12T00:00:00.000Z'), '秒内不翻窗')
  eq(workspaceWriteRateWindowStart(Date.parse('2026-10-12T00:01:00.000Z')), Date.parse('2026-10-12T00:01:00.000Z'), '跨分钟即翻窗')
})
it('N9 写入限流：`count > limit` 才算超；`limit<=0` = 关闭限流（放行）', () => {
  eq(isWorkspaceWriteRateExceeded(600, 600), false, '恰好等于上限 ⇒ 放行')
  eq(isWorkspaceWriteRateExceeded(601, 600), true, '超 1 次 ⇒ 拒')
  eq(isWorkspaceWriteRateExceeded(999999, 0), false, 'limit=0 ⇒ 关闭限流，永不算超')
  eq(isWorkspaceWriteRateExceeded(999999, -1), false, 'limit<0 ⇒ 同上放行')
})

console.log('── O 行级差异（workspace/diff，P1-9 · 验收标记）──')
it('O1 splitWorkspaceDiffLines：统一换行 / 空文本 / 末尾换行不产生空行', () => {
  eq(splitWorkspaceDiffLines('a\nb\n').join(','), 'a,b', '末尾换行不算额外一行')
  eq(splitWorkspaceDiffLines('a\r\nb\r\n').join(','), 'a,b', 'CRLF 归一')
  eq(splitWorkspaceDiffLines('').length, 0, '空文本 = 空数组（不是 [\'\']）')
  eq(splitWorkspaceDiffLines('a').join(','), 'a', '无末尾换行')
})
it('O2 相同内容 ⇒ 零增删（全 context，长段折成 gap）', () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const d = lineDiffWorkspace(body, body)
  eq(d.added, 0, '无新增')
  eq(d.removed, 0, '无删除')
  eq(d.truncated, false, '未截断')
  assert(d.lines.some((line) => line.type === 'gap'), '长未变段折成 gap（否则 20 行全展示）')
})
it('O3 新建（旧为空）⇒ 整篇新增', () => {
  const d = lineDiffWorkspace('', 'a\nb\nc\n')
  eq(d.added, 3, '新增 3 行')
  eq(d.removed, 0, '无删除')
  eq(d.lines.every((line) => line.type === 'add'), true, '全是 add')
  eq(d.lines.map((line) => line.newLine).join(','), '1,2,3', '新行号 1..3')
  eq(d.lines.every((line) => line.oldLine === null), true, '新增行无旧行号')
})
it('O4 删除（新为空）⇒ 整篇删除', () => {
  const d = lineDiffWorkspace('a\nb\n', '')
  eq(d.added, 0, '无新增')
  eq(d.removed, 2, '删除 2 行')
  eq(d.lines.every((line) => line.type === 'del'), true, '全是 del')
  eq(d.lines.map((line) => line.oldLine).join(','), '1,2', '旧行号 1..2')
})
it('O5 单行改动 ⇒ 1 add + 1 del，且带上下文行号', () => {
  const d = lineDiffWorkspace('a\nb\nc\n', 'a\nB\nc\n')
  eq(d.added, 1, '增 1')
  eq(d.removed, 1, '删 1')
  eq(d.lines.length, 4, '上下文(3) + 改动(1)：a / del b / add B / c')
  const del = d.lines.find((line) => line.type === 'del')
  const add = d.lines.find((line) => line.type === 'add')
  eq(del?.text, 'b', '删除行文本')
  eq(del?.oldLine, 2, '删除行旧行号')
  eq(add?.text, 'B', '新增行文本')
  eq(add?.newLine, 2, '新增行新行号')
})
it('O6 中段小改 ⇒ 只保留两端各 3 行上下文，中间折成 gap', () => {
  const oldText = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
  const lines = oldText.split('\n')
  lines[15] = 'CHANGED'
  const d = lineDiffWorkspace(oldText, lines.join('\n'))
  eq(d.added, 1, '增 1')
  eq(d.removed, 1, '删 1')
  const gaps = d.lines.filter((line) => line.type === 'gap')
  // 改动前 15 行未变、改动后 14 行未变 ⇒ 两段各自折成一个 gap（各留首尾 3 行上下文）
  eq(gaps.length, 2, '前后各一个 gap')
  eq(
    gaps.reduce((sum, line) => sum + (line.gap ?? 0), 0),
    15 - 6 + (14 - 6),
    'gap 合计 = 两段未变行各去掉 3+3 行上下文',
  )
  eq(
    d.lines.filter((line) => line.type === 'context').length,
    WORKSPACE_DIFF_CONTEXT_LINES * 4,
    '上下文 = 改动处前后各 3 行 × 2 段',
  )
})
it('O7 超行数上限 ⇒ truncated（计数只反映已处理部分）', () => {
  const big = Array.from({ length: 50 }, (_, i) => `x${i}`).join('\n')
  const d = lineDiffWorkspace('', big, { maxLines: 10 })
  eq(d.truncated, true, '被截断')
  eq(d.added, 10, '只处理前 10 行')
})
it('O8 大改动量退化路径仍给出正确计数（LCS 超上限 ⇒ 整段删+增）', () => {
  const a = Array.from({ length: 600 }, (_, i) => `old-${i}`).join('\n')
  const b = Array.from({ length: 600 }, (_, i) => `new-${i}`).join('\n')
  const d = lineDiffWorkspace(a, b)
  eq(d.added, 600, '600 行全新增')
  eq(d.removed, 600, '600 行全删除')
  eq(d.truncated, false, '未截断（退化不等于截断）')
})

console.log('── P 工作区写保留权限位（P1-20，"g.sh 丢执行权限"修复）──')
// 顶层准备（`it` 同步，先把异步 FS 做完）：一个已有 0755 的脚本走一次覆盖写；一个新建
const modeRoot = await mkdtemp(join(tmpdir(), 'ws-mode-'))
const modeScript = join(modeRoot, 'g.sh')
const modeFresh = join(modeRoot, 'plain.txt')
await writeFile(modeScript, 'echo old\n', { mode: 0o755 })
await writeWorkspaceBytes(modeScript, Buffer.from('echo new\n'))
await writeWorkspaceBytes(modeFresh, Buffer.from('hi\n'))
const scriptMode = (await stat(modeScript)).mode & 0o777
const freshMode = (await stat(modeFresh)).mode & 0o777
await rm(modeRoot, { recursive: true, force: true })
it('P1 writeWorkspaceBytes 覆盖已有文件 ⇒ 保留原权限位（不再被打回 0644）', () => {
  eq(scriptMode, 0o755, '已有 0755 ⇒ 覆盖后仍 0755')
})
it('P2 writeWorkspaceBytes 新建文件 ⇒ 默认 0644', () => {
  eq(freshMode, 0o644, '新建默认 0644')
})

// ───────────────────────────── Q 文件夹递归删除判据 ─────────────────────────────

console.log('── Q 文件夹递归删除判据（workspace/dirModel）──')
it('Q1 workspaceDirPrefix：补一个尾斜杠（幂等）', () => {
  eq(workspaceDirPrefix('out'), 'out/', '补斜杠')
  eq(workspaceDirPrefix('a/b'), 'a/b/', '多段')
  eq(workspaceDirPrefix('a/'), 'a/', '已有斜杠不重复补')
})
it('Q2 isWorkspacePathInDir：只认"该目录之下"，同前缀不误伤', () => {
  eq(isWorkspacePathInDir('out/report.csv', 'out'), true, '直接子文件')
  eq(isWorkspacePathInDir('out/a/b.txt', 'out'), true, '深层子文件')
  eq(isWorkspacePathInDir('outsider.txt', 'out'), false, '同前缀文件（无斜杠边界）')
  eq(isWorkspacePathInDir('out2/report.csv', 'out'), false, '同前缀目录')
  eq(isWorkspacePathInDir('other/x', 'out'), false, '别的目录')
})
it('Q3 selectWorkspaceDirPaths：只挑该目录下的活文件（保序）', () => {
  eq(selectWorkspaceDirPaths('out', ['out/a', 'out/b/c', 'out2/d', 'root.txt', 'outsider']), ['out/a', 'out/b/c'], '过滤')
  eq(selectWorkspaceDirPaths('out', []), [], '空输入')
})

// ───────────────────────────── R git 概况判据（workspace/git） ─────────────────────────────
// ⚠️ 本节的 `scanGitReposUnder` 用例**不用 git 二进制**：手搭 `.git/HEAD` 的两种形态即可 ——
//    这正是被测对象的本意（"分支展示"不该给宿主加一条 git 依赖）。

console.log('── R git 概况判据（workspace/git；读 .git/HEAD，不调 git）──')
it('R1 parseGitHead：分支名 / detached 短 SHA / 认不出回 null（不猜）', () => {
  eq(parseGitHead('ref: refs/heads/master\n'), { branch: 'master', detached: false }, '普通分支')
  eq(
    parseGitHead('ref: refs/heads/feature/a-b_c\n'),
    { branch: 'feature/a-b_c', detached: false },
    '含斜杠 / 连字符 / 下划线的分支名',
  )
  eq(
    parseGitHead('9F1C0D2aB3c4D5e6F708192A3B4C5D6E7F809101\n'),
    { branch: '9f1c0d2', detached: true },
    'detached：给 7 位**小写**短 SHA',
  )
  eq(parseGitHead('ref: refs/tags/v1.0.0\n'), { branch: null, detached: false }, 'tag 不是分支 ⇒ 不冒充分支名')
  eq(parseGitHead('ref: refs/heads/\n'), { branch: null, detached: false }, '空分支名 ⇒ null')
  eq(parseGitHead('   \n'), { branch: null, detached: false }, '空 HEAD ⇒ null')
})
it('R2 parseGitDirFile：相对 gitdir 按仓库根解析；绝对原样；认不出回 null', () => {
  eq(parseGitDirFile('gitdir: ../.git/worktrees/wt\n', '/w/repo'), '/w/.git/worktrees/wt', '相对路径按仓库根解析')
  eq(parseGitDirFile('gitdir: /abs/.git/worktrees/wt\n', '/w/repo'), '/abs/.git/worktrees/wt', '绝对路径原样')
  eq(parseGitDirFile('nonsense\n', '/w/repo'), null, '没有 `gitdir:` 行 ⇒ null')
})

const gitScanRoot = await mkdtemp(join(tmpdir(), 'ws-githead-'))
// ① 根就是仓库：`.git` 是**目录**；② `qatt-platform-qa/` 是 worktree：`.git` 是**文件** + `gitdir:` 相对路径；
// ③ `node_modules/` 与 `.hidden/` 里各塞一个假 `.git` —— 它们**不该**出现在结果里（候选过滤的证据）；
// ④ `real/.git` 是目录但**没有 HEAD** ⇒ 也不该被当成仓库（半截仓库不猜）。
await mkdir(join(gitScanRoot, '.git'), { recursive: true })
await writeFile(join(gitScanRoot, '.git', 'HEAD'), 'ref: refs/heads/master\n')
await mkdir(join(gitScanRoot, 'qatt-platform-qa'), { recursive: true })
await writeFile(join(gitScanRoot, 'qatt-platform-qa', '.git'), 'gitdir: ../real/.git/worktrees/wt\n')
await mkdir(join(gitScanRoot, 'real', '.git', 'worktrees', 'wt'), { recursive: true })
await writeFile(join(gitScanRoot, 'real', '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feat-x\n')
await mkdir(join(gitScanRoot, 'node_modules', 'dep', '.git'), { recursive: true })
await writeFile(join(gitScanRoot, 'node_modules', 'dep', '.git', 'HEAD'), 'ref: refs/heads/should-not-appear\n')
await mkdir(join(gitScanRoot, '.hidden', '.git'), { recursive: true })
await writeFile(join(gitScanRoot, '.hidden', '.git', 'HEAD'), 'ref: refs/heads/also-hidden\n')
const scannedRepos = await scanGitReposUnder(gitScanRoot)
await rm(gitScanRoot, { recursive: true, force: true })

it('R3 scanGitReposUnder：两种 `.git` 形态都认；跳过依赖/隐藏目录与半截仓库', () => {
  eq(
    scannedRepos.map((repo) => repo.path),
    ['', 'qatt-platform-qa'],
    '根优先、再按名字序；node_modules/.hidden 不进候选，real（有 .git 没 HEAD）不当仓库',
  )
  eq(scannedRepos[0], { path: '', branch: 'master', detached: false }, '根仓库：读 `.git/HEAD`')
  eq(
    scannedRepos[1],
    { path: 'qatt-platform-qa', branch: 'feat-x', detached: false },
    '`.git` 是文件（worktree）⇒ 顺着 `gitdir:` 读到那个 HEAD',
  )
})

const noGitDir = await mkdtemp(join(tmpdir(), 'ws-nogit-'))
await mkdir(join(noGitDir, 'src'), { recursive: true })
const noGitRepos = await scanGitReposUnder(noGitDir)
const missingRepos = await scanGitReposUnder(join(tmpdir(), 'ws-does-not-exist-12345'))
await rm(noGitDir, { recursive: true, force: true })

it('R4 scanGitReposUnder：没有 git / 目录不存在 ⇒ 空数组（**不抛错** —— 面板不该因此报错）', () => {
  eq(noGitRepos, [], '普通目录（只有 src/）')
  eq(missingRepos, [], '目录不存在（新会话还没派过活）')
})

console.log('')
console.log(`workspace-regression：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)