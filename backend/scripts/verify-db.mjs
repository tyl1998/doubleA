#!/usr/bin/env node
/**
 * verify-db.mjs —— P0-1-5 的**数据层验收**（需要真实 PG，故不进 CI）
 *
 * 与 `verify-app.mjs` 的分工：
 *   · verify-app 验「HTTP 协议契约」，刻意不需要任何真依赖（CI 里靠 EXPECT_DEGRADED 跑）；
 *   · 本脚本验「库结构 + Prisma 客户端」，**必须**有 PG 与已应用的迁移，因此不进 CI 链路，
 *     由开发者在 `pnpm infra:up` 之后手动跑（`pnpm verify:db`）。
 *
 * 覆盖 docs/06 P0-1-5 的三条验收 + 本批刻意补的边界：
 *   ① 迁移产物形态：7 张表 / 7 个枚举都在；messages 是分区表（relkind='p'）；
 *      月度子表按月命名；主键含分区键；会话索引在父表上并被分区继承；
 *      分区维护函数幂等。
 *   ② `migrate diff` 视角下**无结构漂移**（把 06 的坑预判变成断言）。
 *   ③ Prisma Client 生成且可用：uuid7 默认值、枚举/jsonb 默认值、jsonb 往返、
 *      **跨分区写入与读回**、复合主键 findUnique、唯一约束、级联删除、多态 ref_id。
 *   ④ 边界：缺分区的月份插入会**立刻**报错（"不建 DEFAULT 分区"的取舍取证）。
 *
 * 幂等：所有写入的数据在结尾清理，可反复运行。
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AgentType,
  ComponentType,
  ConversationStatus,
  MessageRole,
  ModelType,
  PrismaClient,
  UserRole,
  UserStatus,
  closePrisma,
  getPrisma,
} from '../dist/backend/src/infra/prisma.js'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
  d: useColor ? '\u001b[90m' : '',
  b: useColor ? '\u001b[1m' : '',
  x: useColor ? '\u001b[0m' : '',
}

let passed = 0
let failed = 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
}

async function it(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

// ───────────────────────── 准备：月份锚点与清理登记 ─────────────────────────

/** 取「本月 + offset 个月」的 15 号 12:00（本地时区）。用月中而非月初，避开边界歧义。 */
function monthAnchor(offset) {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + offset, 15, 12, 0, 0, 0)
}

