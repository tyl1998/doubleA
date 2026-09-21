/**
 * 密码与密文基础设施（P0-1-6）
 *
 * 依据：`docs/02-后端设计.md` §十 安全设计（「密码 bcrypt(cost 12)」「凭据/Provider Key
 *      AES-256-GCM，主密钥仅环境变量注入」）+ §九（MCP 用户级凭据的加解密复用本模块）
 *
 * 两个**用途不同、不可互换**的能力：
 *
 * | 能力 | 用途 | 为什么是它 |
 * |------|------|-----------|
 * | {@link hashPassword} / {@link verifyPassword} | 用户密码（`users.password_hash`） | **单向**：密码永不需还原，哈希即可；bcrypt 自带 salt、cost 决定暴力破解成本 |
 * | {@link encryptSecret} / {@link decryptSecret} | Provider Key / MCP 凭据值 | **可逆**：调用上游时必须还原成明文，故用带认证的对称加密（AES-256-GCM） |
 *
 * 三条贯穿全模块的口径：
 *
 * 1. **主密钥只从配置来**（`CREDENTIAL_MASTER_KEY`，32 字节 base64 → AES-256 的钥匙长度）。
 *    本模块不读环境变量、不落磁盘、不打日志（`02` §十 不变式：密钥零下发，日志同理）。
 * 2. **密文自带版本前缀**（`v1.…`）。将来要换算法/轮转主密钥时，「旧密文仍可解、新密文用新算法」
 *    才可能实现；没有版本号就只能停机全量重加密。
 * 3. **认证加密（AEAD）**：GCM 的 tag 会在解密时校验 —— 密文被改一个 bit 就抛
 *    {@link SecretDecryptionError}，而不是解出一段错误明文（这是"能检出篡改"验收的依据）。
 *
 * ⚠️ 本模块是纯函数层：不依赖 Fastify、不抛 `AppError`（HTTP 语义属 plugins/routes）。
 *    调用方负责把 {@link SecretDecryptionError} 映射成合适的出口。
 */

import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto'

import bcrypt from 'bcrypt'

import { config } from '../config.js'

// ───────────────────────────── 常量 ─────────────────────────────

/** 当前密文版本前缀。换算法时**新增**版本（如 `v2`）而不是改这一行，旧密文才仍可解。 */
const SECRET_VERSION = 'v1'

/** GCM 的 IV 长度（NIST SP 800-38D 推荐 96 bit）——每次加密都必须重新随机生成 */
const IV_BYTES = 12

/** GCM 认证标签长度（128 bit，Node 默认值，显式写出来供审计对照） */
const AUTH_TAG_BYTES = 16

/**
 * 密码哈希成本（`02` §十 明确 cost 12）。
 * 取值依据：约 250~400ms/次（本机测），单次登录付出可接受，暴力破解成本却翻倍增长。
 * 刻意**不做成环境变量**：改它会与库里已有摘要的 cost 不一致（bcrypt 摘要自带 cost，
 * 校验仍可用），但会让"新老账号强度不同"变成隐性事实，需要时再走正规流程。
 */
export const BCRYPT_COST = 12

/**
 * bcrypt 只处理前 **72 字节**（超过部分被**静默忽略**）。
 * 这是很隐蔽的坑：`"a".repeat(72) + "x"` 与 `"a".repeat(72) + "y"` 会被判为同一个密码。
 * 故 {@link hashPassword} 对超长输入直接抛错，让「密码策略」在路由层显式解决，
 * 而不是靠 bcrypt 悄悄截断。
 */
export const MAX_PASSWORD_BYTES = 72

/** 密码长度按**字节**算（中文/emoji 一个字符占多字节，按字符数校验会漏） */
export function passwordByteLength(plain: string): number {
  return Buffer.byteLength(plain, 'utf8')
}

// ───────────────────────────── 错误类型 ─────────────────────────────

/** 密文格式不合法（前缀/段数/编码不对）—— 与「解密失败」区分开，前者是数据坏了，后者可能是被篡改/换钥 */
export class SecretFormatError extends Error {
  constructor(message: string) {
    super(`密文格式非法：${message}`)
    this.name = 'SecretFormatError'
  }
}

