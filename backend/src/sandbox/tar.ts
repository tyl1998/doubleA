/**
 * 极简 tar（ustar）编码器（P1-9 · R11）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7.3（"落盘原语：`putArchive`"）+ §十四。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是**手写**而不是引 `tar-stream` / `tar-fs`
 * ─────────────────────────────────────────────────────────────────────
 * 我们只需要一件事：把**几个已知的小文件**打成一段 tar 交给 `docker putArchive`
 * （私钥 + `known_hosts`，合计几 KB，路径固定）。为此引一个第三方包（以及它的类型包）
 * 是不划算的 —— 本仓对"能自证的小工具"一向手写（同款：`pipeline/preprocess.ts` 的 PNG 解码、
 * `pipeline/caption.ts` 的尺寸嗅探）。tar 的 ustar 头是**固定布局**，40 行就能写对，
 * 且能在回归脚本里逐字段验（见 `scripts/git-credential-regression.ts`）。
 *
 * ⚠️ **只支持**：正规文件（typeflag `0`）与目录（`5`）、`name` ≤ 100 字符、内容 ≤ 8 GiB。
 *    超出即抛错 —— 我们喂进去的全是自己构造的短路径小文件，"不支持"这件事必须是**响亮的失败**，
 *    而不是悄悄产生一个 Docker 解包时才报错的坏归档。
 */

/** 一个待归档的条目（路径相对归档根，目录名以 `/` 结尾） */
export interface TarEntry {
  /** 相对路径（如 `.ssh/id_ed25519`；目录写 `.ssh/`） */
  name: string
  /** 文件内容；目录忽略 */
  content?: Buffer
  /** 权限位（如 `0o600`）；目录默认 `0o755` */
  mode?: number
  uid: number
  gid: number
  /** 修改时刻（秒）；缺省 0（`putArchive` 不看它，仅占位） */
  mtime?: number
}

const BLOCK_SIZE = 512
/** ustar 的 `name` 字段宽度（超长可用 `prefix`，本模块刻意不支持 —— 见文件头） */
const NAME_MAX = 100

/** 八进制字段：`width-1` 位、前导 0、以 NUL 收尾（ustar 的常规写法） */
function octalField(value: number, width: number): Buffer {
  const digits = Math.max(0, Math.floor(value)).toString(8)
  if (digits.length > width - 1) throw new Error(`tar：八进制字段放不下 ${value}（宽 ${width}）`)
  return Buffer.from(`${'0'.repeat(width - 1 - digits.length)}${digits}\0`, 'ascii')
}

/** 一个 ustar 头（512 字节） */
function header(entry: TarEntry): Buffer {
  const isDir = entry.name.endsWith('/')
  const content = isDir ? Buffer.alloc(0) : (entry.content ?? Buffer.alloc(0))
  if (Buffer.byteLength(entry.name, 'utf8') > NAME_MAX) {
    throw new Error(`tar：路径过长（> ${NAME_MAX}）：${entry.name}`)
  }
  const block = Buffer.alloc(BLOCK_SIZE)
  block.write(entry.name, 0, 'utf8') // name[0..99]
  octalField(entry.mode ?? (isDir ? 0o755 : 0o644), 8).copy(block, 100) // mode
  octalField(entry.uid, 8).copy(block, 108) // uid
  octalField(entry.gid, 8).copy(block, 116) // gid
  octalField(content.length, 12).copy(block, 124) // size
  octalField(entry.mtime ?? 0, 12).copy(block, 136) // mtime
  // chksum[148..155]：先填 8 个空格，算完再写回
  block.fill(0x20, 148, 156)
  block.write(isDir ? '5' : '0', 156, 'ascii') // typeflag
  block.write('ustar\0', 257, 'ascii') // magic
  block.write('00', 263, 'ascii') // version
  // 校验和 = 整块按字节求和（chksum 字段按空格计）
  let sum = 0
  for (const byte of block) sum += byte
  // 常规写法：6 位八进制 + NUL + 空格
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

/**
 * 把若干条目打成一个 tar 归档（**纯函数**）。
 * 目录条目请自行给出（本函数**不**替你补父目录）：Docker 解包时若父目录不存在，
 * 会以默认权限创建 —— 而 `.ssh` 的 `0700` 是我们**刻意**要钉的（见 `gitCredential.ts`）。
 */
export function buildTar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    chunks.push(header(entry))
    if (!entry.name.endsWith('/')) {
      const content = entry.content ?? Buffer.alloc(0)
      chunks.push(content)
      const pad = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE
      if (pad > 0) chunks.push(Buffer.alloc(pad))
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2)) // 归档结束：两个全零块
  return Buffer.concat(chunks)
}

/**
 * 读一个 ustar 头的 `name`（**仅供自证/排障**：让回归脚本验"打进去的是什么"）。
 * @returns 该条目头里的 name 与 size；不是 ustar 头则 `undefined`
 */
export function readTarHeader(block: Buffer): { name: string; size: number; mode: number } | undefined {
  if (block.length < BLOCK_SIZE) return undefined
  if (block.toString('ascii', 257, 262) !== 'ustar') return undefined
  const name = block.toString('utf8', 0, block.indexOf(0, 0) < 0 ? NAME_MAX : block.indexOf(0, 0))
  const size = Number.parseInt(block.toString('ascii', 124, 136).replace(/\0.*$/u, '').trim() || '0', 8)
  const mode = Number.parseInt(block.toString('ascii', 100, 108).replace(/\0.*$/u, '').trim() || '0', 8)
  return { name, size, mode }
}
