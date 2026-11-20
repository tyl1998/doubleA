#!/usr/bin/env node
/**
 * skill-workspace-regression.ts —— `request_skill_from_workspace`（TaskAgent 从工作区目录 / zip 导入）
 * 的**无 DB / 无 S3 / 无容器**自证。
 *
 * 跑法：`pnpm --filter @doubulea/backend skill-workspace:regression`
 *      （⚠️ 改过 `shared/src` 要先 `pnpm --filter @doubulea/shared build`）
 *
 * 守的是这几条：
 *  ① 种子映射：`SKILL.md` 只取正文（frontmatter 剥离）；其余文件保留字节，`SKILL.md` 不重复进 files；
 *  ② 名称 / description / runtime / requiresBins 从包里带到草稿；
 *  ③ 名称兜底顺序：frontmatter.name → nameHint → titleHint → 路径 basename；
 *  ④ 入口工具只在 TaskAgent manifest 里下发（ChatBot 的 3 个名单不含它）。
 *
 * ⚠️ 验不了端到端（真工作区 + PG + MinIO + 审核页）：那部分留给用户手动 E2E。
 */

import {
  SKILL_CHATBOT_REQUEST_TOOL_NAMES,
  SKILL_ANY_TOOL_NAMES,
  SKILL_REQUEST_FROM_WORKSPACE_TOOL_NAME,
} from '@doubulea/shared'

import { skillDraftSeedOfParsed } from '../src/services/skillWorkspaceDraft.service.ts'
import type { ParsedSkillZip } from '../src/services/skillZip.ts'

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

function parsedOf(overrides: Partial<ParsedSkillZip> = {}): ParsedSkillZip {
  const entry = [
    '---',
    'name: story',
    'description: 写中文小说时使用',
    'requires:',
    '  runtime: sandbox',
    '  scripts: true',
    '  bins: [python3]',
    '---',
    '',
    '# Story',
    '',
    '正文第一段。',
  ].join('\n')
  return {
    frontmatter: {
      name: 'story',
      description: '写中文小说时使用',
      requires: { runtime: 'sandbox', scripts: true, bins: ['python3'] },
      raw: {},
    },
    runtime: 'SANDBOX',
    requiresBins: ['python3'],
    files: [
      { path: 'SKILL.md', bytes: Buffer.from(entry), ext: '.md', mime: 'text/markdown', sha256: 'a' },
      { path: 'scripts/run.py', bytes: Buffer.from('print(1)\n'), ext: '.py', mime: 'text/x-python', sha256: 'b' },
      { path: 'references/guide.md', bytes: Buffer.from('# 指南\n'), ext: '.md', mime: 'text/markdown', sha256: 'c' },
    ],
    entryMarkdown: entry,
    totalBytes: Buffer.byteLength(entry),
    nameHint: 'story',
    ...overrides,
  }
}

console.log('\n① 种子映射')
{
  const seed = skillDraftSeedOfParsed(parsedOf(), { sourcePath: 'skills/story' })
  check('名称 / description / runtime / bins 原样带入', seed.name === 'story' && seed.description === '写中文小说时使用')
  check('runtime 来自包（带 scripts ⇒ SANDBOX）', seed.runtime === 'SANDBOX')
  check('requiresBins 原样带入', seed.requiresBins.join(',') === 'python3')
  check('正文剥离 frontmatter（从一级标题开始）', !seed.markdown.includes('name: story') && seed.markdown.trimStart().startsWith('# Story'))
  check('files 排除 SKILL.md', seed.files.length === 2 && seed.files.every((file) => file.path !== 'SKILL.md'))
  check(
    '其余文件保留原始字节',
    seed.files.find((file) => file.path === 'scripts/run.py')?.bytes.toString('utf8') === 'print(1)\n',
  )
}

console.log('\n② 名称兜底')
{
  const noName = skillDraftSeedOfParsed(
    parsedOf({
      frontmatter: { description: '写中文小说时使用', requires: {}, raw: {} },
      nameHint: '',
    }),
    { sourcePath: 'skills/story.zip', titleHint: '网文工具' },
  )
  check('frontmatter 无 name ⇒ nameHint 空 ⇒ titleHint', noName.name === '网文工具')

  const pathOnly = skillDraftSeedOfParsed(
    parsedOf({
      frontmatter: { description: '写中文小说时使用', requires: {}, raw: {} },
      nameHint: '',
    }),
    { sourcePath: 'skills/web-novel.zip' },
  )
  check('无 name / nameHint / titleHint ⇒ 路径 basename（去掉 .zip）', pathOnly.name === 'web-novel')
}

console.log('\n③ 工具下发范围')
{
  check('ChatBot 的 3 个入口工具不含工作区导入', !(SKILL_CHATBOT_REQUEST_TOOL_NAMES as readonly string[]).includes(SKILL_REQUEST_FROM_WORKSPACE_TOOL_NAME))
  check('容器 manifest 全集包含工作区导入', SKILL_ANY_TOOL_NAMES.includes(SKILL_REQUEST_FROM_WORKSPACE_TOOL_NAME))
}

console.log(`\n${failed === 0 ? '✅' : '❌'} skill-workspace-regression：${String(passed)} 通过 / ${String(failed)} 失败`)
process.exit(failed === 0 ? 0 : 1)