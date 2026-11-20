#!/usr/bin/env node
/**
 * skill-drafts-regression.ts —— P1-24c-1（Skill 草稿基础设施）的**无 DB / 无 S3 / 无 Redis** 自证
 *
 * 跑法：`pnpm --filter @doubulea/backend skill-drafts:regression`
 *      （= `node --import tsx scripts/skill-drafts-regression.ts`；⚠️ 改过 `shared/src` 要先 `pnpm build:shared`）
 *
 * 依据：`docs/06-实施计划.md` P1-24c-1 验收项 + `docs/子方案/会话生成Skill.md` §五 / §六 / §七.2 / §八 / §十。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 守的是这几条（每条都对应一个"只在运行期才暴露"的错法）
 * ─────────────────────────────────────────────────────────────────────
 * ① **契约形状**：`SkillDraft` 对外**没有** `draftKey` / `storageKey`；`files[]` 只有
 *    `path/kind/mime/size/sha256`；保存入口 schema **不接受** `files`（且会剥掉它）；
 * ② **归属与过期**：`GET/PUT/DELETE` 一律按 `draft.userId` 判 —— 不是你的 / 过期 / 已落库
 *    都是同一个 404 子码（`SKILL_DRAFT_NOT_FOUND`）；
 * ③ **secret scan**：`Authorization` / `token=` / `sk-…` 命中 `credential`；URL / 邮箱 / 长数字串
 *    命中业务形状；打码后**原文不再出现**；命中的凭据形状**不允许恢复**（服务端重扫会拦住）；
 * ④ **SOFT 判据**：`runtime=inline` 带 `scripts/**` ⇒ `normalizeSkillDraftContent` 给出原因；
 *    `sandbox` + `scripts/**` ⇒ 合法；`scripts: true`（frontmatter）也会强制 `sandbox`；
 * ⑤ **规范化**：`SKILL.md` 的旧 frontmatter 被剥离（正文 = 模型看到的正文），表单字段优先，
 *    非受控键（`license`）作为 `extra` 带回；
 * ⑥ **diff**：section 级（`equal/add/remove/replace`）+ 文件增删；同样的输入两次算同一个结果；
 * ⑦ **i18n**：新增的 `app.m304 ~ app.m308` 在 zh / en 字典里都在，且 en 无汉字、占位符个数对齐。
 *
 * ⚠️ 它**验不了**端到端（要 PG + MinIO + Redis）：草稿真的会过期、S3 临时对象真的被回收、
 *    落库后 "我的 Skills" 真的能看到 —— 按 `06` §六「手动 E2E」留给用户真跑。
 */

import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

import {
  APP_MESSAGES,
  SKILL_DRAFT_KINDS_SUPPORTED,
  SKILL_REDACTION_MASK,
  SKILL_REDACTION_KINDS,
  checkSkillRuntimeConsistency,
  computeSkillDiff,
  createSkillDraftBodySchema,
  isLikelyScriptPath,
  normalizeExtractedFiles,
  saveSkillFromDraftBodySchema,
  saveSkillRevisionFromDraftBodySchema,
  scanSkillSecrets,
  skillDraftFileContentBodySchema,
  skillDraftFileQuerySchema,
  skillDraftRenameBodySchema,
  skillDraftSchema,
  updateSkillDraftBodySchema,
} from '@doubulea/shared'

