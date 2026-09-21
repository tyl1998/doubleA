#!/usr/bin/env node
/**
 * verify-knowledge.mjs —— P0-1-14 的**知识库数据层验收**（需要真实 PG，故不进 CI）
 *
 * ⚠️ 前置：`pnpm infra:up` + `pnpm db:deploy`（与 `verify:db` 同一档；本脚本不碰 Redis/S3）。
 *
 * 覆盖 `docs/06` P0-1-14 的两条验收，并把本批发现的三个陷阱变成可执行的断言：
 *   ① `\d+ chunks` 能看到 HNSW 与 `gin_bigm_ops` 两个索引 —— 不只断言"存在"，
 *      还断言 `indexdef` 的**逐字形态**（`USING hnsw` + `vector_cosine_ops` +
 *      `m='16'`/`ef_construction='64'`，以及 `gin` + `gin_bigm_ops`）；
 *   ② `retrieval_config` 默认值写入正确（topK=5/score=0.3/mode=HYBRID/
 *      splitStrategy=hybrid/rrfK=60/weights）—— 走"插一行最小列再读回"的真路，
 *      而不是读 DDL 文本；
 *   ③ **两个索引不会被 Prisma 的 `migrate dev` 删掉**（本批最大的坑，见下）；
 *   ④ **两个索引真的被规划器用上**（`EXPLAIN` + `enable_seqscan=off`）——
 *      索引存在 ≠ 索引可用：算子类/部分索引谓词对不上时，`\d+` 照样看得见，
 *      但查询会退化。这条断言是 ③ 那个"藏法"的**使用侧代价**的守门人。
 *
 * ── 为什么 ③ 是必须的（`06` P0-1-14 的坑预判在这里被证明"不完整"）───────────
 * 迁移 `0002_knowledge` 里的两个索引是**手写**的（Prisma 表达不了 `USING hnsw`
 * 与算子类）。而 Prisma 认不出的索引会被它判成"库里多出来的对象"：
 *
 *     $ prisma migrate dev --create-only       # 只要 schema 有任何其它改动
 *     -- DropIndex
 *     DROP INDEX "idx_chunks_bigram";
 *     -- DropIndex
 *     DROP INDEX "idx_chunks_embedding";
 *
 * 即"下一个批次动 schema 时，两条索引被静默删掉、检索退化成全表扫描"。
 * 注意这**不是** P0-1-5 那个 messages 分区的情形（那次经实测是"Prisma 会主动跳过"），
 * 别把结论外推。本批的处置与守门：
 *   · `idx_chunks_bigram` → 在 `schema.prisma` 里用
 *     `@@index([content(ops: raw("gin_bigm_ops"))], type: Gin, map: "idx_chunks_bigram")`
 *     声明（`Prisma` 能表达它），于是 diff 归零；
 *   · `idx_chunks_embedding` → Prisma 无法表达，改为建**部分索引**
 *     （`WHERE kb_id IS NOT NULL`）：Prisma **忽略部分索引**（实测：普通 btree 与
 *     表达式索引都会被它检出，唯独带 `WHERE` 谓词的不看）；
 *     该谓词恒真（`kb_id` 是 NOT NULL 列）且被向量路的 `kb_id = $2` 蕴含，
 *     故索引内容与全量 HNSW 等价、规划器照常使用（由 ④ 与下面第 5 条断言共同守住）。
 *
 * 日志：脚本故意跑"应当失败"的用例（维度不符）会打 error 日志，故默认把级别收到 fatal
 * （只留断言输出）；要跟着看细节：`LOG_LEVEL=debug pnpm verify:knowledge`。
 *
 * 幂等：所有写入在结尾清理，并**实测复核残留为基线值**（本脚本不写 Redis/S3，无需清键）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ⚠️ 必须在 import config 之前收日志级别（config 在模块求值期就建好了 logger）。
//    用动态 import 才能保证顺序 —— 静态 import 会被提升到本行之上。
//    （config 加载 infra/.env 时**不覆盖**已存在的进程变量，所以这里设了就赢。）
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal'

const { getPrisma, closePrisma } = await import('../dist/backend/src/infra/prisma.js')
const { config } = await import('../dist/backend/src/config.js')

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

/** Prisma CLI 入口（在 backend 下跑，`pnpm exec prisma` 的等价物） */
function resolvePrismaCli() {
  const candidates = [
    // pnpm 把可执行文件提升到工作区根的 node_modules/.bin（backend 下没有 .bin 目录）
    resolve(BACKEND_DIR, '../node_modules/prisma/build/index.js'),
    resolve(BACKEND_DIR, 'node_modules/prisma/build/index.js'),
  ]
  const found = candidates.find((path) => existsSync(path))
  assert(found !== undefined, `找不到 Prisma CLI（试过：${candidates.join(' / ')}）`)
  return found
}

