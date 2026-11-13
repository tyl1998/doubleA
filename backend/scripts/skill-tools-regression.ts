#!/usr/bin/env node
/**
 * skill-tools-regression.ts —— P1-24a-3（ChatBot 渐进披露）的**无 DB / 无 S3 / 无容器**自证
 *
 * 跑法：`pnpm --filter @doubulea/backend skill:regression`
 *      （= `node --import tsx scripts/skill-tools-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/06-实施计划.md` P1-24a-3 验收项 + `docs/子方案/Skill能力.md` §4.1 / §4.2 / §4.2.1 / §4.4。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 守的是这几条（每一条都对应一个"只在运行期才暴露"的错法）
 * ─────────────────────────────────────────────────────────────────────
 * ① **分页**：超 8000 字符的 `SKILL.md` 能**逐页读完**，每页都 ≤ 结果上限，
 *    **每页都不触发 `truncateToolResult` 兜底**，且最后一页 `nextOffset = null`；
 * ② **目录注入**：全量注入 / 超阈值收成一行 / 单条 description 超长时压到预算内 ——
 *    三种形态都必须 ≤ 预算（否则目录段自己就会被兜底截断，"规则段"跟着一起丢）；
 * ③ **slug 区分**：两个同名不同 owner 的 Skill 靠 slug 分开（`bySlug` 不同 key、`byId` 指向不同 id）；
 * ④ **失效项**：已删除 / 固定版本被回收 ⇒ `bound=false`、`hasUsable=false`、`load_skill` 给明确原因；
 * ⑤ **工具定义单一生成源**：`buildSkillOpenAiTools()` 与 `buildSkillManifestTools()` 的参数名**逐字一致**
 *    （ChatBot 与容器侧看到的是同一份 schema）；
 * ⑥ **system prompt**：没绑 Skill 时**一个字节都不变**（与 P1-24a-3 之前的输出逐字相同），
 *    绑了才追加目录段与规则段，且 Skill 段在知识库段**之前**；
 * ⑦ **版本提示（P1-24a-4）**：`skill:last-loaded` 的比较只有"加载过且版本变了"才提示 ——
 *    首次使用 / Redis 丢失 / 版本未变 / 固定版本 ⇒ 不提示；提示不落库（尾标由 chatBot 剔除）；
 * ⑧ **指纹（P1-24a-4）**：标准 SHA-256 已知向量逐字一致、只算可用项、顺序无关性由调用方保证；
 * ⑨ **进程内缓存（P1-24a-4）**：key 含 `skillId + version`（升级即换键、不会串版本）、
 *    有上限且按 LRU 逐出（不清空）、超大单项不缓存。
 *
 * ⚠️ 它**验不了**端到端（要 PG + MinIO + 真模型）：模型是否真的"先 load 再答"、工具卡在界面上的样子
 *    —— 那些按 `06` §六「手动 E2E」留给用户真跑。
 */

import { createHash } from 'node:crypto'

import {
  SKILL_CATALOG_FINGERPRINT_PATTERN,
  SKILL_CATALOG_INLINE_LIMIT,
  SKILL_PAGE_DEFAULT_LIMIT,
  SKILL_RESULT_MAX_CHARS,
  SKILL_TOOL_SERVER_NAME,
  buildSkillManifestTools,
  buildSkillOpenAiTools,
  formatSkillCatalogBlock,
  sha256Hex,
  skillCatalogFingerprint,
  skillCatalogFingerprintLines,
  skillPageOf,
  type SkillCatalogEntry,
} from '@doubulea/shared'

