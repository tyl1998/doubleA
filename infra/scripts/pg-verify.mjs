#!/usr/bin/env node
/**
 * pg-verify.mjs —— P0-1-2 验收脚本
 *
 * 用 `docker compose exec postgres psql` 在**容器内**执行 SQL，因此：
 *   - 不依赖宿主有没有装 psql；
 *   - 不受宿主端口映射影响（走容器内 5432）；
 *   - 环境变量（POSTGRES_USER / POSTGRES_DB）由容器自身持有。
 *
 * ══ 实现要点（P0-1-2 踩坑后固化，改本文件前先读）═══════════════════════
 * ① **`psql -c` 执行多语句会把每条命令的标签也打出来**（CREATE TABLE /
 *    INSERT 0 3 / CREATE INDEX / SET …），`-t -A` 也压不住。若直接把 stdout
 *    丢给断言就会拿到 "CREATE TABLE\nINSERT 0 3\n…\n1"，解析必然失败。
 *    → 对策：凡是「多条语句 + 要读返回值」的场景，一律包成**单条 SELECT**，
 *      用 CTE / 子查询把 DDL 藏进一条语句里（见 `checkDdl`）。
 * ② **扩展的 GUC 只在库被载入本会话后才注册**。`pg_bigm.similarity_limit`
 *    在没调用过 bigm 函数的会话里读不到（`current_setting(..., true)` 返 NULL）。
 *    → 对策：先调一次 `bigm_similarity()` 再读 GUC。
 * ③ 不要在断言里用 `Number(out)` 直接吃多行输出 —— 见 ①。
 *
 * 验收项（对应 docs/06 §P0-1-2 验收门槛）：
 *   1. CREATE EXTENSION vector / pg_bigm  均成功
 *   2. bigm_similarity('中文测试','中文') > 0（**A2 问题的最终验证**）
 *   3. gin_bigm_ops 算子类已注册
 *   4. 能建 GIN(gin_bigm_ops) 索引
 *   5. 能建 HNSW(vector_cosine_ops) 索引
 *   6. 中文 LIKE 在 bigm 索引下命中，且计划走 bitmap index scan
 *   7. bigm_similarity 排序反映中文相似度（相关 > 无关）
 *
 * 用法：
 *   node infra/scripts/pg-verify.mjs
 *   node infra/scripts/pg-verify.mjs --env-file infra/.env
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const infraDir = resolve(scriptDir, '..')

// ── 解析 --env-file ───────────────────────────────────────────────────
function parseEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

const envFileArgIdx = process.argv.indexOf('--env-file')
const envFilePath =
  envFileArgIdx !== -1 ? resolve(process.argv[envFileArgIdx + 1]) : join(infraDir, '.env')
const envVars = parseEnvFile(envFilePath)

const COMPOSE_FILE = join(infraDir, 'docker-compose.yml')
const SERVICE = 'postgres'
const PG_USER = envVars.POSTGRES_USER || 'doubulea'
const PG_DB = envVars.POSTGRES_DB || 'doubulea'

// ── 输出 helpers（不引 chalk）─────────────────────────────────────────
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' }
const ok = (m) => console.log(`  ${C.g}[PASS]${C.x} ${m}`)
const bad = (m) => console.log(`  ${C.r}[FAIL]${C.x} ${m}`)
const info = (m) => console.log(`  ${C.d}${m}${C.x}`)

let failures = 0

/**
 * 在 postgres 容器内执行 SQL。**单条语句**（见文件头 ①）。
 *   -v ON_ERROR_STOP=1  出错即非零退出（否则 psql 会"报错但 exit 0"）
 *   -X                  不读 ~/.psqlrc
 *   -A -t               unaligned / tuples only
 *   -q                  安静模式：抑制 CREATE/INSERT 等命令标签
 */
function psql(sql) {
  const args = [
    'compose', '-f', COMPOSE_FILE,
    ...(existsSync(envFilePath) ? ['--env-file', envFilePath] : []),
    'exec', '-T', SERVICE,
    'psql', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t',
    '-U', PG_USER, '-d', PG_DB,
    '-c', sql,
  ]
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
}

/** 执行单条 SELECT 并断言 */
function check(label, sql, assert) {
  const r = psql(sql)
  if (r.code !== 0) {
    bad(`${label} —— SQL 执行失败`)
    info(r.stderr.split(/\r?\n/).slice(0, 5).join('\n        '))
    failures++
    return
  }
  let verdict
  try {
    verdict = assert(r.stdout)
  } catch (e) {
    bad(`${label} —— 断言抛错：${e.message}`)
    failures++
    return
  }
  if (verdict === true) {
    const shown = r.stdout.replace(/\r?\n/g, ' / ')
    ok(`${label}${shown ? `  ${C.d}${shown.slice(0, 78)}${C.x}` : ''}`)
  } else {
    bad(`${label} —— ${verdict}`)
    failures++
  }
}