/**
 * 按**键名排序后**递归比较两个 JSON —— jsonb 不保留键序（按长度/值规范化存储），
 * 直接 `JSON.stringify` 比较会得到"看起来不同、其实一样"的假失败。
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

function assertJsonEqual(actual, expected, label) {
  assertEqual(
    JSON.stringify(canonical(actual)),
    JSON.stringify(canonical(expected)),
    label,
  )
}

/** 一条 1024 维单位向量（第 idx 位为 1）—— 用它做"最近邻是自己"的确定性断言 */
function unitVector(index) {
  const values = []
  for (let i = 0; i < config.embedding.dim; i += 1) values.push(i === index ? 1 : 0)
  return `[${values.join(',')}]`
}

/** 表名 → 行数（用于残留复核） */
async function tableCounts(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT count(*) FROM knowledge_bases)::int AS kbs,
       (SELECT count(*) FROM documents)::int       AS docs,
       (SELECT count(*) FROM chunks)::int          AS chunks`,
  )
  return rows[0]
}

console.log(`\n${c.b}══ P0-1-14 知识库数据层验收：扩展 / 三表 / 两个特殊索引 ══${c.x}`)

const prisma = getPrisma()

try {
  await prisma.$queryRaw`SELECT 1`
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.log(`\n${c.r}连不上 PostgreSQL：${detail}${c.x}`)
  console.log('  · 先起依赖：pnpm infra:up')
  console.log('  · 再应用迁移：pnpm db:deploy')
  process.exit(1)
}

/** 清理登记（结尾按此删库，级联带走 documents/chunks） */
const cleanup = { kbIds: [] }
const baseline = await tableCounts(prisma)
console.log(
  `  ${c.d}基线行数：knowledge_bases=${baseline.kbs} documents=${baseline.docs} chunks=${baseline.chunks}${c.x}`,
)

// ───────────────────────── 一、扩展与算子类 ─────────────────────────

await it('vector 与 pg_bigm 两个扩展都已在**本库**启用（镜像里有 ≠ 库里装了）', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT extname::text AS name, extversion::text AS version FROM pg_extension
     WHERE extname IN ('vector', 'pg_bigm') ORDER BY extname`,
  )
  const map = Object.fromEntries(rows.map((row) => [row.name, row.version]))
  assertEqual(rows.length, 2, `已安装的扩展数（实际：${JSON.stringify(map)}）`)
  // 下限来自 06 P0-1-14 的 DDL 需求：HNSW 要 pgvector >= 0.5、gin_bigm_ops 要 pg_bigm >= 1.1
  assert(
    Number.parseFloat(map.vector) >= 0.5,
    `pgvector 版本过低（${map.vector}），HNSW 需要 >= 0.5`,
  )
  assert(
    Number.parseFloat(map.pg_bigm) >= 1.1,
    `pg_bigm 版本过低（${map.pg_bigm}），gin_bigm_ops 需要 >= 1.1`,
  )
  console.log(`         ${c.d}vector=${map.vector} pg_bigm=${map.pg_bigm}${c.x}`)
})

await it('pg_bigm 真的在跑：bigm_similarity 对中文返回 > 0', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT bigm_similarity('中文测试', '中文')::float8 AS score`,
  )
  assert(rows[0].score > 0, `bigm_similarity 应 > 0，实际 ${rows[0].score}`)
  console.log(`         ${c.d}bigm_similarity('中文测试','中文') = ${rows[0].score}${c.x}`)
})

await it('text 没有默认 GIN 算子类 —— 这就是 DDL 里必须写 gin_bigm_ops 的机制', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT o.opcname::text AS name, o.opcdefault AS is_default
     FROM pg_opclass o JOIN pg_am a ON a.oid = o.opcmethod
     WHERE a.amname = 'gin' AND o.opcintype = 'text'::regtype`,
  )
  assert(rows.length >= 1, '应当存在 text 的 gin 算子类（pg_bigm 提供）')
  assert(
    rows.every((row) => row.is_default === false),
    `text 的 GIN 算子类不应有默认项，实际：${JSON.stringify(rows)}`,
  )
  console.log(`         ${c.d}${rows.map((row) => `${row.name}(default=${row.is_default})`).join(' ')}${c.x}`)
})