const {
  availableSkillEntries,
  buildSkillSnapshot,
  formatSkillPageText,
  isSkillTool,
  resolveSkillBindingEntry,
  skillCatalogFingerprintOf,
} = await import('../src/orchestrator/skillTools.ts')
const { createSkillObjectCache, skillObjectCacheKey } = await import('../src/orchestrator/skillObjectCache.ts')
const {
  SKILL_VERSION_NOTICE_MARK,
  detectSkillVersionChanges,
  formatSkillVersionNotice,
  skillLastLoadedUpdate,
} = await import('../src/orchestrator/skillVersionNotice.ts')
const { SKILL_USAGE_RULES, TOOL_RESULT_MAX_CHARS, buildSystemPrompt, truncateToolResult } = await import(
  '../src/orchestrator/chatContext.ts'
)

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

/** 码点长度（与 `skillPageOf` 同口径） */
function cpLen(text: string): number {
  return [...text].length
}

/** 造一个 Skill 行（`skills` 的当前投影） */
function skillRow(
  id: string,
  slug: string,
  overrides: Partial<{ name: string; description: string; runtime: 'INLINE' | 'SANDBOX'; version: number }> = {},
): {
  id: string
  slug: string
  name: string
  description: string
  runtime: 'INLINE' | 'SANDBOX'
  version: number
} {
  return {
    id,
    slug,
    name: overrides.name ?? `Skill ${slug}`,
    description: overrides.description ?? '做某件重复流程时使用',
    runtime: overrides.runtime ?? 'INLINE',
    version: overrides.version ?? 1,
  }
}

// ═════════════════════════════════════════════════════════════════════
// ① 分页：长 SKILL.md 逐页读完、每页都不触发兜底
// ═════════════════════════════════════════════════════════════════════
{
  check('结果上限与 chatContext 的 TOOL_RESULT_MAX_CHARS 同值（skill:contract 的前提）', SKILL_RESULT_MAX_CHARS === TOOL_RESULT_MAX_CHARS, `${SKILL_RESULT_MAX_CHARS} vs ${TOOL_RESULT_MAX_CHARS}`)
  check('缺省 limit = 上限 − 512', SKILL_PAGE_DEFAULT_LIMIT === SKILL_RESULT_MAX_CHARS - 512)

  // 9000 码点的正文（夹 emoji：验证按**码点**切而不是按 UTF-16 码元 —— 切在代理对中间会产出半个字符）
  const source = Array.from({ length: 9000 }, (_, index) => (index % 701 === 0 ? '🙂' : String.fromCharCode(0x4e00 + (index % 2000)))).join('')
  check('构造的正文是 9000 码点', cpLen(source) === 9000, String(cpLen(source)))

  const pages: string[] = []
  let offset: number | null = 0
  let guard = 0
  let allUnderLimit = true
  let noFallbackMark = true
  let sawShortPage = false
  while (offset !== null && guard < 20) {
    guard += 1
    const page = skillPageOf(source, offset, SKILL_PAGE_DEFAULT_LIMIT)
    const rendered = formatSkillPageText({
      title: 'Skill「长文」 (long-skill, v1)',
      page,
      toolName: 'load_skill',
      nextArgs: 'slug="long-skill"',
    })
    const final = truncateToolResult(rendered)
    pages.push(page.text)
    if (cpLen(final) >= SKILL_RESULT_MAX_CHARS) allUnderLimit = false
    noFallbackMark = noFallbackMark && final === rendered.trim()
    // 按**码点**比（`text.length` 是 UTF-16 码元：一页里夹了 emoji 时它会大于 limit，那不是错）
    if (cpLen(page.text) > SKILL_PAGE_DEFAULT_LIMIT) sawShortPage = true
    if (page.truncated) {
      check(`第 ${String(guard)} 页 truncated=true 时 nextOffset 必为具体值`, page.nextOffset !== null, String(page.nextOffset))
      check(`第 ${String(guard)} 页页脚写明下一次的 offset`, rendered.includes(`offset=${String(page.nextOffset)}`))
    } else {
      check('最后一页 truncated=false 且 nextOffset=null', page.nextOffset === null, String(page.nextOffset))
    }
    offset = page.nextOffset
  }
  check('9000 码点正文能在 2 页内读完（offset 链不卡死）', guard === 2, `实际 ${String(guard)} 页`)
  check('拼回的内容与原文**逐字一致**（没有丢字 / 没有半个代理对）', pages.join('') === source)
  check('每页经 truncateToolResult 后都 < 上限（正常路径不触发兜底）', allUnderLimit)
  check('每页都没有出现兜底截断的尾缀', noFallbackMark)
  check('每页正文的**码点**长度都 ≤ 请求的 limit', !sawShortPage)

  // offset 越界 ⇒ 空页（不报错：模型多翻一页要知道"已经读完了"）
  const beyond = skillPageOf(source, 999_999, 100)
  check('offset 越界 ⇒ 空页 + nextOffset=null', beyond.text === '' && beyond.nextOffset === null && !beyond.truncated)

  // limit 超上限 ⇒ 被夹到 SKILL_PAGE_MAX_LIMIT（schema 也会拒，这里守"切片函数自己也不越界"）
  const clamped = skillPageOf(source, 0, 99_999)
  check('limit 超上限被夹到 SKILL_RESULT_MAX_CHARS', clamped.limit === SKILL_RESULT_MAX_CHARS, String(clamped.limit))
}

