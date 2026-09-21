/**
 * 用户管理服务（P0-1-8，`(A)` 仅 ADMIN）
 *
 * 依据：`docs/02-后端设计.md` §4.2（列表 / 建号 / 启停与改角色 / 重置密码）、
 *      §十（密钥零下发、停用立即失效）、§4.1 注记（首登强制改密）、`01` §3.1 需求 2
 *
 * 本文件不碰 Fastify（不收 `request`/`reply`）：路由只做"校验 → 调服务 → 组装信封"。
 * 权限（`requireAdmin`）在路由层用 `preHandler` 声明；**"不能操作自己"这条业务约束在服务层**，
 * 因为它取决于"谁在操作谁"，属于业务规则而不是鉴权规则（同一个 admin 对别人可以做，
 * 对自己不行 —— 这是 `06` P0-1-8 的坑预判「防 admin 自锁」）。
 *
 * 三条贯穿本文件的纪律：
 * 1. **任何 `select` 都不带 `passwordHash`**（`02` §十 不变式）；
 * 2. **`initialPassword` 只在建号/重置的那一次响应里出现**，日志侧也按敏感字段打码；
 * 3. **改了状态/角色/密码就必须 `invalidateUserSnapshot`** —— 否则最长 60s 才生效，
 *    `01` §五 门槛 4「停用账号 → 已登录会话 60s 内失效」就会变成"看运气"。
 */

import {
  AppError,
  normalizeUsername,
  type CreateUserBody,
  type InitialPasswordResult,
  type ListUsersQuery,
  type OffsetPage,
  type UpdateUserBody,
  type UserListItem,
} from '@doubulea/shared'

import { generateInitialPassword, hashPassword } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { UserRole, getPrisma } from '../infra/prisma.js'
import { clearLoginFailures, invalidateUserSnapshot } from '../infra/redis.js'

/**
 * 查询字段白名单：**列表/建号/重置共用这一份**。
 * 集中在一处的意义：将来给 `users` 加列时，只有"确实该下发"的列才会被加进来，
 * 不会因为某处顺手 `include: true` 就把 `password_hash` 带出去。
 */
const USER_LIST_SELECT = {
  id: true,
  username: true,
  nickname: true,
  role: true,
  status: true,
  mustChangePassword: true,
  createdAt: true,
} as const