const { normalizeSkillDraftContent } = await import('../src/sandbox/skillScript.ts')
const { mergeFileEntries } = await import('../src/services/skillDraft.service.ts')

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${detail === '' ? '' : ` —— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

const CJK = /[\u4e00-\u9fff]/u

/** 一份合法的草稿记录（`SkillDraft` 的对外形状） */
function draftFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-00000000d001',
    kind: 'CREATE' as const,
    targetSkillId: null,
    baseVersion: null,
    name: '日报导出',
    description: '需要每天导出运营日报时使用',
    runtime: 'INLINE' as const,
    requiresBins: [],
    markdown: '# 日报导出\n\n## 步骤\n1. 打开报表页',
    files: [],
    warnings: [],
    redactions: [],
    source: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-16T01:00:00.000Z',
    ...overrides,
  }
}

// ═════════════════════════════════════════════════════════════════════
// ① 契约形状
// ═════════════════════════════════════════════════════════════════════
console.log('\n① 契约形状')
{
  const parsed = skillDraftSchema.parse(draftFixture())
  check('`SkillDraft` 解析成功', parsed.id === draftFixture().id)
  check('对外形状没有 `draftKey` / `storageKey`', !('draftKey' in parsed) && !('storageKey' in parsed))
  check(
    '`files[]` 只有 path/kind/mime/size/sha256',
    Object.keys(skillDraftSchema.shape.files.element.shape).sort().join(',') === 'kind,mime,path,sha256,size',
  )
  const withDraftKey = skillDraftSchema.safeParse(
    draftFixture({ files: [{ path: 'references/a.md', kind: 'reference', mime: 'text/markdown', size: 1, sha256: 'x', draftKey: 'leak' }] }),
  )
  check('`files[]` 里多带 `draftKey` ⇒ 被剥掉（不透出服务端键）', withDraftKey.success && !('draftKey' in withDraftKey.data.files[0]!))

  // P1-24a-6：客户端可以建 CREATE（页面新建），但必须带非空正文；无来源 ⇒ MANUAL
  check('客户端能建 CREATE + REVISION（a-6）', SKILL_DRAFT_KINDS_SUPPORTED.join(',') === 'CREATE,REVISION')
  check(
    'CREATE 带正文可建（a-6）',
    createSkillDraftBodySchema.safeParse({ kind: 'CREATE', name: 'x', description: 'y', runtime: 'INLINE', markdown: '# x\n1.' }).success,
  )
  check(
    'CREATE 缺正文 ⇒ 400（空壳闸门）',
    !createSkillDraftBodySchema.safeParse({ kind: 'CREATE', name: 'x', description: 'y', runtime: 'INLINE' }).success,
  )
  check(
    'CREATE 正文只有空白 ⇒ 400',
    !createSkillDraftBodySchema.safeParse({ kind: 'CREATE', name: 'x', description: 'y', runtime: 'INLINE', markdown: '   \n\t' }).success,
  )
  check('SESSION_OVERRIDE 建草稿 ⇒ 400', !createSkillDraftBodySchema.safeParse(draftFixture({ kind: 'SESSION_OVERRIDE' })).success)
  check('PROPOSAL 建草稿 ⇒ 400（属 c-6）', !createSkillDraftBodySchema.safeParse(draftFixture({ kind: 'PROPOSAL' })).success)

  // c-2 起 `CREATE` 不在客户端可建的类型里 ⇒ 这一段改为守"`REVISION` 的形状仍然完整"
  const revisionOk = createSkillDraftBodySchema.safeParse({
    kind: 'REVISION',
    targetSkillId: '00000000-0000-4000-8000-00000000d009',
    baseVersion: 1,
    name: '日报导出',
    description: '需要每天导出运营日报时使用',
    runtime: 'INLINE',
  })
  check('REVISION 草稿（带目标与基准版本）可建', revisionOk.success)
  check('REVISION 缺 targetSkillId / baseVersion ⇒ 400', !createSkillDraftBodySchema.safeParse({ ...draftFixture(), kind: 'REVISION' }).success)
  check(
    'CREATE 带 targetSkillId ⇒ 400（字段只属于有目标的草稿）',
    !createSkillDraftBodySchema.safeParse({
      kind: 'CREATE',
      name: 'x',
      description: 'y',
      runtime: 'INLINE',
      markdown: '# x',
      targetSkillId: '00000000-0000-4000-8000-00000000d009',
    }).success,
  )

  const saveOk = saveSkillFromDraftBodySchema.safeParse({
    draftId: '00000000-0000-4000-8000-00000000d001',
    name: '日报导出',
    files: [{ path: 'scripts/x.py' }],
    storageKey: 'skills/evil/v9/',
  })
  check('保存入口接受 `draftId` + 展示元数据', saveOk.success)
  check(
    '保存入口把 `files` / `storageKey` 当未知键剥掉（内容只从服务端草稿读）',
    saveOk.success && !('files' in saveOk.data) && !('storageKey' in saveOk.data),
  )
  check('保存入口没有 `files` 字段', !('files' in saveSkillFromDraftBodySchema.shape))
  check(
    'revisions 入口要求 `changeSummary`',
    !saveSkillRevisionFromDraftBodySchema.safeParse({
      draftId: '00000000-0000-4000-8000-00000000d001',
      fromVersion: 1,
    }).success,
  )
  // P1-24a-5：详情页把可见范围与正文改动合并发布（只收 PRIVATE / PUBLIC）
  const revisionVisibility = saveSkillRevisionFromDraftBodySchema.safeParse({
    draftId: '00000000-0000-4000-8000-00000000d001',
    fromVersion: 1,
    changeSummary: '详情页编辑',
    visibility: 'PUBLIC',
  })
  check('revisions 入口接受 `visibility`（与正文改动合并发布）', revisionVisibility.success)
  check('PUT 草稿不能改 `targetSkillId` / `baseVersion` / `kind`', [
    'targetSkillId',
    'baseVersion',
    'kind',
  ].every((key) => !(key in updateSkillDraftBodySchema.shape)))
}

// ═════════════════════════════════════════════════════════════════════
// ② 归属 / 过期 / 消耗（服务层判据靠子码与 404 语义）
// ═════════════════════════════════════════════════════════════════════
console.log('\n② 归属 / 过期 / 消耗')
{
  const source = stripComments(readFileSync(new URL('../src/services/skillDraft.service.ts', import.meta.url), 'utf8'))
  check('归属判据：`record.userId !== viewer.id` ⇒ 404', source.includes('record.userId !== viewer.id'))
  check('过期判据：`updatedAt + ttl` ⇒ 404', source.includes('isExpired(record)'))
  check(
    '落库成功后消耗草稿（删 `skill_drafts` 行 + 回收对象）',
    source.includes('async function consumeDraft') && source.includes('await dropDraftRecordQuietly(record)'),
  )
  check(
    '草稿落表（`skill_drafts` 是唯一真相源，c-7a）',
    source.includes('getPrisma().skillDraft.upsert') && source.includes('getPrisma().skillDraft.findMany'),
  )
  check(
    '旧 Redis 草稿可迁移（DB 没有时读一次并写表）',
    source.includes('async function readLegacyDraft') && source.includes('await writeDraftRow(record)'),
  )
  check('草稿键里有 `userId`（`skill-drafts/{userId}/{draftId}/`）', source.includes('skill-drafts/${userId}/${draftId}/'))
  check('保存入口按 `kind` 分流（CREATE / REVISION 混用 ⇒ 400）', source.includes('SKILL_ERROR_CODES.DRAFT_KIND_MISMATCH'))
  check('绑定失败不影响保存（回 `bindError`）', source.includes('bindError = await tryBindSkill') && source.includes('bindError: null'))
  check('先写 S3 再写草稿 JSON（失败回收对象）', source.indexOf('await s3.putObject(bucket, key') < source.indexOf('record.files = [...record.files, file]'))
  check(
    'revision 保存把可见范围与版本写进同一个 updateMany（P1-24a-5）',
    source.includes('...(visibility === undefined ? {} : { visibility })'),
  )
  check(
    '`SHARED` 由服务层 `normalizeSkillVisibility` 拒绝（不是 schema 层）',
    source.includes('normalizeSkillVisibility(input.visibility)'),
  )
  // P1-24a-6：创建与保存两处都拦"无来源 CREATE + 空正文"
  check(
    '建草稿时兜底拦无来源 CREATE 的空正文（a-6）',
    source.includes("input.source === undefined && (input.markdown ?? '').trim() === ''"),
  )
  check(
    'from-draft 拦无来源 CREATE 的空正文（a-6）',
    source.includes("record.source === null && (input.markdown ?? record.markdown).trim() === ''"),
  )
}

// ═════════════════════════════════════════════════════════════════════
// ③ secret scan
// ═════════════════════════════════════════════════════════════════════
console.log('\n③ secret scan / 脱敏')
{
  check('脱敏种类与掩码稳定', SKILL_REDACTION_KINDS.join(',') === 'credential,url,email,id' && SKILL_REDACTION_MASK === '«已脱敏»')

  const text = [
    'Authorization: Bearer abcdefghijklmnop1234',
    'api_key=sk-1234567890abcdefghijkl',
    '店铺 https://stg.example.com/shop/10001234',
    '联系 ops@example.com',
    '订单号 123456789012',
  ].join('\n')
  const scan = scanSkillSecrets(text)
  check('命中凭据形状 ⇒ hasCredential', scan.hasCredential)
  check('命中里有 Authorization / Bearer', scan.redactions.some((item) => item.kind === 'credential'))
  check('命中有 URL', scan.redactions.some((item) => item.kind === 'url'))
  check('命中有邮箱', scan.redactions.some((item) => item.kind === 'email'))
  check('命中有长数字串', scan.redactions.some((item) => item.kind === 'id'))
  check('打码后原文不再出现（Bearer 值）', !scan.masked.includes('abcdefghijklmnop1234'))
  check('打码后原文不再出现（sk- Key）', !scan.masked.includes('sk-1234567890abcdefghijkl'))
  check('打码后原文不再出现（店铺 URL）', !scan.masked.includes('stg.example.com'))
  check('打码后原文不再出现（邮箱）', !scan.masked.includes('ops@example.com'))
  check('脱敏清单不回显原文', !JSON.stringify(scan.redactions).includes('abcdefghijklmnop1234'))

  const clean = scanSkillSecrets('1. 打开报表页\n2. 导出 CSV')
  check('干净文本 ⇒ 无命中', clean.redactions.length === 0 && !clean.hasCredential && clean.masked === '1. 打开报表页\n2. 导出 CSV')

  // 恢复 = 把掩码换回原文 ⇒ 服务端重扫必须再命中
  const restored = `Authorization: Bearer ${'secretsecretecret'}`
  check('「恢复」凭据形状后重扫仍命中（服务端会拒保存）', scanSkillSecrets(restored).hasCredential)
}

// ═════════════════════════════════════════════════════════════════════
// ④ runtime / scripts 一致性
// ═════════════════════════════════════════════════════════════════════
console.log('\n④ runtime / scripts 一致性')
{
  const scriptFile = { path: 'scripts/export.py', kind: 'script' as const, size: 10, sha256: 'a', mime: 'text/x-python' }
  const inlineWithScript = normalizeSkillDraftContent({
    markdown: '## 步骤\n1. 跑脚本',
    name: '导出',
    description: '导出日报时使用',
    runtime: 'INLINE',
    files: [scriptFile],
  })
  check('inline + scripts/** ⇒ 给出原因', inlineWithScript.reasons.some((reason) => reason.includes('scripts/')))
  check('inline + scripts/** ⇒ checkSkillRuntimeConsistency 同口径', checkSkillRuntimeConsistency({ runtime: 'INLINE', requiresScripts: false, paths: ['scripts/export.py'] }).length > 0)

  const sandboxWithScript = normalizeSkillDraftContent({
    markdown: '## 步骤\n1. 跑脚本',
    name: '导出',
    description: '导出日报时使用',
    runtime: 'SANDBOX',
    files: [scriptFile],
  })
  check('sandbox + scripts/** ⇒ 合法', sandboxWithScript.reasons.length === 0)
  check('sandbox + scripts/** ⇒ requiresScripts 被判为真', sandboxWithScript.content.requiresScripts)

  const unsafe = normalizeSkillDraftContent({
    markdown: '## 步骤',
    name: '导出',
    description: '导出日报时使用',
    runtime: 'INLINE',
    files: [{ path: '../etc/passwd', kind: 'reference' as const, size: 1, sha256: 'a', mime: 'text/plain' }],
  })
  check('不安全路径 ⇒ 给出原因', unsafe.reasons.some((reason) => reason.includes('不允许的路径')))

  const dup = normalizeSkillDraftContent({
    markdown: '## 步骤',
    name: '导出',
    description: '导出日报时使用',
    runtime: 'INLINE',
    files: [
      { path: 'references/a.md', kind: 'reference' as const, size: 1, sha256: 'a', mime: 'text/markdown' },
      { path: 'references/a.md', kind: 'reference' as const, size: 2, sha256: 'b', mime: 'text/markdown' },
    ],
  })
  check('同名文件 ⇒ 给出原因', dup.reasons.some((reason) => reason.includes('同名文件')))
}

// ═════════════════════════════════════════════════════════════════════
// ⑤ 规范化（frontmatter 剥离 / 表单优先 / 非受控键）
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑤ 规范化')
{
  const markdown = [
    '---',
    'name: 旧名字',
    'description: 旧描述',
    'license: MIT',
    'requires:',
    '  runtime: sandbox',
    '  scripts: true',
    '  bins: [python3, jq]',
    '---',
    '',
    '## 步骤',
    '1. 跑脚本',
  ].join('\n')

  const fromForm = normalizeSkillDraftContent({
    markdown,
    name: '新名字',
    description: '新描述',
    runtime: 'SANDBOX',
    files: [],
  })
  check('表单字段优先于 frontmatter', fromForm.content.name === '新名字' && fromForm.content.description === '新描述')
  check('正文已剥离 frontmatter', !fromForm.content.body.includes('license: MIT') && fromForm.content.body.trimStart().startsWith('## 步骤'), JSON.stringify(fromForm.content.body.slice(0, 60)))
  check('非受控键作为 extra 带回（license）', fromForm.content.extra.license === 'MIT')
  check('frontmatter 的 requires.bins 被读取', fromForm.content.requiresBins.join(',') === 'python3,jq')
  check('frontmatter 的 requires.scripts 被识别', fromForm.content.requiresScripts)

  const fromFrontmatter = normalizeSkillDraftContent({ markdown, runtime: 'SANDBOX', files: [] })
  check('缺省时从 frontmatter 取名 / 描述（手工粘贴整篇也能存）', fromFrontmatter.content.name === '旧名字' && fromFrontmatter.content.description === '旧描述')

  const empty = normalizeSkillDraftContent({ markdown: '', runtime: 'INLINE', files: [] })
  check('空正文 + 空名称 ⇒ 给出原因', empty.reasons.some((reason) => reason.includes('名称')) && empty.reasons.some((reason) => reason.includes('description')))
}

// ═════════════════════════════════════════════════════════════════════
// ⑥ diff
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑥ section 级 diff')
{
  const before = ['## 适用场景', '旧说明', '', '## 步骤', '1. 先导出', '', '## 校验', '对账'].join('\n')
  const after = ['## 适用场景', '旧说明', '', '## 步骤', '1. 先校验', '2. 再导出', '', '## 失败处理', '重试'].join('\n')
  const diff = computeSkillDiff({
    beforeMarkdown: before,
    afterMarkdown: after,
    beforeFiles: [
      { path: 'SKILL.md', sha256: 'a', size: before.length },
      { path: 'references/old.md', sha256: 'b', size: 10 },
      { path: 'references/keep.md', sha256: 'c', size: 10 },
    ],
    afterFiles: [
      { path: 'SKILL.md', sha256: 'd', size: after.length },
      { path: 'references/keep.md', sha256: 'c', size: 10 },
      { path: 'assets/tpl.csv', sha256: 'e', size: 20 },
    ],
  })
  check('相同段 ⇒ equal', diff.sections.some((line) => line.section === '适用场景' && line.op === 'equal'))
  check('改动段 ⇒ replace', diff.sections.some((line) => line.section === '步骤' && line.op === 'replace'))
  check('新增段 ⇒ add', diff.sections.some((line) => line.section === '失败处理' && line.op === 'add'))
  check('删除段 ⇒ remove', diff.sections.some((line) => line.section === '校验' && line.op === 'remove'))
  check('新增文件', diff.addedFiles.join(',') === 'assets/tpl.csv')
  check('删除文件', diff.removedFiles.join(',') === 'references/old.md')
  check('同路径同 sha256 不算改', diff.changedFiles.length === 0)
  check(
    '判定是确定性的（同输入同结果）',
    JSON.stringify(diff) ===
      JSON.stringify(
        computeSkillDiff({
          beforeMarkdown: before,
          afterMarkdown: after,
          beforeFiles: [
            { path: 'SKILL.md', sha256: 'a', size: before.length },
            { path: 'references/old.md', sha256: 'b', size: 10 },
            { path: 'references/keep.md', sha256: 'c', size: 10 },
          ],
          afterFiles: [
            { path: 'SKILL.md', sha256: 'd', size: after.length },
            { path: 'references/keep.md', sha256: 'c', size: 10 },
            { path: 'assets/tpl.csv', sha256: 'e', size: 20 },
          ],
        }),
      ),
  )
  check('stats 口径（前后文件数各含 SKILL.md）', diff.stats.beforeFiles === 3 && diff.stats.afterFiles === 3)
}

// ═════════════════════════════════════════════════════════════════════
// ⑥′ 跨目录脚本识别（2026-11-17：外部 Skill 经常把 vision.js 放在根目录）
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑥′ 跨目录脚本识别')
{
  check('scripts/ 下的任意文件都算脚本', isLikelyScriptPath('scripts/run.txt'))
  check('根目录 vision.js 算脚本', isLikelyScriptPath('vision.js'))
  check('嵌套目录 app.py 算脚本', isLikelyScriptPath('tools/app.py'))
  check('SKILL.md 不算脚本', !isLikelyScriptPath('SKILL.md'))
  check('references/*.md 不算脚本', !isLikelyScriptPath('references/guide.md'))
  check('assets/data.csv 不算脚本', !isLikelyScriptPath('assets/data.csv'))

  const modelFiles = [{ path: 'vision.js', content: 'const MODEL = 1;' }]
  check(
    'CREATE / TRACE 的默认口径仍拒绝非 scripts/、references/ 路径',
    normalizeExtractedFiles(modelFiles).files.length === 0,
  )
  check(
    'REVISION 传入 existingPaths 后允许替换根目录文件',
    normalizeExtractedFiles(modelFiles, { existingPaths: ['vision.js'] }).files.length === 1,
  )
  check(
    '审核阶段修订允许新增任意安全路径（与手动上传同判据）',
    normalizeExtractedFiles([{ path: 'templates/order.md', content: '# 模板' }], { allowAnySafePath: true }).files.length === 1,
  )
  check(
    'allowAnySafePath 仍拒绝不安全路径',
    normalizeExtractedFiles([{ path: '../escape.md', content: 'x' }], { allowAnySafePath: true }).files.length === 0,
  )
}

// ═════════════════════════════════════════════════════════════════════
// ⑥″ 文件树编辑（P1-24a-7）：墓碑过滤 + 契约
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑥″ 文件树编辑（a-7）')
{
  check(
    '`removedPaths` 在对外形状里（旧草稿缺省 []）',
    Array.isArray(skillDraftSchema.parse(draftFixture()).removedPaths) &&
      skillDraftSchema.parse(draftFixture()).removedPaths.length === 0,
  )
  const merged = mergeFileEntries(
    [{ path: 'references/n.md', kind: 'reference', mime: 'text/markdown', size: 1, sha256: 'n' }],
    [
      { path: 'references/keep.md', mime: 'text/markdown', size: 1, sha256: 'k', storageKey: 'v1/references/keep.md' },
      { path: 'references/gone.md', mime: 'text/markdown', size: 1, sha256: 'g', storageKey: 'v1/references/gone.md' },
    ],
    ['references/gone.md'],
  )
  check('`mergeFileEntries` 过滤墓碑（删基准文件不会被补回）', !merged.some((file) => file.path === 'references/gone.md'))
  check('`mergeFileEntries` 保留未删基准 + 草稿增量', merged.some((file) => file.path === 'references/keep.md') && merged.some((file) => file.path === 'references/n.md'))
  check(
    '`mergeFileEntries` 以墓碑为准（同路径不再从草稿残留）',
    !mergeFileEntries(
      [{ path: 'a.md', kind: 'reference', mime: 'text/markdown', size: 1, sha256: 'a' }],
      [],
      ['a.md'],
    ).some((file) => file.path === 'a.md'),
  )

  check(
    '`PUT /files/content` 契约：path + text',
    skillDraftFileContentBodySchema.safeParse({ path: 'references/a.md', text: '# a' }).success,
  )
  check('`PUT /files/content` 缺 text ⇒ 400', !skillDraftFileContentBodySchema.safeParse({ path: 'references/a.md' }).success)
  check(
    '`POST /files/rename` 契约：from / to / kind',
    skillDraftRenameBodySchema.safeParse({ from: 'references/a.md', to: 'references/b.md', kind: 'FILE' }).success,
  )
  check('重命名 SKILL.md ⇒ 400（守卫）', !skillDraftRenameBodySchema.safeParse({ from: 'SKILL.md', to: 'x.md', kind: 'FILE' }).success)
  check(
    '目录移动到自己的子目录 ⇒ 400',
    !skillDraftRenameBodySchema.safeParse({ from: 'references', to: 'references/sub', kind: 'DIR' }).success,
  )
  check(
    '`DELETE /files?path=&recursive=1` 解析出递归标记',
    skillDraftFileQuerySchema.parse({ path: 'references', recursive: '1' }).recursive === true &&
      skillDraftFileQuerySchema.parse({ path: 'references' }).recursive === false,
  )
}

// ═════════════════════════════════════════════════════════════════════
// ⑥‴ 草稿文件操作端到端（假 S3 + 内存草稿行；a-7）
//
// ⚠️ 只替换 S3 / Prisma 两个边界，其余走真服务代码 —— 守的是"墓碑互斥 / 目录递归 /
//    重命名搬字节 / 目标冲突 400"这几条只在运行期暴露的判据。真 PG / 真 MinIO 留给 E2E。
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑥‴ 草稿文件操作（a-7，假 S3）')
{
  const store = new Map<string, Buffer>()
  const rows = new Map<string, { id: string; userId: string; kind: string; payload: unknown; expiresAt: Date; createdAt: Date; updatedAt: Date }>()
  const { getS3Client } = await import('../src/infra/s3.ts')
  const { getPrisma } = await import('../src/infra/prisma.ts')
  const fakeBucketExists = (): Promise<boolean> => Promise.resolve(true)
  const fakeS3 = {
    bucketExists: fakeBucketExists,
    makeBucket: (): Promise<void> => Promise.resolve(),
    putObject: (_bucket: string, key: string, bytes: Buffer): Promise<unknown> => {
      store.set(key, Buffer.from(bytes))
      return Promise.resolve({ etag: '' })
    },
    getObject: (bucket: string, key: string): Promise<NodeJS.ReadableStream> => {
      void bucket
      const bytes = store.get(key)
      if (bytes === undefined) {
        const error = Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' })
        return Promise.reject(error)
      }
      return Promise.resolve(Readable.from([bytes]))
    },
    removeObjects: (_bucket: string, keys: string[]): Promise<unknown> => {
      for (const key of keys) store.delete(key)
      return Promise.resolve({})
    },
  }
  Object.assign(getS3Client(), fakeS3)
  const fakePrisma = {
    skillDraft: {
      findUnique: ({ where }: { where: { id: string } }) => Promise.resolve(rows.get(where.id) ?? null),
      findMany: () => Promise.resolve([...rows.values()]),
      upsert: ({ where, create, update }: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existing = rows.get(where.id)
        rows.set(where.id, (existing === undefined ? { ...create } : { ...existing, ...update }) as never)
        return Promise.resolve(rows.get(where.id))
      },
      deleteMany: ({ where }: { where: { id: string } }) => {
        rows.delete(where.id)
        return Promise.resolve({ count: 0 })
      },
    },
    skillFile: { findMany: () => Promise.resolve([]) },
    skillProposal: { findUnique: () => Promise.resolve(null), findMany: () => Promise.resolve([]) },
  }
  Object.assign(getPrisma(), fakePrisma)
  const {
    createSkillDraft,
    writeSkillDraftFileContent,
    renameSkillDraftPath,
    removeSkillDraftPath,
    uploadSkillDraftFile,
  } = await import('../src/services/skillDraft.service.ts')
  const viewer = { id: 'a7-user', role: 'ADMIN' as const }
  const draft = await createSkillDraft(
    { kind: 'CREATE', name: '棵树', description: '需要整理文件时使用', runtime: 'SANDBOX', markdown: '# 棵树\n1.' },
    viewer,
  )
  await writeSkillDraftFileContent(draft.id, { path: 'references/a.md', text: '# A' }, viewer)
  await writeSkillDraftFileContent(draft.id, { path: 'references/b.md', text: '# B' }, viewer)
  await writeSkillDraftFileContent(draft.id, { path: 'scripts/run.py', text: 'print(1)' }, viewer)
  let current = await writeSkillDraftFileContent(draft.id, { path: "references/a.md", text: "# A2" }, viewer)
  check(
    '写文本文件 ⇒ 进 files（新建 + 原地替换不重复）',
    current.draft.files.some((file) => file.path === "references/a.md") &&
      current.draft.files.filter((file) => file.path === "references/a.md").length === 1 &&
      current.draft.files.some((file) => file.path === "scripts/run.py"),
  )

  current = (await renameSkillDraftPath(draft.id, { from: 'references/a.md', to: 'references/c.md', kind: 'FILE' }, viewer))
  check(
    '重命名草稿文件：新路径进 files、旧路径**不进墓碑**（草稿对象换键即可，2026-11-19 修正）',
    current.files.some((file) => file.path === 'references/c.md') &&
      !current.files.some((file) => file.path === 'references/a.md') &&
      !current.removedPaths.includes('references/a.md'),
  )
  check(
    '重命名搬了字节（新键内容 = 原文）',
    [...store.entries()].some(([key, bytes]) => key.endsWith('references/c.md') && bytes.toString('utf8') === '# A2'),
  )

  // 替换基准文件：`replace=1` 必须能过（以前只看 record.files ⇒ 基准文件被 400 "已有同名文件"）
  // ⚠️ 此时 `references/a.md` 上**没有**草稿文件（只有墓碑 / 改名后的 `c.md`），
  //    正是"基准文件被误判同占"的那种形状。上传必须能摘墓碑，否则物化时还会被过滤一次。
  const replaced = await uploadSkillDraftFile(
    draft.id,
    { fileName: 'a.md', path: 'references/a.md', bytes: Buffer.from('# replaced'), replace: true },
    viewer,
  )
  check(
    '替换基准文件带 `replace=1` ⇒ 成功，且墓碑被摘掉（不变量 ①）',
    replaced.file.size === Buffer.byteLength('# replaced') &&
      replaced.draft.files.some((file) => file.path === 'references/a.md') &&
      !replaced.draft.removedPaths.includes('references/a.md'),
  )
  let replacedNoFlag: unknown = null
  try {
    await uploadSkillDraftFile(
      draft.id,
      { fileName: 'a.md', path: 'references/a.md', bytes: Buffer.from('# again') },
      viewer,
    )
  } catch (error) {
    replacedNoFlag = error
  }
  check('不带 `replace` 的同名上传仍 400（不静默覆盖）', replacedNoFlag !== null && (replacedNoFlag as { code?: unknown }).code === 'VALIDATION')

  let conflict: unknown = null
  try {
    await renameSkillDraftPath(draft.id, { from: 'references/c.md', to: 'references/b.md', kind: 'FILE' }, viewer)
  } catch (error) {
    conflict = error
  }
  check(
    '目标冲突缺省 400（不静默覆盖）',
    conflict !== null && (conflict as { code?: unknown }).code === 'VALIDATION',
  )

  current = (await renameSkillDraftPath(draft.id, { from: 'references', to: 'docs', kind: 'DIR' }, viewer))
  check(
    '目录重命名：前缀内文件全部搬走',
    current.files.some((file) => file.path === 'docs/c.md') &&
      current.files.some((file) => file.path === 'docs/b.md') &&
      !current.files.some((file) => file.path.startsWith('references/')),
  )

  current = (await removeSkillDraftPath(draft.id, { path: 'docs', recursive: true }, viewer))
  check(
    '目录递归删除：草稿文件移除 + 路径进墓碑',
    !current.files.some((file) => file.path.startsWith('docs/')) &&
      // 重命名后目标目录里是"新写的草稿文件"，删除只进 `files` 移除（墓碑记源路径）。
      // 这里直接断言"所有 docs 下的对象被回收、且不再出现在 files 里"。
      current.files.length === 1 &&
      current.files[0]?.path === 'scripts/run.py',
  )

  current = (await writeSkillDraftFileContent(draft.id, { path: 'docs/b.md', text: '# again' }, viewer)).draft
  check(
    '改回被删路径 ⇒ 自动摘墓碑（同一路径不同时在 files 与 removedPaths）',
    current.files.some((file) => file.path === 'docs/b.md') && !current.removedPaths.includes('docs/b.md'),
  )
  check(
    '改回被删路径 ⇒ 路径回到 files、墓碑摘掉',
    current.files.some((file) => file.path === 'docs/b.md') && !current.removedPaths.includes('docs/b.md'),
  )
  check(
    '被改名搬走的源路径不进墓碑（草稿对象只换键；`files` 里也没有它）',
    !current.removedPaths.includes('references/a.md') && !current.files.some((file) => file.path === 'references/a.md'),
  )

  let entryGuard: unknown = null
  try {
    await removeSkillDraftPath(draft.id, { path: 'SKILL.md', recursive: false }, viewer)
  } catch (error) {
    entryGuard = error
  }
  check('删除 SKILL.md ⇒ 400（守卫）', entryGuard !== null && (entryGuard as { code?: unknown }).code === 'VALIDATION')

  let traversal: unknown = null
  try {
    await removeSkillDraftPath(draft.id, { path: '../escape.md', recursive: false }, viewer)
  } catch (error) {
    traversal = error
  }
  check('`..` 路径被拒（400）', traversal !== null && (traversal as { code?: unknown }).code === 'VALIDATION')

  const serviceSource = stripComments(readFileSync(new URL('../src/services/skillDraft.service.ts', import.meta.url), 'utf8'))
  check(
    '物化处都传了墓碑（REVISION / SESSION_OVERRIDE / PROPOSAL 贯通）',
    // 三处物化入口都按墓碑过滤：REVISION / SESSION_OVERRIDE 走 `mergeFileEntries(..., removedPathsOf(..))`，
    // PROPOSAL 走 `new Set(removedPathsOf(record))`（整版快照，不并入基准）
    (serviceSource.match(/mergeFileEntries\([^;]*?removedPathsOf\(/gu) ?? []).length >= 2 &&
      serviceSource.includes('const removed = new Set(removedPathsOf(record))'),
  )
}

// ═════════════════════════════════════════════════════════════════════
// ⑦ i18n
// ═════════════════════════════════════════════════════════════════════
console.log('\n⑦ i18n')
{
  const zh = readFileSync(new URL('../../shared/src/i18n/messages.zh.ts', import.meta.url), 'utf8')
  const en = readFileSync(new URL('../../shared/src/i18n/messages.en.ts', import.meta.url), 'utf8')
  const keys = ['app.m304', 'app.m305', 'app.m306', 'app.m307', 'app.m308']
  for (const key of keys) {
    check(`${key} 在登记表里`, Object.values(APP_MESSAGES).some((entry) => entry.key === key))
    check(`${key} 在 zh 字典里`, zh.includes(`'${key}':`))
    const enLine = new RegExp(`^\\s*'${key}':\\s*(.*),$`, 'mu').exec(en)?.[1] ?? ''
    check(`${key} 在 en 字典里且无汉字`, enLine !== '' && !CJK.test(enLine))
  }
  check('`SKILL_DRAFT_NOT_FOUND` 子码存在', readFileSync(new URL('../../shared/src/skill.ts', import.meta.url), 'utf8').includes("'SKILL_DRAFT_NOT_FOUND'"))
  check('`SKILL_DRAFT_SECRET_FOUND` 子码存在', readFileSync(new URL('../../shared/src/skill.ts', import.meta.url), 'utf8').includes("'SKILL_DRAFT_SECRET_FOUND'"))
}

/** 去掉注释（只做"源码级判据"用；不求精确，够避开注释里的样例字符串） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
}

console.log(`\nskill-drafts-regression：${String(passed)} 通过 / ${String(failed)} 失败`)
if (failed > 0) process.exitCode = 1
