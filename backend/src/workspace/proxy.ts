/**
 * 工作区**沙箱代理端点**（P1-9 · P2）—— 容器内 pi 扩展 → 后端工作区服务
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 2（pi workspace 扩展：`read`/`write`/`edit` 的版本语义）、
 *      §五 3（bash 兜底）、§七 1 第 ②/③ 层（claim + CAS）、§十四（接回点）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一句话：容器里的 pi 读写**同一批字节**（bind mount 的 `/work`），但**写要经版本闸门**
 * ─────────────────────────────────────────────────────────────────────
 * ```
 * 容器里的 workspace 扩展（同名覆盖 read/write/edit）
 *   → fetch POST {SANDBOX_BACKEND_URL}/api/sandbox/workspace/{read|write|edit}（头 x-sandbox-token）
 *   → 本文件：① 令牌 ⇒ {conversationId,userId,agentId}
 *             ② read：直接读宿主 FS（拿到 version）
 *             ③ write/edit：**CAS**（baseVersion 不符 ⇒ 冲突），claim 尽力登记
 *   → 结果回扩展 → 扩展交回 pi（冲突 ⇒ isError，模型读到"请重新读取后再写"）
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 状态码的分界（与 `sandbox/proxy.ts` 逐字同族）：**能不能调 = 状态码；调了之后怎样 = 响应体**
 * ─────────────────────────────────────────────────────────────────────
 *   · 令牌不认 / 体不合法 ⇒ **4xx**（协议层拒绝，扩展翻成异常）；
 *   · 读了 / 写了 / **写冲突了** / 文件不存在了 ⇒ **200 + `{ok, …}`**：
 *     CAS 冲突是**一次写的结论**，模型必须读到它才能重读再写（做成 4xx 模型只会看到"请求失败"）。
 *
 * ⚠️ 多机下这些端点**也必须粘性**（工作区字节在宿主本地盘；§十六 A）——
 *    它们与 `sandbox/proxy.ts` 同挂沙箱代理 listener，天然只服务本机容器。
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { AppError, isWorkspaceTextMime } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
// ★ 2026-10-28：引擎侧读/编辑也要按**真实编码**解码（UTF-16 / GBK 的 txt 按 UTF-8 解是乱码，
//   局部编辑更会拿乱码去匹配 `oldText` ⇒ 永远找不到）。解码器全仓只有 `decodeTextBuffer` 一份。
import { decodeTextBuffer } from '../pipeline/parse/txt.js'
import {
  authenticateSandboxProxy,
  sandboxTokenFromHeader,
  sendSandboxProxyError,
} from '../sandbox/proxyAuth.js'
import { claimWorkspaceFile, releaseWorkspaceFile } from './claims.js'
import { applyWorkspaceEdit, applyWorkspaceEdits } from './edit.js'
import { resolveWorkspacePath } from './paths.js'
import { assertWorkspaceWriteRate } from './rateLimit.js'
import { ensureWorkspace, openWorkspaceFileSource, writeWorkspaceFile } from './service.js'

/** 200 那一类的结果（见文件头"状态码的分界"） */
export type WorkspaceProxyResult =
  | { ok: true; version: number; path: string; mime?: string; size?: number; content?: string }
  | {
      ok: false
      /**
       * `BUSY` = 写入限流命中（P6 · R6）：是"一次写的结论"（模型该退避重试），故按 200 回给引擎，
       * 而不是 4xx（4xx 只会让模型看到"请求失败"）。
       */
      code: 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION' | 'FORBIDDEN' | 'BUSY' | 'INTERNAL'
      message: string
      /** 冲突时告诉模型"当前版本是多少"，好让它重读后再写 */
      currentVersion?: number
    }

const pathSchema = z.object({ path: z.string().min(1).max(1024) })
const writeBodySchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
  baseVersion: z.coerce.number().int().min(0).optional(),
})
/**
 * 一处替换（pin `0.87.1` 内置 `edit` 的 `edits[]` 形状；见 `edit.ts#WorkspaceEdit`）。
 */
const replaceEditSchema = z.object({ oldText: z.string(), newText: z.string() })
/**
 * `edit` 请求体：**首选** `edits[]`（与 pin `0.87.1` 对齐，R8）；**兼容**旧的单处 `oldString/newString`
 * （`replaceAll` 只在这个旧路径上有意义 —— `edits[]` 语义下每处 `oldText` 都要求唯一匹配）。
 */
