#!/usr/bin/env node
/**
 * timezone-regression.ts —— PostgreSQL 时区偏移修复的自证（2026-11-12）
 *
 * 跑法：`pnpm --filter @doubulea/backend timezone:regression`
 *      （= `node --import tsx scripts/timezone-regression.ts`；需要 `infra/.env` 里的 DATABASE_URL 可连）
 *
 * 依据：`docs/02-后端设计.md` §三「已知问题：timestamptz 与 Prisma 的时区偏移」与
 *      「时区偏移修复清单」；`docs/06` §七 待决 8；`docs/子方案/沙箱与引擎集成.md` §十三 9。
 *
 * 它验四件事（**不碰任何业务表**）：
 *   A. 连接层：`SHOW TimeZone` = `UTC`，且 `config.db.url` 没把 query 参数丢掉
 *      （`backend/src/config.ts` 只校验 scheme、原样透传）。
 *   B. 读写恒等 + 物理值正确：临时表里用 Prisma 写一个 JS `Date`，读回同一时刻，
 *      且 `AT TIME ZONE 'UTC'` 的物理值也等于它 —— ⚠️ 只验「往返恒等」不够：
 *      旧偏移下往返也恒等，但物理值早 8 小时。这两条必须一起断言。
 *   C. `now()` 对齐：DB `now()` 与 JS `Date.now()` 差 < 2s。
 *   D. 清单静态断言：schema 里**每一个** DateTime 列都在 {@link INVENTORY} 中有写入方分类
 *      （A=DB 默认 / B=纯 JS/Prisma 写 / C=混写），且「+8h 迁移」与 `INVENTORY`、
 *      迁移 SQL 三者逐列一致 —— 避免以后新增列时漏分类、或迁移漏列/多列。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from '../src/config.js'
import { closePrisma, getPrisma } from '../src/infra/prisma.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = resolve(HERE, '../prisma/schema.prisma')
const MIGRATION_PATH = resolve(HERE, '../prisma/migrations/20261112000000_timezone_offset_fix/migration.sql')

/** A = DB 默认（now()/CURRENT_TIMESTAMP）；B = 纯 JS/Prisma 写；C = 两者都有（逐行不可判） */
type Writer = 'A' | 'B' | 'C'

interface ColumnDisposition {
  writer: Writer
  /** 本次迁移是否 `col = col + interval '8 hours'` */
  shift8h: boolean
  /** 取证点 / 不迁移的理由（写给后来改 schema 的人看） */
  note: string
}

/**
 * ★ 第 1 步的逐列清单（table.column → 写入方 → 是否 +8h）。
 *
 * ⚠️ 新增任何 `DateTime` 列：**必须**在这里补一行（脚本会静态断言"每列都有分类"），
 *    并在 `schema.prisma` 注释里写明由谁写（docs/02 §三 的纪律）。
 */
