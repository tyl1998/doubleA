/**
 * 最小 ZIP 编码器（**stored，不压缩**）—— 供「按目录下载工作区」用（2026-10-29）。
 *
 * 依据：用户定案"不用支持批量上传，支持下载即可（下载支持按目录下载即可，打包成 zip 然后给他下载下来）"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么自己写而不是引依赖
 * ─────────────────────────────────────────────────────────────────────
 * · **零新依赖**是本仓的纪律（见 `README` / 各批次"零新增依赖"）；而这里要的是"把若干份
 *   已是成品字节的文件塞进一个 zip"，用不上压缩能力 —— `deflate` 只会多一次 CPU 与一份依赖。
 * · 格式足够小且权威（PKWARE APPNOTE 4.3.12 的 stored 条目）：本地头 + 原样字节 + 中央目录 + EOCD。
 *   本文件把三处偏移算清楚，导出纯函数便于在回归脚本里逐字节核对。
 *
 * ⚠️ **限制（刻意，写在这里免得下次当 bug）**：
 *   · 单文件 / 整包 **≤ 4 GiB**（32 位字段；更大的包该走对象存储直出，不是这个端点）；
 *   · 文件名按 **UTF-8** 写并置通用标志位 bit 11（否则中文名在 Windows 资源管理器里是乱码）；
 *   · 不做目录条目（只写文件），解压时各客户端会按路径自动建目录；
 *   · 不压缩（`method = 0`）⇒ 响应体的 `content-length` 可精确算出。
 */

/** zip 里的一条：`name` = 包内相对路径（`/` 分隔，UTF-8），`data` = 原样字节 */
export interface ZipEntry {
  name: string
  data: Buffer
}

/** 单个 zip 允许的最大体积（32 位偏移上限；超过就拒绝而不是写坏一个包） */
export const ZIP_MAX_BYTES = 4 * 1024 * 1024 * 1024 - 1

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
/** 通用标志位 bit 11：文件名是 UTF-8（非 ASCII 名的唯一正确做法） */
const FLAG_UTF8 = 0x0800
/** 版本号 2.0（stored 只需要 1.0 的能力，留一点余量） */
const VERSION = 20
/** DOS 时间/日期的兜底值 = 1980-01-01 00:00:00（zip 纪元；时间戳对产物包没有意义） */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

/** CRC-32（zip 必需；表预生成一次，避免每条都要现算多项式） */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 算 CRC-32（导出给回归脚本核对） */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 包内路径归一（`\` → `/`、去掉前导 `/` 与 `./`；空段丢弃）—— 只防"包里出现绝对路径" */
export function zipEntryName(raw: string): string {
  return raw
    .split(/[\\/]/u)
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/**
 * 拼一个 zip（stored）。条目顺序 = 入参顺序；空条目名字被丢弃。
 *
 * @throws {Error} 超过 {@link ZIP_MAX_BYTES}（宁可报错也不写一个坏包）
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  let written = 0

  for (const entry of entries) {
    const name = zipEntryName(entry.name)
    if (name === '') continue
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(0, 8) // method = stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22) // uncompressed === compressed（stored）
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    parts.push(local, nameBytes, entry.data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
    header.writeUInt16LE(VERSION, 4) // version made by
    header.writeUInt16LE(VERSION, 6) // version needed
    header.writeUInt16LE(FLAG_UTF8, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(DOS_TIME, 12)
    header.writeUInt16LE(DOS_DATE, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(size, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk number
    header.writeUInt16LE(0, 36) // internal attrs
    header.writeUInt32LE(0, 38) // external attrs
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBytes)

    offset += local.length + nameBytes.length + size
    written += 1
    if (offset > ZIP_MAX_BYTES) {
      throw new Error(`zip 超过 ${ZIP_MAX_BYTES} 字节上限（请改为分批或直接下载单个文件）`)
    }
  }

  const centralBuffer = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(written, 8)
  eocd.writeUInt16LE(written, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...parts, centralBuffer, eocd])
}