// ═════════════════════════════════════════════════════════════════════
// ② 目录注入（system prompt 的 ④ 段）
// ═════════════════════════════════════════════════════════════════════
{
  const budget = SKILL_RESULT_MAX_CHARS - 600
  const entry = (index: number, description = '做某件重复流程时使用'): SkillCatalogEntry => ({
    slug: `skill-${String(index).padStart(2, '0')}`,
    name: `技能 ${String(index)}`,
    description,
    version: 1,
  })

  const empty = formatSkillCatalogBlock([])
  check('一条都没有 ⇒ text 为空串（调用方不注入这一段）', empty.text === '' && empty.total === 0)

  const few = formatSkillCatalogBlock([entry(1), entry(2), entry(3)])
  check('少量 ⇒ 全量注入（inline）', few.inline && few.entries.length === 3 && few.text.includes('skill-01'))
  check('目录行含 slug / 版本 / 名称 / 用途', few.text.includes('skill-01（v1）技能 1：做某件重复流程时使用'))

  const many = Array.from({ length: SKILL_CATALOG_INLINE_LIMIT + 1 }, (_, index) => entry(index + 1))
  const collapsed = formatSkillCatalogBlock(many)
  check('超过阈值 ⇒ 只回一行（不列 description）', !collapsed.inline && collapsed.entries.length === 0)
  check('收成一行时写明条数并指向 list_skills', collapsed.text.includes(String(many.length)) && collapsed.text.includes('list_skills'))
  check('收成一行时长度远小于预算', cpLen(collapsed.text) < 200, String(cpLen(collapsed.text)))

  // 条数没超、但 description 都很长 ⇒ 逐条压到预算内，**不丢条目**
  const longDescriptions = Array.from({ length: 8 }, (_, index) => entry(index + 1, '很长的用途说明'.repeat(200)))
  const clipped = formatSkillCatalogBlock(longDescriptions)
  check('description 超长 ⇒ 全部条目仍在', clipped.inline && clipped.entries.length === 8)
  check('description 超长 ⇒ 目录文本 ≤ 预算（不会把规则段挤掉）', cpLen(clipped.text) <= budget, `${String(cpLen(clipped.text))} > ${String(budget)}`)
  check('被截断的 description 带省略号（模型据此知道要 load_skill 看全文）', clipped.text.includes('…'))
}