const INVENTORY: Readonly<Record<string, ColumnDisposition>> = {
  // ── users ──
  'users.created_at': { writer: 'A', shift8h: false, note: 'user.create 不带 createdAt ⇒ DB now()' },
  'users.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt（Prisma 客户端生成）' },
  // ── model_providers ──
  'model_providers.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'model_providers.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  // ── provider_user_credentials ──
  'provider_user_credentials.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'provider_user_credentials.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  // ── models ──
  'models.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'models.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  // ── agents ──
  'agents.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'agents.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'agents.deleted_at': { writer: 'B', shift8h: true, note: '软删时 new Date()（agent.service.ts）' },
  // ── 纯默认时间戳（无显式赋值点）──
  'agent_models.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'agent_components.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'agent_audiences.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'knowledge_base_audiences.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'user_groups.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'user_groups.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'user_group_members.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  // ── conversations / messages ──
  'conversations.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'conversations.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'conversations.last_message_at': {
    writer: 'C',
    shift8h: false,
    note: '多数由 touchConversation 的 JS new Date() 写；但删消息后回算写的是读回的 message.created_at（物理已正确）⇒ 逐行不可判，暂不迁移（见 docs/02 残留清单）',
  },
  'messages.created_at': { writer: 'A', shift8h: false, note: 'message.create 不带 createdAt ⇒ DB now()（分区键）' },
  // ── knowledge ──
  'knowledge_bases.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'knowledge_bases.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'documents.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'documents.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'chunks.created_at': { writer: 'A', shift8h: false, note: 'raw INSERT 不带 created_at ⇒ DB now()' },
  // ── mcp ──
  'mcp_servers.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'mcp_servers.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'mcp_credentials.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'mcp_credentials.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  // ── sandboxes（P0-3-2 起两列都由 JS 显式写，DDL 默认仅兜底）──
  'sandboxes.created_at': { writer: 'B', shift8h: true, note: 'createSandbox 显式传入 startedAt' },
  'sandboxes.last_active_at': { writer: 'B', shift8h: true, note: 'createSandbox / touchSandbox 显式传入 JS 时间' },
  // ── scheduled_tasks（P1-6：调度比较正是 JS 侧边界）──
  'scheduled_tasks.next_run_at': { writer: 'B', shift8h: true, note: 'nextCronRun 在 JS 侧计算' },
  'scheduled_tasks.last_run_at': { writer: 'B', shift8h: true, note: '调度器 new Date()' },
  'scheduled_tasks.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'scheduled_tasks.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  // ── artifacts ──
  'artifacts.created_at': { writer: 'B', shift8h: true, note: 'artifacts.ts 显式传入 JS 时间（保留期清理是 JS 边界）' },
  'artifacts.expires_at': { writer: 'B', shift8h: true, note: '以 createdAt 为基准 + 用户延期（JS 计算）' },
  // ── usage_records（P0-3-12 / P1-7）──
  'usage_records.created_at': { writer: 'B', shift8h: true, note: 'persist.ts 显式传入 usageRecord.createdAt' },
  // ── open_api_keys ──
  'open_api_keys.expires_at': { writer: 'B', shift8h: true, note: '请求里的 ISO 时刻 new Date()' },
  'open_api_keys.last_used_at': { writer: 'B', shift8h: true, note: '当前无写入点（恒 NULL）；语句为空操作，保留防将来漏' },
  'open_api_keys.revoked_at': { writer: 'B', shift8h: true, note: '吊销时 new Date()' },
  'open_api_keys.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  // ── files ──
  'files.created_at': { writer: 'B', shift8h: true, note: 'file.service.ts 显式传入 new Date()' },
  // ── 记忆 ──
  'conversation_summaries.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'conversation_summaries.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'memories.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'memories.last_used_at': { writer: 'B', shift8h: true, note: '注入/打开时 new Date()' },
  // ── 工作区 ──
  'workspaces.created_at': { writer: 'A', shift8h: false, note: 'worker.create 不带 createdAt ⇒ DB now()' },
  'workspaces.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt（保留期清理是 JS 边界）' },
  'workspace_files.deleted_at': { writer: 'B', shift8h: true, note: '墓碑由 JS 传入 now' },
  'workspace_files.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'workspace_file_versions.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'workspace_claims.expires_at': { writer: 'B', shift8h: true, note: 'claim 时 JS 计算（无 DB 默认）' },
  'workspace_claims.heartbeat_at': { writer: 'B', shift8h: true, note: 'claim / 心跳时 JS 传入（无 DB 默认）' },
  'workspace_events.at': { writer: 'B', shift8h: true, note: 'workspaceEventCreateData 显式传 now' },
  // ── git / 平台单例 ──
  'git_credentials.created_at': { writer: 'A', shift8h: false, note: 'DB now()' },
  'git_credentials.updated_at': { writer: 'B', shift8h: true, note: '@updatedAt' },
  'egress_policy.updated_at': {
    writer: 'C',
    shift8h: false,
    note: '迁移 seed 行由 CURRENT_TIMESTAMP 写（物理正确），之后应用更新由 @updatedAt 写 ⇒ 逐行不可判；只作展示，不迁移',
  },
  'title_model_config.updated_at': {
    writer: 'C',
    shift8h: false,
    note: '同 egress_policy：seed 行 SQL 写、应用更新 @updatedAt 写；只作展示，不迁移',
  },
}

/** 解析 schema：返回 `table.column` 全集（模型 → `@@map`；列 → `@map`） */
function schemaColumns(): Set<string> {
  const text = readFileSync(SCHEMA_PATH, 'utf8')
  const found = new Set<string>()
  const blocks = text.split(/^model\s+\w+\s*\{/m).slice(1)
  for (const block of blocks) {
    const body = block.split(/^\}/m)[0] ?? ''
    const table = /^\s*@@map\("([^"]+)"\)/m.exec(body)?.[1]
    if (table === undefined) continue
    for (const line of body.split('\n')) {
      const column = /^\s*(\w+)\s+DateTime\??\s/.exec(line)
      if (column === null) continue
      const dbName = /@map\("([^"]+)"\)/.exec(line)?.[1] ?? column[1]
      if (dbName === undefined) continue
      found.add(`${table}.${dbName}`)
    }
  }
  return found
}