/**
 * DDL + 校验合并到**同一个 psql 会话**里跑。
 *
 * ⚠️ 为什么必须同会话：`TEMP TABLE` 的生命周期是**会话级**，而每次
 *    `docker compose exec psql` 都是一次新会话 —— 分两次调用时第二句必定
 *    报 `relation "_v_x" does not exist`（P0-1-2 踩过）。
 *
 * 返回值的取法：把 DDL 与最终的 SELECT 用 `;` 串起来，然后**只取最后一行**
 * 作为结果 —— 因为 `-q` 已抑制 CREATE/INSERT/SET 的命令标签，
 * 唯一会输出的就是最后那条查询的结果集。
 * 若 DDL 中途报错，`ON_ERROR_STOP=1` 会让整条命令非零退出，直接判失败。
 */
function checkDdlOk(label, ddl, verifySql, assert) {
  const r = psql(`${ddl}\n${verifySql}`)
  if (r.code !== 0) {
    bad(`${label} —— SQL 执行失败`)
    info(r.stderr.split(/\r?\n/).slice(0, 5).join('\n        '))
    failures++
    return
  }
  const lines = r.stdout.split(/\r?\n/).filter((l) => l !== '')
  const out = lines.length ? lines[lines.length - 1].trim() : ''
  let verdict
  try {
    verdict = assert(out, r.stdout)
  } catch (e) {
    bad(`${label} —— 断言抛错：${e.message}`)
    failures++
    return
  }
  if (verdict === true) {
    ok(`${label}${out ? `  ${C.d}${out.slice(0, 78)}${C.x}` : ''}`)
  } else {
    bad(`${label} —— ${verdict}`)
    failures++
  }
}

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${C.b}══ P0-1-2 基础设施验收：PostgreSQL 扩展与索引可用性 ══${C.x}`)
info(`compose: ${COMPOSE_FILE}`)
info(`env:     ${existsSync(envFilePath) ? envFilePath : '(未找到，使用 compose 默认值)'}`)
info(`target:  ${SERVICE} 容器内 ${PG_USER}@${PG_DB}\n`)

// ── 0. 连接 ───────────────────────────────────────────────────────────
const ping = psql('SELECT version();')
if (ping.code !== 0) {
  console.error(`${C.r}无法连接 postgres 容器。${C.x}`)
  console.error('请先运行：pnpm infra:up   或   docker compose -f infra/docker-compose.yml up -d')
  console.error(ping.stderr.slice(0, 500))
  process.exit(1)
}
ok(`容器内 psql 可连接 —— ${ping.stdout.split(/[\s(]/).slice(0, 2).join(' ')}`)

// ── 1. 扩展可用性（核心）─────────────────────────────────────────────
console.log(`\n${C.b}[1] 扩展可用性（A2 问题的最终验证）${C.x}`)

checkDdlOk(
  'CREATE EXTENSION vector',
  'CREATE EXTENSION IF NOT EXISTS vector;',
  `SELECT extversion FROM pg_extension WHERE extname='vector';`,
  (out) => (out ? true : 'vector 未出现在 pg_extension'),
)

checkDdlOk(
  'CREATE EXTENSION pg_bigm',
  'CREATE EXTENSION IF NOT EXISTS pg_bigm;',
  `SELECT extversion FROM pg_extension WHERE extname='pg_bigm';`,
  (out) => (out ? true : 'pg_bigm 未出现在 pg_extension'),
)

// 需求：bigm_similarity > 0 —— 这是 pg_bigm 真的编译进去的最终证明
check(
  "SELECT bigm_similarity('中文测试','中文') > 0",
  `SELECT round(bigm_similarity('中文测试','中文')::numeric, 4)::text;`,
  (out) => {
    const v = Number(out)
    if (Number.isNaN(v)) return `返回值无法解析为数字：${JSON.stringify(out)}`
    return v > 0 ? true : `期望 > 0，实际 ${v}`
  },
)

// ⚠️ GUC 只在库被载入会话后才注册 —— 先调一次 bigm 函数再读（见文件头 ②）
check(
  'pg_bigm GUC 可读（similarity_limit 默认 0.3）',
  `SELECT bigm_similarity('abc','ab') IS NOT NULL,
          coalesce(current_setting('pg_bigm.similarity_limit', true), '(null)');`,
  (out) => {
    const parts = out.split('\n')
    const limit = parts[parts.length - 1]?.trim()
    if (!limit || limit === '(null)') return 'GUC 未注册（扩展库未载入本会话）'
    return true
  },
)

check(
  'gin_bigm_ops 算子类已注册',
  `SELECT count(*)::text FROM pg_opclass WHERE opcname = 'gin_bigm_ops';`,
  (out) => (Number(out) > 0 ? true : 'pg_opclass 中无 gin_bigm_ops'),
)

{
  const r = psql(`SELECT count(*)::text FROM pg_extension WHERE extname='pg_trgm';`)
  if (r.code === 0 && Number(r.stdout) > 0) ok('pg_trgm 已就绪（备用，本步不依赖）')
  else info('pg_trgm 未安装（不阻塞本步）')
}

// ── 2. 索引能力（D 包 §4-4 前置）────────────────────────────────────
console.log(`\n${C.b}[2] D 包（子方案① §4-4）所需的索引能力${C.x}`)

checkDdlOk(
  '可建 GIN(gin_bigm_ops) 索引',
  `CREATE TEMP TABLE _v_bigm (content text);
   CREATE INDEX _v_bigm_idx ON _v_bigm USING gin (content gin_bigm_ops);`,
  `SELECT count(*)::text FROM pg_indexes WHERE tablename = '_v_bigm';`,
  (out) => (Number(out) >= 1 ? true : `期望至少 1 个索引，实际 ${out}`),
)

checkDdlOk(
  '可建 HNSW(vector_cosine_ops) 索引',
  `CREATE TEMP TABLE _v_vec (embedding vector(1024));
   CREATE INDEX _v_vec_idx ON _v_vec USING hnsw (embedding vector_cosine_ops)
     WITH (m = 16, ef_construction = 64);`,
  `SELECT count(*)::text FROM pg_indexes WHERE tablename = '_v_vec';`,
  (out) => (Number(out) >= 1 ? true : `期望至少 1 个索引，实际 ${out}`),
)

// ── 3. 中文全文检索行为 ──────────────────────────────────────────────
console.log(`\n${C.b}[3] 中文全文检索行为验证${C.x}`)

checkDdlOk(
  "中文 LIKE '%向量检索%' 命中 1 行",
  `CREATE TEMP TABLE _v_hit (content text);
   INSERT INTO _v_hit VALUES
     ('本系统采用向量检索与全文检索混合的方案'),
     ('报销制度请参见财务手册第三章'),
     ('中文 bigram 倒排索引让 LIKE 查询可以走索引');
   CREATE INDEX _v_hit_idx ON _v_hit USING gin (content gin_bigm_ops);`,
  `SELECT count(*)::text FROM _v_hit WHERE content LIKE '%向量检索%';`,
  (out) => (Number(out) === 1 ? true : `期望命中 1 行，实际 ${JSON.stringify(out)}`),
)

check(
  'bigm_similarity 排序反映中文相似度（相关 > 无关）',
  `SELECT round(bigm_similarity('向量检索与全文检索混合','向量检索')::numeric, 4)::text || '|' ||
          round(bigm_similarity('报销制度请参见财务手册','向量检索')::numeric, 4)::text;`,
  (out) => {
    const [a, b] = out.split('|').map(Number)
    if (Number.isNaN(a) || Number.isNaN(b)) return `无法解析：${JSON.stringify(out)}`
    return a > b ? true : `相关文本得分(${a})应高于无关文本(${b})`
  },
)

// 执行计划：中大表 + 关 seqscan，验证索引真的被用上
checkDdlOk(
  '中文 LIKE 在大表上走 bitmap index scan',
  `CREATE TEMP TABLE _v_plan (id serial, content text);
   INSERT INTO _v_plan (content)
     SELECT '中文检索测试语料第' || g || '号内容' FROM generate_series(1, 20000) g;
   CREATE INDEX _v_plan_idx ON _v_plan USING gin (content gin_bigm_ops);
   ANALYZE _v_plan;
   SET enable_seqscan = off;`,
  `EXPLAIN (COSTS OFF) SELECT count(*) FROM _v_plan WHERE content LIKE '%语料第5号%';`,
  (_last, full) => {
    if (!/_v_plan_idx|Bitmap Index Scan/i.test(full)) {
      return `计划未使用 bigm 索引：${full.replace(/\r?\n/g, ' / ').slice(0, 100)}`
    }
    return true
  },
)

// ── 汇总 ──────────────────────────────────────────────────────────────
console.log('')
if (failures === 0) {
  console.log(`${C.g}${C.b}✅ P0-1-2 验收通过：pgvector + pg_bigm 均可用，中文全文路具备施工条件${C.x}`)
  console.log(`${C.d}   下一步（P0-1-3）配置加载 + 结构化日志 + 共享错误码${C.x}\n`)
  process.exit(0)
} else {
  console.log(`${C.r}${C.b}❌ P0-1-2 验收未通过：${failures} 项失败${C.x}`)
  console.log(`${C.d}   排查建议：${C.x}`)
  console.log(`${C.d}   1. docker compose -f infra/docker-compose.yml logs postgres${C.x}`)
  console.log(`${C.d}   2. 确认镜像构建日志里出现 "pg_bigm ... installed OK"${C.x}`)
  console.log(`${C.d}   3. 若是旧数据卷，扩展未随 initdb 创建 —— 手工 CREATE EXTENSION 后再验${C.x}\n`)
  process.exit(1)
}
