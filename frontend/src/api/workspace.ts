/**
 * 工作区接口层（P1-9 · P3）—— 树 / 读 / 写（CAS）/ 建 / 移 / 删 / 字节出口 / 事件流 / codeMode
 *
 * 依据：`docs/02-后端设计.md` §3.3（端点表）、`docs/03-前端设计.md` §六（`api/` 统一错误码→文案）、
 *      `子方案/Code模式工作区.md` §六（人侧集成）。
 *
 * ⚠️ 一律走 `api/client.ts`（信封 / 401 收口 / 错误码文案），**不自己 `fetch`**
 * （唯一例外是两台"字节/事件流"型出口，它们本就不套信封，走 client 的 `requestBlob` /
 * `openEventStream`）。
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import {
  translate,
  type GetConversationInstanceResult,
  type SetConversationCodeModeResult,
  type SetConversationInstanceResult,
  type SetConversationRuntimeResult,
  type ArtifactItem,
  type WorkspaceChangesResult,
  type WorkspaceDeleteDirResult,
  type WorkspaceFileDiff,
  type WorkspaceFileEntry,
  type WorkspaceFileRead,
  type WorkspaceGitResult,
  type WorkspaceRevertResult,
  type WorkspaceRevertScope,
  type WorkspaceRetentionInfo,
  type WorkspaceTreeResult,
} from '@doubulea/shared'

import { openEventStream, request, requestBlob, requestFormData } from './client.js'
import { currentLocale } from '../stores/locale.js'

import type { WorkspaceEventItem } from '@doubulea/shared'

/** 文件树的 query key（`["workspace-tree", conversationId]`） */
export function workspaceTreeQueryKey(conversationId: string): readonly [string, string] {
  return ['workspace-tree', conversationId]
}

/** 拉文件树（DB 索引查询；不含字节） */
export function fetchWorkspaceTree(conversationId: string): Promise<WorkspaceTreeResult> {
  return request<WorkspaceTreeResult>(`/api/conversations/${encodeURIComponent(conversationId)}/workspace`)
}

/** 工作区 git 概况的 query key（`["workspace-git", conversationId]`） */
export function workspaceGitQueryKey(conversationId: string): readonly [string, string] {
  return ['workspace-git', conversationId]
}

/**
 * 工作区 git 概况（有哪些仓库 + 各自当前分支；`repos: []` = 这个工作区没有 git）。
 *
 * 服务端只读 `.git/HEAD`（不调 git 二进制），所以这里**不会**有 ahead/behind / 脏不脏。
 */
export function fetchWorkspaceGit(conversationId: string): Promise<WorkspaceGitResult> {
  return request<WorkspaceGitResult>(`/api/conversations/${encodeURIComponent(conversationId)}/workspace/git`)
}

/**
 * 工作区 git 概况（react-query）。
 *
 * 分支只在"有人动了工作区"时才可能变（`git checkout` 会写 `.git/HEAD` ⇒ 工作区事件）⇒
 * {@link WorkspacePanel} 在工作区事件到达时与文件树**一并失效**它，这里只给一个不刷屏的
 * `staleTime`（免得每次挂载都打一次这个"锦上添花"的端点）。
 *
 * ★ P1-24（2026-10-27）：`repos[].cloning`（`index.lock` / `shallow.lock` 还在）时**每 1.5s 再问一次**
 *   —— `clone --depth` 中途工作区会一口气长出几千个文件，面板要把"已就绪"推后（见
 *   `WorkspacePanel` 的 `workspaceReady`），直到 git 自己把锁文件删掉。
 */
export function useWorkspaceGit(
  conversationId: string | undefined,
  enabled: boolean,
): UseQueryResult<WorkspaceGitResult> {
  return useQuery({
    queryKey: workspaceGitQueryKey(conversationId ?? ''),
    queryFn: () => fetchWorkspaceGit(conversationId ?? ''),
    enabled: enabled && conversationId !== undefined,
    staleTime: 10_000,
    refetchInterval: (q) => ((q.state.data?.repos ?? []).some((repo) => repo.cloning) ? 1500 : false),
  })
}