/** Prisma 行 → 对外形态（`createdAt` 的 Date 转 ISO 字符串：JSON 里 Date 会变成同一形态，但显式转换更可控） */
function toListItem(row: {
  id: string
  username: string
  nickname: string | null
  role: UserRole
  status: UserListItem['status']
  mustChangePassword: boolean
  createdAt: Date
}): UserListItem {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Prisma 已知错误码判定。
 *
 * 为什么用**鸭子类型**而不是 `instanceof PrismaClientKnownRequestError`：Prisma 7 的错误类
 * 从生成物的内部路径导出，跨模块/跨构建产物做 `instanceof` 容易因"两份类对象"而失效
 * （monorepo 里尤其如此）；错误码字符串反而是稳定契约。这一层只做"是不是唯一冲突/记录不存在"，
 * 认不出来就原样抛给 errorHandler（变成 500 + 完整日志），不会吞错。
 */
function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

/** `P2002` = 唯一约束冲突 */
const isUniqueViolation = (error: unknown): boolean => hasPrismaCode(error, 'P2002')
/** `P2025` = 目标记录不存在（update/delete 未命中） */
const isRecordNotFound = (error: unknown): boolean => hasPrismaCode(error, 'P2025')

/**
 * 用户列表（`02` §4.2）。按 `username` 升序（管理员按名字找人最直观），
 * 以 `id` 作为第二排序键 —— 分页必须有**稳定顺序**，否则翻页时会出现重复/漏项。
 */
export async function listUsers(query: ListUsersQuery): Promise<OffsetPage<UserListItem>> {
  const db = getPrisma()
  // 两次查询放进一个事务：否则"总数"与"当页数据"可能来自不同快照，分页器看着会错位
  const [rows, total] = await db.$transaction([
    db.user.findMany({
      select: USER_LIST_SELECT,
      orderBy: [{ username: 'asc' }, { id: 'asc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.user.count(),
  ])
  return { items: rows.map(toListItem), total, offset: query.offset, limit: query.limit }
}

/**
 * 建号（`02` §4.2）：生成初始密码，**仅此一次明文返回**；建号即 `mustChangePassword=true`。
 *
 * @throws {AppError} `CONFLICT`(409) 用户名已存在（含大小写不同的同一用户名）
 */
export async function createUser(input: CreateUserBody): Promise<InitialPasswordResult> {
  const db = getPrisma()
  const username = normalizeUsername(input.username)

  // 先查一次是为了给出"用户名已存在"这种可读结论；并发下仍可能撞唯一约束，
  // 故 create 也要接 P2002（两道都留，见下方 catch）。
  const existing = await db.user.findUnique({ where: { username }, select: { id: true } })
  if (existing !== null) throw AppError.conflict(`用户名已存在：${username}`)

  const initialPassword = generateInitialPassword()
  let created
  try {
    created = await db.user.create({
      data: {
        username,
        nickname: input.nickname ?? null,
        role: input.role ?? UserRole.MEMBER,
        passwordHash: await hashPassword(initialPassword),
        // 显式写出来（DB 默认也是 true）：这是"建号即必须改密"这条契约的落点，
        // 不该依赖一个藏在迁移里的默认值。
        mustChangePassword: true,
      },
      select: USER_LIST_SELECT,
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict(`用户名已存在：${username}`)
    throw error
  }

  // ⚠️ 日志里**只记 id/username/role**，绝不记 initialPassword（`02` §十 密钥零留痕）
  getLogger().info({ targetUserId: created.id, username, role: created.role }, '建号成功（初始密码仅本次响应下发）')
  return { user: toListItem(created), initialPassword }
}

/**
 * 启停 / 改角色（`02` §4.2）。
 *
 * **不能操作自己**（`06` P0-1-8 坑预判「防 admin 自锁」）：管理员若把自己停用或降级，
 * 就没有任何入口能改回来（本系统只有 ADMIN 能进 `/api/users`），只能去数据库里改。
 * 这条约束在这里而不是在路由里 —— 它需要知道"谁在操作谁"。
 *
 * @throws {AppError} `CONFLICT`(409) 目标是自己 / `NOT_FOUND`(404) 目标不存在
 */
export async function updateUser(
  requesterId: string,
  targetId: string,
  input: UpdateUserBody,
): Promise<UserListItem> {
  if (targetId === requesterId) {
    throw AppError.conflict('不能修改自己的状态或角色（否则可能把自己锁在外面）')
  }

  const db = getPrisma()
  const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true, username: true } })
  if (target === null) throw AppError.notFound('用户不存在')

  let updated
  try {
    updated = await db.user.update({
      where: { id: targetId },
      // 缺省的字段不传（Prisma 把 undefined 当作"不动这一列"），与 schema 的"至少给一个"呼应
      data: {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.role === undefined ? {} : { role: input.role }),
      },
      select: USER_LIST_SELECT,
    })
  } catch (error) {
    // 极小的竞态窗口：查到了但更新前被删了（本系统不提供删用户，留作兜底）
    if (isRecordNotFound(error)) throw AppError.notFound('用户不存在')
    throw error
  }

  // ⚠️ 写侧主动失效：停用 / 降权必须**立即**生效（`01` §五 门槛 4）
  await invalidateUserSnapshot(targetId)

  getLogger().info(
    { targetUserId: targetId, username: target.username, status: input.status, role: input.role },
    '用户状态/角色已更新',
  )
  return toListItem(updated)
}

/**
 * 重置密码（`02` §4.2）：返回新的初始密码（**仅此一次明文**），并把 `mustChangePassword` 置回 true。
 *
 * 三个连带动作，缺一个都会让"重置密码"这件事名不副实：
 * 1. **失效快照缓存** —— 否则该用户已在线的会话不会被首登闸门拦住（最长 60s 的空档）；
 * 2. **清登录失败计数** —— 现实中"重置密码"往往正是因为对方被锁在外面（连错 5 次）。
 *    不清计数的话，管理员重置完对方仍要再等最多 10 分钟才能登录，看着就是"重置没生效"；
 * 3. 不吊销该用户已有会话 —— 没有"按用户反查会话"的索引（P0-1-6 的取舍）。
 *    但配合第 1 条后，那些会话会立刻被闸门赶到改密页，等价于"必须先用初始密码改密"。
 *
 * @throws {AppError} `CONFLICT`(409) 目标是自己 / `NOT_FOUND`(404) 目标不存在
 */
export async function resetUserPassword(
  requesterId: string,
  targetId: string,
): Promise<InitialPasswordResult> {
  if (targetId === requesterId) {
    // 与"不能停用自己"同源：重置自己的密码虽然不会锁死账号，但会在响应里显示一次新的初始密码，
    // 而本人本来就有 `/api/auth/password` 可以自助改密 —— 少一条可能把密码弄丢的路径。
    throw AppError.conflict('不能重置自己的密码，请用「修改密码」自助改密')
  }

  const db = getPrisma()
  const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true, username: true } })
  if (target === null) throw AppError.notFound('用户不存在')

  const initialPassword = generateInitialPassword()
  let updated
  try {
    updated = await db.user.update({
      where: { id: targetId },
      data: { passwordHash: await hashPassword(initialPassword), mustChangePassword: true },
      select: USER_LIST_SELECT,
    })
  } catch (error) {
    if (isRecordNotFound(error)) throw AppError.notFound('用户不存在')
    throw error
  }

  await invalidateUserSnapshot(targetId)
  await clearLoginFailures(target.username)

  getLogger().info(
    { targetUserId: targetId, username: target.username },
    '已重置密码（初始密码仅本次响应下发；同时清掉了登录失败计数）',
  )
  return { user: toListItem(updated), initialPassword }
}
