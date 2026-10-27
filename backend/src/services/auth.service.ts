/**
 * 认证服务（P0-1-7）
 *
 * 依据：`docs/02-后端设计.md` §4.1（login / logout / me / password）、§十（登录限速 5 次/10 分钟、
 *      密码 bcrypt(cost 12)、密钥零下发）、`01` §3.1 需求 1/3（登录登出、修改密码）
 *
 * 分层：**本文件不碰 Fastify**（不收 `request`/`reply`，也不设 Cookie）——
 * 会话的发放/销毁归 `plugins/session.ts`（`issueSession`/`endSession`），
 * 路由只做「校验请求 → 调服务 → 组装响应」。
 * 这样服务层可以被脚本直接调用（`verify:auth` 里就用它造数据 + 断言），
 * 也让"认证逻辑"与"HTTP 外壳"能分别演进。
 *
 * 两个必须写对、否则会静默出错的点（详见 `issue_fix/问题记录-P0-1-7-*.md`）：
 *   1. **账号不存在时也要跑一次真实的 bcrypt 校验**（用 `DUMMY_PASSWORD_HASH`）——
 *      否则"库里有/没有"会从**响应耗时**上区分出来（225ms vs 0ms）。
 *   2. **用户名先归一化再查库**（`normalizeUsername`，与 P0-1-8 建号同一个函数）。
 */

import { appMsg,
  AppError,
  PASSWORD_MAX_BYTES,
  normalizeUsername,
  utf8ByteLength,
  type AuthUser,
  type ChangePasswordBody,
  type LoginBody,
} from '@doubulea/shared'

import { config } from '../config.js'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { UserStatus, getPrisma } from '../infra/prisma.js'
import {
  clearLoginFailures,
  invalidateUserSnapshot,
  readLoginLock,
  recordLoginFailure,
  writeUserSnapshot,
  type UserSnapshot,
} from '../infra/redis.js'

/** `requireAuth` 只看快照；这里把快照转成对外的 `AuthUser`（两者字段刻意不同：快照不含 status 的对外形态） */
export function toAuthUser(snapshot: UserSnapshot): AuthUser {
  return {
    id: snapshot.id,
    username: snapshot.username,
    nickname: snapshot.nickname,
    role: snapshot.role,
    mustChangePassword: snapshot.mustChangePassword,
  }
}

/** 查询时统一带上的字段（登录 / 改密都要 passwordHash，故单独列出而不是复用快照的 select） */
const USER_AUTH_SELECT = {
  id: true,
  username: true,
  nickname: true,
  role: true,
  status: true,
  mustChangePassword: true,
  passwordHash: true,
} as const

/**
 * 登录。
 *
 * 顺序是有讲究的（每一步失败都对应一条明确的验收门槛）：
 *   ① 锁定检查（`02` §十）→ 429 + 剩余时间
 *   ② 取用户 + 校验密码（不存在也走等时比较）→ 失败统一「用户名或密码错误」+ 累加计数
 *   ③ **凭据正确才**清计数（`06` P0-1-7 坑预判：成功即 DEL）
 *   ④ 账号状态检查（停用 → 401）—— 刻意放在密码正确之后
 *   ⑤ 预写快照缓存 + 返回
 *
 * @throws {AppError} `BUSY`(429) 已锁定 / `UNAUTHORIZED`(401) 凭据错误或账号停用
 */