const editBodySchema = z
  .object({
    path: z.string().min(1).max(1024),
    edits: z.array(replaceEditSchema).min(1).optional(),
    oldString: z.string().optional(),
    newString: z.string().optional(),
    replaceAll: z.boolean().default(false),
    baseVersion: z.coerce.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    const hasEdits = value.edits !== undefined && value.edits.length > 0
    const hasLegacy = value.oldString !== undefined && value.newString !== undefined
    if (!hasEdits && !hasLegacy) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '需要 edits[] 或 oldString/newString' })
    }
  })

/** agent 侧的写入身份：`actorId` 取 `agentId`（沙箱代理拿不到 turnId，见 §五 2 的已知边界） */
function agentAuthor(agentId: string): { actor: 'AGENT'; actorId: string } {
  return { actor: 'AGENT', actorId: agentId }
}

/** 把 `AppError` 翻成 200 那一类的结果（只翻领域的四种，其余交给外层 500） */
function toFailure(error: AppError): WorkspaceProxyResult {
  const code =
    error.code === 'CONFLICT' ||
    error.code === 'NOT_FOUND' ||
    error.code === 'VALIDATION' ||
    error.code === 'FORBIDDEN' ||
    error.code === 'BUSY'
      ? error.code
      : 'INTERNAL'
  const data = error.data as { currentVersion?: number } | undefined
  return {
    ok: false,
    code,
    message: error.message,
    ...(code === 'CONFLICT' && typeof data?.currentVersion === 'number'
      ? { currentVersion: data.currentVersion }
      : {}),
  }
}

