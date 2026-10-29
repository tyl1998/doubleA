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
  isGitInternalPath,
  isWorkspaceTextMime,
  normalizeWorkspacePath,
  planWorkspaceRevert,
  workspaceMimeOf,
} from '@doubulea/shared'

import { resolveWorkspacePath } from '../src/workspace/paths.js'
import { parseGitDirFile, parseGitHead, scanGitReposUnder } from '../src/workspace/git.js'
import { decodeTextBuffer } from '../src/pipeline/parse/txt.js'
import { writeWorkspaceBytes } from '../src/workspace/store.js'
import {
  buildWorkspaceRevertPreview,
  contentEventTimes,
  isWorkspaceChangeStillPresent,
  pickUsableRoundStart,
  planWorkspaceRevertCandidates,
  revertRollbackVersion,
  shouldRevertPath,
  splitWorkspaceChangesByRound,
  workspaceChangeGrouping,
  type WorkspacePathStates,
} from '../src/workspace/changesModel.js'
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
import { buildZip, crc32, zipEntryName } from '../src/workspace/zip.js'
import {
  ARTIFACT_EXTEND_MAX_DAYS,
  defaultArtifactExpiresAt,
  isArtifactExpired,
  resolveArtifactExpiry,
} from '../src/services/artifactExpiryModel.js'
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
// ★ 2026-10-28（用户反馈「txt 文件在 Code 模式下不能展示」）：`.txt` / `.log` 是 `text/plain`，
//   必须**能进编辑器**；读接口的文本解码走编码嗅探（`pipeline/parse/txt#decodeTextBuffer`），
//   于是 UTF-8 / UTF-16（BOM）/ GBK 的 txt 都能正常展示，而不是一屏乱码或直接只给下载。
it('C2b txt / log 是文本：能进编辑器，且解码按真实编码（UTF-8 / UTF-16 BOM / GBK）', () => {
  eq(workspaceMimeOf('requirements.txt'), 'text/plain', 'txt → text/plain')
  eq(workspaceMimeOf('a/b/app.log'), 'text/plain', 'log → text/plain')
  eq(isWorkspaceTextMime(workspaceMimeOf('notes.txt')), true, 'txt 可编辑')
  eq(decodeTextBuffer(Buffer.from('allure-pytest==0.0.1\n', 'utf8')).text, 'allure-pytest==0.0.1\n', '严格 UTF-8 原样')
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\nb\n', 'utf16le')])
  eq(decodeTextBuffer(utf16).text, 'a\nb\n', 'UTF-16LE BOM：解成正常文本（不是乱码）')
  eq(decodeTextBuffer(utf16).encoding, 'utf-16le', '编码被识别出来')
  // GBK 的「中文」：严格 UTF-8 解不过 ⇒ 退回 GBK
  eq(decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])).text, '中文', 'GBK 回退')
  const utf8bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n')])
  eq(decodeTextBuffer(utf8bom).text, 'x\n', 'UTF-8 BOM 不留在正文里')
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

// ── H4 同一轮里改多次：基线取"本轮第一次改之前"，不是 `version - 1`（2026-10-28 用户反馈） ──
// 场景：v1 是 clone 的原始内容，同一轮里又连续改了两次 → v2 → v3。
// 用户实际改了 2 行，展示必须覆盖**整轮**（v1 → v3），而不是最后一跳（v2 → v3）。
it('H4 planWorkspaceRevert：同一轮多次改，beforeVersion 取轮内最早那次的基线', () => {
  const at = (m: number) => `2026-10-28T10:${String(m).padStart(2, '0')}:00.000Z`
  const plan = planWorkspaceRevert([
    ev('f.py', 'updated', at(0), 2),
    ev('f.py', 'updated', at(1), 3),
  ])
  eq(plan.length, 1, '同一路径只出一次计划')
  eq(plan[0].beforeVersion, 1, '基线 = 轮内第一条（v2）的前一版 = v1 —— 不是 v3-1=2')
  eq((plan[0].expect as { version: number }).version, 3, '轮末版本仍是最后一条')
})

