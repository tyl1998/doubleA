/**
 * 种子脚本（P0-1-9 认证与用户验收）
 *
 * 依据：`docs/06-实施计划.md` P0-1-9（「种子脚本造一个 admin（首登改密态）与一个 MEMBER」）、
 *      `docs/02-后端设计.md` §4.2（用户管理）、§十（密码与会话）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * `POST /api/users` 已经能建号，但它**本身要求调用者是 ADMIN** —— 系统里第一个 ADMIN
 * 没有地方生成。这个"先有鸡还是先有蛋"的洞由本脚本补上（README「怎么拿到第一个账号」
 * 指的就是这里；在此之前只能手工写一段 Prisma 脚本）。
 *
 * ── 三条设计口径 ────────────────────────────────────────────────────────
 * 1. **幂等**：默认「不存在才建，已存在就跳过且绝不改密码」。种子脚本会被反复执行
 *    （`db:deploy` 之后、重装环境、CI 起库），若每次都覆盖密码，"改过密码的人"会在
 *    下一次 seed 后突然登录不上 —— 这是最容易被当成"系统坏了"的假故障。
 *    确实要重置时用 `SEED_RESET_PASSWORD=1` 显式请求（破坏性动作不设默认值）。
 * 2. **首登改密态**（`mustChangePassword=true`）：与 admin 建号完全同构 ——
 *    初始密码是一次性的，首次登录必须改密。**admin 也一样**，所以必须先改密才能调
 *    `/api/users`（首登闸门白名单不含它，见 `06` P0-1-8 落地要点 9）。
 * 3. **密码只打印一次到 stdout**：这是"交付初始密码"的唯一通道（与建号响应的语义相同）。
 *    刻意不写日志、不落库明文 —— pino 那边另有 `initialPassword` 脱敏兜底。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────
 *   pnpm db:seed                              # 前置：pnpm infra:up && pnpm db:deploy
 *   SEED_ADMIN_PASSWORD=... pnpm db:seed      # 自己指定初始密码
 *   SEED_RESET_PASSWORD=1 pnpm db:seed        # 已存在的账号也重置密码（打回首登态）
 *
 * ⚠️ 开关一律走**环境变量**而不是命令行参数：本仓的根 script 是
 *    `pnpm --filter @doubulea/backend db:seed`，多出来的参数会被中间的 `pnpm --filter` 吞掉
 *    （`06` §六 的既有教训，P0-1-4 起沿用）。
 *
 * 变量（全部可选，清单在 `infra/.env.example` 的 [G] 段）：
 *   SEED_ADMIN_USERNAME(admin) / SEED_ADMIN_PASSWORD(随机 18 位) / SEED_ADMIN_NICKNAME(系统管理员)
 *   SEED_MEMBER_USERNAME(member) / SEED_MEMBER_PASSWORD(随机 18 位) / SEED_MEMBER_NICKNAME(示例成员)
 *   SEED_RESET_PASSWORD(空)
 */

import { config } from '../src/config.js'
import { generateInitialPassword, hashPassword } from '../src/infra/crypto.js'
import { closePrisma, getPrisma, UserRole, type PrismaClientInstance } from '../src/infra/prisma.js'
import { normalizeUsername } from '@doubulea/shared'

// 本文件是 CLI：stdout 就是它的接口（人看 + `verify-e2e.mjs` grep），
// 与业务代码「日志必须走 pino」的口径不冲突 —— 见 eslint.config.mjs 的脚本 override。

/** 账号规格：两个账号的唯一差异集中在这里 */
interface SeedAccount {
  label: string
  username: string
  password: string
  nickname: string
  role: (typeof UserRole)[keyof typeof UserRole]
}

/** 建号结果：`created`=新建、`reset`=已存在且按显式请求重置、`skipped`=已存在且原样保留 */
type Action = 'created' | 'reset' | 'skipped'

interface SeedOutcome {
  account: SeedAccount
  action: Action
  /** 打印用：`skipped` 时为 undefined（密码没动过，无从知晓） */
  password?: string
}

/** 取环境变量（去空白）；空串按"未设置"处理 —— 与 `src/config.ts` 的 `defaultedVar` 同一口径 */
function optionalVar(name: string): string | undefined {
  const raw = (process.env[name] ?? '').trim()
  return raw === '' ? undefined : raw
}

/** 目标库摘要（只打 host:port/db，不含用户名密码）—— 排错时第一件想知道的事 */
function describeDatabaseTarget(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    return `${url.hostname}:${url.port === '' ? '5432' : url.port}${url.pathname}`
  } catch {
    return '（DATABASE_URL 无法解析）'
  }
}

const resetExisting = optionalVar('SEED_RESET_PASSWORD') === '1'

