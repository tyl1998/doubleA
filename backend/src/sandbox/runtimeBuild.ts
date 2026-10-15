/**
 * 沙箱运行时**按需构建**（P1-17a · 定案 B，2026-10-14 用户拍板）。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它解的是什么
 * ─────────────────────────────────────────────────────────────────────
 * 用户选了"本机还没构建过"的运行时组合（如 Python 3.10 + Node 22）时，**后端自动 `docker build`**
 * 那份组合，再交给 `ensureSandbox` 用 —— 于是**运维不必预先猜组合、也不必为每个组合手改镜像**。
 * 组合键（变体 id）即镜像 tag 的可读部分 ⇒ **第二次直接命中缓存**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ★ 2026-10-14 修订：构建**改成长任务**（进度条 + 可取消）
 * ─────────────────────────────────────────────────────────────────────
 * 原来 `buildSandboxRuntime` 是**阻塞式**的（一个 HTTP 请求等整个 `docker build` 跑完，最长 20 分钟），
 * 前端拿不到进度、也不能中途取消。现改为**任务（job）模型**：
 *   · `startSandboxRuntimeBuild()` → 落一个 job、**立刻**回快照（含 `buildId`），构建在后台跑；
 *   · `getSandboxBuildJob(buildId)` → 前端轮询（阶段 / 百分比 / 日志尾 / 结局）；
 *   · `cancelSandboxBuild(buildId)` → 杀 docker build 进程、标 `canceled`。
 * 于是前端能画**进度条**、显示"正在做什么"、并支持**取消**。
 *
 * ⚠️ 判据（与旧实现一致，只是改成"job 视角"）：
 *   · **已就绪直接命中**：本机已有同变体镜像（任意层版本）⇒ 回一个 `succeeded` 快照，不起构建；
 *   · **串行 + 去重**：同一时刻只跑一个 build；同 tag 的并发请求**复用同一个 job**（构建很贵，
 *     且 docker build 并发会互相抢 apt/pip 缓存）；
 *   · **阶段与百分比只增不减**：docker build 的输出是流式的，"进度"只是观感，不做严格计量。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条工程约束（沿用）
 * ─────────────────────────────────────────────────────────────────────
 *   ① **tag 的唯一事实来源仍在 `infra/sandbox/versions.mjs`**（`runtimeImageRef` + 层版本号）：
 *      后端**动态 import 构建上下文旁的 `versions.mjs`**，不自己再写一份版本号（否则"建出来的 tag"
 *      与"CLI 建的 tag"会分叉）。
 *   ② **构建上下文**（`infra/sandbox/runtime`，含 `Dockerfile` + 两个脚本）由配置 `SANDBOX_RUNTIME_BUILD_CONTEXT`
 *      指定或自动推断（`config.ts#defaultRuntimeBuildContext`）；**推断不出 ⇒ 不可按需构建**
 *      （生产镜像里常常没有这份源码），由 `GET /api/sandbox/runtimes` 的 `canBuild` 反映。
 *   ③ **串行 + 去重**：见上。
 *
 * ⚠️ 构建走**宿主网络**（不是沙箱的 egress 代理）：python 版本要联网拉（见 `install-python-version.sh`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 进度从哪来（尽力而为、零新依赖）
 * ─────────────────────────────────────────────────────────────────────
 * 解析 docker build 的 stdout/stderr：
 *   · **BuildKit**：`#N [x/y] ...` ⇒ 用 `x/y` 当百分比；方括号后的动作文案当"当前步骤"；
 *   · **经典构建器**：`Step x/y : ...` ⇒ 同款；
 *   · 再把动作文案按关键字粗分到 {@link SANDBOX_BUILD_PHASES}（apt / 语言 / 自检）。
 * 解析不出（输出格式变了）时退回"阶段 = 语言安装中、百分比 = 上次值"——**只影响观感，不影响构建**。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  sandboxComponentsArg,
  sandboxVariantIdFromSelection,
  sandboxVariantLabel,
  SANDBOX_BUILD_PHASE_LABELS,
  type SandboxBuildJob,
  type SandboxBuildPhase,
  type SandboxRuntimeSelection,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { listRuntimeImages } from './docker.js'

/** 单次构建的上限（毫秒）：python 版本要联网下载 + 编译期较长，给足；超时按失败处理。 */
const BUILD_TIMEOUT_MS = 20 * 60 * 1000

