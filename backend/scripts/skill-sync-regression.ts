#!/usr/bin/env node
/**
 * skill-sync-regression.ts —— P1-24b-1（TaskAgent 宿主副本与同步）的**无 DB / 无 S3 / 无容器**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend skill-sync:regression`
 *      （= `node --import tsx scripts/skill-sync-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/06-实施计划.md` P1-24b-1 验收项 + `docs/子方案/Skill能力.md` §3.2 / §4.13 / §4.14 / §4.16。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 守的是这几条（每一条都对应一个"只在运行期才暴露"的错法）
 * ─────────────────────────────────────────────────────────────────────
 * ① **mount 规格**：`buildSandboxContainerSpec` 的第二条 bind —— `Source` 是绝对路径、`Target` 是
 *    `/home/agent/.skills`、**`ReadOnly: true`**；不传 `skillRootPath` 时**只有一条 mount**（旧行为不变）；
 * ② **目录结构**：`v{n}/<slug>` / `current/<slug>` / `manifest.json` 的拼法；manifest 里的 `path` /
 *    `currentPath` 都是**相对**路径（写绝对路径会在换机后指空）；`override` 恒 false / `overrideRevision` 恒 null；
 * ③ **指纹**：同一份集合两次算同一个值（顺序无关）；版本 / 名字 / slug / runtime / 工具集合任一项变化 ⇒ 变；
 *    **`overrideRevision` 为 null 时不影响既有哈希**（a-1~a-4 的指纹逐字不变），有覆写修订号时变；
 * ④ **有效性判据**（{@link manifestMatches}）：manifest 缺失 / 指纹不符 / 版本目录缺失 / current 链接
 *    指错，四条任一都判"不一致"（= 必须 rehydrate，不能当"没有 Skill"）；
 * ⑤ **空目录判据**：`v1/` 残留而有 manifest 缺失时**不是**"空目录"（由 ④ 判不一致，重写 manifest 即可，
 *    不删目录）；只有 manifest / current / overrides / vN 之外什么都没有时才算空；
 * ⑥ **prompt 目录段**：没有 Skill 时返回空串（prompt 逐字不变）；有 Skill 时给出 slug / 版本 / path /
 *    currentPath（模型跑脚本靠它定位）。
 *
 * ⚠️ 它**验不了**端到端（要 PG + MinIO + 真容器）：容器内是否真的只读、`load_skill` 是否读到新版本、
 *    宿主目录被清空后的 rehydrate 是否真的发生了 —— 那些按 `06` §六「手动 E2E」留给用户真跑。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSandboxContainerSpec, SANDBOX_AGENT_HOME, SANDBOX_SKILLS_DIR } from '../src/sandbox/spec.ts'

const {
  buildSkillManifest,
  expectedFingerprintOf,
  formatSkillCatalogPromptBlock,
  manifestMatches,
  skillCurrentPath,
  skillRuntimeDirIsEmpty,
  skillVersionDir,
  SKILL_MANIFEST_TOOL_NAMES,
} = await import('../src/sandbox/skillSync.ts')

const { needsSkillsRefresh, skillsMountHealthy, skillsRefreshPromptLine, skillToolSetOf } = await import(
  '../src/sandbox/skillContainer.ts'
)
const { readConversationSkillManifest } = await import('../src/sandbox/skillSync.ts')

import {
  SKILL_ANY_TOOL_NAMES,
  SKILL_LIST_TOOL_NAME,
  SKILL_LOAD_TOOL_NAME,
  SKILL_REQUEST_DRAFT_TOOL_NAME,
  SKILL_REQUEST_REVISION_TOOL_NAME,
  SKILL_REVISE_DRAFT_TOOL_NAME,
  SKILL_MANIFEST_FILE,
  SKILL_READ_FILE_TOOL_NAME,
  SKILL_RESULT_MAX_CHARS,
  SKILLS_REFRESH_COMMAND,
  buildSkillOpenAiTools,
  formatSkillPageText,
  isSafeSkillPath,
  normalizeSkillPagingArgs,
  sha256Hex,
  skillCatalogFingerprintLines,
  skillDirInContainer,
  skillManifestFingerprint,
  skillPageOf,
} from '@doubulea/shared'

const {
  SKILL_SCRIPT_RULES,
  binsProbeCommand,
  declaredBinsOf,
  findBareScriptPathMentions,
  formatSkillBinsWarningBlock,
  parseBinsProbe,
  shouldProbeBins,
  skillDirAbsoluteOf,
  skillDirOfEntry,
  splitBinsForProbe,
} = await import('../src/sandbox/skillScript.ts')

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

/** 造一条 desired 项 */
function desired(
  id: string,
  slug: string,
  overrides: Partial<{ name: string; description: string; version: number; runtime: 'INLINE' | 'SANDBOX'; bins: string[] }> = {},
) {
  return {
    id,
    slug,
    name: overrides.name ?? `Skill ${slug}`,
    description: overrides.description ?? '做某件重复流程时使用',
    version: overrides.version ?? 1,
    runtime: overrides.runtime ?? 'INLINE',
    requiresBins: overrides.bins ?? [],
    overrideRevision: null,
  }
}