// ───────────────────────── 二、chunks 的两个特殊索引 ─────────────────────────

await it('idx_chunks_embedding：USING hnsw + vector_cosine_ops + m=16/ef_construction=64', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT indexdef::text AS def FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'chunks' AND indexname = 'idx_chunks_embedding'`,
  )
  assertEqual(rows.length, 1, 'idx_chunks_embedding 应当存在')
  const def = rows[0].def
  for (const fragment of [
    'USING hnsw',
    'embedding vector_cosine_ops',
    "m='16'",
    "ef_construction='64'",
  ]) {
    assert(def.includes(fragment), `indexdef 缺少 ${fragment}：${def}`)
  }
  console.log(`         ${c.d}${def}${c.x}`)
})

await it('idx_chunks_bigram：USING gin + 显式算子类 gin_bigm_ops（06 点名的必测坑）', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT indexdef::text AS def FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'chunks' AND indexname = 'idx_chunks_bigram'`,
  )
  assertEqual(rows.length, 1, 'idx_chunks_bigram 应当存在')
  const def = rows[0].def
  assert(def.includes('USING gin'), `应当是 GIN 索引：${def}`)
  assert(def.includes('gin_bigm_ops'), `必须显式写算子类 gin_bigm_ops：${def}`)
  assert(!def.includes('gin_trgm_ops'), `不应是 trigram 算子类：${def}`)
  console.log(`         ${c.d}${def}${c.x}`)
})

await it('HNSW 索引带 `WHERE kb_id IS NOT NULL` 谓词（把 Prisma 看不见的索引藏起来）', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pg_get_expr(i.indpred, i.indrelid)::text AS predicate
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_chunks_embedding'`,
  )
  assertEqual(rows.length, 1, 'idx_chunks_embedding 应当存在')
  assertEqual(rows[0].predicate, '(kb_id IS NOT NULL)', '部分索引谓词（Prisma 据此忽略它）')
})