/**
 * 解密失败：GCM tag 校验不通过（被篡改）、AAD 上下文不匹配、或主密钥已更换。
 * 刻意**不区分**这三者对外的话术（能区分就等于给攻击者反馈），但要能在日志里定位。
 */
export class SecretDecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SecretDecryptionError'
  }
}

// ───────────────────────────── AES-256-GCM：加解密 ─────────────────────────────

/** 主密钥（每次取当前配置，便于测试时替换；长度由 config 校验保证为 32 字节） */
function masterKey(): Buffer {
  return config.credentialMasterKey
}

/** base64url 严格解码：解出来再编回去必须一致，否则视为格式非法（防手抖塞半截串） */
function decodeStrict(segment: string): Buffer | undefined {
  const decoded = Buffer.from(segment, 'base64url')
  return decoded.toString('base64url') === segment ? decoded : undefined
}

/**
 * 加密一个需要还原的敏感值（Provider Key / MCP 凭据值）。
 *
 * @param plaintext 明文（空串合法，会得到 `v1.iv.tag.` 形态的空密文）
 * @param context   **附加认证数据（AAD）**：可选，用来把密文"绑定"到它的归属，例如
 *                  `provider:${id}`。绑定后，把 A 记录密文粘到 B 记录上会解密失败 ——
 *                  这对"整库被拖走后仍无法把 Key 挪用到别的 provider"是有意义的。
 *                  代价：**解密时必须传同一个值**，且一旦改了归属（如换 id）旧密文就废了。
 *                  不传则该密文可在任意记录间搬运（值本身仍受主密钥保护）。
 * @returns `v1.<iv>.<tag>.<ciphertext>`（各段 base64url，无填充）
 */
export function encryptSecret(plaintext: string, context?: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv, { authTagLength: AUTH_TAG_BYTES })
  if (context !== undefined) cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [SECRET_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

/**
 * 解密 {@link encryptSecret} 的产物。
 *
 * @throws {SecretFormatError}      密文串本身不合法（版本未知 / 段数不对 / 编码非法）
 * @throws {SecretDecryptionError}  tag 校验失败（被篡改）、AAD 不匹配、主密钥已更换
 */
export function decryptSecret(payload: string, context?: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4) {
    throw new SecretFormatError(`应有 4 段（版本.iv.tag.密文），实际 ${parts.length} 段`)
  }
  const [version, ivRaw, tagRaw, ciphertextRaw] = parts as [string, string, string, string]
  if (version !== SECRET_VERSION) {
    throw new SecretFormatError(`未知版本 ${version}（本进程支持 ${SECRET_VERSION}）`)
  }
  const iv = decodeStrict(ivRaw)
  const tag = decodeStrict(tagRaw)
  const ciphertext = decodeStrict(ciphertextRaw)
  if (iv === undefined || iv.length !== IV_BYTES) {
    throw new SecretFormatError(`IV 应为 ${IV_BYTES} 字节的 base64url`)
  }
  if (tag === undefined || tag.length !== AUTH_TAG_BYTES) {
    throw new SecretFormatError(`认证标签应为 ${AUTH_TAG_BYTES} 字节的 base64url`)
  }
  if (ciphertext === undefined) throw new SecretFormatError('密文段不是合法 base64url')

  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv, { authTagLength: AUTH_TAG_BYTES })
    if (context !== undefined) decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (error) {
    // 到这里通常只有三种可能：密文/标签被改过、AAD 与加密时不一致、主密钥换过。
    // 原始错误（`Unsupported state or unable to authenticate data`）挂 cause 上供日志定位，
    // 对外文案保持中性 —— 能区分就等于给攻击者反馈。
    throw new SecretDecryptionError('解密失败：密文可能被篡改，或与当前主密钥不匹配', { cause: error })
  }
}

// ───────────────────────────── bcrypt：密码哈希 ─────────────────────────────