/**
 * 工作区**保留期提示**（2026-10-28）：还有几天清理、到期会不会被保护（有产物 / 有我的手写）。
 *
 * ★ 2026-10-28（用户反馈「agent 生成的 docx 被静默清掉」）：清理必须让用户**提前**看见，
 *   而不是删完才发现。面板据此在「最近变更」上方显示一条可关闭的提示。
 */
export function fetchWorkspaceRetention(conversationId: string): Promise<WorkspaceRetentionInfo> {
  return request<WorkspaceRetentionInfo>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/retention`,
  )
}

/** 保留期提示的 react-query key */
export function workspaceRetentionQueryKey(conversationId: string): readonly [string, string] {
  return ['workspace-retention', conversationId]
}

/** 轮末变更集（`?since=<iso>` 只看该时刻后；缺省 = 全量），按时间倒序、各路径一条（P4） */
export function fetchWorkspaceChanges(conversationId: string, since?: string): Promise<WorkspaceChangesResult> {
  const query = since === undefined ? '' : `?${new URLSearchParams({ since }).toString()}`
  return request<WorkspaceChangesResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/changes${query}`,
  )
}

/**
 * 文件差异的 react-query key —— **实现在纯函数模块** `features/chat/workspaceModel.ts`。
 *
 * 放那儿是为了能被 `verify:workspace-ui`（零依赖、不加载 `import.meta.env`）直接断言；
 * 这里只做转出，调用点照旧从 `api/` 取。
 */
export { workspaceFileDiffQueryKey } from '../features/chat/workspaceModel.js'

/**
 * 文件**行级差异**（旧版本 → 当前；P1-9 · 验收标记）。
 * `stats:true` 只取 `+N −M` 计数（列表徽标用，不带逐行内容）；缺省基线 = 当前版本的前一版。
 */
export function fetchWorkspaceFileDiff(
  conversationId: string,
  path: string,
  options: { baseVersion?: number; toVersion?: number; stats?: boolean; roundBase?: boolean } = {},
): Promise<WorkspaceFileDiff> {
  const params = new URLSearchParams({ path })
  if (options.baseVersion !== undefined) params.set('baseVersion', String(options.baseVersion))
  // ★ 2026-10-28：「更早」那条要比到**那一段的末版本**为止（不一路比到此刻盘上的内容）
  if (options.toVersion !== undefined) params.set('toVersion', String(options.toVersion))
  if (options.stats === true) params.set('stats', '1')
  // ★ 2026-10-28：让**服务端**按本轮窗口算基线（前端不必传 `beforeVersion`，合并丢字段也不漂移）
  if (options.roundBase === true) params.set('roundBase', '1')
  return request<WorkspaceFileDiff>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/file/diff?${params.toString()}`,
  )
}

/** 文件树（react-query）。`enabled=false` 时不发请求（非 Code 模式不拉） */
export function useWorkspaceTree(
  conversationId: string | undefined,
  enabled: boolean,
): UseQueryResult<WorkspaceTreeResult> {
  return useQuery({
    queryKey: workspaceTreeQueryKey(conversationId ?? ''),
    queryFn: () => fetchWorkspaceTree(conversationId ?? ''),
    enabled: enabled && conversationId !== undefined,
  })
}

/**
 * 单个文件正文的 query key（`["workspace-file", conversationId, path]`）。
 *
 * ⚠️ 内存优化 P4（`docs/子方案/前端长会话内存优化.md`）：一份正文最大 1 MiB，挂在缓存里就是
 * 一份常驻字符串。**关标签 / 切会话时要能精确回收它** ⇒ key 必须有构造器（而不是调用点
 * 各写一遍字面量），否则"回收"那条路会静默漏掉某个前缀写错的 key。
 */
export function workspaceFileQueryKey(conversationId: string, path: string): readonly [string, string, string] {
  return ['workspace-file', conversationId, path]
}

/** 读文件（文本内联 `text`；二进制 / 大文件 `text=null`，改走 {@link workspaceRawUrl}） */
export function fetchWorkspaceFile(
  conversationId: string,
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceFileRead> {
  const query = new URLSearchParams({ path }).toString()
  return request<WorkspaceFileRead>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/file?${query}`,
    options,
  )
}