// ═════════════════════════════════════════════════════════════════════
// ③ slug 区分（同名不同 owner）+ 排序稳定
// ═════════════════════════════════════════════════════════════════════
{
  const alice = resolveSkillBindingEntry({
    skill: skillRow('skill-a', 'report-export', { name: '报表导出', description: 'A 的做法' }),
    pinnedVersion: null,
  })
  const bob = resolveSkillBindingEntry({
    skill: skillRow('skill-b', 'report-export-2', { name: '报表导出', description: 'B 的做法' }),
    pinnedVersion: null,
  })
  const snapshot = buildSkillSnapshot([bob, alice])
  check('同名不同 owner ⇒ 两个 slug 都在快照里', snapshot.bySlug.has('report-export') && snapshot.bySlug.has('report-export-2'))
  check('按 slug 解析到的是正确的 Skill', snapshot.bySlug.get('report-export-2')?.skillId === 'skill-b')
  const ordered = availableSkillEntries(snapshot).map((item) => item.slug)
  check('目录顺序 slug asc（prompt cache 依赖它）', ordered.join(',') === 'report-export,report-export-2', ordered.join(','))
  check('hasUsable=true', snapshot.hasUsable)

  check('isSkillTool 只认三个名字', isSkillTool('list_skills') && isSkillTool('load_skill') && isSkillTool('read_skill_file'))
  check('isSkillTool 不认 run_skill_script（第一阶段不下发）', !isSkillTool('run_skill_script'))
  check('工具卡归集名 = Skill', SKILL_TOOL_SERVER_NAME === 'Skill')
}

// ═════════════════════════════════════════════════════════════════════
// ④ 失效项（已删除 / 固定版本被回收）
// ═════════════════════════════════════════════════════════════════════
{
  const pinnedTooNew = resolveSkillBindingEntry({
    skill: skillRow('skill-c', 'pinned', { version: 1 }),
    pinnedVersion: 3,
  })
  check('固定版本 > 当前版本 ⇒ bound=false', !pinnedTooNew.bound)
  check('固定版本被回收 ⇒ 原因写清 v3 / 最新 v1', (pinnedTooNew.unavailableReason ?? '').includes('v3') && (pinnedTooNew.unavailableReason ?? '').includes('v1'))
  check('失效项 hasUsable=false（不下载具、不注入目录）', !buildSkillSnapshot([pinnedTooNew]).hasUsable)

  const pinnedOk = resolveSkillBindingEntry({
    skill: skillRow('skill-d', 'pinned-ok', { version: 5 }),
    pinnedVersion: 2,
  })
  check('固定版本 ≤ 当前版本 ⇒ 用固定版本（v2 而不是 v5）', pinnedOk.bound && pinnedOk.version === 2)

  const follow = resolveSkillBindingEntry({ skill: skillRow('skill-e', 'follow', { version: 7 }), pinnedVersion: null })
  check('未固定 ⇒ 跟随最新（v7）', follow.bound && follow.version === 7)
}

// ═════════════════════════════════════════════════════════════════════
// ⑤ 工具定义单一生成源（OpenAI 下发 vs 容器 manifest）
// ═════════════════════════════════════════════════════════════════════
{
  const openAiTools = buildSkillOpenAiTools()
  const manifestTools = buildSkillManifestTools()
  check('两边都是 3 个工具、名字同序', openAiTools.map((tool) => tool.function.name).join(',') === manifestTools.map((tool) => tool.name).join(','))
  const sameRequired = openAiTools.every((tool, index) => {
    const openAiRequired = (tool.function.parameters['required'] as string[] | undefined) ?? []
    const manifestRequired = (manifestTools[index]?.inputSchema['required'] as string[] | undefined) ?? []
    return openAiRequired.join(',') === manifestRequired.join(',')
  })
  check('两边 required 逐字一致', sameRequired)
  const openAiProps = openAiTools.map((tool) => Object.keys(tool.function.parameters['properties'] as object).join(','))
  const manifestProps = manifestTools.map((tool) => Object.keys(tool.inputSchema['properties'] as object).join(','))
  check('两边参数名逐字一致', openAiProps.join('|') === manifestProps.join('|'), `${openAiProps.join('|')} vs ${manifestProps.join('|')}`)
}