// ─────────────── H3 git 内部路径（P1-24；「最近变更」不显示 git 自己的中间产物） ───────────────
it('H3 isGitInternalPath：只认 `.git` 那一段', () => {
  eq(isGitInternalPath('repo/.git/objects/pack/tmp_pack_EDixtn'), true, 'clone 中途的临时 pack')
  eq(isGitInternalPath('repo/.git/index.lock'), true, 'index.lock')
  eq(isGitInternalPath('repo/.git'), true, '`--separate-git-dir` 那种 `.git` 文件本身')
  eq(isGitInternalPath('.git/HEAD'), true, '根就是仓库')
  eq(isGitInternalPath('repo/Demo/test_case/test_demo1.py'), false, '普通文件')
  eq(isGitInternalPath('.doubulea/memory.md'), false, '隐藏目录不等于 .git（记忆文档不算）')
  eq(isGitInternalPath('repo/.github/workflows/ci.yml'), false, '`.github` 是正常目录')
  // ★ 2026-10-28（用户指正「为什么现在我 memory 的文件不算更改了」）：**只有 `.git` 被剔**，
  //   `.doubulea/memory.md` 是真实写入（每轮重写），必须照常进「最近变更」。
  //   本轮/更早由边界 + "当前内容仍在"判，**不由路径白名单判** —— 曾误加 `.doubulea/**` 排除，
  //   导致记忆文档的改动凭空消失，此断言锁住该口径。
  eq(isGitInternalPath('.doubulea/memory.md'), false, '记忆文档是工作区改动，不是 git 内部产物')
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
    // ★ 2026-10-28（用户反馈「拉取代码这个会话最近变更对不上」）：`tracked` 要单独给出来 ——
    //   `committed.txt` 虽然是 tracked，但此刻是脏的（`kept` 里有它），于是按路径判据它会被当成
    //   "被改过的文件"。可它在 checkout 那一刻还产生过一条 `created v1`（仓库自带，不是谁新建的）。
    //   调用方拿 `tracked` 就能把那条"检出产生的创建"剔掉。
    it('L5b filterGitCleanPaths.tracked：脏的 tracked 也报出来（供剔除"检出产生的 created"）', () => {
      eq(result.tracked.sort(), ['clean.txt', 'committed.txt'], '被 git 跟踪的路径都报出来，与脏不脏无关')
      assert(!result.tracked.includes('untracked.txt'), '未跟踪的新文件不是"拉取下来的"')
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
// ★ 2026-10-28（用户反馈「txt 文件在 Code 模式下不能展示」）：带 BOM 的 UTF-16 是**纯文本**，
//   但每个 ASCII 字符后面跟着一个 NUL（`a\0l\0l\0…`）⇒ 只按 NUL 判会被误判成二进制，
//   于是编辑器只给"该文件不是文本，只能下载"。BOM 是文件自己的编码声明，必须优先采信。
it('N2b 二进制嗅探先认 UTF-16 BOM（带 BOM 的 UTF-16 txt 是文本，不是二进制）', () => {
  // 真实现场：`requirements.txt` 是 UTF-16LE + BOM（FF FE），内容 `allure-\n…`
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('allure-\n', 'utf16le')])
  eq(looksBinaryWorkspaceContent(utf16le), false, 'UTF-16LE BOM ⇒ 文本（不是二进制）')
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('a\0l\0l\0', 'latin1')])
  eq(looksBinaryWorkspaceContent(utf16be), false, 'UTF-16BE BOM ⇒ 文本')
  const utf8bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n')])
  eq(looksBinaryWorkspaceContent(utf8bom), false, 'UTF-8 BOM 文本')
  // 无 BOM 的"UTF-16 样子"仍然按 NUL 判二进制（无从判定，保守）
  eq(looksBinaryWorkspaceContent(Buffer.from('a\0l\0l\0', 'latin1')), true, '无 BOM 的 NUL 序列仍是二进制')
  // PNG 头里也没有 BOM ⇒ 照旧判二进制（不能因为加了 BOM 判据就放过真二进制）
  eq(looksBinaryWorkspaceContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false, 'PNG 头本身无 NUL')
  eq(looksBinaryWorkspaceContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])), true, 'PNG 头里的 NUL 仍判二进制')
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

// ─────────────────────── S 「最近变更」分类判据（workspace/changesModel） ───────────────────────
// 用户定案 2026-10-28：`本轮改动 = 当前保存改动的内容`、`更早 = 非本轮改动`（git 拉取下来的不算）。
// 实测坏样本（会话 01a17c6d「拉取代码」）：Redis 轮次标记写成 `08:23:31Z`，而该轮事件在 `00:23:31Z`
// （偏 8 小时、`ttl=-1` 永不过期）⇒ 旧实现把那一轮真正的编辑判成「更早」、把昨天的保存判成「本轮」。

console.log('── S 「最近变更」分类判据（workspace/changesModel；纯函数）──')
it('S1 isWorkspaceChangeStillPresent：改回去 / 删了又建 / 删除后重建 ⇒ 不再算"当前改动"', () => {
  const states = new Map([
    ['kept.py', { version: 5, deleted: false, contentHash: 'hash-v5' }],
    // ★ 实测形态（`repo/pytest.ini`）：版本号变了（v3），内容 hash 与基线 v1 **相同**（改了又改回去）
    ['reverted.py', { version: 3, deleted: false, contentHash: 'hash-v1' }],
    ['gone.py', { version: 4, deleted: true, contentHash: 'hash-v4' }],
    ['fresh.py', { version: 1, deleted: false, contentHash: 'hash-v1' }],
  ]) satisfies WorkspacePathStates
  /** 被测的历史 hash 表（`undefined` = 那一版没有历史，无从判定） */
  const hashOf = (path: string, version: number): string | undefined =>
    ({
      'kept.py\u00003': 'hash-v3',
      'reverted.py\u00001': 'hash-v1',
      'gone.py\u00004': 'hash-v4',
      'kept.py\u00004': 'hash-v4',
    })[`${path}\u0000${version}`]

  eq(
    isWorkspaceChangeStillPresent({ path: 'kept.py', type: 'updated', beforeVersion: 3 }, states, hashOf),
    true,
    'v3 的 hash 与当前 v5 不同 ⇒ 内容确实变了 ⇒ 算数',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'reverted.py', type: 'updated', beforeVersion: 1 }, states, hashOf),
    false,
    '★ 改了又改回去：版本号 3 ≠ 1，但内容 hash 完全相同 ⇒ 不是"当前保存的改动"（实测 pytest.ini 就是这样）',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'gone.py', type: 'deleted', beforeVersion: 4 }, states, hashOf),
    true,
    '删掉且仍是墓碑 ⇒ 算数',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'kept.py', type: 'deleted', beforeVersion: 4 }, states, hashOf),
    false,
    '删了又建回来 ⇒ 那条删除已经不是现状',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'fresh.py', type: 'created', beforeVersion: null }, states, hashOf),
    true,
    '本轮新建且现在还在 ⇒ 算数',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'gone.py', type: 'created', beforeVersion: null }, states, hashOf),
    false,
    '新建后又删掉 ⇒ 现在不在了，不算数',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'never.py', type: 'updated', beforeVersion: 3 }, states, hashOf),
    false,
    '索引里根本没有这条活文件 ⇒ 不算数',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'kept.py', type: 'updated' }, states, hashOf),
    true,
    '没有基线信息 ⇒ 保守保留（宁可多显示一条，也不藏掉真实改动）',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'kept.py', type: 'updated', beforeVersion: 99 }, states, hashOf),
    true,
    '基线历史查不到（本功能上线前的版本）⇒ 无从判定，保守保留',
  )
})

