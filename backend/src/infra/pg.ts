/**
 * PostgreSQL 连接池（P0-1-4 起）
 *
 * 依据：`docs/02-后端设计.md` §4.9（`/health` 探 PG）+ §十三（可观测）
 *
 * 定位：**探活专用**的轻量连接池。业务查询走 Prisma（P0-1-5 落地 Prisma Client）——
 * 刻意不让健康检查依赖 ORM：ORM 的引擎就绪/迁移状态与「进程此刻能否对外服务」不是同一件事，
 * 探活要能在 Prisma 引擎异常时照样给出结论（P0-1-5 若判断两者可合并，再议）。
 *
 * 懒连接：`new Pool()` 不发连接，首次 query 才建连 —— 因此 import 本模块是零副作用的，
 * 没起 PG 也不会拖住进程/启动。
 */

import { Pool } from 'pg'

import { config } from '../config.js'
import { getLogger } from './logger.js'

/** 探活池的连接数上限（只服务 `/health`，业务并发与它无关） */
const HEALTH_POOL_MAX = 4
/** 空闲连接回收时间：探活是低频操作，不需要常驻连接 */
const IDLE_TIMEOUT_MS = 10_000

let pool: Pool | undefined

/** 取（必要时创建）探活连接池 */
export function getPgPool(): Pool {
  if (pool !== undefined) return pool
  pool = new Pool({
    connectionString: config.db.url,
    max: HEALTH_POOL_MAX,
    application_name: 'doubulea-backend',
    // 三层超时都按「探活预算」收紧，避免 PG 挂起时把 /health 拖住（`06` P0-1-4 坑预判）：
    // connectionTimeoutMillis = 建连；query_timeout = 单条 SQL；statement_timeout = 服务端侧
    connectionTimeoutMillis: config.limits.healthProbeTimeoutMs,
    query_timeout: config.limits.healthProbeTimeoutMs,
    statement_timeout: config.limits.healthProbeTimeoutMs,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
  })
  // ⚠️ 必须挂：pg 的空闲连接被服务端断开时会 emit('error')，EventEmitter 无人监听即抛出
  //    未捕获异常 → 进程直接挂掉（PG 重启一次就中招）。
  pool.on('error', (error) => {
    getLogger().warn({ err: error }, 'PG 空闲连接异常（连接池会自动重建，无需干预）')
  })
  return pool
}

/** PG 探活：`SELECT 1` + 顺带取库名与版本，供 `/health` 的 detail 展示 */
export async function pingPg(): Promise<{ database: string; version: string }> {
  const result = await getPgPool().query<{ database: string; version: string }>(
    'SELECT current_database() AS database, version() AS version',
  )
  const row = result.rows[0]
  if (row === undefined) throw new Error('SELECT 未返回任何行')
  return { database: row.database, version: row.version.split(',')[0] ?? row.version }
}

/** 关闭连接池（优雅退出用）；未创建过则空操作 */
export async function closePg(): Promise<void> {
  const current = pool
  pool = undefined
  if (current !== undefined) await current.end()
}