// ═════════════════════════════════════════════════════════════════════
// ① mount 规格
// ═════════════════════════════════════════════════════════════════════
{
  const limits = { memMb: 1024, cpu: 1, pids: 256, tmpfsMb: 64 }
  const base = {
    image: 'doubulea/sandbox-runtime:none-v1',
    conversationId: '00000000-0000-4000-8000-000000000001',
    volumeName: 'doubulea-work-1',
    workspacePath: '/var/lib/doubulea/workspaces/c1',
    startedAt: new Date('2026-11-16T00:00:00Z'),
    network: 'doubulea-sandbox',
    limits,
    env: {},
  }

  check('挂载点常量 = /home/agent/.skills', SANDBOX_SKILLS_DIR === `${SANDBOX_AGENT_HOME}/.skills`)

  const withoutSkills = buildSandboxContainerSpec(base)
  const mountsWithout = (withoutSkills.HostConfig?.Mounts ?? []) as { Target?: string }[]
  check('不传 skillRootPath ⇒ 只有 /work 一条 mount（旧行为逐字不变）', mountsWithout.length === 1, String(mountsWithout.length))

  const withSkills = buildSandboxContainerSpec({ ...base, skillRootPath: '/var/lib/doubulea/skills/c1' })
  const mounts = (withSkills.HostConfig?.Mounts ?? []) as {
    Type?: string
    Source?: string
    Target?: string
    ReadOnly?: boolean
  }[]
  check('传了 skillRootPath ⇒ 两条 mount', mounts.length === 2, String(mounts.length))
  const skillMount = mounts.find((mount) => mount.Target === SANDBOX_SKILLS_DIR)
  check('第二条 mount 的 Target = $HOME/.skills', skillMount !== undefined)
  check('第二条 mount 是 bind', skillMount?.Type === 'bind')
  check('第二条 mount 是**只读**（容器内写它必须 EROFS）', skillMount?.ReadOnly === true)
  check('第二条 mount 的 Source 是传进来的绝对路径', skillMount?.Source === '/var/lib/doubulea/skills/c1')
  check('第一条 mount 仍是可写的 /work', mounts[0]?.Target === '/work' && mounts[0]?.ReadOnly === false)
}

// ═════════════════════════════════════════════════════════════════════
// ② 目录结构与 manifest 形状
// ═════════════════════════════════════════════════════════════════════
{
  check('版本目录拼法 = v{n}/{slug}', skillVersionDir(2, 'report-export') === 'v2/report-export')
  check('current 路径拼法 = current/{slug}', skillCurrentPath('report-export') === 'current/report-export')
  check('manifest 文件名 = manifest.json', SKILL_MANIFEST_FILE === 'manifest.json')

  const manifest = buildSkillManifest({
    conversationId: 'c1',
    entries: [desired('skill-b', 'zeta', { version: 3 }), desired('skill-a', 'alpha')],
    generatedAt: new Date('2026-11-16T00:00:00Z'),
  })

  check('manifest 带 conversationId / maxChars / tools', manifest.conversationId === 'c1' && manifest.maxChars === SKILL_RESULT_MAX_CHARS)
  check('maxChars 与容器切片上限同值（SKILL_RESULT_MAX_CHARS）', manifest.maxChars === SKILL_RESULT_MAX_CHARS)
  check('tools[] 是完整定义（name / description / inputSchema），不是字符串', manifest.tools.every((tool) => typeof tool.description === 'string' && typeof tool.inputSchema === 'object'))
  check('tools[] 名字与固定三工具一致', manifest.tools.map((tool) => tool.name).join(',') === SKILL_MANIFEST_TOOL_NAMES.join(','))
  check('skills[] 按 slug asc 排序（同一份集合两次同步得到同一份 manifest）', manifest.skills.map((entry) => entry.slug).join(',') === 'alpha,zeta')
  check('每项的 path 是**相对**路径（v{n}/<slug>）', manifest.skills.every((entry) => !entry.path.startsWith('/') && /^v\d+\/[a-z0-9-]+$/u.test(entry.path)))
  check('每项的 currentPath = current/<slug>', manifest.skills.every((entry) => entry.currentPath === `current/${entry.slug}`))
  check(
    '覆写位先占好：override 恒 false、overrideRevision 恒 null',
    manifest.skills.every((entry) => entry.override === false && entry.overrideRevision === null),
  )
  check('requires.bins 原样带出（b-3 的预检只提示）', buildSkillManifest({ conversationId: 'c1', entries: [desired('s', 'a', { bins: ['python3'] })] }).skills[0]?.requires.bins.join(',') === 'python3')
  check('generatedAt 是 ISO 串', typeof manifest.generatedAt === 'string' && !Number.isNaN(Date.parse(manifest.generatedAt)))
  check('fingerprint 是 sha256:<64 hex>', /^sha256:[0-9a-f]{64}$/u.test(manifest.fingerprint), manifest.fingerprint)
}