/**
 * 保存文件（`baseVersion` CAS）。**409 冲突**时抛 `ApiError`（`code === 'CONFLICT'`，
 * `data.currentVersion` 是服务端当前版本）—— 调用方据此提示"重新读取后再写"。
 */
export function saveWorkspaceFile(
  conversationId: string,
  path: string,
  content: string,
  baseVersion: number,
  options: { signal?: AbortSignal } = {},
): Promise<WorkspaceFileEntry> {
  const query = new URLSearchParams({ path }).toString()
  return request<WorkspaceFileEntry>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/file?${query}`,
    { method: 'PUT', body: { content, baseVersion }, ...options },
  )
}

/** 新建文件（已存在即 409） */
export function createWorkspaceFile(conversationId: string, path: string, content = ''): Promise<WorkspaceFileEntry> {
  return request<WorkspaceFileEntry>(`/api/conversations/${encodeURIComponent(conversationId)}/workspace/file`, {
    method: 'POST',
    body: { path, content },
  })
}

/**
 * 上传文件到指定目录（`POST .../workspace/upload`，multipart）。
 *
 * 走 {@link requestFormData}（`content-type` 必须由浏览器带 `boundary`，不能手设）；
 * 落点 = `dir/<上传文件名>`，服务端负责归一化与越界校验。
 */
export function uploadWorkspaceFile(conversationId: string, dir: string, file: File): Promise<WorkspaceFileEntry> {
  const form = new FormData()
  form.append('file', file)
  form.append('dir', dir)
  return requestFormData<WorkspaceFileEntry>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/upload`,
    form,
  )
}

/**
 * 「上传至平台」（2026-10-29）：把**工作区里的一个文件**登记成产物。
 *
 * 只传路径 —— 字节由服务端从工作区读（同一台实例、同一份 canonical 字节）。
 * 回 `ArtifactItem`（= 产物面板 / 消息 `artifact` 卡同一形状）。
 */
export function uploadWorkspaceArtifact(conversationId: string, path: string): Promise<ArtifactItem> {
  return request<ArtifactItem>(`/api/conversations/${encodeURIComponent(conversationId)}/workspace/artifact`, {
    method: 'POST',
    body: { path },
  })
}

/** 删除文件（软删 + 墓碑） */
export function deleteWorkspaceFile(conversationId: string, path: string): Promise<{ path: string }> {
  const query = new URLSearchParams({ path }).toString()
  return request<{ path: string }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/file?${query}`,
    { method: 'DELETE' },
  )
}

/**
 * 删除文件夹（递归）：该目录下所有文件一起软删 + 墓碑，目录整份落盘删除。
 * 回 `{ path, deleted }`（`deleted` = 实际软删的文件数；空目录为 0）。
 */
export function deleteWorkspaceDirectory(conversationId: string, path: string): Promise<WorkspaceDeleteDirResult> {
  const query = new URLSearchParams({ path }).toString()
  return request<WorkspaceDeleteDirResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/dir?${query}`,
    { method: 'DELETE' },
  )
}

/** 改名 / 移动（目标已存在即 409） */
export function moveWorkspaceFile(conversationId: string, from: string, to: string): Promise<WorkspaceFileEntry> {
  return request<WorkspaceFileEntry>(`/api/conversations/${encodeURIComponent(conversationId)}/workspace/move`, {
    method: 'POST',
    body: { from, to },
  })
}