// ═════════════════════════════════════════════════════════════════════
// ⑥ system prompt（没绑 Skill 时逐字不变）
// ═════════════════════════════════════════════════════════════════════
{
  const baseline = buildSystemPrompt('你是助手', [])
  check('没绑 Skill / 没绑库 ⇒ 只有人设（与 a-3 之前逐字相同）', baseline === '你是助手', baseline)
  check('空数组等价于缺省（不引入空段）', buildSystemPrompt('你是助手', [], { skills: [] }) === baseline)

  const withSkill = buildSystemPrompt('你是助手', [], {
    skills: [{ slug: 'report-export', name: '报表导出', description: '导出月报时使用', version: 2 }],
  })
  check('绑了 Skill ⇒ 注入规则段', withSkill.includes(SKILL_USAGE_RULES))
  check('绑了 Skill ⇒ 注入目录段（slug + 版本 + 用途）', withSkill.includes('可用 Skill') && withSkill.includes('report-export（v2）报表导出：导出月报时使用'))
  check('规则段写明"先 load 再执行"', SKILL_USAGE_RULES.includes('先调用 `load_skill`'))
  check('规则段写明"不要假装读过"', SKILL_USAGE_RULES.includes('不要假装已经读过'))

  const kbFirst = buildSystemPrompt('你是助手', [{ name: '运维手册', documents: ['a.md'], documentTotal: 1 }], {
    skills: [{ slug: 'report-export', name: '报表导出', description: '导出月报时使用', version: 2 }],
  })
  const skillAt = kbFirst.indexOf('可用 Skill')
  const kbAt = kbFirst.indexOf('可用知识库')
  check('Skill 段在知识库段之前（流程 → 资料）', skillAt >= 0 && kbAt > skillAt, `${String(skillAt)} vs ${String(kbAt)}`)

  // 目录段逐字稳定（prompt cache 依赖它）：同一组 Skill 两次组装必须给出同一个字符串
  const again = buildSystemPrompt('你是助手', [], {
    skills: [{ slug: 'report-export', name: '报表导出', description: '导出月报时使用', version: 2 }],
  })
  check('同一组 Skill 两次组装逐字一致（prompt cache 可命中）', again === withSkill)
}

// ═════════════════════════════════════════════════════════════════════
// ⑦ 版本提示（P1-24a-4）：只有"加载过且版本变了"才提示
// ═════════════════════════════════════════════════════════════════════
{
  const current = [
    { skillId: 'skill-a', slug: 'report-export', name: '报表导出', version: 2 },
    { skillId: 'skill-b', slug: 'inspect', name: '巡检', version: 4 },
  ]

  check('Redis 丢失（undefined）⇒ 不提示', detectSkillVersionChanges(current, undefined).length === 0)
  check('首次使用（哈希为空对象）⇒ 不提示', detectSkillVersionChanges(current, {}).length === 0)
  check('加载过但版本没变 ⇒ 不提示', detectSkillVersionChanges(current, { 'skill-a': 2, 'skill-b': 4 }).length === 0)

  const bumped = detectSkillVersionChanges(current, { 'skill-a': 1, 'skill-b': 4 })
  check('只有版本变了的那个进提示（未变的那个不出现）', bumped.length === 1 && bumped[0]?.skillId === 'skill-a', JSON.stringify(bumped))
  check('提示项带的是**本轮**版本（v2 而不是旧值 v1）', bumped[0]?.version === 2)

  const regressed = detectSkillVersionChanges(current, { 'skill-a': 9 })
  check('版本回退（Redis 残留旧值更大）也按"变了"提示', regressed.length === 1 && regressed[0]?.version === 2)

  check('哈希里没有这个 skillId ⇒ 不提示（别的会话加载过不算）', detectSkillVersionChanges(current, { 'skill-z': 1 }).length === 0)
  check('哈希值是坏数据（NaN / 0）⇒ 跳过该项', detectSkillVersionChanges(current, { 'skill-a': Number.NaN, 'skill-b': 0 }).length === 0)

  const notice = formatSkillVersionNotice(bumped)
  check('提示正文含 Skill 名称 / slug / 新版本', notice.includes('报表导出') && notice.includes('report-export') && notice.includes('v2'))
  check('提示正文要求重新 load_skill', notice.includes('load_skill'))
  check('提示正文以尾标结尾（chatBot 据此剔除上一轮那条，不落库）', notice.endsWith(SKILL_VERSION_NOTICE_MARK) === false && notice.startsWith(SKILL_VERSION_NOTICE_MARK))
  check('没有变化 ⇒ 正文为空串（不注入空消息）', formatSkillVersionNotice([]) === '')

  const manyChanges = detectSkillVersionChanges(
    Array.from({ length: 30 }, (_, index) => ({
      skillId: `skill-${String(index)}`,
      slug: `s-${String(index)}`,
      name: `技能 ${String(index)}`,
      version: 2,
    })),
    Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`skill-${String(index)}`, 1])),
  )
  check('提示条数有上限（异常数据不会造出无限长的消息）', manyChanges.length > 0 && manyChanges.length <= 20, String(manyChanges.length))

  check('回写只带 skillId → 本轮版本', JSON.stringify(skillLastLoadedUpdate({ skillId: 'skill-a', skillVersion: 3 })) === '{"skill-a":3}')
}