it('S2 pickUsableRoundStart：标记必须与事件流自洽，否则按"没有本轮"处理（不猜）', () => {
  const now = Date.parse('2026-10-28T09:00:00.000Z')
  const goodMarker = { start: '2026-10-28T08:00:00.000Z' }
  const inside = [Date.parse('2026-10-28T08:10:00.000Z')]
  eq(pickUsableRoundStart(goodMarker, inside, now), goodMarker.start, '窗口内有内容事件 ⇒ 可用')

  // ★ 实测坏标记的形态：起点在未来 8 小时（偏时区），窗口里一条事件都没有
  eq(
    pickUsableRoundStart({ start: '2026-10-28T16:00:00.000Z' }, inside, now),
    null,
    '起点在未来 ⇒ 标记不可用（这就是本次实测的坏标记形态）',
  )
  eq(
    pickUsableRoundStart(goodMarker, [Date.parse('2026-10-28T07:00:00.000Z')], now),
    null,
    '窗口内一条内容事件都没有 ⇒ 标记与事件流不自洽，不可用',
  )
  eq(
    pickUsableRoundStart({ start: '2026-10-28T09:00:00.000Z', end: '2026-10-28T08:00:00.000Z' }, inside, now),
    null,
    'end 早于 start ⇒ 不可用',
  )
  eq(pickUsableRoundStart({}, inside, now), null, '没有起点 ⇒ 没有本轮')
  eq(
    pickUsableRoundStart({ start: '2026-10-28T08:00:00.000Z' }, [Date.parse('2026-10-28T07:59:00.000Z')], now),
    null,
    '内容事件全在起点之前 ⇒ 窗口空，不可用',
  )
  eq(
    pickUsableRoundStart({ start: '2026-10-28T08:00:00.000Z' }, [Date.parse('2026-10-28T08:00:00.000Z')], now),
    '2026-10-28T08:00:00.000Z',
    '边界取闭区间（起点那一刻的写入算本轮）',
  )
})

it('S3 contentEventTimes：ISO 串与 Date 都收，解析不了的丢弃', () => {
  eq(
    contentEventTimes([{ at: '2026-10-28T08:00:00.000Z' }, { at: new Date('2026-10-28T09:00:00.000Z') }]),
    [Date.parse('2026-10-28T08:00:00.000Z'), Date.parse('2026-10-28T09:00:00.000Z')],
    '两种形态都归一成毫秒',
  )
  eq(contentEventTimes([{ at: 'not-a-date' }]), [], '坏数据丢弃，不编 0')
})

// ───────── S4/S5 「按轮划分」的两个典型场景（用户 2026-10-28 提问，逐条钉住） ─────────
//
// 判据回顾（`service#listWorkspaceChanges`）：
//   本轮 = **每个文件各自最近一次保存**（A、B、C 三个都改过 ⇒ 三个都在本轮）；
//   更早 = 各文件的其余历史，**按文件压成一条**（轮前最早 → 轮前末）。
//   基线 = 这一跳之前那一版；本轮还要过"当前内容仍在"（比内容 hash），更早是历史、不过滤。