export async function login(input: LoginBody): Promise<AuthUser> {
  const username = normalizeUsername(input.username)

  // ① 锁定检查：达到 5 次即锁 10 分钟（第 6 次到这里就被拒）
  const lock = await readLoginLock(username)
  if (lock !== undefined) {
    const minutes = Math.max(1, Math.ceil(lock.retryAfterSec / 60))
    getLogger().warn(
      { username, failures: lock.failures, retryAfterSec: lock.retryAfterSec },
      '登录被拒：账号已锁定',
    )
    // 429 而不是 401：这不是"凭据不对"，而是"现在不允许再试"；data 带上剩余秒数供前端倒计时
    throw AppError.busy(appMsg('app.m131', { p0: minutes }), { retryAfterSec: lock.retryAfterSec })
  }

  const user = await getPrisma().user.findUnique({ where: { username }, select: USER_AUTH_SELECT })

  // ② 密码校验。**账号不存在时喂 DUMMY_PASSWORD_HASH** → 同样跑一次 cost 12 的 bcrypt，
  //    两条路径耗时一致，才谈得上"不泄露账号是否存在"（`01` §3.1 验收要点）。
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)
  if (user === null || !passwordOk) {
    const failures = await recordLoginFailure(username)
    // 日志里区分"账号不存在"与"密码错"是有意为之：这是**运维**信息（排查撞库 vs 用户忘了密码），
    // 而响应文案两者完全一致、耗时才已对齐，不外泄给调用方。
    getLogger().warn({ username, failures, accountExists: user !== null }, '登录失败：用户名或密码错误')
    throw AppError.unauthorized(appMsg('app.m132'))
  }

  // ③ 凭据正确 → 清计数（否则"错 4 次→成功→再错 1 次"就会被锁，与用户直觉不符）
  await clearLoginFailures(username)

  // ④ 账号状态：**在密码正确之后**才报"已停用"。
  //    这样"错误密码"永远只得到通用文案（不泄露账号是否存在），而真正被停用的用户
  //    能立刻知道原因、不必反复重试到把计数刷满。
  if (user.status !== UserStatus.ACTIVE) {
    getLogger().warn({ userId: user.id, username }, '登录被拒：账号已停用')
    throw AppError.unauthorized(appMsg('app.m018'))
  }

  // ⑤ 预写快照缓存：前端登录成功后通常立刻打 `/auth/me` 与若干初始化请求，
  //    这里写入能让它们直接命中缓存（省掉每个请求一次回库）。
  const snapshot: UserSnapshot = {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
  }
  await writeUserSnapshot(user.id, snapshot, config.session.statusCacheTtlSec)
  getLogger().info(
    { userId: user.id, username, role: user.role, mustChangePassword: user.mustChangePassword },
    '登录成功',
  )
  return toAuthUser(snapshot)
}

/**
 * 自助改密（首登强制改密也走这里，`02` §4.1）。
 *
 * - 旧密码错误 → **400 VALIDATION** 且带上 `data.fields`（`path: 'body.oldPassword'`），
 *   前端据此把错误标在对应输入框上（`02` §四 规则 3）；且**不做任何修改**。
 * - 成功后置 `mustChangePassword=false` 并**主动失效快照缓存**
 *   —— 否则首登闸门会继续 403 到缓存过期（`invalidateUserSnapshot` 的注释里有完整时序说明）。
 *
 * 刻意**不**吊销其它会话：改密成功的人仍是本人，`01` §五 门槛 3 要求的正是"改密后能正常访问业务 API"。
 * （若将来要"改密即踢掉其它设备"，在这里按 userId 反查会话集合即可，但那需要额外的会话索引 —— 见 issue_fix。）
 *
 * @throws {AppError} `UNAUTHORIZED`(401) 用户已不存在 / `VALIDATION`(400) 旧密码错或新密码超字节上限
 */
export async function changePassword(userId: string, input: ChangePasswordBody): Promise<AuthUser> {
  const db = getPrisma()
  const user = await db.user.findUnique({ where: { id: userId }, select: USER_AUTH_SELECT })
  // 会话有效但用户已不在（缓存窗口内的竞态）：当作未登录处理
  if (user === null) throw AppError.unauthorized(appMsg('app.m005'))

  const oldPasswordOk = await verifyPassword(input.oldPassword, user.passwordHash)
  if (!oldPasswordOk) {
    getLogger().info({ userId }, '改密失败：当前密码不正确')
    throw AppError.validation(appMsg('app.m133'), {
      fields: [{ path: 'body.oldPassword', message: '当前密码不正确' }],
    })
  }

  // 双保险：schema 已按字节卡过一遍，但 service 也可能被直接调用（脚本/将来的内部调用），
  // 而 bcrypt 对超长密码是**静默截断**（`issue_fix/问题记录-P0-1-6-...` 坑 2），必须在写入前拦住。
  if (utf8ByteLength(input.newPassword) > PASSWORD_MAX_BYTES) {
    throw AppError.validation(appMsg('app.m134', { p0: PASSWORD_MAX_BYTES }), {
      fields: [{ path: 'body.newPassword', message: `新密码最多 ${PASSWORD_MAX_BYTES} 字节（中文按 3 字节计）` }],
    })
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(input.newPassword), mustChangePassword: false },
    select: USER_AUTH_SELECT,
  })

  // ⚠️ 写侧主动失效：`mustChangePassword` 必须**立即**生效
  //    （不快照失效的话，首登用户改完密码仍会被闸门 403，最长 60s —— 看起来就是"改密没生效"）
  await invalidateUserSnapshot(userId)

  getLogger().info({ userId, firstLogin: user.mustChangePassword }, '改密成功')
  return toAuthUser({
    id: updated.id,
    username: updated.username,
    nickname: updated.nickname,
    role: updated.role,
    status: updated.status,
    mustChangePassword: updated.mustChangePassword,
  })
}