// ═════════════════════════════════════════════════════════════════════
// ③ 指纹
// ═════════════════════════════════════════════════════════════════════
{
  const one = [desired('skill-a', 'report-export', { version: 1, name: '报表导出' })]
  const first = expectedFingerprintOf(one)
  const again = expectedFingerprintOf([...one])
  check('同一份集合两次算的指纹逐字相同（确定性）', first === again)

  check('顺序无关（调用方排序后再算）', expectedFingerprintOf([desired('a', 'x'), desired('b', 'y')]) === expectedFingerprintOf([desired('b', 'y'), desired('a', 'x')]))
  check('版本变化 ⇒ 指纹变化', expectedFingerprintOf(one) !== expectedFingerprintOf([desired('skill-a', 'report-export', { version: 2, name: '报表导出' })]))
  check('name / description 变化**不进** manifest 指纹（模型看到的是 load_skill 的正文，不是目录）', first === expectedFingerprintOf([desired('skill-a', 'report-export', { version: 1, name: '改个名', description: '改了用途' })]))
  check('slug 变化 ⇒ 指纹变化', first !== expectedFingerprintOf([desired('skill-a', 'other-slug', { version: 1, name: '报表导出' })]))
  check('runtime 变化 ⇒ 指纹变化', first !== expectedFingerprintOf([desired('skill-a', 'report-export', { version: 1, name: '报表导出', runtime: 'SANDBOX' })]))
  check(
    '工具集合变化 ⇒ 指纹变化（0→N / N→0 要触发 refresh）',
    expectedFingerprintOf(one) !== expectedFingerprintOf(one, ['list_skills']),
  )
  check(
    '同 id 不同 Skill（同名不同人）⇒ 指纹变化',
    expectedFingerprintOf([desired('skill-a', 'report-export')]) !== expectedFingerprintOf([desired('skill-c', 'report-export')]),
  )

  // ★ overrideRevision 是 c-4b 才有的维度：
  const noOverride = buildSkillManifest({ conversationId: 'c1', entries: one })
  const withOverride = buildSkillManifest({
    conversationId: 'c1',
    entries: [{ ...one[0]!, overrideRevision: 2 }],
  })
  check('overrideRevision 变化 ⇒ 指纹变化（改了覆写但不改上游版本也要同步）', noOverride.fingerprint !== withOverride.fingerprint)
  const withOverrideManifestEntry = withOverride.skills[0]
  check('有覆写修订号时 override=true / overrideRevision=2', withOverrideManifestEntry?.override === true && withOverrideManifestEntry?.overrideRevision === 2)

  // ★ 与 ChatBot 的目录指纹共用"目录行"实现：overrideRevision 为 null 时行逐字不变
  const catalogLine = skillCatalogFingerprintLines([{ slug: 'a', version: 1, name: 'n', description: 'd' }]).join('\n')
  const catalogLineNull = skillCatalogFingerprintLines([{ slug: 'a', version: 1, name: 'n', description: 'd', overrideRevision: null }]).join('\n')
  check('overrideRevision=null 时目录行逐字相同（a-1~a-4 的既有指纹不变）', catalogLine === catalogLineNull)
  const catalogLineRev = skillCatalogFingerprintLines([{ slug: 'a', version: 1, name: 'n', description: 'd', overrideRevision: 1 }]).join('\n')
  check('overrideRevision=1 时目录行多一段（c-4b 落地时即可生效）', catalogLineRev !== catalogLine && catalogLineRev.endsWith('\u0000r1'))
  check('sha256Hex 与 Node crypto 的已知向量一致（容器侧会拿 Node crypto 复算）', sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')

  // 指纹的底层实现与"目录行"不同：manifest 指纹还要含 id / runtime / tools
  check(
    'manifest 指纹 ≠ 目录指纹（两者职责不同：容器要不要重读 vs 提示缓存）',
    skillManifestFingerprint({ entries: [{ id: 'skill-a', slug: 'report-export', version: 1, overrideRevision: null, runtime: 'INLINE' }], toolNames: [] }) !==
      'sha256:' + sha256Hex(catalogLine),
  )
}

// ═════════════════════════════════════════════════════════════════════
// ④ 有效性判据（manifestMatches）—— 四条判据任一不满足都算"不一致"
// ═════════════════════════════════════════════════════════════════════
{
  const desiredEntries = [desired('skill-a', 'report-export', { version: 2 })]
  const expected = buildSkillManifest({ conversationId: 'c1', entries: desiredEntries })
  const expectedPath = 'v2/report-export'

  /** 默认全部"存在 / 指对"的假 FS */
  const fs = (overrides: { dirMissing?: string; linkWrong?: string; linkMissing?: string } = {}) => ({
    dirExists: async (relative: string) => relative !== overrides.dirMissing,
    readLink: async (relative: string) => {
      if (relative === overrides.linkMissing) return null
      if (relative === overrides.linkWrong) return '../v9/report-export'
      return `../${expectedPath}`
    },
  })

  check('manifest 缺失 ⇒ 不一致（rehydrate）', !(await manifestMatches(expected, null, fs())))
  check('完全一致 ⇒ 一个文件都不动', await manifestMatches(expected, expected, fs()))
  check(
    '指纹不符（上游改了版本）⇒ 不一致',
    !(await manifestMatches(expected, { ...expected, fingerprint: `sha256:${'0'.repeat(64)}` }, fs())),
  )
  check('版本目录缺失（换机 / reaper 清过）⇒ 不一致', !(await manifestMatches(expected, expected, fs({ dirMissing: expectedPath }))))
  check('current 链接缺失 ⇒ 不一致', !(await manifestMatches(expected, expected, fs({ linkMissing: 'current/report-export' }))))
  check(
    'current 链接指错版本 ⇒ 不一致（脚本会跑错版本）',
    !(await manifestMatches(expected, expected, fs({ linkWrong: 'current/report-export' }))),
  )

  // 空 manifest（0 个 Skill）也必须是"可比对的"：没有 Skill 时不该每轮都重写
  const emptyManifest = buildSkillManifest({ conversationId: 'c1', entries: [] })
  check('0 个 Skill 的两份 manifest 判等（不每轮重写）', await manifestMatches(emptyManifest, emptyManifest, fs()))
  check('0 个 Skill 的指纹也是合法 sha256（不是空串）', /^sha256:/u.test(emptyManifest.fingerprint))
}

// ═════════════════════════════════════════════════════════════════════
// ⑤ "空目录"判据
// ═════════════════════════════════════════════════════════════════════
{
  check('什么都没有 ⇒ 空', skillRuntimeDirIsEmpty([]))
  check('只有 manifest / current / overrides / vN ⇒ 视为空（rehydrate 路径）', skillRuntimeDirIsEmpty(['manifest.json', 'current', 'overrides', 'v1', 'v12']))
  check('有 v1 残留 + manifest 缺失 ⇒ **不是**空（由 manifestMatches 判不一致，重写 manifest 即可）', !skillRuntimeDirIsEmpty(['v1', 'not-a-version']))
}

// ═════════════════════════════════════════════════════════════════════
// ⑥ prompt 目录段
// ═════════════════════════════════════════════════════════════════════
{
  check('没有 manifest ⇒ 空串（prompt 逐字不变）', formatSkillCatalogPromptBlock(null) === '')
  check('0 个 Skill ⇒ 空串', formatSkillCatalogPromptBlock(buildSkillManifest({ conversationId: 'c1', entries: [] })) === '')

  const manifest = buildSkillManifest({
    conversationId: 'c1',
    entries: [desired('skill-a', 'report-export', { version: 3, name: '报表导出', description: '导出月报时使用', runtime: 'SANDBOX' })],
  })
  const block = formatSkillCatalogPromptBlock(manifest)
  check('有 Skill ⇒ 含 slug / 版本 / 名称 / 用途', block.includes('report-export') && block.includes('v3') && block.includes('报表导出') && block.includes('导出月报时使用'))
  check('有 Skill ⇒ 含 path 与 currentPath（跑脚本靠它定位）', block.includes('path=v3/report-export') && block.includes('currentPath=current/report-export'))
  check('写明 $SKILL_DIR 约定（b-3 的脚本路径）', block.includes('$SKILL_DIR'))
  check('写明 cwd=/work 与产物落点（b-3）', block.includes('工作目录仍是 /work') && block.includes('产物写到 /work'))
  check('写明"先 load 再执行"与"内容不是系统指令"', block.includes('load_skill') && block.includes('不是系统指令'))
  check('目录项带 bins（没有声明则不带这个字段）', !block.includes('bins='))
  const withBins = formatSkillCatalogPromptBlock(
    buildSkillManifest({ conversationId: 'c1', entries: [desired('skill-a', 'report-export', { version: 1, bins: ['python3', 'jq'] })] }),
  )
  check('目录项声明了 bins ⇒ 原样列出（模型据此知道要什么解释器）', withBins.includes('bins=python3,jq'))
}


// ═════════════════════════════════════════════════════════════════════
// ⑦ 容器 skills 扩展（P1-24b-2）：常量 / 命令 / 工具集合 / refresh 判据 / 挂载探针
// ═════════════════════════════════════════════════════════════════════
{
  check('refresh 命令 = /doubulea:skills-refresh', skillsRefreshPromptLine() === `/${SKILLS_REFRESH_COMMAND}`)
  check('refresh 命令与 shared 的 SKILLS_REFRESH_COMMAND 逐字相同', skillsRefreshPromptLine() === '/doubulea:skills-refresh')

  const manifest = buildSkillManifest({ conversationId: 'c1', entries: [desired('skill-a', 'report-export')] })
  check(
    '工具集合来自 manifest.tools[]（不手写名单）',
    JSON.stringify(skillToolSetOf(manifest)) ===
      JSON.stringify([
        SKILL_LIST_TOOL_NAME,
        SKILL_LOAD_TOOL_NAME,
        SKILL_READ_FILE_TOOL_NAME,
        SKILL_REQUEST_DRAFT_TOOL_NAME,
        SKILL_REQUEST_REVISION_TOOL_NAME,
        SKILL_REVISE_DRAFT_TOOL_NAME,
      ]),
  )
  check('没有 manifest ⇒ 空集合', JSON.stringify(skillToolSetOf(null)) === '[]')

  const three = [
    SKILL_LIST_TOOL_NAME,
    SKILL_LOAD_TOOL_NAME,
    SKILL_READ_FILE_TOOL_NAME,
    SKILL_REQUEST_DRAFT_TOOL_NAME,
    SKILL_REQUEST_REVISION_TOOL_NAME,
    SKILL_REVISE_DRAFT_TOOL_NAME,
  ]
  check('0→N（首次绑定）⇒ 要刷新', needsSkillsRefresh(null, three))
  check('0→0（没绑 Skill）⇒ 不刷新（一个字节都不注入）', !needsSkillsRefresh(null, []))
  check('N→N（只有版本变化）⇒ 不刷新', !needsSkillsRefresh(three, three))
  check('N→0（全部解绑）⇒ 要刷新', needsSkillsRefresh(three, []))
  check('集合相同但顺序不同 ⇒ 不刷新（按名字比较，不看顺序）', !needsSkillsRefresh([...three].reverse(), three))

  const healthy = { isDirectory: true, manifest: { conversationId: 'c1' } }
  check('挂载健康：目录在 + manifest 是本会话', skillsMountHealthy(healthy, 'c1'))
  check('空 Skill 集合也是健康的（目录在、manifest 对）', skillsMountHealthy(healthy, 'c1'))
  check('不是目录 ⇒ 重建', !skillsMountHealthy({ ...healthy, isDirectory: false }, 'c1'))
  check('读不到 manifest ⇒ 重建', !skillsMountHealthy({ isDirectory: true, manifest: null }, 'c1'))
  check('manifest 属于别的会话（bind 源指错）⇒ 重建', !skillsMountHealthy(healthy, 'c2'))

  // 宿主编译产物里确实有这个函数（b-2 用它做探针）
  check('readConversationSkillManifest 已导出（挂载探针用）', typeof readConversationSkillManifest === 'function')
  // 挂载点常量与容器扩展的默认值同源
  check('SANDBOX_SKILLS_DIR = /home/agent/.skills', SANDBOX_SKILLS_DIR === `${SANDBOX_AGENT_HOME}/.skills`)
}

// ═════════════════════════════════════════════════════════════════════
// ⑧ 容器扩展源码与 shared 的契约逐字一致（skill:contract 的 b-2 部分）
// ═════════════════════════════════════════════════════════════════════
/** 仓库根（脚本在 `backend/scripts/`；锚在这里，容器侧路径一律从根往下拼，不数 `..`） */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const extensionDir = join(repoRoot, 'infra/sandbox/base/pi-agent/extensions/skills')
const contractSource = readFileSync(join(extensionDir, 'contract.ts'), 'utf8')
const indexSource = readFileSync(join(extensionDir, 'index.ts'), 'utf8')

/** 从容器 `contract.ts` 里读一个常量的**右值文本**（`export const NAME = 8000 - 512`） */
function contractConstExpr(name: string): string | null {
  const match = new RegExp(`export const ${name} = ([^\\n]+)`, 'u').exec(contractSource)
  return match === null ? null : (match[1] ?? '').trim()
}

/** 容器副本的常量值：先把 `SKILL_RESULT_MAX_CHARS` 这个标识符换成 shared 的数值再求值（只收数字与运算符） */
function contractNumber(name: string): number | null {
  const expr = contractConstExpr(name)
  if (expr === null) return null
  const substituted = expr.replaceAll('SKILL_RESULT_MAX_CHARS', String(SKILL_RESULT_MAX_CHARS))
  if (!/^[\d\s+\-*/()]+$/u.test(substituted)) return null
  return Number(Function(`"use strict"; return (${substituted});`)())
}

{
  check('容器副本 SKILL_RESULT_MAX_CHARS 与 shared 同值', contractNumber('SKILL_RESULT_MAX_CHARS') === SKILL_RESULT_MAX_CHARS)
  check('容器副本 SKILL_PAGE_DEFAULT_LIMIT 与 shared 同值', contractNumber('SKILL_PAGE_DEFAULT_LIMIT') === 8000 - 512)
  check('容器副本 SKILL_PAGE_MAX_LIMIT 与 shared 同值', contractNumber('SKILL_PAGE_MAX_LIMIT') === SKILL_RESULT_MAX_CHARS)
  for (const [name, expected] of [
    ['SKILL_LIST_TOOL_NAME', SKILL_LIST_TOOL_NAME],
    ['SKILL_LOAD_TOOL_NAME', SKILL_LOAD_TOOL_NAME],
    ['SKILL_READ_FILE_TOOL_NAME', SKILL_READ_FILE_TOOL_NAME],
    ['SKILL_REQUEST_DRAFT_TOOL_NAME', SKILL_REQUEST_DRAFT_TOOL_NAME],
    ['SKILL_REQUEST_REVISION_TOOL_NAME', SKILL_REQUEST_REVISION_TOOL_NAME],
    ['SKILL_REVISE_DRAFT_TOOL_NAME', SKILL_REVISE_DRAFT_TOOL_NAME],
  ] as const) {
    check(`容器扩展里 ${name} = ${expected}`, contractSource.includes(`export const ${name} = '${expected}'`))
  }
  check(
    '容器扩展里的刷新命令与 shared 逐字相同',
    contractSource.includes(`export const SKILLS_REFRESH_COMMAND = '${SKILLS_REFRESH_COMMAND}'`),
  )
  check('容器扩展里 manifest 文件名与 shared 相同', contractSource.includes(`export const SKILL_MANIFEST_FILE = '${SKILL_MANIFEST_FILE}'`))
  check('容器扩展读 DOUBULEA_SKILLS_DIR（与 spec.ts 的 env 名一致）', indexSource.includes("'DOUBULEA_SKILLS_DIR'"))
  check(
    '只读工具在容器内本地读文件；草稿入口工具才代理回 /api/sandbox/builtin/call',
    indexSource.includes(`BUILTIN_CALL${'_PATH'}`) && indexSource.includes('isSkillRequestToolName'),
  )
  check('容器扩展把 manifest 的 inputSchema 原样交给 pi（不手写第二份 schema）', indexSource.includes('inputSchema'))
}

// ── 分页算法逐字等价：用**同一段 9000 码点正文**（含 emoji）比对两边 ──
const contractModule = (await import(`${extensionDir}/contract.ts`)) as {
  skillPageOf: typeof skillPageOf
  formatSkillPageText: typeof formatSkillPageText
  normalizePagingArgs: typeof normalizeSkillPagingArgs
}
{
  const source = Array.from({ length: 9000 }, (_, index) => (index % 701 === 0 ? '🙂' : String.fromCharCode(0x4e00 + (index % 2000)))).join('')
  let same = true
  for (const [offset, limit] of [[0, 7488], [7488, 7488], [9000, 7488], [0, 99999], [500, 1]] as const) {
    const a = skillPageOf(source, offset, limit)
    const b = contractModule.skillPageOf(source, offset, limit)
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      same = false
      break
    }
    const textA = formatSkillPageText({ title: 'Skill「报表导出」（report-export，v3）', page: a, toolName: SKILL_LOAD_TOOL_NAME, nextArgs: 'slug="report-export"' })
    const textB = contractModule.formatSkillPageText({ title: 'Skill「报表导出」（report-export，v3）', page: b, toolName: SKILL_LOAD_TOOL_NAME, nextArgs: 'slug="report-export"' })
    if (textA !== textB) {
      same = false
      break
    }
  }
  check('容器副本的 skillPageOf / formatSkillPageText 与 shared 逐字一致（9000 码点 5 组参数）', same)

  const pagingArgs = [{ offset: '12', limit: 99999 }, { limit: 0 }, { offset: -5 }, {}, null, { limit: 3.9 }]
  const pagingSame = pagingArgs.every((args) => {
    const a = normalizeSkillPagingArgs(args)
    const b = contractModule.normalizePagingArgs(args)
    return a.offset === b.offset && a.limit === b.limit
  })
  check('容器副本的入参归一化与 shared 一致（字符串 / 越界 / 小数 / null）', pagingSame)

}