console.log('── S4/S5 「按轮划分」典型场景 ──')
it('S4 同一文件连改两次（33 行 → 44 行）：本轮 = 后一次，前一次次退回更早', () => {
  // 用户场景 1。轮初 v10/33行；先存成 33 行(v11)，再存成 44 行(v12)。
  const rows = [
    { id: 'e1', type: 'updated' as const, path: 'A', version: 11, actor: 'USER' as const, actorId: null, at: '2026-10-28T09:00:01.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'A', version: 12, actor: 'USER' as const, actorId: null, at: '2026-10-28T09:00:02.000Z' },
  ]
  // 基线：每一跳各自"这一跳之前"的版本（第一次 = 轮初 v10，第二次 = v11）
  const beforeOf = (event: { version: number | null }): number | null => (event.version ?? 1) - 1
  const split = splitWorkspaceChangesByRound(rows, beforeOf)

  eq(split.current.length, 1, '本轮一条')
  eq(split.current[0].version, 12, '★ 本轮 = 该文件**最近一次保存**（44 行那次），不是被合并成轮初→44')
  eq(split.current[0].beforeVersion, 11, '★ 本轮的范围是 33→44（v11→v12），不是轮初→44')
  eq(split.earlier.length, 1, '更早一条（第一次保存）')
  eq(split.earlier[0].version, 11, '更早 = 上一次保存（33 行那次）')
  eq(split.earlier[0].beforeVersion, 10, '更早的范围是 轮初→33（v10→v11）')

  const states = new Map([['A', { version: 12, deleted: false, contentHash: 'hash-44' }]])
  const hashOf = (path: string, version: number): string | undefined =>
    path === 'A' && version === 11 ? 'hash-33' : undefined
  eq(
    isWorkspaceChangeStillPresent({ path: 'A', type: 'updated', beforeVersion: 11 }, states, hashOf),
    true,
    '本轮：当前 44 行 ≠ 这一跳的基线 33 行 ⇒ 保留',
  )
})

it('S4a agent 依次保存 A、B、C 三个文件 ⇒ 三个都在本轮（不是只剩 C）', () => {
  // ★ 用户 2026-10-28 的反例：「假设文档按时间 A、B、C，在 agent 编辑过并保存，最后只会展示 C？」
  //   旧实现取**全局最后一跳** ⇒ 只有 C 进本轮，A、B 还会被历史折叠吞掉。本轮必须按**文件**算。
  const rows = [
    { id: 'e1', type: 'updated' as const, path: 'A.md', version: 2, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T09:00:01.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'B.md', version: 2, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T09:00:02.000Z' },
    { id: 'e3', type: 'updated' as const, path: 'C.md', version: 2, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T09:00:03.000Z' },
  ]
  const beforeOf = (event: { version: number | null }): number | null => (event.version ?? 1) - 1
  const split = splitWorkspaceChangesByRound(rows, beforeOf)
  eq(split.current.length, 3, '★ 三个文件各一条，全在「本轮」')
  eq(split.current.map((item) => item.path).sort().join(','), 'A.md,B.md,C.md', 'A、B、C 都在')
  eq(split.current.map((item) => item.beforeVersion).join(','), '1,1,1', '每条的基线都是它自己前一版（v1→v2）')
  eq(split.earlier.length, 0, '没有历史剩余 ⇒ 更早为空')
})

it('S4b 更早按文件压成一条：同一文件轮前 3 次保存 ⇒ 更早只出一条（轮前最早 → 轮前末）', () => {
  // 用户定案「更早的全部历史压成一条」：不让 32 次历史保存把清单撑爆。
  const rows = [
    { id: 'e1', type: 'created' as const, path: 'A', version: 1, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T08:00:01.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'A', version: 2, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T08:00:02.000Z' },
    { id: 'e3', type: 'updated' as const, path: 'A', version: 3, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T08:00:03.000Z' },
    { id: 'e4', type: 'updated' as const, path: 'A', version: 4, actor: 'USER' as const, actorId: null, at: '2026-10-28T09:00:01.000Z' },
  ]
  const plan = planWorkspaceRevert(rows)
  const split = splitWorkspaceChangesByRound(rows, () => plan[0].beforeVersion)
  eq(split.current.length, 1, '本轮 = 最后一次保存（v4）')
  eq(split.current[0].version, 4, '本轮展示末版本')
  eq(split.earlier.length, 1, '★ 轮前 3 次保存压成**一条**（不是 3 条）')
  eq(split.earlier[0].version, 3, '更早展示的是**轮前末**版本（v3）')
  // ★ 2026-10-28 实测修正：A 是 `created v1` 建的 ⇒ 更早那段的起点是 **v1**（不是 null）。
  //   以前用 `beforeOf(first)` 会得 null ⇒ 清单显示 `vNone→v3`，等于说"整篇都是新建"，
  //   可它其实是 v1 建、v1→v3 改。
  eq(split.earlier[0].beforeVersion, 1, '更早的基线 = 该文件在本会话最早那次事件的版本（v1）')
})

it('S5 第一轮改 A 新建 B，第二轮删 B：本轮 = A改 + B已删除，更早 = B新建', () => {
  const rows = [
    { id: 'e1', type: 'updated' as const, path: 'A', version: 2, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T08:00:10.000Z' },
    { id: 'e2', type: 'created' as const, path: 'B', version: 1, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T08:00:20.000Z' },
    { id: 'e3', type: 'deleted' as const, path: 'B', version: 1, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T09:00:10.000Z' },
  ]
  const beforeOf = (event: { version: number | null }): number | null => (event.version ?? 1) - 1
  const split = splitWorkspaceChangesByRound(rows, beforeOf)

  eq(
    split.current.map((item) => `${item.path}:${item.type}`),
    ['B:deleted', 'A:updated'],
    '★ 本轮 = **各文件最近一次保存**：A 改过、B 被删 ⇒ 两条都在（不是只剩最后一个动作）',
  )
  eq(
    split.earlier.map((item) => `${item.path}:${item.type}`),
    ['B:created'],
    '更早：B 的「新建」是同一文件更早的历史 ⇒ 压成一条保留（A 没有更早历史）',
  )

  // 状态：A 被改过、B 现在是墓碑
  const states = new Map([
    ['A', { version: 2, deleted: false, contentHash: 'hash-A2' }],
    ['B', { version: 1, deleted: true, contentHash: 'hash-B1' }],
  ])
  const hashOf = (path: string, version: number): string | undefined =>
    path === 'A' && version === 1 ? 'hash-A1' : undefined

  eq(
    isWorkspaceChangeStillPresent({ path: 'B', type: 'deleted' }, states, hashOf),
    true,
    '本轮：B 仍不在 ⇒ 「已删除」保留',
  )
  // ★ 2026-10-28（用户定案「两段同规则」）：更早也要过"当前内容仍在"的检查 ——
  //   但判据对 `deleted` 是"仍然不在"，而 `created` 是"现在还在"。
  //   B 现在不在 ⇒ 它那条「新建」确实已经不是"当前保存的改动"，两段都该收起
  //   （用户点「更早」看到的 +N 应该是那一段真实残留的差异，不是已被删掉的历史）。
  eq(
    isWorkspaceChangeStillPresent({ path: 'B', type: 'created', beforeVersion: null }, states, hashOf),
    false,
    '更早：B 已被删 ⇒ 「新建」不再算当前改动（两段同规则）',
  )
  eq(
    isWorkspaceChangeStillPresent({ path: 'B', type: 'deleted' }, states, hashOf),
    true,
    '★ 更早里"删除"这条永远保留：历史删除是真实发生过的事',
  )
})

// ───────────────── S6-S9 撤销范围 / 回滚点 / 展示口径（2026-10-28「撤销怎么选」） ─────────────────
console.log('── S6-S9 撤销范围与回滚点 ──')
it('S6 默认范围只撤 agent：用户手写收尾的路径**故意不动**（不是漏了）', () => {
  const candidates = planWorkspaceRevertCandidates([
    { id: 'e1', type: 'updated' as const, path: 'agent.py', version: 2, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T09:00:00.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'mine.py', version: 2, actor: 'USER' as const, actorId: null, at: '2026-10-28T09:00:01.000Z' },
  ])
  eq(shouldRevertPath(candidates[0], 'AGENT_ONLY'), true, 'agent 收尾 ⇒ 撤')
  eq(shouldRevertPath(candidates[1], 'AGENT_ONLY'), false, '★ 用户手写收尾 ⇒ 默认不撤')

  const preview = buildWorkspaceRevertPreview(candidates, 'AGENT_ONLY')
  eq(preview.restore.join(','), 'agent.py', '预演：会还原 agent.py')
  eq(preview.skip.map((item) => `${item.path}:${item.reason}`).join(','), 'mine.py:USER_EDIT_EXCLUDED', '★ 预演：mine.py 明确标"故意不动"')

  const all = buildWorkspaceRevertPreview(candidates, 'ALL')
  eq(all.restore.sort().join(','), 'agent.py,mine.py', '★ 显式 ALL：两条都撤（勾了就要回退）')
})

it('S7 用户手写被 agent 覆盖 ⇒ 回滚到「你最后一次手写之后」，不是段初', () => {
  // 段初 v10 → 用户手写 v11 → agent 覆盖 v12。撤 agent 不能把 v11 一起冲掉。
  const candidates = planWorkspaceRevertCandidates([
    { id: 'e0', type: 'updated' as const, path: 'A', version: 10, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T08:00:00.000Z' },
    { id: 'e1', type: 'updated' as const, path: 'A', version: 11, actor: 'USER' as const, actorId: null, at: '2026-10-28T09:00:00.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'A', version: 12, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T09:00:01.000Z' },
  ])
  const candidate = candidates[0]
  eq(candidate.lastActor, 'AGENT', '这一段最后是 agent 写的 ⇒ 默认范围内可撤')
  eq(candidate.touchesUserEdit, true, '段内出现过用户手写')
  const rollback = revertRollbackVersion(candidate)
  eq(rollback.version, 11, '★ 回滚点 = 最后一跳（v12）的前一版 v11')
})

it('S8 只有一跳 ⇒ 回滚点 = 它的前一版（与"段初"同值）', () => {
  const candidates = planWorkspaceRevertCandidates([
    { id: 'e1', type: 'updated' as const, path: 'A', version: 5, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T09:00:00.000Z' },
  ])
  const rollback = revertRollbackVersion(candidates[0])
  eq(rollback.version, 4, 'v5 的前一版 = v4')
})

it('S9 只有 USER 才算「变更历史」；SYSTEM / AGENT 一律分「本轮 / 更早」', () => {
  // ★ 2026-10-28 浏览器实测修正：原来"有 AGENT 才 rounds"，但真跑过的会话事件常常全是
  //   `SYSTEM`（对账 / clone / 引擎写），会话 01a17c6d 一条 AGENT 都没有 ⇒ 被判成「变更历史」。
  eq(workspaceChangeGrouping([{ actor: 'USER' as const }]), 'history', '纯手写 ⇒ 平铺历史')
  eq(workspaceChangeGrouping([{ actor: 'USER' as const }, { actor: 'SYSTEM' as const }]), 'rounds', '有 SYSTEM（clone/对账）⇒ 分两段')
  eq(workspaceChangeGrouping([{ actor: 'USER' as const }, { actor: 'AGENT' as const }]), 'rounds', '有 agent ⇒ 分两段')
  eq(workspaceChangeGrouping([]), 'history', '空清单 ⇒ history（不编造空的本轮）')
})

it('S9b 默认撤销范围：手写收尾不撤，SYSTEM / AGENT 收尾都撤', () => {
  // ★ 2026-10-28 实测修正：原来只认 AGENT ⇒ 全是 SYSTEM 的会话"默认只撤 agent"等于什么都不撤。
  eq(shouldRevertPath({ path: 'a', lastActor: 'USER' as const }, 'AGENT_ONLY'), false, '手写收尾 ⇒ 不撤')
  eq(shouldRevertPath({ path: 'b', lastActor: 'SYSTEM' as const }, 'AGENT_ONLY'), true, 'SYSTEM 收尾（引擎/clone）⇒ 撤')
  eq(shouldRevertPath({ path: 'c', lastActor: 'AGENT' as const }, 'AGENT_ONLY'), true, 'agent 收尾 ⇒ 撤')
})

it('S10 预演：本轮新建 ⇒ 会删除；净变化为零 ⇒ 跳过', () => {
  const candidates = planWorkspaceRevertCandidates([
    { id: 'e1', type: 'created' as const, path: 'new.md', version: 1, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T09:00:00.000Z' },
  ])
  const preview = buildWorkspaceRevertPreview(candidates, 'AGENT_ONLY')
  eq(preview.remove.join(','), 'new.md', '段内新建 ⇒ 撤销 = 删除')
  eq(preview.restore.length, 0, '没有要还原的')
})

it('S13 撤销 = 退一步：含手写的文件选 ALL / 勾选也不会被删（会话「NGPOS星礼包」gen_doc.py）', () => {
  // ★ 2026-10-29 用户实测：agent 建 gen_doc.py（更早轮次）→ 用户手改 v2 → v3 → 点撤销，整个文件被删。
  // ★ 2026-10-29 用户定案「无论如何都是前一个版本」：撤销 = 回到最后一跳之前那一版，文件不消失。
  const candidates = planWorkspaceRevertCandidates([
    { id: 'e1', type: 'updated' as const, path: 'gen_doc.py', version: 2, actor: 'USER' as const, actorId: null, at: '2026-10-29T05:00:00.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'gen_doc.py', version: 3, actor: 'USER' as const, actorId: null, at: '2026-10-29T05:10:00.000Z' },
  ])
  const candidate = candidates[0]
  eq(candidate.previousVersion, 2, '★ 回滚点 = 前一版 v2（不是段初）')
  eq(shouldRevertPath(candidate, 'ALL'), true, 'ALL：勾了就要撤')
  eq(shouldRevertPath(candidate, 'SELECTED', ['gen_doc.py']), true, '★ SELECTED：勾了就撤')
  eq(shouldRevertPath(candidate, 'AGENT_ONLY'), false, 'AGENT_ONLY：这一跳就是你保存的 ⇒ 默认不动')

  const preview = buildWorkspaceRevertPreview([candidate], 'ALL')
  eq(preview.remove.length, 0, '★ 预演里不出现"会删除"（回滚点是 v2）')
  eq(preview.restore.join(','), 'gen_doc.py', '预演：会还原')

  // agent 建的、且"这一跳就是新建" ⇒ 退一步 = 删除（唯一的合法删除场景）
  const pure = planWorkspaceRevertCandidates([
    { id: 'e1', type: 'created' as const, path: 'pure.py', version: 1, actor: 'AGENT' as const, actorId: null, at: '2026-10-29T05:00:00.000Z' },
  ])
  eq(shouldRevertPath(pure[0], 'ALL'), true, '没有手写 ⇒ ALL 照常撤')
  eq(buildWorkspaceRevertPreview(pure, 'ALL').remove.join(','), 'pure.py', '★ 最后一跳是新建 ⇒ 撤销 = 删除')
})

it('S13b 预演与执行同源：三栏分类必须等于"按落点分类"的结果', () => {
  // ★ 2026-10-29 review：预演曾经单独传 userVersions，和执行（只认 previousVersion）分叉 ⇒
  //   弹窗写"会还原"，点下去却把文件删了。这里把"预演"和"按回滚点分类"逐条对齐。
  const candidates = planWorkspaceRevertCandidates([
    { id: 'a1', type: 'updated' as const, path: 'edited.py', version: 3, actor: 'USER' as const, actorId: null, at: '2026-10-29T05:00:00.000Z' },
    { id: 'b1', type: 'created' as const, path: 'fresh.py', version: 1, actor: 'AGENT' as const, actorId: null, at: '2026-10-29T05:00:01.000Z' },
  ])
  for (const scope of ['AGENT_ONLY', 'ALL', 'SELECTED'] as const) {
    const selected = ['edited.py', 'fresh.py']
    const preview = buildWorkspaceRevertPreview(candidates, scope, selected)
    const expected = { restore: [] as string[], remove: [] as string[] }
    for (const candidate of candidates) {
      if (!shouldRevertPath(candidate, scope, selected)) continue
      if (revertRollbackVersion(candidate).version === null) expected.remove.push(candidate.path)
      else expected.restore.push(candidate.path)
    }
    eq(preview.restore.sort().join(','), expected.restore.sort().join(','), `${scope}：还原栏与实际落点一致`)
    eq(preview.remove.sort().join(','), expected.remove.sort().join(','), `${scope}：删除栏与实际落点一致`)
  }
  // edited.py 前一版 v2 ⇒ 不删除；fresh.py 这一跳就是新建 ⇒ 删除
  eq(buildWorkspaceRevertPreview(candidates, 'ALL').remove.join(','), 'fresh.py', '★ 只有"最后一跳是新建"才进删除栏')
})

it('S14 撤销窗口取"各路径最后一跳"里最早的时刻，不是全会话第一条事件', () => {
  // ★ 2026-10-29：起点用"第一条内容事件" ⇒ 更早几轮建的文件在本窗口里第一条就是 created
  //   ⇒ beforeVersion = null ⇒ ALL 判"段初不存在"⇒ 删除。窗口必须是本轮。
  const events = planWorkspaceRevertCandidates([
    { id: 'e1', type: 'created' as const, path: 'gen_doc.py', version: 1, actor: 'AGENT' as const, actorId: null, at: '2026-10-28T08:00:00.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'gen_doc.py', version: 2, actor: 'USER' as const, actorId: null, at: '2026-10-29T05:00:00.000Z' },
    { id: 'e3', type: 'updated' as const, path: 'gen_doc.py', version: 3, actor: 'USER' as const, actorId: null, at: '2026-10-29T05:10:00.000Z' },
  ])
  // 全量窗口（旧口径）：第一条是 created ⇒ 段初不存在
  eq(events[0].beforeVersion, null, '旧口径（全量窗口）会把"更早轮次新建"看成"本段新建"')
  // 本轮窗口（新口径）：只看最后一跳 v3 ⇒ 段初 = v2（用户手写），撤销回到 v2，文件仍在
  const roundWindow = planWorkspaceRevertCandidates([
    { id: 'e3', type: 'updated' as const, path: 'gen_doc.py', version: 3, actor: 'USER' as const, actorId: null, at: '2026-10-29T05:10:00.000Z' },
  ])
  eq(roundWindow[0].beforeVersion, 2, '★ 本轮窗口：段初 = 前一版 v2（不是"不存在"）')
})

it('S15 回滚点不看范围：无论选哪个，都只退到"前一版"', () => {
  // ★ 2026-10-29 用户定案：撤销本轮 = 文件级"撤销一步"，不存在"某个范围退回段初"。
  const candidates = planWorkspaceRevertCandidates([
    { id: 'e1', type: 'updated' as const, path: 'a.py', version: 5, actor: 'AGENT' as const, actorId: null, at: '2026-10-29T05:00:00.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'a.py', version: 6, actor: 'USER' as const, actorId: null, at: '2026-10-29T05:10:00.000Z' },
  ])
  const c = candidates[0]
  eq(revertRollbackVersion(c).version, 5, '★ 回滚到 v5（前一版），不是段初 v4')
  // 只有一跳且"这一跳就是新建" ⇒ 退一步 = 删除
  eq(revertRollbackVersion(planWorkspaceRevertCandidates([
    { id: 'x', type: 'created' as const, path: 'b.py', version: 1, actor: 'AGENT' as const, actorId: null, at: '2026-10-29T05:00:00.000Z' },
  ])[0]).version, null, '最后一跳是新建 ⇒ 退一步 = 删除')
})

it('S10b 纯手写文件：退一步到前一版，不会把文件删掉', () => {
  const candidates = planWorkspaceRevertCandidates([
    { id: 'e1', type: 'created' as const, path: 'u.txt', version: 1, actor: 'USER' as const, actorId: null, at: '2026-10-28T10:00:00.000Z' },
    { id: 'e2', type: 'updated' as const, path: 'u.txt', version: 2, actor: 'USER' as const, actorId: null, at: '2026-10-28T10:00:01.000Z' },
  ])
  const c = candidates[0]
  // 最后一跳是 v2 ⇒ 退一步 = v1（文件仍在）；段初（不存在）不再参与回滚点
  eq(revertRollbackVersion(c).version, 1, '★ 回滚到 v1（前一版），不是 null（删除）')
  eq(c.beforeVersion, null, 'beforeVersion 仍记录"本轮从"新建"开始（只用于展示）')
  // 只有"最后一跳本身就是新建"时，退一步才等于删除
  const onlyCreate = planWorkspaceRevertCandidates([
    { id: 'x1', type: 'created' as const, path: 'n.txt', version: 1, actor: 'USER' as const, actorId: null, at: '2026-10-28T10:00:00.000Z' },
  ])[0]
  eq(revertRollbackVersion(onlyCreate).version, null, '最后一跳是新建 ⇒ 退一步 = 删除')
})

it('S12 段内净变化为零 ⇒ 不显示（v1 与段末 hash 相同）', () => {
  // ★ 2026-10-28 浏览器实测：conftest.py「更早」是 v1→v37，两版 hash 完全相同（改了又改回）
  //   ⇒ 徽标 +0 −0，白占一行。判据要比**段内段末**与基线，而不是只比当前内容。
  const states = new Map([['f', { version: 38, deleted: false, contentHash: 'h38' }]])
  const hashes: Record<string, string> = { 'f@1': 'same', 'f@37': 'same' }
  const hashOf = (path: string, version: number): string | undefined => hashes[`${path}@${version}`]
  eq(
    isWorkspaceChangeStillPresent({ path: 'f', type: 'updated', beforeVersion: 1, version: 37 }, states, hashOf),
    false,
    '★ 段初与段末内容相同 ⇒ 这一段没改动，不显示',
  )
  hashes['f@37'] = 'diff'
  eq(
    isWorkspaceChangeStillPresent({ path: 'f', type: 'updated', beforeVersion: 1, version: 37 }, states, hashOf),
    true,
    '段末与段初不同 ⇒ 保留',
  )
})

it('S11 更早的基线取 created 的版本（不是 null）：单文件多次改动 ⇒ v1→vN', () => {
  // ★ 2026-10-28 浏览器实测：a.txt 被 user 改了 3 次（v1 建、v2、v3、v4），清单显示
  //   `更早 vNone→v3`，点开差异是"整篇新增"而不是 v1→v3。这是 `beforeOf(first)` 的错。
  const rows = [
    { id: 'e1', type: 'created' as const, path: 'demo/a.txt', version: 1, actor: 'USER' as const, actorId: null, at: '2026-10-28T10:57:50.113Z' },
    { id: 'e2', type: 'updated' as const, path: 'demo/a.txt', version: 2, actor: 'USER' as const, actorId: null, at: '2026-10-28T10:57:50.433Z' },
    { id: 'e3', type: 'updated' as const, path: 'demo/a.txt', version: 3, actor: 'USER' as const, actorId: null, at: '2026-10-28T10:57:50.662Z' },
    { id: 'e4', type: 'updated' as const, path: 'demo/a.txt', version: 4, actor: 'USER' as const, actorId: null, at: '2026-10-28T10:58:06.204Z' },
  ]
  const previousCache = new Map<string, number | null>()
  const latest = new Map<string, number>()
  for (const e of rows) {
    previousCache.set(`${e.path}\u0000${e.at}\u0000${e.id}`, latest.get(e.path) ?? null)
    latest.set(e.path, e.version)
  }
  const beforeOf = (e: { id: string; path: string; at: string }): number | null =>
    previousCache.get(`${e.path}\u0000${e.at}\u0000${e.id}`) ?? null
  const split = splitWorkspaceChangesByRound(rows, beforeOf)
  eq(split.current.length, 1, '本轮一条（最后一跳）')
  eq(split.current[0].version, 4, '本轮末版本 v4')
  eq(split.current[0].beforeVersion, 3, '本轮基线 = v3（前一跳）')
  eq(split.earlier.length, 1, '更早一条')
  eq(split.earlier[0].version, 3, '更早末版本 v3')
  eq(split.earlier[0].beforeVersion, 1, '★ 更早基线 = v1（created 的版本），不是 null')
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
  eq(scannedRepos[0], { path: '', branch: 'master', detached: false, cloning: false }, '根仓库：读 `.git/HEAD`')
  eq(
    scannedRepos[1],
    { path: 'qatt-platform-qa', branch: 'feat-x', detached: false, cloning: false },
    '`.git` 是文件（worktree）⇒ 顺着 `gitdir:` 读到那个 HEAD',
  )
})

// ⑤ P1-24：clone / pull 进行中（`index.lock` / `shallow.lock` 还在，HEAD 还没写完）——
//    面板据此推迟"已就绪"，否则 clone 中途的半棵树会被当成新文件而层层展开。
const cloningRoot = await mkdtemp(join(tmpdir(), 'ws-gitcloning-'))
await mkdir(join(cloningRoot, 'depth1', '.git'), { recursive: true })
await writeFile(join(cloningRoot, 'depth1', '.git', 'HEAD'), 'ref: refs/heads/main\n')
await writeFile(join(cloningRoot, 'depth1', '.git', 'shallow.lock'), '')
await mkdir(join(cloningRoot, 'fresh', '.git'), { recursive: true })
await writeFile(join(cloningRoot, 'fresh', '.git', 'index.lock'), '')
const cloningRepos = await scanGitReposUnder(cloningRoot)
await rm(cloningRoot, { recursive: true, force: true })

it('R5 scanGitReposUnder：clone/pull 进行中（shallow.lock / index.lock，甚至 HEAD 还没写）⇒ cloning=true', () => {
  eq(
    cloningRepos,
    [
      { path: 'depth1', branch: 'main', detached: false, cloning: true },
      { path: 'fresh', branch: null, detached: false, cloning: true },
    ],
    '`--depth` 浅克隆 + 索引锁都被认成进行中；只有 `.git/index.lock`、没有 HEAD 的半截仓库也报出来（不当成"没有 git"）',
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

// ───────────────────────────── Z zip 编码（2026-10-29 按目录下载） ─────────────────────────────
it('Z1 crc32：与已知值一致（"123456789" ⇒ 0xCBF43926）', () => {
  eq(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926, 'CRC-32 标准校验值')
  eq(crc32(Buffer.alloc(0)), 0, '空数据 = 0')
})

it('Z2 zipEntryName：反斜杠归一、去掉前导 `/` 与 `./`（包里不许出现绝对路径）', () => {
  eq(zipEntryName('dir\\a.txt'), 'dir/a.txt', '反斜杠')
  eq(zipEntryName('/etc/passwd'), 'etc/passwd', '前导斜杠')
  eq(zipEntryName('./x/./y'), 'x/y', '`.` 段丢弃')
  eq(zipEntryName(''), '', '空名 ⇒ 空（调用方丢弃）')
})

it('Z3 buildZip：结构可解析（本地头 / 中央目录 / EOCD 三处偏移自洽）', () => {
  const body = buildZip([
    { name: 'a.txt', data: Buffer.from('hello', 'utf8') },
    { name: 'dir/b.bin', data: Buffer.from([0, 1, 2]) },
  ])
  eq(body.readUInt32LE(0), 0x04034b50, '本地头签名')
  eq(body.readUInt16LE(6), 0x0800, 'UTF-8 标志位（bit 11）')
  eq(body.readUInt16LE(8), 0, 'stored（不压缩）')
  eq(body.readUInt32LE(14), crc32(Buffer.from('hello', 'utf8')), '第一条的 CRC')
  eq(body.readUInt32LE(18), 5, '第一条的压缩后大小')
  eq(body.readUInt32LE(22), 5, '第一条的原始大小')
  eq(body.readUInt16LE(26), 5, '第一条的文件名长度（a.txt）')
  // EOCD 在末尾 22 字节
  const eocd = body.byteLength - 22
  eq(body.readUInt32LE(eocd), 0x06054b50, 'EOCD 签名')
  eq(body.readUInt16LE(eocd + 8), 2, '条目总数')
  eq(body.readUInt16LE(eocd + 10), 2, '中央目录条目总数')
  const centralSize = body.readUInt32LE(eocd + 12)
  const centralOffset = body.readUInt32LE(eocd + 16)
  eq(centralOffset + centralSize, eocd, '中央目录紧贴 EOCD 之前（偏移链自洽）')
  eq(body.readUInt32LE(centralOffset), 0x02014b50, '中央目录签名')
  eq(body.readUInt32LE(centralOffset + 42), 0, '第一条的本地头偏移 = 0')
  // 第二条的本地头偏移 = 第一条（30 + 5 名 + 5 数据）
  eq(body.readUInt32LE(centralOffset + 46 + 5 + 42), 40, '第二条的本地头偏移')
})

it('Z4 buildZip：空名条目被丢弃；全空 ⇒ 合法空包', () => {
  const body = buildZip([{ name: '', data: Buffer.from('x') }])
  const eocd = body.byteLength - 22
  eq(body.readUInt32LE(eocd), 0x06054b50, '仍是合法 EOCD')
  eq(body.readUInt16LE(eocd + 8), 0, '条目数 0')
})

// ───────────────────────────── E 产物延期（2026-10-29：延期几天 / 延到某日 / 永久） ─────────────────────────────
const NOW = new Date('2026-10-29T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

it('E1 defaultArtifactExpiresAt：保留期 > 0 ⇒ created + N 天；≤ 0 ⇒ null（永久）', () => {
  const created = new Date('2026-10-29T08:00:00.000Z')
  eq(defaultArtifactExpiresAt(created, 7)?.toISOString(), '2026-11-05T08:00:00.000Z', '7 天')
  eq(defaultArtifactExpiresAt(created, 0), null, '0 = 永久保存')
})

it('E2 resolveArtifactExpiry · DAYS：从"较晚的那个"往后推（已过期 ⇒ 从现在起算）', () => {
  const future = new Date(NOW.getTime() + 2 * DAY)
  eq(resolveArtifactExpiry(future, { mode: 'DAYS', days: 3 }, NOW), { ok: true, expiresAt: new Date(NOW.getTime() + 5 * DAY) }, '未过期 ⇒ 到期日 + 3 天')
  const past = new Date(NOW.getTime() - 10 * DAY)
  eq(resolveArtifactExpiry(past, { mode: 'DAYS', days: 3 }, NOW), { ok: true, expiresAt: new Date(NOW.getTime() + 3 * DAY) }, '已过期 ⇒ 从今天起算（不会仍落在过去）')
  assert(resolveArtifactExpiry(future, { mode: 'DAYS', days: 0 }, NOW).ok === false, '0 天 ⇒ 拒绝')
  assert(resolveArtifactExpiry(future, { mode: 'DAYS', days: ARTIFACT_EXTEND_MAX_DAYS + 1 }, NOW).ok === false, '超过上限 ⇒ 拒绝')
  assert(resolveArtifactExpiry(future, { mode: 'DAYS', days: 1.5 }, NOW).ok === false, '非整数 ⇒ 拒绝')
})

it('E3 resolveArtifactExpiry · UNTIL / FOREVER：只能往后推；永久不再延期', () => {
  const current = new Date(NOW.getTime() + 2 * DAY)
  const later = new Date(NOW.getTime() + 10 * DAY).toISOString()
  eq(resolveArtifactExpiry(current, { mode: 'UNTIL', until: later }, NOW), { ok: true, expiresAt: new Date(later) }, '更晚 ⇒ 生效')
  assert(resolveArtifactExpiry(current, { mode: 'UNTIL', until: new Date(NOW.getTime() + DAY).toISOString() }, NOW).ok === false, '早于当前到期 ⇒ 拒绝（那是缩短保留期）')
  assert(resolveArtifactExpiry(current, { mode: 'UNTIL', until: new Date(NOW.getTime() - DAY).toISOString() }, NOW).ok === false, '早于现在 ⇒ 拒绝')
  assert(resolveArtifactExpiry(current, { mode: 'UNTIL', until: 'not-a-date' }, NOW).ok === false, '解析不出 ⇒ 拒绝')
  eq(resolveArtifactExpiry(current, { mode: 'FOREVER' }, NOW), { ok: true, expiresAt: null }, '永久保存 ⇒ expiresAt=null')
  assert(resolveArtifactExpiry(null, { mode: 'DAYS', days: 3 }, NOW).ok === false, '已经是永久 ⇒ 不再延期（给出理由）')
  assert(resolveArtifactExpiry(null, { mode: 'FOREVER' }, NOW).ok === false, '永久 + 永久 ⇒ 同样拒绝（幂等由前端禁用入口保证）')
})

it('E4 isArtifactExpired：永久（null）永不到期；到期时刻 <= now 即可清理', () => {
  eq(isArtifactExpired(null, new Date('2099-01-01T00:00:00.000Z')), false, '永久保存：100 年后也不删')
  eq(isArtifactExpired(new Date(NOW.getTime()), NOW), true, '恰好到点 ⇒ 过期（与 SQL 的 <= 同源）')
  eq(isArtifactExpired(new Date(NOW.getTime() + 1), NOW), false, '差 1ms ⇒ 未过期')
})

console.log('')
console.log(`workspace-regression：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)