await it('谓词是恒真的：chunks.kb_id 是 NOT NULL 列 ⇒ 索引覆盖全部行，与全量 HNSW 等价', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT format_type(a.atttypid, a.atttypmod)::text AS type, a.attnotnull AS notnull
     FROM pg_attribute a
     WHERE a.attrelid = 'public.chunks'::regclass AND a.attname = 'kb_id'`,
  )
  assertEqual(rows.length, 1, 'chunks.kb_id 应当存在')
  assertEqual(rows[0].notnull, true, 'chunks.kb_id 的 NOT NULL 约束（谓词恒真的前提）')
  console.log(`         ${c.d}chunks.kb_id ${rows[0].type} NOT NULL ⇒ 谓词恒真${c.x}`)
})

await it('⚠️ 结构无漂移：`prisma migrate diff --exit-code` = 0（即两个索引不会被 migrate 删掉）', () => {
  const cli = resolvePrismaCli()
  let output
  let status = 0
  try {
    output = execFileSync(
      process.execPath,
      [
        cli,
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
    status = error.status ?? 1
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  assert(
    status === 0,
    `migrate diff 退出码应为 0（0=无差异）实际 ${status}；输出：${String(output).trim()}`,
  )
  console.log(`         ${c.d}无差异（HNSW 的"藏法"与 GIN 的 schema 声明都还成立）${c.x}`)
})

await it('两个特殊索引真的被规划器用上（存在 ≠ 可用）', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-索引用例', embeddingModel: 'api:verify' },
  })
  cleanup.kbIds.push(kb.id)
  const doc = await prisma.document.create({
    data: {
      kbId: kb.id,
      fileKey: `verify/${kb.id}.txt`,
      fileName: '索引用例.txt',
      contentHash: 'b'.repeat(64),
    },
  })
  await prisma.$executeRawUnsafe(
    `INSERT INTO chunks (id, doc_id, kb_id, seq, content, embedding)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 0, $3, $4::vector)`,
    doc.id,
    kb.id,
    '报销制度的中文正文内容',
    unitVector(0),
  )

  // ⚠️ 这里要读的是「这条索引**能不能**服务这个查询形状」，不是「PG 会不会选它」——
  //    小表上 PG 理性地选 (`chunks_kb_id_idx` + 排序) 而不是 HNSW/KB 索引 + 过滤，
  //    那是成本模型正确的判断（数据少时它确实更快），不是索引坏了的信号。
  //    手法：关掉更便宜的退路，看索引是否现身。方向是**单向有效**的 ——
  //    不可用的索引永远不会出现在计划里，所以"现身"就是可用性证据（"没现身"则不构成反证）。
  //    · `enable_sort=off`：否则 ORDER BY 会走"kb_id 索引取行 + 显式排序"这条更便宜的路；
  //    · 全文路**不能**关 `enable_bitmapscan`：GIN 的常规用法正是 Bitmap Index Scan。
  //    `SET LOCAL` 必须在同一个连接里生效 → 用交互式事务把 SET 与 EXPLAIN 绑在一起。
  const planOf = (settings, sql, params) =>
    prisma.$transaction(async (tx) => {
      for (const setting of settings) await tx.$executeRawUnsafe(`SET LOCAL ${setting}`)
      const rows = await tx.$queryRawUnsafe(sql, ...params)
      return rows.map((row) => row['QUERY PLAN']).join('\n')
    })

  const vectorPlan = await planOf(
    ['enable_seqscan = off', 'enable_sort = off'],
    `EXPLAIN (COSTS OFF)
     SELECT id FROM chunks WHERE kb_id = $1::uuid ORDER BY embedding <=> $2::vector LIMIT 5`,
    [kb.id, unitVector(0)],
  )
  assert(
    vectorPlan.includes('idx_chunks_embedding'),
    `向量路应命中 idx_chunks_embedding（部分索引的谓词必须被 kb_id = $1 蕴含），实际计划：\n${vectorPlan}`,
  )

  // 全文路刻意**去掉 kb_id 限定**：留着它时 PG 会优先用 kb_id 索引再过滤（同样是小表的理性选择），
  // GIN 就不露头了；去掉之后"唯一能服务这个 LIKE 的索引"就是 GIN，它现身即证明算子类对得上。
  const fulltextPlan = await planOf(
    ['enable_seqscan = off'],
    `EXPLAIN (COSTS OFF)
     SELECT id FROM chunks WHERE content LIKE '%中文正文%'`,
    [],
  )
  assert(
    fulltextPlan.includes('idx_chunks_bigram'),
    `全文路应命中 idx_chunks_bigram，实际计划：\n${fulltextPlan}`,
  )
  console.log(`         ${c.d}向量路 → idx_chunks_embedding；全文路 → idx_chunks_bigram${c.x}`)
})

// ───────────────────────── 三、三表结构、默认值与主键口径 ─────────────────────────

await it('三表 + document_status 枚举齐备，取值域与 docs/02 第三节一致', async () => {
  const tables = await prisma.$queryRawUnsafe(
    `SELECT tablename::text AS name FROM pg_tables
     WHERE schemaname = 'public' AND tablename IN ('knowledge_bases', 'documents', 'chunks')
     ORDER BY tablename`,
  )
  assertEqual(
    tables.map((row) => row.name).join(','),
    'chunks,documents,knowledge_bases',
    '三张表',
  )
  const labels = await prisma.$queryRawUnsafe(
    `SELECT e.enumlabel::text AS label FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'document_status' ORDER BY e.enumsortorder`,
  )
  assertEqual(
    labels.map((row) => row.label).join(','),
    'PARSING,READY,FAILED',
    'document_status 取值域',
  )
})

await it('chunks.embedding 的维度与 EMBEDDING_DIM 一致（DDL 写死的 vector(1024)）', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT format_type(atttypid, atttypmod)::text AS type
     FROM pg_attribute
     WHERE attrelid = 'public.chunks'::regclass AND attname = 'embedding'`,
  )
  assertEqual(rows.length, 1, 'chunks.embedding 应当存在')
  assertEqual(rows[0].type, `vector(${config.embedding.dim})`, 'chunks.embedding 的类型')
})