const accounts: SeedAccount[] = [
  {
    label: 'ADMIN',
    username: optionalVar('SEED_ADMIN_USERNAME') ?? 'admin',
    password: optionalVar('SEED_ADMIN_PASSWORD') ?? generateInitialPassword(),
    nickname: optionalVar('SEED_ADMIN_NICKNAME') ?? '系统管理员',
    role: UserRole.ADMIN,
  },
  {
    label: 'MEMBER',
    username: optionalVar('SEED_MEMBER_USERNAME') ?? 'member',
    password: optionalVar('SEED_MEMBER_PASSWORD') ?? generateInitialPassword(),
    nickname: optionalVar('SEED_MEMBER_NICKNAME') ?? '示例成员',
    role: UserRole.MEMBER,
  },
]

/**
 * 建/重置一个账号。
 *
 * 唯一性判定用 Prisma 的**错误码鸭子类型**（`P2002`）而不是 `instanceof`：
 * 生产是编译产物、脚本走 dist，跨构建产物的 `instanceof` 不可靠（P0-1-8 的结论）。
 * `findUnique` 先查一遍只是为了给出**可读结论**（"已存在 → 跳过"），两者是互补而非重复。
 */
async function seedAccount(prisma: PrismaClientInstance, account: SeedAccount): Promise<SeedOutcome> {
  const username = normalizeUsername(account.username)
  const existing = await prisma.user.findUnique({ where: { username }, select: { id: true } })

  if (existing !== null && !resetExisting) {
    return { account, action: 'skipped' }
  }

  const passwordHash = await hashPassword(account.password)

  if (existing !== null) {
    // 显式请求的重置：密码换新 + **打回首登改密态**（等价于 admin 点了"重置密码"）
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, mustChangePassword: true, status: 'ACTIVE' },
    })
    return { account, action: 'reset', password: account.password }
  }

  try {
    await prisma.user.create({
      data: {
        username,
        passwordHash,
        nickname: account.nickname,
        role: account.role,
        status: 'ACTIVE',
        // 首登改密态：初始密码是一次性的（口径 2）
        mustChangePassword: true,
      },
    })
    return { account, action: 'created', password: account.password }
  } catch (error) {
    if ((error as { code?: unknown }).code === 'P2002') {
      // 竞态（两个进程同时 seed）：另一个进程刚建好 → 当作"已存在"
      return { account, action: 'skipped' }
    }
    throw error
  }
}

const ACTION_TEXT: Record<Action, string> = {
  created: '已创建',
  reset: '已重置密码',
  skipped: '已存在（密码未改动）',
}

async function main(): Promise<void> {
  console.log('\n== doubuleA 种子脚本（P0-1-9）：第一个 ADMIN + 一个 MEMBER ==')
  console.log(`   目标库：${describeDatabaseTarget(config.db.url)}`)
  console.log(`   模式：${resetExisting ? '已存在的账号也重置密码（SEED_RESET_PASSWORD=1）' : '不存在才建，已存在则跳过'}`)

  const prisma = getPrisma()
  try {
    // 预检：种子脚本的价值就是"库不通时立刻说清"，而不是抛一个驱动层的栈
    await prisma.$queryRaw`SELECT 1`

    const outcomes: SeedOutcome[] = []
    for (const account of accounts) {
      outcomes.push(await seedAccount(prisma, account))
    }

    console.log('\n── 结果 ────────────────────────────────────────────────────────────────')
    for (const { account, action, password } of outcomes) {
      const secret = password === undefined ? '（未改动，用原密码）' : password
      console.log(`   ${account.label.padEnd(6)} ${account.username.padEnd(16)} ${ACTION_TEXT[action]}`)
      if (password !== undefined) console.log(`   ${' '.repeat(7)}└ 初始密码（只打印这一次）：${secret}`)
    }

    const created = outcomes.filter((outcome) => outcome.action === 'created').length
    const reset = outcomes.filter((outcome) => outcome.action === 'reset').length
    console.log(
      `\n   新建 ${created} 个 / 重置 ${reset} 个 / 跳过 ${outcomes.length - created - reset} 个；` +
        '两个账号都是**首登改密态**（mustChangePassword=true）',
    )
    console.log('\n── 下一步 ──────────────────────────────────────────────────────────────')
    if (created + reset === 0) {
      // 幂等路径下不该说"用上面的初始密码登录"—— 这次根本没打密码出来
      console.log('   本次没有新建/重置，密码未改动。忘了初始密码就重发一枚：')
      console.log('     SEED_RESET_PASSWORD=1 pnpm db:seed     # 会把该账号打回首登改密态')
    } else {
      console.log('   ① 用上面的初始密码登录，会拿到 mustChangePassword=true；')
      console.log('   ② 此时除 /api/auth/{login,logout,me,password} 外所有 API 都是 403（首登强制改密闸门）；')
      console.log('   ③ **ADMIN 也必须先改密**，改完才能调 POST /api/users 建别人的号。')
    }
    console.log('   端到端验收：pnpm verify:e2e（自己起服务、自己造号、跑完删净）\n')
  } finally {
    await closePrisma()
  }
}

try {
  await main()
} catch (error) {
  console.error(`\n✖ 种子脚本失败：${error instanceof Error ? error.message : String(error)}`)
  console.error('  前置检查：pnpm infra:up && pnpm db:deploy\n')
  process.exitCode = 1
}