/**
 * 生成密码摘要（`users.password_hash` 的写入侧）。
 * @throws {RangeError} 明文超过 {@link MAX_PASSWORD_BYTES} 字节 —— 见该常量注释（bcrypt 静默截断）
 */
export async function hashPassword(plain: string): Promise<string> {
  const bytes = passwordByteLength(plain)
  if (bytes > MAX_PASSWORD_BYTES) {
    throw new RangeError(
      `密码过长（${bytes} 字节 > bcrypt 上限 ${MAX_PASSWORD_BYTES} 字节）：` +
        'bcrypt 会静默忽略超出部分，故在此直接拒绝；请在路由层按密码策略校验长度。',
    )
  }
  return bcrypt.hash(plain, BCRYPT_COST)
}

/**
 * 校验密码（登录 / 改密时校验旧密码）。
 *
 * 两个刻意的设计：
 * 1. **摘要本身坏了也返回 false，不抛错**：库里若存了非 bcrypt 形态的脏数据，
 *    让登录以「密码错误」结束，好过 500 —— 前者是用户能理解的结论，后者会把
 *    "数据坏了" 包装成服务故障（且 5xx 还会被运维当着依赖问题去查）。
 * 2. **不做长度校验**：只在 {@link hashPassword} 侧拒绝超长。
 *    校验侧若也拒绝，超长输入的登录会与"密码错误"走不同分支，等于泄露了密码长度特征。
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (hash === '') return false
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

/**
 * 一个**已知不可能匹配**的摘要，供登录失败路径做「等时比较」。
 *
 * 为什么要它：账号不存在时若直接返回「用户名或密码错误」，从**耗时**上仍能区分
 * （库里没有 → 不跑 bcrypt → 立刻返回；库里有 → 跑一次 cost 12 → 慢 300ms）。
 * P0-1-7 对不存在的账号也用这个摘要跑一次 {@link verifyPassword}（恒为 false），
 * 两条路径耗时一致，P0-1-7 验收「不泄露账号是否存在」才站得住。
 * （值本身是常量摘要，泄露无害：验证结果被丢弃。）
 *
 * ⚠️ 必须是**结构合法**的 bcrypt 摘要：实测（bcrypt 6.0.0）传入 `'not-a-hash'` 时
 * `compare` 会立刻返回 false（0ms，不抛错）—— 那样就完全起不到等时作用了。
 * 本串由 `bcrypt.hash(随机串, 12)` 生成，任何人都不可能猜到对应明文。
 */
export const DUMMY_PASSWORD_HASH = '$2b$12$zdC1OsUBJBssxoQb.pWB8.5zDJN1iF24HCU5a1Nqy3/pUgi65oM4W'

// ───────────────────────────── 初始密码生成 ─────────────────────────────

/**
 * 初始密码字母表：**刻意剔除易混字符**（0/O/o、1/l/I）。
 * 初始密码是 admin 建号后「一次性展示、人工转达」的，抄错一个字符就会变成
 * "密码不对"的排查；去掉易混字符比事后解释便宜。
 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
/** 每类至少一个（大写/小写/数字）——满足常见口令复杂度检查，避免"生成的密码过不了自己设的策略" */
const PASSWORD_CLASSES = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789'] as const
/** 默认长度：18 字符 × log2(57) ≈ 105 bit，远超暴力破解成本（`01` §1.3 规模：几百人内部账号） */
export const INITIAL_PASSWORD_LENGTH = 18

/**
 * 生成初始密码（`02` §4.2：建号返回初始密码，**仅此一次明文**）。
 * 用 `randomInt`（CSPRNG，且天然规避了 `randomBytes % n` 的取模偏置）。
 */
export function generateInitialPassword(length: number = INITIAL_PASSWORD_LENGTH): string {
  const chars: string[] = PASSWORD_CLASSES.map((klass) => klass[randomInt(klass.length)] as string)
  while (chars.length < length) chars.push(PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)] as string)
  // 先放每类各一个会让前三位固定成「大写小写数字」，故洗牌后再返回（Fisher–Yates）
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    const a = chars[i] as string
    chars[i] = chars[j] as string
    chars[j] = a
  }
  return chars.join('')
}