{
  const containerPaths: [string, boolean][] = [
    ['SKILL.md', true],
    ['references/api.md', true],
    ['scripts/export.py', true],
    ['../etc/passwd', false],
    ['/abs/path', false],
    ['a/./b', false],
    ['a\\b', false],
    ['c:x', false],
    ['', false],
  ]
  check(
    '路径判据（安全路径放行；.. / 绝对 / 反斜杠 / 盘符 / 空串拒绝）',
    containerPaths.every(([path, ok]) => isSafeSkillPath(path) === ok),
  )
  check(
    'manifest tools 与 OpenAI tools 的工具名逐字一致（同一生成源）',
    buildSkillOpenAiTools([...SKILL_ANY_TOOL_NAMES]).map((tool) => tool.function.name).join(',') ===
      [
        SKILL_LIST_TOOL_NAME,
        SKILL_LOAD_TOOL_NAME,
        SKILL_READ_FILE_TOOL_NAME,
        SKILL_REQUEST_DRAFT_TOOL_NAME,
        SKILL_REQUEST_REVISION_TOOL_NAME,
        SKILL_REVISE_DRAFT_TOOL_NAME,
      ].join(','),
  )
}

// ═════════════════════════════════════════════════════════════════════
// ⑩ 脚本路径与预检（P1-24b-3）：$SKILL_DIR / 裸路径提示 / bins 只提示不阻断
// ═════════════════════════════════════════════════════════════════════
{
  // ── $SKILL_DIR 约定 ──
  check('$SKILL_DIR 绝对路径 = $HOME/.skills/current/<slug>', skillDirAbsoluteOf('report-export') === `${SANDBOX_SKILLS_DIR}/current/report-export`)
  check(
    '与 shared#skillDirInContainer 同值（容器扩展 / 后端拼法不漂移）',
    skillDirAbsoluteOf('report-export') === skillDirInContainer(SANDBOX_SKILLS_DIR, 'report-export'),
  )
  const entryDir = skillDirOfEntry({ currentPath: 'current/report-export' })
  check('manifest 条目的 $SKILL_DIR = 挂载点 + currentPath', entryDir === skillDirAbsoluteOf('report-export'))

  // ── 裸相对路径：只发现、不抛错、不重复 ──
  check(
    '裸 `scripts/export.py` 能被发现（只提示，不拦截导入）',
    findBareScriptPathMentions('3. 执行 `scripts/export.py` 导出').join(',') === 'scripts/export.py',
  )
  check('`$SKILL_DIR/scripts/...` 不算裸路径', findBareScriptPathMentions('执行 $SKILL_DIR/scripts/export.py').length === 0)
  check('绝对路径 `/opt/x/scripts/export.py` 不算裸路径', findBareScriptPathMentions('执行 /opt/x/scripts/export.py').length === 0)
  check(
    '同一段里出现两次只报一条',
    findBareScriptPathMentions('先 scripts/a.py 再 scripts/a.py').join(',') === 'scripts/a.py',
  )

  // ── bins：白名单 / 探针命令 / 解析 ──
  check('非法 bin 名不拼进 shell（只列入 unsupported）', binsProbeCommand(['python3; rm -rf /work']) === null && splitBinsForProbe(['python3; rm -rf /work']).unsupported.length === 1)
  check('没有 bin ⇒ 不探（null，不付一次 exec）', binsProbeCommand([]) === null && !shouldProbeBins([]))
  const cmd = binsProbeCommand(['python3', 'jq'])
  check('探针命令用 command -v 逐项判（不执行用户脚本）', cmd !== null && cmd[0] === 'sh' && cmd[2]?.includes('command -v python3') === true && cmd[2]?.includes('command -v jq') === true)
  check('声明了合法 bin ⇒ 要探', shouldProbeBins(['python3']))
  check(
    '白名单之外的名字不探、不算缺失',
    shouldProbeBins(['../evil']) === false && parseBinsProbe('', ['../evil']).missing.length === 0,
  )

  const parsed = parseBinsProbe('1 python3\n0 jq\nnoise line\n1 haskell\n', ['python3', 'jq', 'haskell'])
  check('解析：在 / 不在如实分开', parsed.present.join(',') === 'python3,haskell' && parsed.missing.join(',') === 'jq')
  check('探针没输出的行按"不在"处理（宁可多提示一次）', parseBinsProbe('', ['python3']).missing.join(',') === 'python3')

  const binsManifest = buildSkillManifest({
    conversationId: 'c1',
    entries: [
      desired('skill-a', 'report-export', { version: 2, runtime: 'SANDBOX', bins: ['python3', 'jq'] }),
      desired('skill-b', 'inline-doc', { version: 1 }),
    ],
  })
  check('declaredBinsOf 去重保序、跳过没声明的 Skill', declaredBinsOf(binsManifest).join(',') === 'python3,jq')
  check('declaredBinsOf(null) = 空（没有 manifest 就不探）', declaredBinsOf(null).length === 0)

  // ── 提示块：只提示、不阻断；不缺 ⇒ 空串（prompt 逐字不变） ──
  check('全都在 ⇒ 空串（prompt 不变）', formatSkillBinsWarningBlock(binsManifest, parseBinsProbe('1 python3\n1 jq\n', ['python3', 'jq'])) === '')
  check('没有 manifest ⇒ 空串', formatSkillBinsWarningBlock(null, { present: [], missing: ['jq'], unsupported: [] }) === '')
  check('探针没跑（null）⇒ 空串', formatSkillBinsWarningBlock(binsManifest, null) === '')
  const warning = formatSkillBinsWarningBlock(binsManifest, parseBinsProbe('1 python3\n', ['python3', 'jq']))
  check('缺 bin ⇒ 写明哪个 Skill 缺哪个 bin', warning.includes('report-export') && warning.includes('jq') && warning.includes('python3'))
  check('提示块明确"只提示、不阻断"与"不要假装执行过"', warning.includes('只提示') && warning.includes('不阻断') && warning.includes('假装'))
  check('没有声明 bins 的 Skill 不出现在提示里', !warning.includes('inline-doc'))
  const unsupportedWarning = formatSkillBinsWarningBlock(
    buildSkillManifest({ conversationId: 'c1', entries: [desired('skill-a', 'weird', { bins: ['../evil'] })] }),
    { present: [], missing: [], unsupported: ['../evil'] },
  )
  check('非法名只在提示里原样列出（未探测）', unsupportedWarning.includes('../evil') && unsupportedWarning.includes('未探测'))

  // ── 不开放 run_skill_script（第一阶段脚本只走 bash） ──
  check(
    'manifest tools 里没有 run_skill_script（脚本统一走 bash）',
    !buildSkillManifest({ conversationId: 'c1', entries: [desired('skill-a', 'x', { runtime: 'SANDBOX' })] }).tools.some((tool) => tool.name === 'run_skill_script'),
  )

  // ── 生成器不产出裸路径：本节的规则段自己不能示范裸 `scripts/` ──
  check('脚本规则段自身不出现裸 `scripts/`（免得模型照着抄）', SKILL_SCRIPT_RULES.every((rule) => findBareScriptPathMentions(rule).length === 0))
}

