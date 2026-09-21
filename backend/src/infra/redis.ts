/**
 * Redis 客户端（P0-1-4 起）
 *
 * 依据：`docs/02-后端设计.md` §4.9（`/health` 探 Redis）+ §三（会话 / 锁 / 队列均走 Redis）
 *
 * P0-1-4 只用到探活（`PING`），但**连接在这一层收敛成一个单例**，
 * 后续 P0-1-6（会话存储）/ P0-1-26（停止信号、会话互斥锁）/ P0-1-17（流水线队列）都复用它，
 * 不各建各的连接。
 *
 * 三个刻意的取值（都为了「依赖挂掉时进程要能照样给出结论」）：
 * 1. `lazyConnect` —— import 本模块不拨号（config 校验失败时更不该拨）。
 * 2. `enableOfflineQueue` 保持 ioredis 默认的 true：命令短暂排队比立刻失败更符合会话语义。
 * 3. `maxRetriesPerRequest: 1` + **有限重试**（见 `retryStrategy`）—— 连不上时不无限重连，
 *    否则 `/health` 只能等到外层超时、拿不到「连接被拒」这个真正的原因。
 */

import { Redis } from 'ioredis'

import { config } from '../config.js'
import { getLogger } from './logger.js'

/** 首连失败后的自动重连次数上限（约 1.5s 放弃；避免探活被无限重连拖成超时） */
const RECONNECT_LIMIT = 5
/** 重连退避上限（毫秒） */
const RECONNECT_MAX_DELAY_MS = 500

let client: Redis | undefined
/** 「本轮连接故障是否已告警」——避免 redis 宕机期间每次重试都刷一条 warn */
let downNotified = false
/**
 * 最近一次**连接层**错误。
 * 为什么要单独记：ioredis 在连不上时，命令报的是「达到重试上限」这类**结果**错误，
 * 真正的根因（`ECONNREFUSED 127.0.0.1:16379`）只在连接层的 error 事件里 ——
 * 而 `/health` 的 detail 正是要告诉运维「为什么不可用」，故这里留一份。
 */
let lastConnectionError: Error | undefined

/** 取（必要时创建）单例客户端 */
export function getRedis(): Redis {
  if (client !== undefined) return client
  client = new Redis(config.redis.url, {
    lazyConnect: true,
    connectTimeout: config.limits.healthProbeTimeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > RECONNECT_LIMIT ? null : Math.min(times * 100, RECONNECT_MAX_DELAY_MS)),
  })
  // ⚠️ 必须挂：ioredis 每次失败都会 emit('error')，EventEmitter 无人监听即抛出未捕获异常。
  //    策略：一轮故障只 warn 一次，恢复时再补一条 info（宕机期不刷屏，恢复有痕迹）。
  client.on('error', (error: unknown) => {
    lastConnectionError = error instanceof Error ? error : new Error(String(error))
    if (downNotified) {
      getLogger().debug({ err: error }, 'Redis 连接异常（本轮已告警过，降为 debug）')
      return
    }
    downNotified = true
    getLogger().warn({ err: error }, 'Redis 连接异常（本轮同类错误降为 debug，恢复时会再报一次）')
  })
  client.on('ready', () => {
    lastConnectionError = undefined
    if (!downNotified) return
    downNotified = false
    getLogger().info('Redis 连接已恢复')
  })
  return client
}

/**
 * Redis 探活：`PING`。
 *
 * 未连接时先显式 `connect()`（`wait` = 懒连接未拨号；`end` = 上轮重试放弃后已关闭），
 * 这样「连接被拒」会作为一个明确错误抛出，而不是让 PING 在队列里干等。
 * 失败时统一把「客户端状态 + 最近一次连接层错误」拼进消息 —— `/health` 的 detail 直接用
 * {@link pingRedis} 抛出的 message，所以要在这里把诊断信息补齐（见 `lastConnectionError` 注释）。
 */
export async function pingRedis(): Promise<void> {
  const redis = getRedis()
  try {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect()
    const pong = await redis.ping()
    if (pong !== 'PONG') throw new Error(`PING 返回了非预期结果：${pong}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cause = lastConnectionError === undefined ? '' : `；最近一次连接错误：${lastConnectionError.message}`
    // 带上 `cause`：诊断信息进 detail，但原始错误对象也保留在错误链上（日志/调试能看到堆栈）
    throw new Error(`${message}（客户端状态：${redis.status}${cause}）`, { cause: error })
  }
}

/** 关闭客户端（优雅退出用）；优先 QUIT 让服务端正常收尾，失败则强断 */
export async function closeRedis(): Promise<void> {
  const current = client
  client = undefined
  if (current === undefined) return
  try {
    if (current.status === 'ready') await current.quit()
    else current.disconnect()
  } catch {
    current.disconnect()
  }
}
