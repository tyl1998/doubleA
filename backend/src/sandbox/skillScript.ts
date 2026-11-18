/**
 * Skill 脚本的**路径约定与预检**（P1-24b-3）
 *
 * 依据：`docs/子方案/Skill能力.md` §2.3（脚本路径与工作目录）/ §4.3 第 5、7 条（不新增工具、
 *      `requires.bins` 只提示）/ §4.19（验收判据）/ §6.3（已知边界）；`docs/06-实施计划.md` P1-24b-3。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本批只做三件事，且**全是约定 / 提示，没有一条是拦截**
 * ─────────────────────────────────────────────────────────────────────
 * ① **脚本路径**：`SKILL_DIR=$HOME/.skills/current/<slug>`，脚本步骤写 `$SKILL_DIR/scripts/...`；
 *    cwd 仍是 `/work`，产物写 `/work`（§2.3）。
 * ② **预检（只提示）**：`requires.bins` 与镜像里真实可用的解释器/命令不匹配时，在容器里探一次
 *    `command -v`，把"该 Skill 需要 X、当前运行时没有"写进本轮 prompt 与日志 —— **不阻断派活**
 *    （§4.3 第 7 条：脚本执行失败由模型/用户决定是否换运行时）。
 * ③ **不新增工具**：脚本统一走容器已有的 `bash`，**不开放** `run_skill_script`（§4.3 第 5 条）。
 *
 * ⚠️ **为什么"只提示"是唯一正确的形态**：第一阶段 `bash` 始终可用，模型完全可以绕开某个 bin
 *    自己拼命令；在派活前因为 `requires.bins` 拦一轮，只会把"这个 Skill 的说明还有价值"变成
 *    "整个 Agent 不可用"。§6.3 的两条已知边界（脚本能读同会话其他 Skill 文件、能借 `SANDBOX_TOKEN`
 *    调 MCP / 出网默认 `ALL`）也不靠这里收窄，它们的唯一判据是**绑定期 403**（a-1）。
 *
 * ⚠️ 本文件**不碰 Docker、不碰 DB、不碰 manifest**（纯函数 + 一次可注入的 exec）：
 *    `taskAgent.ts` 把结论拼进 prompt，`skill-sync:regression` 直接喂数据核对。
 */

import {
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
  checkSkillRuntimeConsistency,
  isSafeSkillPath,
  isSkillScriptPath,
  type SkillManifest,
  type SkillManifestEntry,
  type SkillRuntime,
} from '@doubulea/shared'

import { SANDBOX_SKILLS_DIR, SANDBOX_WORK_DIR } from './spec.js'
import { parseSimpleYaml, stripFrontmatter } from '../services/skillZip.js'

/** 喂给模型的目录段里的**一句话口径**（没有 Skill 时不注入，prompt 逐字不变） */
export const SKILL_SCRIPT_RULES: readonly string[] = [
  `- 脚本入口：$SKILL_DIR=$HOME/.skills/current/<slug>（= 目录里每一项的 currentPath，挂载点 ${SANDBOX_SKILLS_DIR}）。`,
  `- 执行：用 bash 跑 \`$SKILL_DIR/scripts/...\`；工作目录仍是 ${SANDBOX_WORK_DIR}，产物写到 ${SANDBOX_WORK_DIR}（临时文件用 /tmp）。`,
  '- 不要写裸相对路径（例如只写 `脚本名.py`）：cwd 不是 Skill 目录，那种命令一定找不到文件。',
  '- `$SKILL_DIR` 是只读挂载：不要往 Skill 目录里写东西（写它一定失败），也不要 `cd` 进去再把产物落在里面。',
  "- 目录里每项都列了脚本依赖（`bins`）。本轮运行时缺哪个只作提示，脚本跑不起来就换一种做法或明确告诉用户，不要假装跑过。",
]

/** `$SKILL_DIR` 的**绝对路径**（= `current/<slug>`；容器里与 `shared#skillDirInContainer` 同值） */
export function skillDirAbsoluteOf(slug: string): string {
  return `${SANDBOX_SKILLS_DIR}/current/${slug}`
}