/** 解析迁移 SQL：返回所有 `UPDATE "table" SET "column"` 的 `table.column` 集合 */
function migrationColumns(): Set<string> {
  const text = readFileSync(MIGRATION_PATH, 'utf8')
  const found = new Set<string>()
  for (const match of text.matchAll(/^UPDATE\s+"([^"]+)"\s+SET\s+"([^"]+)"/gm)) {
    found.add(`${match[1]}.${match[2]}`)
  }
  return found
}

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  [PASS] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${label}：期望 ${b}，实际 ${a}`)
}

async function main(): Promise<void> {
  // ── D. 静态清单（先跑：不依赖 DB）────────────────────────────────────
  console.log('── D 写入方清单（schema / 迁移 / INVENTORY 三方一致）──')
  await check('D1 schema.prisma 的每个 DateTime 列都在清单里（无遗漏、无陈旧项）', () => {
    const schema = schemaColumns()
    const listed = new Set(Object.keys(INVENTORY))
    const missing = [...schema].filter((key) => !listed.has(key)).sort()
    const stale = [...listed].filter((key) => !schema.has(key)).sort()
    assert(missing.length === 0, `清单缺这些列（新增 DateTime 列必须补分类）：${missing.join(', ')}`)
    assert(stale.length === 0, `清单里有多余列（schema 已删/改名，同步删掉）：${stale.join(', ')}`)
  })

  await check('D2 writer=A/C 一律不 +8h；writer=B 一律 +8h（处置不留模糊）', () => {
    const wrong = Object.entries(INVENTORY)
      .filter(([, item]) => item.shift8h !== (item.writer === 'B'))
      .map(([key]) => key)
    assert(wrong.length === 0, `写入方与处置矛盾：${wrong.join(', ')}`)
  })

  await check('D3 迁移 SQL 的 UPDATE 列 = 清单里所有 shift8h=true 的列（不漏、不多）', () => {
    const sql = migrationColumns()
    const expected = new Set(Object.entries(INVENTORY).filter(([, item]) => item.shift8h).map(([key]) => key))
    const missing = [...expected].filter((key) => !sql.has(key)).sort()
    const extra = [...sql].filter((key) => !expected.has(key)).sort()
    assert(missing.length === 0, `迁移漏了：${missing.join(', ')}`)
    assert(extra.length === 0, `迁移多写了（或清单未标 shift8h）：${extra.join(', ')}`)
    assert(expected.size > 0, '清单里没有任何 +8h 列 —— 修复范围不可能为空')
  })

  // ── A. 连接层 ────────────────────────────────────────────────────────
  console.log('── A 连接层（DATABASE_URL / 会话时区）──')
  await check('A1 config.ts 保留 query 参数：config.db.url 含 options=-c TimeZone=UTC', () => {
    const url = new URL(config.db.url)
    const options = url.searchParams.get('options') ?? ''
    assert(
      /timezone\s*=\s*utc/i.test(options),
      `config.db.url 的 options 丢失：${options || '（空）'}；应含 "-c TimeZone=UTC"`,
    )
  })

  const prisma = getPrisma()
  const tzRows = await prisma.$queryRawUnsafe<Array<Record<string, string>>>('SHOW TimeZone')
  const sessionTz = Object.values(tzRows[0] ?? {})[0] ?? ''
  await check('A2 SHOW TimeZone = UTC（Prisma 实际会话，不只是连接串字面量）', () => {
    eq(sessionTz, 'UTC', 'TimeZone')
  })

  // ── B. 临时表：往返恒等 + 物理值正确 ────────────────────────────────
  console.log('── B Prisma 写入 / 读回（临时表，不碰业务表）──')
  const sample = new Date('2026-02-01T00:00:00.000Z')
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'CREATE TEMP TABLE tz_probe (id integer PRIMARY KEY, ts timestamptz(3) NOT NULL)',
    )
    await tx.$executeRawUnsafe('INSERT INTO tz_probe (id, ts) VALUES (1, $1)', sample)
    const rows = await tx.$queryRawUnsafe<Array<{ ts: Date; utc: string }>>(
      `SELECT ts, to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc FROM tz_probe WHERE id = 1`,
    )

    await check('B1 Prisma 写入 → 读回同一 timestamptz（往返恒等）', () => {
      const row = rows[0]
      assert(row !== undefined, '临时表读不到刚写入的行')
      eq(row.ts.toISOString(), sample.toISOString(), '读回值')
    })

    await check('B2 物理值是真 UTC（不是"往返恒等但整体差 8h"）', () => {
      const row = rows[0]
      assert(row !== undefined, '临时表读不到刚写入的行')
      eq(row.utc, '2026-02-01T00:00:00.000Z', 'AT TIME ZONE UTC')
    })
  })

  // ── C. DB now() 与 JS now() 对齐 ────────────────────────────────────
  console.log('── C DB now() vs JS Date.now() ──')
  await check('C1 两者差 < 2000ms', async () => {
    const before = Date.now()
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, Date>>>('SELECT now() AS now')
    const after = Date.now()
    const dbNow = Object.values(rows[0] ?? {})[0]
    assert(dbNow instanceof Date, 'SELECT now() 没返回 Date')
    const diff = Math.abs(dbNow.getTime() - (before + after) / 2)
    assert(diff < 2000, `差 ${diff}ms（会话时区/时钟不同步）`)
  })

  console.log('')
  console.log(`timezone-regression：${passed} 通过 / ${failed} 失败`)
}

try {
  await main()
} finally {
  await closePrisma()
}

process.exit(failed === 0 ? 0 : 1)