export function registerWorkspaceProxyRoutes(app: FastifyInstance): void {
  const maxWriteBytes = (config.workspace.maxFileMb + 1) * 1024 * 1024

  /** 读文件（文本 ⇒ `content`；二进制 ⇒ `ok:false`，agent 仍可用 `bash` 读） */
  app.post('/api/sandbox/workspace/read', { bodyLimit: maxWriteBytes }, async (request, reply) => {
    const auth = await authenticateSandboxProxy(sandboxTokenFromHeader(request.headers))
    if (!auth.ok) return sendSandboxProxyError(reply, 401, 'UNAUTHORIZED', auth.message)
    const parsed = pathSchema.safeParse(request.body)
    if (!parsed.success) return sendSandboxProxyError(reply, 400, 'VALIDATION', '请求体不合法：需要 { path }')

    try {
      const source = await openWorkspaceFileSource(auth.record.conversationId, parsed.data.path)
      // 二进制闸门（P6 · R6）：扩展名说文本、**内容**却含二进制字节 ⇒ 同样不交给引擎当文本（乱码）
      if (!isWorkspaceTextMime(source.mime) || source.binary) {
        return reply.send({
          ok: false,
          code: 'VALIDATION',
          message: `文件 ${source.path} 不是文本（${source.binary ? '内容为二进制' : source.mime}），工作区默认识别不支持在引擎内读取；可用 bash 处理。`,
        } satisfies WorkspaceProxyResult)
      }
      return reply.send({
        ok: true,
        path: source.path,
        version: source.version,
        mime: source.mime,
        size: source.size,
        content: decodeTextBuffer(source.body).text,
      } satisfies WorkspaceProxyResult)
    } catch (error) {
      if (error instanceof AppError) return reply.send(toFailure(error))
      throw error
    }
  })

  /** 写文件（CAS）：`baseVersion` 不符 ⇒ 冲突（200 + `ok:false`），模型据此重读再写 */
  app.post('/api/sandbox/workspace/write', { bodyLimit: maxWriteBytes }, async (request, reply) => {
    const auth = await authenticateSandboxProxy(sandboxTokenFromHeader(request.headers))
    if (!auth.ok) return sendSandboxProxyError(reply, 401, 'UNAUTHORIZED', auth.message)
    const parsed = writeBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return sendSandboxProxyError(reply, 400, 'VALIDATION', '请求体不合法：需要 { path, content, baseVersion? }')
    }
    const { path, content, baseVersion } = parsed.data

    try {
      // 写入限流（P6 · R6）：超限抛 BUSY，由 `toFailure` 翻成 200 + `{ok:false,code:'BUSY'}` 回给引擎
      await assertWorkspaceWriteRate(auth.record.conversationId)
      // 先尽力登记 AGENT claim（拿不到不影响写，见 claims.ts 文件头）
      const claimedPath = await resolveWritablePath(auth.record.conversationId, path)
      await claimWorkspaceFile({
        conversationId: auth.record.conversationId,
        path: claimedPath,
        holder: 'AGENT',
        holderId: auth.record.agentId,
      })
      const current = await currentVersion(auth.record.conversationId, claimedPath)
      const entry = await writeWorkspaceFile(
        auth.record.conversationId,
        claimedPath,
        content,
        baseVersion ?? current,
        agentAuthor(auth.record.agentId),
      )
      await releaseWorkspaceFile(auth.record.conversationId, entry.path, 'AGENT')
      return reply.send({ ok: true, path: entry.path, version: entry.version, mime: entry.mime, size: entry.size })
    } catch (error) {
      if (error instanceof AppError) {
        getLogger().info(
          { conversationId: auth.record.conversationId, path, code: error.code },
          '沙箱代理收到一次工作区写入，结果为领域错误（按 200 结论回给引擎）',
        )
        return reply.send(toFailure(error))
      }
      throw error
    }
  })

  /** 局部编辑：读 → `applyWorkspaceEdits`（原子多改，R8 起与 pin `0.87.1` 的 `edits[]` 对齐）→ 写（CAS）。找不到 / 多处 / 重叠 ⇒ `ok:false`（模型可读懂） */
  app.post('/api/sandbox/workspace/edit', { bodyLimit: maxWriteBytes }, async (request, reply) => {
    const auth = await authenticateSandboxProxy(sandboxTokenFromHeader(request.headers))
    if (!auth.ok) return sendSandboxProxyError(reply, 401, 'UNAUTHORIZED', auth.message)
    const parsed = editBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return sendSandboxProxyError(reply, 400, 'VALIDATION', '请求体不合法：需要 { path, edits: [{ oldText, newText }] }')
    }
    const { path, edits, oldString, newString, replaceAll, baseVersion } = parsed.data

    try {
      // 写入限流（P6 · R6）：edit 也是一次写
      await assertWorkspaceWriteRate(auth.record.conversationId)
      const source = await openWorkspaceFileSource(auth.record.conversationId, path)
      if (!isWorkspaceTextMime(source.mime) || source.binary) {
        return reply.send({
          ok: false,
          code: 'VALIDATION',
          message: `文件 ${source.path} 不是文本${source.binary ? '（内容为二进制）' : ''}，不能做局部编辑。`,
        } satisfies WorkspaceProxyResult)
      }
      // 首选 `edits[]`（与 pin 0.87.1 内置 edit 同形，R8）；旧的单处形态（含 replaceAll）走兼容分支
      const currentText = decodeTextBuffer(source.body).text
      const applied =
        edits !== undefined
          ? applyWorkspaceEdits(currentText, edits)
          : applyWorkspaceEdit(currentText, oldString ?? '', newString ?? '', replaceAll)
      if (!applied.ok) {
        return reply.send({ ok: false, code: 'VALIDATION', message: applied.reason } satisfies WorkspaceProxyResult)
      }
      await claimWorkspaceFile({
        conversationId: auth.record.conversationId,
        path: source.path,
        holder: 'AGENT',
        holderId: auth.record.agentId,
      })
      const entry = await writeWorkspaceFile(
        auth.record.conversationId,
        source.path,
        applied.text,
        baseVersion ?? source.version,
        agentAuthor(auth.record.agentId),
      )
      await releaseWorkspaceFile(auth.record.conversationId, entry.path, 'AGENT')
      return reply.send({ ok: true, path: entry.path, version: entry.version, mime: entry.mime, size: entry.size })
    } catch (error) {
      if (error instanceof AppError) return reply.send(toFailure(error))
      throw error
    }
  })
}

/** 归一化路径（不碰盘），用于 claim 的键；非法路径在这里就翻成 AppError（由调用方兜） */
async function resolveWritablePath(conversationId: string, rawPath: string): Promise<string> {
  const handle = await ensureWorkspace(conversationId)
  return resolveWorkspacePath(handle.rootPath, rawPath).relative
}

/** 当前版本（文件不存在 ⇒ 0，表示"新建"） */
async function currentVersion(conversationId: string, relativePath: string): Promise<number> {
  const row = await getPrisma().workspaceFile.findUnique({
    where: { conversationId_path: { conversationId, path: relativePath } },
    select: { version: true, deletedAt: true },
  })
  return row === null || row.deletedAt !== null ? 0 : row.version
}