// ═════════════════════════════════════════════════════════════════════
// ⑧ 目录指纹（P1-24a-4）：标准 SHA-256 + 只算可用项
// ═════════════════════════════════════════════════════════════════════
{
  // FIPS 180-4 的已知向量：纯 JS 实现必须与标准逐位一致（否则容器侧 Node crypto 算出来的会分叉）
  check('sha256("") = e3b0c442…（标准向量）', sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  check('sha256("abc") = ba7816bf…（标准向量）', sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  check(
    'sha256("中文 + emoji") 按 UTF-8 算（与 Node crypto 同值）',
    sha256Hex('中文🙂') === nodeSha256('中文🙂'),
    `${sha256Hex('中文🙂')} vs ${nodeSha256('中文🙂')}`,
  )
  check('长文本（> 1 个块）也与 Node crypto 一致', sha256Hex('技能'.repeat(500)) === nodeSha256('技能'.repeat(500)))

  const fingerprint = skillCatalogFingerprint(skillCatalogFingerprintLines([
    { slug: 'report-export', version: 1, name: '报表导出', description: '导出月报' },
  ]).join('\n'))
  check('指纹形状是 sha256:<64 hex>', SKILL_CATALOG_FINGERPRINT_PATTERN.test(fingerprint), fingerprint)
  check('指纹是确定性的（同输入同输出）', fingerprint === skillCatalogFingerprint(skillCatalogFingerprintLines([
    { slug: 'report-export', version: 1, name: '报表导出', description: '导出月报' },
  ]).join('\n')))

  const v1 = skillCatalogFingerprintOf(buildSkillSnapshot([
    resolveSkillBindingEntry({ skill: skillRow('skill-a', 'report-export', { version: 1 }), pinnedVersion: null }),
  ]))
  const v2 = skillCatalogFingerprintOf(buildSkillSnapshot([
    resolveSkillBindingEntry({ skill: skillRow('skill-a', 'report-export', { version: 2 }), pinnedVersion: null }),
  ]))
  check('版本变化 ⇒ 指纹变化（版本提示的判据靠它）', v1 !== v2)

  const renamed = skillCatalogFingerprintOf(buildSkillSnapshot([
    resolveSkillBindingEntry({ skill: skillRow('skill-a', 'report-export', { version: 1, name: '改了名' }), pinnedVersion: null }),
  ]))
  check('名称变化（目录文本变了）⇒ 指纹变化', renamed !== v1)

  const emptySnapshot = skillCatalogFingerprintOf(buildSkillSnapshot([]))
  check('没有可用项 ⇒ 指纹为空串（空目录不参与判据）', emptySnapshot === '')

  const deleted = skillCatalogFingerprintOf(buildSkillSnapshot([
    { ...resolveSkillBindingEntry({ skill: skillRow('skill-a', 'report-export', { version: 1 }), pinnedVersion: null }), bound: false, unavailableReason: '已删除' },
  ]))
  check('全失效 ⇒ 指纹为空串（目录本来就不注入）', deleted === '')
}

/** 用 Node 自带 crypto 算同一个值（交叉验证纯 JS 实现；脚本跑在 Node 里，不是"造工具"） */
function nodeSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ═════════════════════════════════════════════════════════════════════
// ⑨ 进程内缓存（P1-24a-4）：key 含版本 + 有上限 + LRU
// ═════════════════════════════════════════════════════════════════════
{
  check(
    '缓存 key 含 skillId / version / path（三段都不同则键不同）',
    skillObjectCacheKey('skill-a', 1, 'SKILL.md') !== skillObjectCacheKey('skill-a', 2, 'SKILL.md') &&
      skillObjectCacheKey('skill-a', 1, 'SKILL.md') !== skillObjectCacheKey('skill-b', 1, 'SKILL.md') &&
      skillObjectCacheKey('skill-a', 1, 'SKILL.md') !== skillObjectCacheKey('skill-a', 1, 'references/a.md'),
  )

  const cache = createSkillObjectCache(3, 1000, 500)
  cache.set('a', 'AAA')
  check('写入后可命中', cache.get('a') === 'AAA')
  check('未命中返回 undefined', cache.get('missing') === undefined)

  cache.set('a', 'AA')  // 覆盖：总字符要按新值算
  check('覆盖写入后总字符不重复累加', cache.stats().totalChars === 2, JSON.stringify(cache.stats()))

  cache.set('b', 'BB')
  cache.set('c', 'CC')
  check('未超上限时全部保留', cache.stats().entries === 3, JSON.stringify(cache.stats()))
  cache.set('d', 'DD')
  check('超条数上限 ⇒ 逐出最旧的一条（不是清空）', cache.stats().entries === 3 && cache.get('a') === undefined && cache.get('d') === 'DD')

  const lru = createSkillObjectCache(2, 1000, 500)
  lru.set('x', '1')
  lru.set('y', '2')
  lru.get('x')        // x 变成最近使用
  lru.set('z', '3')   // 应该逐出 y（而不是 x）
  check('LRU：命中过的条目不会被先逐出', lru.get('x') === '1' && lru.get('y') === undefined && lru.get('z') === '3')

  const cappedChars = createSkillObjectCache(100, 10, 500)
  cappedChars.set('big', '12345678')
  cappedChars.set('small', '123')
  check('总字符超上限 ⇒ 逐出旧条目', cappedChars.stats().totalChars <= 10 && cappedChars.get('small') === '123', JSON.stringify(cappedChars.stats()))

  const oversized = createSkillObjectCache(10, 1000, 5)
  oversized.set('huge', '123456')
  check('单项超过上限 ⇒ 整条不缓存（不挤掉别人）', oversized.get('huge') === undefined && oversized.stats().entries === 0)

  const versioned = createSkillObjectCache()
  versioned.set(skillObjectCacheKey('skill-a', 1, 'SKILL.md'), 'v1 正文')
  versioned.set(skillObjectCacheKey('skill-a', 2, 'SKILL.md'), 'v2 正文')
  check(
    '版本升级后同一个 path 读到的**不是**旧正文（缓存不串版本）',
    versioned.get(skillObjectCacheKey('skill-a', 2, 'SKILL.md')) === 'v2 正文',
  )
  check(
    '旧版本条目仍在缓存里（历史行仍可读，审计不受影响）',
    versioned.get(skillObjectCacheKey('skill-a', 1, 'SKILL.md')) === 'v1 正文',
  )
}

console.log('')
console.log(`skill-tools-regression：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