await it('普通索引齐备（两个文档/分块查询方向 + doc_id 外键所需的那条）', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT indexname::text AS name FROM pg_indexes
     WHERE schemaname = 'public' AND tablename IN ('documents', 'chunks') ORDER BY indexname`,
  )
  const names = rows.map((row) => row.name)
  for (const expected of [
    'documents_kb_id_created_at_idx',
    'chunks_kb_id_idx',
    'chunks_doc_id_seq_idx',
  ]) {
    assert(names.includes(expected), `缺少索引 ${expected}（实际：${names.join(', ')}）`)
  }
})

await it('外键删除语义：documents→knowledge_bases 与 chunks→documents 都是 CASCADE', async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT conname::text AS name, confdeltype::text AS action FROM pg_constraint
     WHERE conrelid IN ('public.documents'::regclass, 'public.chunks'::regclass)
       AND contype = 'f' ORDER BY conname`,
  )
  assertEqual(rows.length, 2, `外键数量（实际：${JSON.stringify(rows)}）`)
  for (const row of rows) {
    assertEqual(row.action, 'c', `${row.name} 的 ON DELETE 动作（c = CASCADE）`)
  }
})

await it('retrieval_config 的 DB 默认值是完整形状（topK/score/mode/splitStrategy/rrfK/weights）', async () => {
  // 只给必填列 —— 其余全部走 DB 默认值，正是"老数据/裸插入也有可用配置"的取证
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-默认值用例', embeddingModel: 'api:verify' },
  })
  cleanup.kbIds.push(kb.id)
  const row = await prisma.$queryRawUnsafe(
    `SELECT chunk_size, chunk_overlap, retrieval_config FROM knowledge_bases WHERE id = $1::uuid`,
    kb.id,
  )
  assertEqual(row[0].chunk_size, 512, 'chunk_size 默认值')
  assertEqual(row[0].chunk_overlap, 64, 'chunk_overlap 默认值')
  assertJsonEqual(
    row[0].retrieval_config,
    {
      topK: 5,
      score: 0.3,
      mode: 'HYBRID',
      splitStrategy: 'hybrid',
      rrfK: 60,
      weights: { vector: 1, fulltext: 1 },
    },
    'retrieval_config 默认值',
  )
  console.log(`         ${c.d}${JSON.stringify(row[0].retrieval_config)}${c.x}`)
})

await it('非默认写入：chunk_size / chunk_overlap / retrieval_config 可整体覆盖', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: {
      name: 'verify-知识库-覆盖用例',
      description: '描述可空',
      embeddingModel: 'local:bge-m3-int8',
      chunkSize: 256,
      chunkOverlap: 32,
      retrievalConfig: { topK: 3, score: 0.7, mode: 'VECTOR', splitStrategy: 'fixed', rrfK: 10, weights: { vector: 2, fulltext: 0 } },
    },
  })
  cleanup.kbIds.push(kb.id)
  const row = await prisma.$queryRawUnsafe(
    `SELECT chunk_size, chunk_overlap, retrieval_config FROM knowledge_bases WHERE id = $1::uuid`,
    kb.id,
  )
  assertEqual(row[0].chunk_size, 256, 'chunk_size')
  assertEqual(row[0].chunk_overlap, 32, 'chunk_overlap')
  assertEqual(row[0].retrieval_config.mode, 'VECTOR', 'retrieval_config.mode')
  assertEqual(row[0].retrieval_config.topK, 3, 'retrieval_config.topK')
})

await it('documents 默认值：status=PARSING、chunk_count=0、error_msg=NULL、content_hash 非空', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-文档默认值', embeddingModel: 'api:verify' },
  })
  cleanup.kbIds.push(kb.id)
  const doc = await prisma.document.create({
    data: {
      kbId: kb.id,
      fileKey: `verify/${kb.id}.md`,
      fileName: '默认值.md',
      contentHash: 'c'.repeat(64),
    },
  })
  assertEqual(doc.status, 'PARSING', 'documents.status 默认值')
  assertEqual(doc.chunkCount, 0, 'documents.chunk_count 默认值')
  assertEqual(doc.errorMsg, null, 'documents.error_msg 默认值')
  const rows = await prisma.$queryRawUnsafe(
    `SELECT character_maximum_length AS len, is_nullable::text AS nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'content_hash'`,
  )
  assertEqual(rows[0].nullable, 'NO', 'content_hash is_nullable')
  assertEqual(rows[0].len, 64, 'content_hash 长度（sha256 十六进制）')
})