/** `YYYY-MM-DD`：喂给 SQL 时用字符串而**不是** Date —— PG 函数签名是 date，字符串可被正确推断 */
function monthKey(date) {
  const yyyy = String(date.getFullYear()).padStart(4, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** 某个月份对应的分区名（与迁移里 to_char(...,'YYYY_MM') 的口径一致） */
function partitionNameFor(date) {
  return `messages_${monthKey(date).slice(0, 7).replace('-', '_')}`
}

/** 清理登记 */
const cleanup = { users: [], providers: [], conversations: [] }
/** 主链路的外键锚点，供多条用例共用 */
const chain = {}

console.log(`\n${c.b}══ P0-1-5 数据层验收：数据模型 / 分区 / Prisma 客户端 ══${c.x}`)

const prisma = getPrisma()

// 先探活：连不上就直接给出「怎么办」，而不是抛一坨驱动栈
try {
  await prisma.$queryRaw`SELECT 1`
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.log(`\n${c.r}连不上 PostgreSQL：${detail}${c.x}`)
  console.log('  · 先起依赖：pnpm infra:up')
  console.log('  · 再应用迁移：pnpm db:migrate')
  process.exit(1)
}

// ───────────────────────── 一、Prisma Client 与枚举 ─────────────────────────

await it('Prisma Client 可实例化，7 张表的委托齐备（"类型可用"的运行时侧证据）', () => {
  assert(typeof PrismaClient === 'function', 'PrismaClient 应当是可 new 的类')
  const delegates = [
    'user',
    'modelProvider',
    'model',
    'agent',
    'agentComponent',
    'conversation',
    'message',
  ]
  for (const name of delegates) {
    const delegate = prisma[name]
    assert(delegate != null, `客户端缺少委托 prisma.${name}`)
    for (const method of ['create', 'findMany', 'findUnique', 'update', 'delete']) {
      assert(typeof delegate[method] === 'function', `prisma.${name}.${method} 不可用`)
    }
  }
  console.log(`         ${c.d}委托：${delegates.join(' / ')}${c.x}`)
})

await it('7 个枚举取值域与 docs/02 第三节 一致', () => {
  assertEqual(Object.values(UserRole).join(','), 'ADMIN,MEMBER', 'UserRole')
  assertEqual(Object.values(UserStatus).join(','), 'ACTIVE,DISABLED', 'UserStatus')
  assertEqual(Object.values(ModelType).join(','), 'CHAT,EMBEDDING', 'ModelType')
  assertEqual(Object.values(AgentType).join(','), 'CHATBOT,TASK_AGENT', 'AgentType')
  assertEqual(Object.values(ComponentType).join(','), 'KNOWLEDGE,MCP', 'ComponentType')
  assertEqual(Object.values(ConversationStatus).join(','), 'ACTIVE,FINISHED', 'ConversationStatus')
  assertEqual(Object.values(MessageRole).join(','), 'USER,ASSISTANT,SYSTEM', 'MessageRole')
})

// ───────────────────────── 二、库结构：分区形态 ─────────────────────────

await it('messages 是分区表（pg_class.relkind = "p"，不是普通表 "r"）', async () => {
  const rows = await prisma.$queryRaw`
    SELECT c.relkind::text AS relkind
    FROM pg_class c
    WHERE c.oid = 'public.messages'::regclass`
  assertEqual(rows.length, 1, 'messages 应当存在')
  assertEqual(rows[0].relkind, 'p', 'relkind（p = partitioned table）')
})

await it('分区子表按月命名，数量 >= 12 且覆盖当月', async () => {
  const rows = await prisma.$queryRaw`
    SELECT c.relname::text AS name
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.messages'::regclass
    ORDER BY 1`
  const names = rows.map((row) => row.name)
  assert(names.length >= 12, `分区数应 >= 12，实际 ${names.length}`)
  for (const name of names) {
    assert(/^messages_\d{4}_\d{2}$/.test(name), `分区命名不符合 messages_YYYY_MM：${name}`)
  }
  const current = partitionNameFor(new Date())
  assert(names.includes(current), `应当包含当月分区 ${current}，实际 ${names.join(',')}`)
  console.log(`         ${c.d}${names.join(' ')}${c.x}`)
})

await it('主键 = (id, created_at)：分区键已在主键内（PG 硬性要求）', async () => {
  const rows = await prisma.$queryRaw`
    SELECT a.attname::text AS column
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = 'public.messages'::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`
  assertEqual(
    rows.map((row) => row.column).join(','),
    'id,created_at',
    '主键列与列序（游标分页要按 id / created_at 两列定位）',
  )
})

await it('会话分页索引建在父表上，且已被分区继承（新分区会同样继承）', async () => {
  const rows = await prisma.$queryRaw`
    SELECT c.relname::text AS name
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE i.indrelid = 'public.messages'::regclass
    ORDER BY 1`
  const names = rows.map((row) => row.name)
  assert(
    names.includes('messages_conversation_id_created_at_idx'),
    `父表缺少会话分页索引，实际 ${names.join(',')}`,
  )
  assert(names.includes('messages_pkey'), `父表缺少主键索引，实际 ${names.join(',')}`)

  const partition = partitionNameFor(new Date())
  const childRows = await prisma.$queryRawUnsafe(
    `SELECT c.relname::text AS name FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     WHERE i.indrelid = ('public.' || $1)::regclass ORDER BY 1`,
    partition,
  )
  const childNames = childRows.map((row) => row.name)
  assert(
    childNames.includes(`${partition}_conversation_id_created_at_idx`),
    `分区 ${partition} 未继承索引，实际 ${childNames.join(',')}`,
  )
})

await it('分区维护函数 ensure_messages_partition 幂等（重复调用不报错、不新建）', async () => {
  const before = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'public.messages'::regclass`
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "ensure_messages_partition"($1::date)::text AS name`,
    monthKey(monthAnchor(0)),
  )
  const after = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'public.messages'::regclass`
  assertEqual(rows[0].name, partitionNameFor(monthAnchor(0)), '返回值应是分区名')
  assertEqual(after[0].n, before[0].n, '重复调用不应新建分区（幂等）')
})

await it('Prisma 视角无结构漂移（migrate diff --exit-code = 0，即 06 坑预判已排除）', () => {
  let output
  try {
    output = execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--exit-code',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
      ],
      { cwd: BACKEND_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`
    throw new Error(`存在结构漂移（exit=${error.status}）。输出：\n${detail.trim() || '(无)'}`, {
      cause: error,
    })
  }
  assert(
    output.includes('No difference detected'),
    `期望 "No difference detected"，实际：${output.trim()}`,
  )
})

// ───────────────────────── 三、CRUD 与跨分区行为 ─────────────────────────