/**
 * 一段正文里的**裸相对脚本路径**（`scripts/export.py` 这种）—— 只用于提示，**不拦截导入**。
 *
 * 为什么不在 zip 导入时拒绝：① 正文里出现这串字面量也可能是在讲"不要这么写"（本文件的规则段
 * 自己就有）；② §2.3 的判据是"验收不通过"，不是"导入失败"；③ 生成器（c 批）才是产出方，
 * 在那边保证不产出裸路径比在这里猜语义可靠。
 *
 * 匹配口径：行首 / 空白 / 反引号 / 引号 之后紧跟的 `scripts/`，且**前面不是** `$SKILL_DIR` 或 `/`
 * 或字母数字下划线（那样是 `$SKILL_DIR/scripts/...`、绝对路径或更长标识符的一部分）。
 */
export function findBareScriptPathMentions(markdown: string): string[] {
  const hits: string[] = []
  const pattern = /(^|[\s`'"(=])(scripts\/[A-Za-z0-9._\-/]+)/gmu
  for (const match of markdown.matchAll(pattern)) {
    const mention = match[2]
    if (mention !== undefined && !hits.includes(mention)) hits.push(mention)
  }
  return hits
}

/**
 * 容器里一次 `command -v` 探到的事实：哪些在、哪些不在。
 *
 * `missing` 为空 ⇒ 本轮没有预检提示（**最常见的路径**：没声明 bins 的 Skill 根本不探）。
 * `unsupported` 是**不在白名单**的 bin 名（不拼进 shell，见 `binsProbeCommand`）。
 */
export interface BinsProbeResult {
  present: string[]
  missing: string[]
  unsupported: string[]
}

/**
 * `requires.bins` 的**白名单**（能被安全地反查 `command -v` 的名字）。
 *
 * ⚠️ 为什么要白名单：bins 来自用户上传的 `SKILL.md` frontmatter，而探针要把它们拼进 `sh -c`。
 *    不校验就拼 = 一条 `python3; rm -rf /work` 就能在容器里跑任意命令（而这条命令是**平台**发的，
 *    不是模型发的）。白名单之外的名字**不探、不执行**，只在提示里原样列出。
 */
const SAFE_BIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u

/** 拆成"能探的"与"不探的"（`unsupported` 原样保留给提示） */
export function splitBinsForProbe(bins: readonly string[]): { probe: string[]; unsupported: string[] } {
  const probe: string[] = []
  const unsupported: string[] = []
  for (const bin of bins) {
    const name = bin.trim()
    if (name === '') continue
    if (SAFE_BIN_PATTERN.test(name)) {
      if (!probe.includes(name)) probe.push(name)
    } else if (!unsupported.includes(name)) {
      unsupported.push(name)
    }
  }
  return { probe, unsupported }
}

/**
 * 一次探完所有 bin 的 `sh -c` 命令（**逐行输出** `1 <bin>` / `0 <bin>`；顺序与输入一致）。
 *
 * 只把白名单里的名字拼进去（见 `splitBinsForProbe`）；空输入 ⇒ `null`（调用方**不要 exec**）。
 */
export function binsProbeCommand(bins: readonly string[]): string[] | null {
  const { probe } = splitBinsForProbe(bins)
  if (probe.length === 0) return null
  const body = probe.map((bin) => `if command -v ${bin} >/dev/null 2>&1; then echo "1 ${bin}"; else echo "0 ${bin}"; fi`).join('; ')
  return ['sh', '-c', body]
}

/**
 * 解析 {@link binsProbeCommand} 的输出（**恒不抛**：认不出的行直接忽略）。
 *
 * 只认 `1 <name>` / `0 <name>` 两种行，且 `name` 必须在 `bins` 里（防止容器里别的输出混进来）。
 */
export function parseBinsProbe(stdout: string, bins: readonly string[]): BinsProbeResult {
  const known = new Set(bins.map((bin) => bin.trim()))
  const present = new Set<string>()
  const absent = new Set<string>()
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*([01])\s+(\S+)\s*$/u.exec(line)
    if (match === null) continue
    const [, flag, name] = match
    if (name === undefined || !known.has(name)) continue
    if (flag === '1') present.add(name)
    else absent.add(name)
  }
  const { probe, unsupported } = splitBinsForProbe(bins)
  return {
    present: probe.filter((bin) => present.has(bin) && !absent.has(bin)),
    // 探针跑了但这一行没出现 ⇒ 按"不在"处理（宁可多提示一次，也别在脚本 ENOENT 时一片安静）
    missing: probe.filter((bin) => !present.has(bin)),
    unsupported,
  }
}

/** 探针"要不要跑"（没有可探的 bin ⇒ `false`，不付一次 exec） */
export function shouldProbeBins(bins: readonly string[]): boolean {
  return splitBinsForProbe(bins).probe.length > 0
}

/** manifest 里所有 Skill 声明的 bins（去重、保序）——探针的输入 */
export function declaredBinsOf(manifest: SkillManifest | null): string[] {
  if (manifest === null) return []
  const bins: string[] = []
  for (const entry of manifest.skills) {
    for (const bin of entry.requires.bins) {
      const name = bin.trim()
      if (name !== '' && !bins.includes(name)) bins.push(name)
    }
  }
  return bins
}

/**
 * 预检提示块（**只提示、不阻断**；没有任何缺失 ⇒ 空串 ⇒ prompt 逐字不变）。
 *
 * 逐 Skill 列出"缺哪个 bin"，并明确告诉模型：这是提示，不是平台判定的失败 —— 它仍可以先读说明
 * 再决定怎么做，但**不得假装执行过脚本**。
 */
export function formatSkillBinsWarningBlock(manifest: SkillManifest | null, probe: BinsProbeResult | null): string {
  if (manifest === null || probe === null) return ''
  const missing = new Set(probe.missing)
  const unsupported = new Set(probe.unsupported)
  const lines: string[] = []
  for (const entry of manifest.skills) {
    const absent = entry.requires.bins.map((bin) => bin.trim()).filter((bin) => bin !== '' && missing.has(bin))
    const unprobed = entry.requires.bins.map((bin) => bin.trim()).filter((bin) => bin !== '' && unsupported.has(bin))
    if (absent.length === 0 && unprobed.length === 0) continue
    const parts: string[] = []
    if (absent.length > 0) parts.push(`缺少 ${absent.join(' / ')}`)
    if (unprobed.length > 0) parts.push(`${unprobed.join(' / ')}（名字不合法，未探测）`)
    lines.push(`- ${entry.slug}（v${String(entry.version)}）需要 ${entry.requires.bins.join(' / ')}：${parts.join('；')}`)
  }
  if (lines.length === 0) return ''
  return [
    'Skill 运行时预检（**只提示，不阻断**）：',
    '下面这些 Skill 声明的脚本依赖在当前运行时里没找到。说明与参考资料仍然可用；',
    '脚本跑不起来时换一种做法或明确告诉用户"当前运行时缺少 X"，不要假装执行过。',
    ...lines,
  ].join('\n')
}

/** 一个 manifest 条目对应的 `$SKILL_DIR`（诊断日志 / 回归用；`entry.currentPath` 的绝对形态） */
export function skillDirOfEntry(entry: Pick<SkillManifestEntry, 'currentPath'>): string {
  return `${SANDBOX_SKILLS_DIR}/${entry.currentPath}`
}

// ═════════════════════════════════════════════════════════════════════
// 草稿输入规范化（P1-24c-1）
// ═════════════════════════════════════════════════════════════════════
//
// 为什么放在这里而不是 `services/skillDraft.service.ts`：草稿的 `SKILL.md` 与导入包走**同一条**
// 解包/路径/一致性判据（`skillZip.ts` 的 `parseSkillMarkdown` / `isSafeSkillPath` /
// `checkSkillRuntimeConsistency`）。把"草稿的 markdown / 文件清单 → 校验结果"写成纯函数，
// 服务层与回归脚本就能对同一份输入得到同一个结论（`skill-drafts:regression` 守着）。

/** 草稿落库前的规范化结果（frontmatter 已剥离，正文就是"模型看到的正文"） */
export interface NormalizedSkillDraftContent {
  name: string
  description: string
  runtime: SkillRuntime
  requiresBins: string[]
  requiresScripts: boolean
  /** `SKILL.md` 正文（frontmatter 已剥离；落库时由 `composeSkillMarkdown` 按 DB 字段重写） */
  body: string
  /** 包内 frontmatter 的其余键（`license` 等；原样带回） */
  extra: Record<string, unknown>
  files: { path: string; kind: 'reference' | 'asset' | 'script'; size: number; sha256: string; mime: string }[]
}

/**
 * 把草稿里填的表单 + `SKILL.md` 正文规范化。
 *
 * 三条口径：
 *   · **表单优先、正文里的旧 frontmatter 丢弃**（`stripFrontmatter`）—— 与导入"frontmatter 由服务端
 *     重写"同一条纪律；正文里那份 frontmatter 只用来取**非受控键**（`license` / `allowed-tools`）。
 *   · `name` / `description` 缺省时从 frontmatter 取（手工粘贴一份完整 `SKILL.md` 也能存）。
 *   · `runtime` / `requires.scripts` / `scripts/**` 的一致性由 `checkSkillRuntimeConsistency` 判 ——
 *     **失败返回原因而不是抛错**（调用方把它们放进 `SKILL_DRAFT_INVALID` 的 `data.reasons[]`）。
 */
export function normalizeSkillDraftContent(input: {
  markdown: string
  name?: string | undefined
  description?: string | undefined
  runtime: SkillRuntime
  requiresBins?: readonly string[] | undefined
  files: {
    path: string
    kind: 'reference' | 'asset' | 'script'
    size: number
    sha256: string
    mime: string
  }[]
}): { content: NormalizedSkillDraftContent; reasons: string[] } {
  const reasons: string[] = []
  const markdown = input.markdown.replace(/^\uFEFF/u, '')
  const frontmatter = readDraftFrontmatter(markdown)
  const name = (input.name?.trim() ?? frontmatter?.name ?? '').trim()
  const description = (input.description?.trim() ?? frontmatter?.description ?? '').trim()
  if (name === '') reasons.push('名称为空')
  if (description === '') reasons.push('description 为空（它是模型选择 Skill 的唯一依据）')
  if (name !== '' && [...name].length > SKILL_NAME_MAX_CHARS) {
    reasons.push(`名称超过 ${String(SKILL_NAME_MAX_CHARS)} 个字符`)
  }
  if (description !== '' && [...description].length > SKILL_DESCRIPTION_MAX_CHARS) {
    reasons.push(`description 超过 ${String(SKILL_DESCRIPTION_MAX_CHARS)} 个字符`)
  }
  const requiresScripts = frontmatter?.requiresScripts === true || input.files.some((file) => isSkillScriptPath(file.path))
  for (const file of input.files) {
    if (!isSafeSkillPath(file.path)) {
      reasons.push(`不允许的路径（绝对路径 / .. / 盘符 / 反斜杠 / 空段）：${file.path}`)
    }
  }
  reasons.push(
    ...checkSkillRuntimeConsistency({
      runtime: input.runtime,
      requiresScripts,
      paths: input.files.map((file) => file.path),
    }),
  )
  const seen = new Set<string>()
  for (const file of input.files) {
    if (seen.has(file.path)) reasons.push(`有两个同名文件：${file.path}`)
    seen.add(file.path)
  }
  return {
    content: {
      name,
      description,
      runtime: input.runtime,
      requiresBins: [...new Set((input.requiresBins ?? frontmatter?.requiresBins ?? []).map((bin) => bin.trim()).filter((bin) => bin !== ''))],
      requiresScripts,
      body: stripFrontmatter(markdown),
      extra: frontmatter?.extra ?? {},
      files: input.files,
    },
    reasons,
  }
}

/** 从 `SKILL.md` 里读三件事（**读不出来就给 `null`，不抛**：正文可能只是一段纯 Markdown） */
function readDraftFrontmatter(markdown: string): {
  name?: string
  description?: string
  runtime?: SkillRuntime
  requiresScripts?: boolean
  requiresBins?: string[]
  extra: Record<string, unknown>
} | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown.replace(/^\uFEFF/u, ''))
  if (match === null) return null
  const raw = parseSimpleYaml(match[1] ?? '')
  const requires =
    raw.requires !== null && typeof raw.requires === 'object' && !Array.isArray(raw.requires)
      ? (raw.requires as Record<string, unknown>)
      : {}
  const binsRaw = requires.bins
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== 'name' && key !== 'description' && key !== 'requires'),
  )
  return {
    ...(typeof raw.name === 'string' && raw.name.trim() !== '' ? { name: raw.name.trim() } : {}),
    ...(typeof raw.description === 'string' && raw.description.trim() !== ''
      ? { description: raw.description.trim() }
      : {}),
    ...(requires.runtime === 'sandbox' ? { runtime: 'SANDBOX' as SkillRuntime } : { runtime: 'INLINE' as SkillRuntime }),
    ...(requires.scripts === true ? { requiresScripts: true } : {}),
    ...(Array.isArray(binsRaw)
      ? {
          requiresBins: binsRaw
            .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
            .map((item) => item.trim()),
        }
      : {}),
    extra,
  }
}