await it('主键仍是 uuid(7) 口径（三张表的新记录 id 第 3 组首字符为 7）', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-uuid7', embeddingModel: 'api:verify' },
  })
  cleanup.kbIds.push(kb.id)
  const doc = await prisma.document.create({
    data: { kbId: kb.id, fileKey: 'k', fileName: 'f.txt', contentHash: 'd'.repeat(64) },
  })
  const chunk = await prisma.chunk.create({
    data: { docId: doc.id, kbId: kb.id, seq: 0, content: '正文' },
  })
  for (const [label, id] of [
    ['knowledge_bases', kb.id],
    ['documents', doc.id],
    ['chunks', chunk.id],
  ]) {
    // uuid v7 的版本位固定为第 3 组的首字符（形如 01a0c2ed-2fbc-75ae-...）
    assertEqual(id.split('-')[2][0], '7', `${label} 的 id 版本位`)
  }
})

await it('Prisma 侧能建 chunk 行（可空 Unsupported 列是关键），但读回**不含** embedding', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-unsupported', embeddingModel: 'api:verify' },
  })
  cleanup.kbIds.push(kb.id)
  const doc = await prisma.document.create({
    data: { kbId: kb.id, fileKey: 'k', fileName: 'f.txt', contentHash: 'e'.repeat(64) },
  })
  const chunk = await prisma.chunk.create({
    data: { docId: doc.id, kbId: kb.id, seq: 0, content: '不写向量' },
  })
  assert(chunk.id !== undefined, 'chunk 应当建成功（embedding 可空 ⇒ Prisma 可省略它）')
  assert(
    !Object.hasOwn(chunk, 'embedding'),
    `embedding 是 Unsupported 列，不应出现在 client 结果里（实际键：${Object.keys(chunk).join(',')}）`,
  )
  const raw = await prisma.$queryRawUnsafe(
    `SELECT embedding IS NULL AS is_null FROM chunks WHERE id = $1::uuid`,
    chunk.id,
  )
  assertEqual(raw[0].is_null, true, '未写向量的行，库内 embedding 应为 NULL')
})

// ───────────────────────── 四、向量列的真实读写 ─────────────────────────

await it('1024 维向量可写入并按 <=> 排回；无向量的行 score 为 NULL 且排在最后', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-向量', embeddingModel: 'api:verify' },
  })
  cleanup.kbIds.push(kb.id)
  const doc = await prisma.document.create({
    data: { kbId: kb.id, fileKey: 'k', fileName: 'f.txt', contentHash: 'f'.repeat(64) },
  })
  await prisma.$executeRawUnsafe(
    `INSERT INTO chunks (id, doc_id, kb_id, seq, content, embedding) VALUES
       (gen_random_uuid(), $1::uuid, $2::uuid, 0, '第 0 位为 1', $3::vector),
       (gen_random_uuid(), $1::uuid, $2::uuid, 1, '第 1 位为 1', $4::vector)`,
    doc.id,
    kb.id,
    unitVector(0),
    unitVector(1),
  )
  await prisma.chunk.create({
    data: { docId: doc.id, kbId: kb.id, seq: 2, content: '没有向量' },
  })
  const rows = await prisma.$queryRawUnsafe(
    `SELECT seq, 1 - (embedding <=> $2::vector) AS score FROM chunks
     WHERE kb_id = $1::uuid ORDER BY embedding <=> $2::vector LIMIT 10`,
    kb.id,
    unitVector(0),
  )
  assertEqual(rows.length, 3, '应读回 3 行')
  assertEqual(rows[0].seq, 0, '与查询向量同向的那条应排第一')
  assertEqual(Number(rows[0].score), 1, '同向向量的 cosine 相似度应为 1')
  assertEqual(rows[2].seq, 2, '无向量的行应排最后（NULLS LAST）')
  assertEqual(rows[2].score, null, '无向量的行 score 应为 NULL')
  console.log(`         ${c.d}${JSON.stringify(rows)}${c.x}`)
})