await it('建链路：user → provider → model → agent → conversation（各类默认值）', async () => {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

  const user = await prisma.user.create({
    data: { username: `verify_p015_${suffix}`, passwordHash: 'bcrypt-placeholder' },
  })
  cleanup.users.push(user.id)
  assert(isUuid(user.id), `uuid 默认值应生效，实际 id=${user.id}`)
  assertEqual(user.id[14], '7', 'id 应当是 uuid v7（第 3 组首字符 = 版本号）')
  assertEqual(user.role, UserRole.MEMBER, 'role 默认值')
  assertEqual(user.status, UserStatus.ACTIVE, 'status 默认值')
  assertEqual(user.mustChangePassword, true, 'mustChangePassword 默认值')
  assert(user.createdAt instanceof Date, 'createdAt 应有默认值')

  const provider = await prisma.modelProvider.create({
    data: {
      name: `verify-provider-${suffix}`,
      baseUrl: 'http://127.0.0.1:11434/v1',
      type: ModelType.CHAT,
    },
  })
  cleanup.providers.push(provider.id)
  assertEqual(provider.enabled, true, 'provider.enabled 默认值')
  assertEqual(provider.apiKeyEnc, null, 'apiKeyEnc 应可空（允许无鉴权 provider）')

  const model = await prisma.model.create({
    data: {
      providerId: provider.id,
      modelName: `verify-model-${suffix}`,
      label: '验收用模型',
      type: ModelType.CHAT,
      maxContext: 128000,
    },
  })
  assertEqual(model.supportsVision, false, 'supportsVision 默认值')
  assertEqual(model.enabled, true, 'model.enabled 默认值')

  // 刻意**不传** guideQuestions：验的是 jsonb 的 DB 级默认值 '[]'，不是 Prisma 侧兜底
  const agent = await prisma.agent.create({
    data: {
      name: `verify-agent-${suffix}`,
      type: AgentType.CHATBOT,
      modelId: model.id,
      createdBy: user.id,
      systemPrompt: '你是验收助手。',
    },
  })
  assertEqual(JSON.stringify(agent.guideQuestions), '[]', 'guide_questions 的 DB 默认值')
  assertEqual(agent.deletedAt, null, 'deletedAt 默认应为 null')

  const conversation = await prisma.conversation.create({
    data: { agentId: agent.id, userId: user.id, topic: '验收会话' },
  })
  cleanup.conversations.push(conversation.id)
  assertEqual(conversation.status, ConversationStatus.ACTIVE, 'status 默认值')
  assertEqual(conversation.lastMessageAt, null, 'lastMessageAt 初始为空')

  Object.assign(chain, { user, provider, model, agent, conversation })
})

await it('唯一约束生效：重复 username → P2002（而不是静默写入两条）', async () => {
  const duplicate = await prisma.user
    .create({ data: { username: chain.user.username, passwordHash: 'x' } })
    .then(() => null)
    .catch((error) => error)
  assert(duplicate !== null, '重复 username 竟然创建成功了')
  assertEqual(duplicate.code, 'P2002', 'Prisma 错误码')
})

await it('agent_components：多态 ref_id 无 FK、同绑定不可重复、同 ref 不同类型可共存', async () => {
  const refId = crypto.randomUUID()
  const mcp = await prisma.agentComponent.create({
    data: { agentId: chain.agent.id, componentType: ComponentType.MCP, refId },
  })
  assert(isUuid(mcp.refId), 'refId 原样落库（无 FK，故可以是任何 uuid）')

  const duplicate = await prisma.agentComponent
    .create({ data: { agentId: chain.agent.id, componentType: ComponentType.MCP, refId } })
    .then(() => null)
    .catch((error) => error)
  assert(duplicate !== null, '同一 (agent, type, ref) 竟然重复绑定了')
  assertEqual(duplicate.code, 'P2002', 'Prisma 错误码')

  const knowledge = await prisma.agentComponent.create({
    data: { agentId: chain.agent.id, componentType: ComponentType.KNOWLEDGE, refId },
  })
  assert(knowledge.id !== mcp.id, '同一 refId 的不同组件类型应当都能绑定（唯一键含 component_type）')

  const count = await prisma.agentComponent.count({ where: { agentId: chain.agent.id } })
  assertEqual(count, 2, '绑定数')
})

