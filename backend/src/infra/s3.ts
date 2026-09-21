/**
 * 对象存储客户端（MinIO / S3 协议，P0-1-4 起）
 *
 * 依据：`docs/02-后端设计.md` §一（对象存储 = MinIO，S3 协议）+ §4.9（`/health` 探 S3）
 *
 * P0-1-4 只用到探活（`bucketExists`），P0-1-16（文档原始文件）/ P0-1-19（入库产物）复用同一客户端。
 * 探活刻意用 **`bucketExists`（HEAD /{bucket}）而不是 `listBuckets`**：
 * 前者只需要该桶的权限（生产上后端用的是受限 AK），后者要求 list-all-my-buckets，
 * 会把「密钥被收窄」误报成「S3 不可用」。
 *
 * `S3_ENDPOINT` 是完整 URL（形如 `http://127.0.0.1:19000`），而 minio 客户端要 host/port/useSSL
 * 三项分开，故此处统一解析一次 —— 端口默认值按协议补齐（http→80 / https→443），
 * 避免出现「endpoint 写 https 却没写端口，客户端退回 9000」这类难查的错。
 */

import { Client } from 'minio'

import { config } from '../config.js'
import { getLogger } from './logger.js'

let client: Client | undefined

/** 端点里显式写了 `:port` 就用它，否则按协议取默认端口 */
function parseEndpoint(endpoint: string): { endPoint: string; port: number; useSSL: boolean } {
  const url = new URL(endpoint)
  const useSSL = url.protocol === 'https:'
  return {
    endPoint: url.hostname,
    port: url.port === '' ? (useSSL ? 443 : 80) : Number(url.port),
    useSSL,
  }
}

/** 取（必要时创建）S3 客户端 */
export function getS3Client(): Client {
  if (client !== undefined) return client
  const { endPoint, port, useSSL } = parseEndpoint(config.s3.endpoint)
  client = new Client({
    endPoint,
    port,
    useSSL,
    accessKey: config.s3.key,
    secretKey: config.s3.secret,
    // MinIO 走 path-style（`http://host/bucket/key`）；MinIO 也支持 virtual-host，
    // 但内网部署常用 IP/单标签域名，path-style 是唯一稳的那个。
    pathStyle: true,
  })
  return client
}

/**
 * S3 探活：`bucketExists`。
 * 返回桶是否存在 —— **桶不存在不算探活失败**（P0-1-16 首次上传时按需创建），
 * 只有请求本身失败（网络不通 / 密钥错误）才抛。
 */
export async function pingS3(): Promise<{ bucket: string; bucketExists: boolean }> {
  const s3 = getS3Client()
  const exists = await s3.bucketExists(config.s3.bucket)
  if (!exists) {
    getLogger().debug({ bucket: config.s3.bucket }, 'S3 探活：桶尚不存在（首次上传时创建）')
  }
  return { bucket: config.s3.bucket, bucketExists: exists }
}

/**
 * 确保桶存在（不存在则按需创建）。P0-1-16 起在**写原文件之前**调用。
 *
 * 为什么允许后端建桶：`02` §十二 的部署形态里 MinIO 随 compose 起来，桶名来自 `S3_BUCKET`。
 * 要求运维"先手工 mc mb 一次"会变成部署清单里一条容易被漏掉的步骤，而漏掉的症状是
 * "上传 500、日志说 NoSuchBucket"，与"密钥不对"长得几乎一样。顺手建出来最省事。
 *
 * 并发下 `makeBucket` 会抛 `BucketAlreadyOwnedByYou` —— 那**不是**失败，
 * 故这里用"再探一次"来区分"别人刚建好"与"真的建不了"（后者才抛）。
 */
export async function ensureBucket(bucket: string = config.s3.bucket): Promise<void> {
  const s3 = getS3Client()
  if (await s3.bucketExists(bucket)) return
  try {
    await s3.makeBucket(bucket)
    getLogger().info({ bucket }, '对象存储桶不存在，已创建')
  } catch (error) {
    if (!(await s3.bucketExists(bucket))) throw error
    getLogger().debug({ bucket }, '对象存储桶已被并发创建（忽略本次冲突）')
  }
}

/**
 * S3 客户端**无需显式关闭**：minio 客户端按请求复用 http agent，不持有常驻连接池句柄，
 * 故本模块不提供 `close` —— 退出流程（`index.ts`）只需收 PG / Redis 两个。
 */