/** 构建日志保留的**尾部**字符数（轮询每次都回带；太大会几何膨胀） */
const BUILD_LOG_TAIL_CHARS = 16_000

/** 任务在终态后仍保留多久（供前端收尾轮询最后一次拿到 `succeeded`/`failed`/`canceled`） */
const JOB_RETENTION_MS = 10 * 60 * 1000

/** `versions.mjs` 里我们要用的那部分（动态 import 的契约，只取 `runtimeImageRef`） */
interface RuntimeVersionsModule {
  runtimeImageRef: (variant: string) => string
}

/** 读一次构建上下文旁的 `versions.mjs`（tag/层版本的**唯一事实来源**）；不可用返回 `undefined` */
async function loadRuntimeVersions(): Promise<RuntimeVersionsModule | undefined> {
  const context = config.sandbox.runtimeBuildContext
  if (context === undefined) return undefined
  const versionsPath = resolve(context, '..', 'versions.mjs')
  if (!existsSync(versionsPath)) return undefined
  try {
    const mod = (await import(pathToFileURL(versionsPath).href)) as Partial<RuntimeVersionsModule>
    return typeof mod.runtimeImageRef === 'function' ? (mod as RuntimeVersionsModule) : undefined
  } catch (error) {
    getLogger().warn({ err: error, versionsPath }, '读取 versions.mjs 失败 ⇒ 按需构建不可用')
    return undefined
  }
}

/** 能否**按需构建**（构建上下文 + Dockerfile + versions.mjs 都在）—— `GET /runtimes` 的 `canBuild` */
export async function canBuildSandboxRuntime(): Promise<boolean> {
  const context = config.sandbox.runtimeBuildContext
  if (context === undefined || !existsSync(resolve(context, 'Dockerfile'))) return false
  return (await loadRuntimeVersions()) !== undefined
}

// ───────────────────────────── job 模型 ─────────────────────────────

/**
 * 一个构建任务的**内部状态**（比对外的 {@link SandboxBuildJob} 多一个子进程句柄与收尾定时器）。
 */