/**
 * 「撤销本轮」（`POST .../workspace/revert`，P1-9 · P4 · R2；2026-10-28 加范围）。
 *
 * 不传 `since`/`until` = 由服务端按**与「最近变更」同一段划分**定窗口；`dryRun=true` = 只算不写
 * （回 `preview` 三栏）。`scope` 缺省 = `AGENT_ONLY`（只撤 agent，手写收尾的路径故意不动）。
 */
export function revertWorkspaceRound(
  conversationId: string,
  options: {
    since?: string
    until?: string
    dryRun?: boolean
    scope?: WorkspaceRevertScope
    paths?: readonly string[]
  } = {},
): Promise<WorkspaceRevertResult> {
  return request<WorkspaceRevertResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/revert`,
    { method: 'POST', body: options },
  )
}

/** 目录 / 路径是否可编辑的判据在 `@doubulea/shared#isWorkspaceTextMime`（不在这里重写一份） */

/** 二进制 / 大文件的**字节出口 URL**（`<img src>` / `<a href>` 用；本仓第四个不套信封端点） */
export function workspaceRawUrl(conversationId: string, path: string): string {
  const query = new URLSearchParams({ path }).toString()
  return `/api/conversations/${encodeURIComponent(conversationId)}/workspace/file/raw?${query}`
}

/**
 * 目录下载为 zip 的 URL（`GET .../workspace/dir/zip?path=`，2026-10-29）。
 *
 * 返回 URL 而不是 Promise：调用方用 `<a download>` 直接触发（与单文件下载同款）——
 * 打包可能要几秒，浏览器自己会转圈，前端不必把整包字节读进内存再造 blob。
 */
export function workspaceDirZipUrl(conversationId: string, path: string): string {
  const query = new URLSearchParams({ path }).toString()
  return `/api/conversations/${encodeURIComponent(conversationId)}/workspace/dir/zip?${query}`
}

/** 读工作区文件的**原始字节**（下载 / 图片预览用；非 UTF-8 文本由调用方判） */
export function fetchWorkspaceBlob(
  conversationId: string,
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ blob: Blob; fileName: string | null }> {
  return requestBlob(workspaceRawUrl(conversationId, path), options)
}

/**
 * 打开工作区**事件流**（`GET .../workspace/events`，SSE）。
 *
 * @param after 上次看到的 `headVersion`（断线补发）；不传 = 只订阅实时
 * @returns 原始 `Response`（调用方用 SSE 帧解析器读；与 `/chat`、`/stream` 同款）
 */
export function openWorkspaceEventStream(
  conversationId: string,
  options: { after?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const query = options.after === undefined ? '' : `?${new URLSearchParams({ after: String(options.after) }).toString()}`
  return openEventStream(
    `/api/conversations/${encodeURIComponent(conversationId)}/workspace/events${query}`,
    { method: 'GET', ...(options.signal === undefined ? {} : { signal: options.signal }) },
  )
}

/**
 * 打开 / 关闭**会话级 Code 模式**（`POST /api/conversations/:id/code-mode`）。
 * 回带落定后的 `codeMode`（与 auto-approve 同款：调用方据此对齐本地状态）。
 */
export function setConversationCodeMode(
  conversationId: string,
  enabled: boolean,
): Promise<SetConversationCodeModeResult> {
  return request<SetConversationCodeModeResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/code-mode`,
    { method: 'POST', body: { enabled } },
  )
}

/** 设置**会话运行时**（P1-17a）：改的是 Code 会话派活时用的运行时镜像（下次派活生效）。 */
export function setConversationRuntime(
  conversationId: string,
  runtime: string,
): Promise<SetConversationRuntimeResult> {
  return request<SetConversationRuntimeResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/runtime`,
    { method: 'POST', body: { runtime } },
  )
}

/**
 * 把会话**点名**到某台实例（`POST /api/conversations/:id/instance`，P1-14 多机）。
 *
 * `instanceId: null` = 交还自动落点（不删已有 owner）。已有 owner 且指向别的实例时后端回 409
 * （容器/工作区在那台）—— 调用方按 `feedback.fail` 展示即可。
 */
export function setConversationInstance(
  conversationId: string,
  instanceId: string | null,
  runtime?: string,
): Promise<SetConversationInstanceResult> {
  return request<SetConversationInstanceResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/instance`,
    // `runtime` 只在 `instanceId === null`（自动落点）时有意义：让后端挑一台具备该环境的实例
    { method: 'POST', body: runtime === undefined ? { instanceId } : { instanceId, runtime } },
  )
}

/**
 * 这条会话**此刻**落在哪台实例（`GET /api/conversations/:id/instance`，P1-14）。
 *
 * 唯一能回答"实际在哪"的读端点：前端只能知道"我点过谁"，新会话首轮落点由网关选的。
 */
export function fetchConversationInstance(conversationId: string): Promise<GetConversationInstanceResult> {
  return request<GetConversationInstanceResult>(`/api/conversations/${encodeURIComponent(conversationId)}/instance`)
}

/** 落点查询键（切换实例 / 派活后失效，让选择器对齐到实际 owner） */
export function conversationInstanceQueryKey(conversationId: string | undefined): readonly unknown[] {
  return ['conversation-instance', conversationId ?? null]
}

export interface WorkspaceStreamHandlers {
  /** 每个工作区事件（`created`/`updated`/`deleted`/`renamed`/`claim`/`release`） */
  onEvent: (event: WorkspaceEventItem) => void
  /** 解析异常（形状不对）—— 记 warn，不影响订阅 */
  onIssue?: (message: string) => void
  /** 断线补发游标（上次看到的 `headVersion`） */
  after?: number
  /** 外部中断信号（组件卸载）：abort 后读流循环随之结束 */
  signal?: AbortSignal
}

/**
 * 订阅工作区事件流（读到 abort / 流结束才返回）。
 *
 * ⚠️ **不复用 `features/chat/sseParser.ts`**：那是 chat 流的解析器（认 `SSE_EVENT_NAMES`
 * 全集），而工作区事件是**另一条 channel**（事件名 `workspace`）—— 用 chat 解析器会把每一帧
 * 都判成"未知事件名"。这里只按 SSE 最朴素的格式（`event:` / `data:` 两行、空行分帧）读。
 */
export async function streamWorkspaceEvents(
  conversationId: string,
  handlers: WorkspaceStreamHandlers,
): Promise<void> {
  const response = await openWorkspaceEventStream(conversationId, {
    ...(handlers.after === undefined ? {} : { after: handlers.after }),
    ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
  })
  const reader = response.body?.getReader()
  if (reader === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (!frame.startsWith(':')) {
          const parsed = parseWorkspaceFrame(frame)
          if (parsed !== null) handlers.onEvent(parsed)
          else handlers.onIssue?.(translate(currentLocale(), 'api.workspace.frameInvalid'))
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    // abort 是正常收尾（组件卸载），不当作错误
    if (handlers.signal?.aborted === true) return
    throw error
  }
}

/** 解析一帧（`event: workspace` + `data: <json>`）；非 workspace 或 data 坏 ⇒ `null` */
function parseWorkspaceFrame(frame: string): WorkspaceEventItem | null {
  let name = ''
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) data += line.slice('data:'.length).trim()
  }
  if (name !== 'workspace' || data === '') return null
  try {
    return JSON.parse(data) as WorkspaceEventItem
  } catch {
    return null
  }
}
/**
 * 保留期提示（2026-10-28）：`staleTime` 5 分钟 —— 这是"天级"信息，没必要频繁问。
 * `enabled` 跟工作区面板一致（非 Code 模式不拉）。
 */
export function useWorkspaceRetention(
  conversationId: string | undefined,
  enabled: boolean,
): UseQueryResult<WorkspaceRetentionInfo> {
  return useQuery({
    queryKey: workspaceRetentionQueryKey(conversationId ?? ''),
    queryFn: () => fetchWorkspaceRetention(conversationId ?? ''),
    enabled: enabled && conversationId !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  })
}