await it('跨月写入 3 条消息 → 分别落到 3 个不同分区（分区路由正确）', async () => {
  const anchors = [monthAnchor(0), monthAnchor(1), monthAnchor(2)]
  const created = []
  for (const [index, createdAt] of anchors.entries()) {
    created.push(
      await prisma.message.create({
        data: {
          conversationId: chain.conversation.id,
          role: index === 0 ? MessageRole.USER : MessageRole.ASSISTANT,
          content: {
            text: `第 ${index} 条`,
            thinking: null,
            tool_calls: [],
            citations: [],
            attachments: [],
          },
          createdAt,
        },
      }),
    )
  }
  chain.messages = created

  const distribution = await prisma.$queryRawUnsafe(
    `SELECT tableoid::regclass::text AS partition, count(*)::int AS n
     FROM public.messages WHERE conversation_id = $1::uuid GROUP BY 1 ORDER BY 1`,
    chain.conversation.id,
  )
  assertEqual(distribution.length, 3, `3 条消息应落在 3 个分区，实际 ${distribution.length} 个`)
  assertEqual(
    distribution.map((row) => row.partition).join(','),
    anchors.map(partitionNameFor).join(','),
    '分区归属与月份对应关系',
  )
  console.log(
    `         ${c.d}${distribution.map((row) => `${row.partition}×${row.n}`).join('  ')}${c.x}`,
  )
})

await it('Prisma 跨分区读回 3 条，且 jsonb content 原样还原', async () => {
  const rows = await prisma.message.findMany({
    where: { conversationId: chain.conversation.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  assertEqual(rows.length, 3, '跨分区 findMany 应取回全部 3 条')
  assertEqual(
    rows.map((row) => row.content.text).join('|'),
    '第 0 条|第 1 条|第 2 条',
    'jsonb 内容顺序',
  )
  const first = rows[0].content
  for (const key of ['text', 'thinking', 'tool_calls', 'citations', 'attachments']) {
    assert(key in first, `content 应保留 key ${key}（02 第三节 约定的五个字段）`)
  }
  assertEqual(JSON.stringify(first.tool_calls), '[]', 'jsonb 嵌套数组应原样还原')
})

await it('复合主键 findUnique 可用（@@id([id, createdAt]) 的调用口径）', async () => {
  const target = chain.messages[1]
  const found = await prisma.message.findUnique({
    where: { id_createdAt: { id: target.id, createdAt: target.createdAt } },
  })
  assert(found !== null, '复合键应能取回消息')
  assertEqual(found.id, target.id, 'id')
  assertEqual(found.content.text, '第 1 条', 'content')

  const wrong = await prisma.message.findUnique({
    where: { id_createdAt: { id: target.id, createdAt: chain.messages[0].createdAt } },
  })
  assertEqual(wrong, null, 'id 与 created_at 不匹配时不应误命中（这正是复合键的意义）')
})

await it('缺分区的月份插入**立刻**报错（"不建 DEFAULT 分区"的取舍取证）', async () => {
  const orphan = monthAnchor(-24)
  const error = await prisma.message
    .create({
      data: {
        conversationId: chain.conversation.id,
        role: MessageRole.USER,
        content: { text: '越界月份' },
        createdAt: orphan,
      },
    })
    .then(() => null)
    .catch((caught) => caught)
  assert(error !== null, '越界月份竟然写成功了 —— 说明存在 DEFAULT 分区，取舍需重新评估')
  assert(
    /no partition of relation "messages" found/.test(String(error.message)),
    `期望 PG 的缺分区报错，实际：${error.message}`,
  )
  console.log(`         ${c.d}越界月份 ${partitionNameFor(orphan)} 的报错符合预期（吵但清晰）${c.x}`)
})

await it('删会话级联删消息（分区表上的 FK 级联生效）', async () => {
  await prisma.conversation.delete({ where: { id: chain.conversation.id } })
  cleanup.conversations = []
  const left = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM public.messages WHERE conversation_id = $1::uuid`,
    chain.conversation.id,
  )
  assertEqual(left[0].n, 0, '级联后不应残留消息')
})

await it('删 Agent 级联删组件绑定（agent_components 的 Cascade 生效）', async () => {
  await prisma.agent.delete({ where: { id: chain.agent.id } })
  const left = await prisma.agentComponent.count({ where: { agentId: chain.agent.id } })
  assertEqual(left, 0, '级联后不应残留组件绑定')
})

// ───────────────────────── 四、清理（幂等，可反复运行）─────────────────────────

try {
  for (const id of cleanup.conversations) {
    await prisma.conversation.delete({ where: { id } }).catch(() => undefined)
  }
  if (chain.model !== undefined) {
    await prisma.model.delete({ where: { id: chain.model.id } }).catch(() => undefined)
  }
  for (const id of cleanup.providers) {
    await prisma.modelProvider.delete({ where: { id } }).catch(() => undefined)
  }
  for (const id of cleanup.users) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined)
  }
} catch (error) {
  console.log(
    `  ${c.d}清理时出错（不影响结论）：${error instanceof Error ? error.message : String(error)}${c.x}`,
  )
}

await closePrisma()

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-5 数据层验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-5 数据层验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