interface BuildJobState {
  buildId: string
  variant: string
  label: string
  tag: string
  startedAtMs: number
  status: SandboxBuildJob['status']
  phase: SandboxBuildPhase
  /** 阶段显示文案（含"正在装 X"这类细节，由 {@link phaseLabelFor} 生成） */
  phaseLabel: string
  /** 0..1；只增不减 */
  progress: number
  log: string
  image: string | null
  error: string | null
  /** 正在跑的 docker build 子进程；未起或已收尾为 `undefined` */
  child: ChildProcessWithoutNullStreams | undefined
  /** 超时/收尾定时器（取消、超时、保留期回收共用一条） */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** 活跃/近期的构建任务（`buildId` → 状态） */
const jobs = new Map<string, BuildJobState>()
/** tag → buildId（**去重**：同一变体并发请求复用同一 job；终态后移除，下次可重建） */
const tagToJob = new Map<string, string>()
/** 串行闸：同一时刻只跑一个 build（`docker build` 并发会互相抢 apt/pip 缓存） */
let buildChain: Promise<unknown> = Promise.resolve()

/** 内部状态 → 对外快照（去掉子进程句柄；`durationMs` 现算） */
function snapshot(job: BuildJobState): SandboxBuildJob {
  return {
    buildId: job.buildId,
    variant: job.variant,
    label: job.label,
    status: job.status,
    phase: job.phase,
    phaseLabel: job.phaseLabel,
    progress: job.progress,
    log: job.log,
    image: job.image,
    error: job.error,
    durationMs: Date.now() - job.startedAtMs,
  }
}

/** 立刻落一个**终态**快照并登记（已就绪直接命中 / 拒绝构建这类"不起进程"的结局） */
function settleImmediately(partial: {
  variant: string
  label: string
  tag: string
  status: SandboxBuildJob['status']
  phase: SandboxBuildPhase
  progress: number
  image: string | null
  error: string | null
  log?: string
}): SandboxBuildJob {
  const job: BuildJobState = {
    buildId: randomUUID(),
    variant: partial.variant,
    label: partial.label,
    tag: partial.tag,
    startedAtMs: Date.now(),
    status: partial.status,
    phase: partial.phase,
    phaseLabel: SANDBOX_BUILD_PHASE_LABELS[partial.phase],
    progress: partial.progress,
    log: partial.log ?? '',
    image: partial.image,
    error: partial.error,
    child: undefined,
    timer: undefined,
  }
  registerJob(job)
  retainThenDrop(job)
  return snapshot(job)
}

/** 登记一个 job（成功/失败后会给它一条"保留期到期就删"的定时器） */
function registerJob(job: BuildJobState): void {
  jobs.set(job.buildId, job)
  if (job.status !== 'running') tagToJob.delete(job.tag)
}

/** 终态 job 保留 {@link JOB_RETENTION_MS} 后回收（其间前端还能轮询到最后一次快照） */
function retainThenDrop(job: BuildJobState): void {
  if (job.timer !== undefined) clearTimeout(job.timer)
  job.timer = setTimeout(() => {
    jobs.delete(job.buildId)
  }, JOB_RETENTION_MS)
  // 定时器不该吊住进程退出
  job.timer.unref?.()
}

/** 阶段顺序（**只前进**：`queued < preparing < apt < language < verifying < done`） */
export const SANDBOX_BUILD_PHASE_ORDER: readonly SandboxBuildPhase[] = [
  'queued',
  'preparing',
  'apt',
  'language',
  'verifying',
  'done',
]

/** 每个阶段的**百分比下限**（避免"阶段变了、条却不动"）—— 也是纯判据，供回归逐条核对 */
const PHASE_PROGRESS_FLOOR: Readonly<Record<SandboxBuildPhase, number>> = {
  queued: 0,
  preparing: 0.05,
  apt: 0.2,
  language: 0.4,
  verifying: 0.9,
  done: 1,
}

/** 一行 docker build 输出的**解读结果**（纯数据；`undefined` 字段 = 这一行没给出该信息） */
export interface BuildLineInterpretation {
  /** 若这一行是"步进度"行，给出 0.1..0.85 的百分比（首尾预留给准备与自检） */
  progress?: number
  /** 若这一行命中某阶段关键字，给出该阶段 */
  phase?: SandboxBuildPhase
  /** 阶段文案的"人话细节"（组件名 / RUN 概要） */
  detail?: string
}

/**
 * 把 docker build 的一行输出翻成"阶段 + 百分比"（**纯函数、零 IO**：便于回归逐条核对）。
 *
 * BuildKit：`#5 [2/5] RUN set -eux; ...`；经典：`Step 2/5 : RUN ...`。
 * ⚠️ 认不出的一律返回空对象（`{}`）—— 解析失败**只影响观感**，不影响构建本身。
 */
export function interpretBuildLine(line: string): BuildLineInterpretation {
  const result: BuildLineInterpretation = {}
  const buildkit = /#\d+\s+\[(?:\w+\s+)?(\d+)\/(\d+)\]/u.exec(line)
  const classic = /Step\s+(\d+)\/(\d+)\s*:/u.exec(line)
  const matched = buildkit ?? classic
  if (matched?.[1] !== undefined && matched[2] !== undefined) {
    const step = Number(matched[1])
    const total = Number(matched[2])
    if (total > 0) result.progress = Math.min(0.85, 0.1 + 0.75 * (step / total))
  }
  const lower = line.toLowerCase()
  if (/apt-get|apt install|sources\.list|deb\.debian/u.test(lower)) result.phase = 'apt'
  else if (/=== 组件：|install-python|pip install|golang|openjdk|maven|rustc|cargo|python3-pip|venv/u.test(lower)) {
    result.phase = 'language'
    const detail = phaseDetail(line)
    if (detail !== undefined) result.detail = detail
  } else if (/selfcheck|自检/u.test(lower)) result.phase = 'verifying'
  else if (/load build definition|load \.dockerignore|transferring context|load metadata/u.test(lower)) {
    result.phase = 'preparing'
  }
  return result
}

/** 更新阶段（**只前进**；顺带把百分比抬到该阶段下限） */
function advancePhase(job: BuildJobState, phase: SandboxBuildPhase, detail?: string): void {
  if (SANDBOX_BUILD_PHASE_ORDER.indexOf(phase) < SANDBOX_BUILD_PHASE_ORDER.indexOf(job.phase)) return
  job.phase = phase
  job.phaseLabel =
    detail !== undefined && detail !== ''
      ? `${SANDBOX_BUILD_PHASE_LABELS[phase]}（${detail}）`
      : SANDBOX_BUILD_PHASE_LABELS[phase]
  job.progress = Math.max(job.progress, PHASE_PROGRESS_FLOOR[phase])
}

/** 把一行输出应用到 job（阶段只前进、进度只增不减）—— 解析逻辑全在 {@link interpretBuildLine} */
function consumeBuildLine(job: BuildJobState, line: string): void {
  const interpreted = interpretBuildLine(line)
  if (interpreted.progress !== undefined) job.progress = Math.max(job.progress, interpreted.progress)
  if (interpreted.phase !== undefined) advancePhase(job, interpreted.phase, interpreted.detail)
}

/** 从一行输出里挤出"人话细节"（组件名 / RUN 的概要），仅供阶段文案用；过长就截断 */
function phaseDetail(line: string): string | undefined {
  const component = /=== 组件：([^=]+=[^\s]+) ===/u.exec(line)
  if (component?.[1] !== undefined) return component[1]
  const run = /RUN\s+(.{0,60})/u.exec(line)
  if (run?.[1] !== undefined) return run[1].trim()
  return undefined
}

/** 追加日志（保留尾部，避免几何膨胀） */
function appendLog(job: BuildJobState, chunk: string): void {
  job.log += chunk
  if (job.log.length > BUILD_LOG_TAIL_CHARS) job.log = job.log.slice(-BUILD_LOG_TAIL_CHARS)
}

/** 构建子进程收尾：定状态、清句柄、登记保留期 */
function finishJob(job: BuildJobState, status: 'succeeded' | 'failed' | 'canceled', error: string | null): void {
  if (job.status !== 'running') return
  if (job.timer !== undefined) clearTimeout(job.timer)
  job.child = undefined
  job.status = status
  job.image = status === 'succeeded' ? job.tag : null
  job.error = error
  if (status === 'succeeded') {
    job.phase = 'done'
    job.phaseLabel = SANDBOX_BUILD_PHASE_LABELS.done
    job.progress = 1
  }
  tagToJob.delete(job.tag)
  retainThenDrop(job)
  getLogger().info(
    { buildId: job.buildId, variant: job.variant, tag: job.tag, status, durationMs: Date.now() - job.startedAtMs },
    '按需构建运行时镜像任务结束（P1-17a）',
  )
}

/**
 * 启动一个运行时构建**任务**（P1-17a · 定案 B）。
 *
 * 口径：见文件头。**立刻返回快照**（不阻塞在 `docker build` 上）。
 */
export async function startSandboxRuntimeBuild(
  components: readonly SandboxRuntimeSelection[],
): Promise<SandboxBuildJob> {
  const variant = sandboxVariantIdFromSelection(components)
  const label = sandboxVariantLabel(variant)

  const versions = await loadRuntimeVersions()
  const context = config.sandbox.runtimeBuildContext
  if (versions === undefined || context === undefined) {
    return settleImmediately({
      variant,
      label,
      tag: '',
      status: 'failed',
      phase: 'done',
      progress: 1,
      image: null,
      error: '本机未配置按需构建上下文（SANDBOX_RUNTIME_BUILD_CONTEXT / 仓库 infra 不在），请运维先构建运行时镜像',
    })
  }
  // 全部选择项都没认出来（空集合 = none 除外）⇒ 拒绝（避免给一个"什么都没装"的镜像）
  if (components.length > 0 && variant === 'none') {
    return settleImmediately({
      variant,
      label,
      tag: '',
      status: 'failed',
      phase: 'done',
      progress: 1,
      image: null,
      error: '没有可识别的语言+版本（语言或版本不合法）',
    })
  }

  const tag = versions.runtimeImageRef(variant)
  // 已有同变体镜像（任意层版本）⇒ 认为已就绪，**不起构建**，直接回一个成功快照
  const refs = await listRuntimeImages(config.sandbox.runtimeRepo)
  const already = refs.some((ref) => ref.replace(/-v\d+$/u, '') === tag.replace(/-v\d+$/u, ''))
  if (already) {
    getLogger().info({ variant, tag }, '运行时镜像已存在 ⇒ 跳构建（P1-17a 按需构建）')
    return settleImmediately({
      variant,
      label,
      tag,
      status: 'succeeded',
      phase: 'done',
      progress: 1,
      image: tag,
      error: null,
    })
  }

  // 去重：同 tag 已有一个**在跑**的 job ⇒ 复用它的快照（不再起一个 build）
  const existingId = tagToJob.get(tag)
  if (existingId !== undefined) {
    const existing = jobs.get(existingId)
    if (existing !== undefined && existing.status === 'running') return snapshot(existing)
  }

  const job: BuildJobState = {
    buildId: randomUUID(),
    variant,
    label,
    tag,
    startedAtMs: Date.now(),
    status: 'running',
    phase: 'queued',
    phaseLabel: SANDBOX_BUILD_PHASE_LABELS.queued,
    progress: 0,
    log: '',
    image: null,
    error: null,
    child: undefined,
    timer: undefined,
  }
  jobs.set(job.buildId, job)
  tagToJob.set(tag, job.buildId)

  // 串行：排在前一个 build 之后（每个 job 自己起进程，串行只是"同一时刻只有一个在跑"）
  buildChain = buildChain.then(() => runBuildProcess(job, context, components)).catch(() => undefined)

  return snapshot(job)
}

/** 真正跑 `docker build`（在串行链上被调用）；返回的 promise 在进程收尾时 resolve */
function runBuildProcess(
  job: BuildJobState,
  context: string,
  components: readonly SandboxRuntimeSelection[],
): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (job.status !== 'running') {
      // 排在链上期间被取消了 ⇒ 直接收尾
      resolvePromise()
      return
    }
    advancePhase(job, 'preparing')
    const componentsArg = sandboxComponentsArg(components)
    const args = [
      'build',
      '-f',
      resolve(context, 'Dockerfile'),
      '-t',
      job.tag,
      '--build-arg',
      `BASE_IMAGE=${config.sandbox.image ?? ''}`,
      '--build-arg',
      `COMPONENTS=${componentsArg}`,
      '--build-arg',
      `APT_MIRROR=${process.env.SANDBOX_APT_MIRROR ?? ''}`,
      '--build-arg',
      `NODE_DIST_MIRROR=${process.env.SANDBOX_NODE_DIST_MIRROR ?? ''}`,
      '--build-arg',
      `RUST_DIST_MIRROR=${process.env.SANDBOX_RUST_DIST_MIRROR ?? ''}`,
      context,
    ]
    getLogger().info({ buildId: job.buildId, variant: job.variant, tag: job.tag, components: componentsArg }, '按需构建运行时镜像开始（P1-17a）')

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(config.sandbox.dockerBin, args, { cwd: context, env: process.env })
    } catch (error) {
      finishJob(job, 'failed', `docker build 启动失败：${error instanceof Error ? error.message : String(error)}`)
      resolvePromise()
      return
    }
    job.child = child

    // 超时兜底：杀进程 + 标失败
    job.timer = setTimeout(() => {
      appendLog(job, `\n[build] 超时（${BUILD_TIMEOUT_MS}ms），已终止\n`)
      child.kill('SIGKILL')
    }, BUILD_TIMEOUT_MS)
    job.timer.unref?.()

    // 逐行解析（半行先攒着，遇 \n 再消费整行）
    let pending = ''
    const onChunk = (chunk: Buffer): void => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        appendLog(job, `${line}\n`)
        consumeBuildLine(job, line)
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)

    child.on('error', (error) => {
      appendLog(job, `\n[build] 子进程错误：${error.message}\n`)
    })
    child.on('close', (code) => {
      if (pending !== '') {
        appendLog(job, pending)
        consumeBuildLine(job, pending)
      }
      if (job.status !== 'running') {
        // 已被取消（cancelSandboxBuild 已定状态）
        resolvePromise()
        return
      }
      if (code === 0) {
        finishJob(job, 'succeeded', null)
      } else {
        finishJob(job, 'failed', `docker build 失败（退出码 ${String(code)}）：\n${job.log.slice(-2000)}`)
      }
      resolvePromise()
    })
  })
}

/** 端点用：拿一个构建任务的当前快照；查不到返回 `undefined` */
export function getSandboxBuildJob(buildId: string): SandboxBuildJob | undefined {
  const job = jobs.get(buildId)
  return job === undefined ? undefined : snapshot(job)
}

/**
 * 取消一个构建任务：杀 docker build 进程、标 `canceled`。
 *
 * ⚠️ 幂等：终态（或查不到）时不报错，回当前快照（或 `undefined`）—— 前端点两次取消不该炸。
 */
export function cancelSandboxBuild(buildId: string): SandboxBuildJob | undefined {
  const job = jobs.get(buildId)
  if (job === undefined) return undefined
  if (job.status === 'running') {
    appendLog(job, '\n[build] 用户取消，已终止\n')
    // 先定状态再杀进程：close 回调看见 status !== running 就不再改结局
    finishJob(job, 'canceled', '构建已取消')
    job.child?.kill('SIGKILL')
  }
  return snapshot(job)
}