// ═════════════════════════════════════════════════════════════════════
// ⑨ 镜像层：版本号 + 构建期断言（漏了就是"构建成功但跑的是上一版"）
// ═════════════════════════════════════════════════════════════════════
{
  const versionsSource = readFileSync(join(repoRoot, 'infra/sandbox/versions.mjs'), 'utf8')
  const baseMatch = /export const BASE_LAYER_VERSION = '(\d+)'/u.exec(versionsSource)
  const toolkitMatch = /export const TOOLKIT_LAYER_VERSION = '(\d+)'/u.exec(versionsSource)
  check('base 层版本 ≥ 8（b-2 加了 skills 扩展）', baseMatch !== null && Number(baseMatch[1]) >= 8, baseMatch?.[1] ?? 'missing')
  check('toolkit 层版本 ≥ 11（跟随 base 换 tag）', toolkitMatch !== null && Number(toolkitMatch[1]) >= 11, toolkitMatch?.[1] ?? 'missing')

  const dockerfile = readFileSync(join(repoRoot, 'infra/sandbox/base/Dockerfile'), 'utf8')
  check('Dockerfile 构建期断言 skills/index.ts（并入 mcp-bridge / workspace 那两条）', dockerfile.includes('test -f /opt/pi/agent/extensions/skills/index.ts'))
  check('Dockerfile 构建期断言 skills/contract.ts', dockerfile.includes('test -f /opt/pi/agent/extensions/skills/contract.ts'))
}

console.log('')
console.log(`skill-sync-regression：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
