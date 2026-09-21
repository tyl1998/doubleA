/**
 * Prisma Client 单例（P0-1-5 起）
 *
 * 依据：`docs/02-后端设计.md` §一（ORM: Prisma）、§三（数据模型）、§十（密钥零下发）、
 *      §十三（可观测：日志统一走 pino）
 *
 * 三件事：
 *   1. 用 `@prisma/adapter-pg` 组装 Prisma 7 的 Rust-free 客户端（v7 起**必须**用驱动适配器，
 *      不再有内置连接池）；产物是 `backend/generated/prisma`（生成物，见 prisma.config.ts）。
 *   2. 懒初始化：`new PrismaClient()` 本身不建连，但仍刻意做成懒单例 —— 与 `infra/pg.ts`
 *      同一风格，保证 import 零副作用（`--check-config` 与验收脚本可以只引配置不连库）。
 *   3. 把 Prisma 的日志接到 pino（只接事件，不接 stdout：stdout 会绕开我们的脱敏与 requestId）。
 *
 * ⚠️ 与 `infra/pg.ts` 的关系（P0-1-5 定案：**不合并**）：
 * `/health` 的 PG 探活继续用独立的轻量 pg 池，不走 Prisma。理由：探活要回答
 * 「进程此刻能否触达 PG」，而 Prisma 的池可能正因为长流对话/批量 embedding 被打满 ——
 * 那时业务确实慢，但依赖本身是好的，把它报成 degraded 会把运维引到错的方向；
 * 且探活有 `HEALTH_TIMEOUT_MS` 硬超时，独立池不必受 ORM 层行为影响。
 */

import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../../generated/prisma/client.js'
import { config } from '../config.js'
import { getLogger } from './logger.js'

/**
 * 连接池上限。
 *
 * ⚠️ 刻意**不引入环境变量**：`pg` 的默认值（10）已经覆盖本项目规模假设
 * （`01` §1.3：并发 ChatBot 流 ≤50、任务沙箱 ≤10，但这两者绝大部分时间在等 LLM，
 * 不是等 PG）。等压测真的暴露出瓶颈，再走「加 `DATABASE_POOL_MAX` 到 `infra/.env.example`
 * + `docs/02` §十一」的正规流程 —— 而不是先摆一个没人调过的旋钮。
 */
const POOL_MAX = 10

/** Prisma Client 实例类型（业务代码里需要标注类型时用这个，不要自己去推 InstanceType） */
export type PrismaClientInstance = InstanceType<typeof PrismaClient>

let client: PrismaClientInstance | undefined

/** 取（必要时创建）Prisma 客户端单例 */
export function getPrisma(): PrismaClientInstance {
  if (client !== undefined) return client

  const adapter = new PrismaPg(
    {
      connectionString: config.db.url,
      max: POOL_MAX,
      application_name: 'doubulea-backend',
    },
    {
      // ⚠️ 必须挂：适配器虽然自己给 Pool 挂了 'error' 监听（所以不会因空闲连接被服务端断开
      //    而触发未捕获异常），但默认只是 debug 输出。接到 pino 才能在日志里看到
      //    「PG 断过一次」——`infra/pg.ts` 的同名坑，P0-1-4 已踩。
      onPoolError: (error) => {
        getLogger().warn({ err: error }, 'Prisma 连接池空闲连接异常（池会自动重建，无需干预）')
      },
    },
  )

  const instance = new PrismaClient({
    adapter,
    // 只用事件形态（emit: 'event'）：'stdout' 会直接写控制台，绕开 pino 的脱敏规则
    // 与 requestId 上下文（`02` §十三）。
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
      // 查询日志的粒度其实属于 trace 档（每条 SQL 一行，验收脚本里能瞬间刷几百行），
      // 故用 `LOG_LEVEL=trace` 显式开，而不是跟着 development 默认的 debug 一起开。
      // 要看 SQL 时：`LOG_LEVEL=trace pnpm dev:backend`。
      ...(config.logLevel === 'trace' ? [{ emit: 'event', level: 'query' } as const] : []),
    ],
  })

  // ⚠️ `query` 事件里的 `params` 是**参数值**（如 bcrypt 摘要），`02` §十 要求密钥零留痕 ——
  //    故只打 SQL 文本与耗时，**刻意丢掉 params**。需要看真实参数时用 pg_stat_statements
  //    或临时改这一行，不要让它长期待在代码里。
  instance.$on('query', (event) => {
    getLogger().trace({ durationMs: event.duration, target: event.target }, 'Prisma 查询')
  })
  instance.$on('warn', (event) => {
    getLogger().warn({ target: event.target }, event.message)
  })
  instance.$on('error', (event) => {
    getLogger().error({ target: event.target }, event.message)
  })

  client = instance
  return client
}

/** 关闭客户端（优雅退出用）；未创建过则空操作 */
export async function closePrisma(): Promise<void> {
  const current = client
  client = undefined
  if (current !== undefined) await current.$disconnect()
}

// 枚举与客户端类从这里统一转发：业务代码只 import 本模块，
// 不必到处写 `../../generated/prisma/...` 这种深路径（生成物位置将来若变，只改这一处）。
export { PrismaClient } from '../../generated/prisma/client.js'
export * from '../../generated/prisma/enums.js'