await it('维度不符被拒：写 3 维进 vector(1024) 必须报 "expected 1024 dimensions"', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-维度', embeddingModel: 'api:verify' },
  })
  cleanup.kbIds.push(kb.id)
  const doc = await prisma.document.create({
    data: { kbId: kb.id, fileKey: 'k', fileName: 'f.txt', contentHash: '0'.repeat(64) },
  })
  // 这一条刻意走 Prisma 的 raw 通道（P0-1-19 的写入路径），失败日志已由 LOG_LEVEL 收敛
  let error
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO chunks (id, doc_id, kb_id, seq, content, embedding)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 9, '短向量', '[1,2,3]'::vector)`,
      doc.id,
      kb.id,
    )
  } catch (caught) {
    error = caught
  }
  assert(error !== undefined, '维度不符竟然写成功了 —— vector(n) 的维度约束失效')
  assert(
    /expected 1024 dimensions, not 3/.test(String(error.message)),
    `期望维度报错，实际：${String(error.message).split('\n')[0]}`,
  )
})

// ───────────────────────── 五、级联删除 ─────────────────────────

await it('删一个 document → 它的 chunks 清零，兄弟文档的 chunk 完好', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-级联1', embeddingModel: 'api:verify' },
  })
  cleanup.kbIds.push(kb.id)
  const docs = []
  for (const [seq, name] of [
    [0, '甲.txt'],
    [1, '乙.txt'],
  ]) {
    const doc = await prisma.document.create({
      data: { kbId: kb.id, fileKey: `k/${seq}`, fileName: name, contentHash: String(seq).repeat(64) },
    })
    docs.push(doc)
    await prisma.chunk.create({
      data: { docId: doc.id, kbId: kb.id, seq: 0, content: `正文-${name}` },
    })
  }
  await prisma.document.delete({ where: { id: docs[0].id } })
  const left = await prisma.$queryRawUnsafe(
    `SELECT doc_id::text AS doc_id FROM chunks WHERE kb_id = $1::uuid`,
    kb.id,
  )
  assertEqual(left.length, 1, '应只剩兄弟文档的 1 个 chunk')
  assertEqual(left[0].doc_id, docs[1].id, '剩下的 chunk 应属于兄弟文档')
})

await it('删 knowledge_base → documents 与 chunks 全部级联清除（kb → doc → chunk）', async () => {
  const kb = await prisma.knowledgeBase.create({
    data: { name: 'verify-知识库-级联2', embeddingModel: 'api:verify' },
  })
  const doc = await prisma.document.create({
    data: { kbId: kb.id, fileKey: 'k', fileName: 'f.txt', contentHash: '9'.repeat(64) },
  })
  await prisma.chunk.create({ data: { docId: doc.id, kbId: kb.id, seq: 0, content: '正文' } })
  await prisma.knowledgeBase.delete({ where: { id: kb.id } })
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT count(*) FROM documents WHERE kb_id = $1::uuid)::int AS docs,
       (SELECT count(*) FROM chunks WHERE kb_id = $1::uuid)::int    AS chunks`,
    kb.id,
  )
  assertEqual(rows[0].docs, 0, '级联后不应残留 documents')
  assertEqual(rows[0].chunks, 0, '级联后不应残留 chunks')
})

// ───────────────────────── 六、清理与残留复核 ─────────────────────────

try {
  if (cleanup.kbIds.length > 0) {
    // deleteMany：清单里可能有已被用例自己删掉的记录，delete 会为它打一段 P2025 堆栈到 stdout
    await prisma.knowledgeBase.deleteMany({ where: { id: { in: cleanup.kbIds } } })
  }
} catch (error) {
  console.log(
    `  ${c.d}清理时出错（不影响结论）：${error instanceof Error ? error.message : String(error)}${c.x}`,
  )
}

await it('自清理复核：三表行数回到基线（无残留 session/文档/chunk）', async () => {
  const after = await tableCounts(prisma)
  assertEqual(JSON.stringify(after), JSON.stringify(baseline), '清理后的行数应与基线一致')
  const leftovers = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM knowledge_bases WHERE name LIKE 'verify-%'`,
  )
  assertEqual(leftovers[0].n, 0, '不应残留 verify- 前缀的知识库')
})

await closePrisma()

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ P0-1-14 知识库数据层验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ P0-1-14 知识库数据层验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
