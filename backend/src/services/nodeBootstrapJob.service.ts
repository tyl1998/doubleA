/**
 * 一键初始化的**任务编排**（2026-10-20 用户反馈：「切到别的页面再回来就看不到进度了」）。
 *
 * 职责划分：
 *   · `sandbox/nodeBootstrap.ts` —— **纯执行单元**：干活、给结论，只通过回调喊"第一步开始了/结束了"；
 *   · 本文件 —— **任务单元**：建快照、把回调节流写进 Redis、结束时收尾；
 *   · `routes/node.ts` —— **HTTP 单元**：`POST` 立即返回 `jobId`，`GET` 返回快照。
 *
 * 三条必须写对的规则（都不是风格问题）：
 * 1. **立即返回**：初始化可能跑几十分钟（拉/建镜像）。同步等它 ⇒ 网关/浏览器超时，进度全丢。
 *    这也是长任务清单（`shared/router.ts#LONG_RUNNING_ADMIN_ENDPOINTS`）想摆脱的东西。
 * 2. **计划先于执行**：步骤表在**开始前**就写全（未开始的标 `pending`，附"将做什么"），
 *    页面一进来就能看到完整步骤，而不是"跑一步冒一步"。
 * 3. **同一实例只跑一个**：重复点不叠跑（并发拉镜像/起容器会互相打架），返回**同一个** jobId。
 *    进程内 `inflight` 只是快路径；跨实例靠 Redis 里的 `running` 快照判重。
 */

import type { NodeBootstrapJob, NodeBootstrapTaskStep, NodeRoleName } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { bootstrapNode, type NodeBootstrapProgress } from '../sandbox/nodeBootstrap.js'
import {
  createJob,
  finishJobWith,
  getCurrentJob,
  getJob,
  jobPercent,
  newNodeJobId,
  saveJob,
} from '../sandbox/nodeJobStore.js'
import type { NodeTarget } from '../sandbox/nodeOps.js'
import { bootstrapNodeOn } from '../sandbox/nodeOps.js'

/** 进度落盘的最小间隔（毫秒）：步骤事件很碎（拉镜像会打很多条），没必要每条都写 Redis */
const FLUSH_INTERVAL_MS = 700
/** 即使没有任何事件，也按这个间隔续心跳 —— 让"还活着"可被 `NODE_JOB_STALE_MS` 判据区分开 */
const HEARTBEAT_MS = 5_000

/** 步骤计划：顺序 = 执行顺序；`detail` 是**尚未开始**时给运维看的"将做什么" */
const PLAN: ReadonlyArray<{ key: string; label: string; pending: string }> = [
  { key: 'docker', label: 'Docker daemon', pending: '检查能否连上 Docker（连不上后面都做不了）' },
  { key: 'sandboxNetwork', label: '沙箱网 doubulea-sandbox', pending: '创建 / 校验沙箱网，并拿到网关地址' },
  { key: 'dockerCli', label: 'docker-cli 侧车', pending: '检查侧车容器（按需构建环境要用它的 CLI）' },
  { key: 'toolkitImage', label: '沙箱镜像（toolkit）', pending: '已有就跳过；缺失则先 docker pull，拉不到再构建' },
  { key: 'egress', label: '出口代理 doubulea-egress', pending: '未运行或没接上沙箱网才拉起（含镜像准备）' },
  { key: 'relay', label: '出口② 中转 doubulea-sandbox-relay', pending: '仅 macOS / Windows（Docker 在 VM 里）需要' },
  { key: 'recheck', label: '重新自检', pending: '跑一遍完整自检，给出最终结论' },
]

/** 一个实例同时只跑一个初始化：进程内去重（跨实例由 Redis 快照判重） */
const inflight = new Map<string, string>()

function planSteps(): NodeBootstrapTaskStep[] {
  return PLAN.map((item) => ({ key: item.key, label: item.label, state: 'pending' as const, detail: item.pending, events: [] }))
}

/**
 * 把进度回调落成一份可轮询的快照。
 *
 * `draft` 是唯一真相；`flush()` 把它写进 Redis（节流 + 立即写关键点）。
 * ⚠️ 所有方法都**不抛**：写盘失败只影响"回看"，不能拖垮初始化本身。
 */
class JobRecorder implements NodeBootstrapProgress {
  #job: NodeBootstrapJob
  #lastFlush = 0
  #writing: Promise<void> = Promise.resolve()
  #closed = false

  constructor(job: NodeBootstrapJob) {
    this.#job = job
  }

  get job(): NodeBootstrapJob {
    return this.#job
  }

  #find(key: string, createLabel?: string): NodeBootstrapTaskStep {
    const found = this.#job.steps.find((step) => step.key === key)
    if (found !== undefined) return found
    // 计划外的步骤（后端新增而前端/计划没跟上）：追加到末尾，而不是丢弃
    const extra: NodeBootstrapTaskStep = { key, label: createLabel ?? key, state: 'pending', detail: '', events: [] }
    this.#job.steps.push(extra)
    return extra
  }

  #recompute(): void {
    this.#job.completed = this.#job.steps.filter((step) => step.state === 'ok' || step.state === 'failed' || step.state === 'skipped').length
    this.#job.total = this.#job.steps.length
    this.#job.percent = jobPercent(this.#job.steps)
    this.#job.updatedAt = Date.now()
  }

  begin(key: string, detail: string): void {
    const step = this.#find(key)
    if (step.state !== 'running') {
      step.state = 'running'
      step.startedAt = Date.now()
      delete step.finishedAt
    }
    if (detail !== '') step.detail = detail
    this.#recompute()
    this.flush(true)
  }

  note(key: string, event: string): void {
    const step = this.#find(key)
    const text = event.trim()
    if (text === '') return
    // 同一个事件不重复记（脚本重试时会出现），其余按时间顺序保留
    step.events.push(text)
    this.#recompute()
    this.flush(false)
  }

  end(key: string, outcome: { ok: boolean; detail: string; skipped?: boolean }): void {
    const step = this.#find(key)
    if (outcome.skipped === true) step.state = 'skipped'
    else step.state = outcome.ok ? 'ok' : 'failed'
    step.detail = outcome.detail
    step.finishedAt = Date.now()
    if (step.startedAt === undefined) step.startedAt = step.finishedAt
    this.#recompute()
    this.flush(true)
  }

  stage(stage: string): void {
    // 阶段只决定"接下来做什么"的预告：把第一个 `pending` 的 detail 换成阶段说明没有意义，
    // 这里只做心跳（长阶段之间也要让服务端知道任务还活着）。
    getLogger().debug({ jobId: this.#job.jobId, stage }, '节点初始化阶段')
    this.flush(false)
  }

  /** 到点写盘；`force` = 关键点（步骤开始/结束）立即写，丢掉中间节流 */
  flush(force: boolean): void {
    if (this.#closed) return
    const now = Date.now()
    if (!force && now - this.#lastFlush < FLUSH_INTERVAL_MS && now - this.#job.updatedAt < HEARTBEAT_MS) return
    this.#lastFlush = now
    const snapshot: NodeBootstrapJob = { ...this.#job, steps: this.#job.steps.map((step) => ({ ...step, events: [...step.events].slice(-12) })) }
    this.#writing = this.#writing.then(() => saveJob(snapshot)).catch(() => undefined)
  }

  /** 定时心跳（步骤内部长时间只打一条事件时，仍要让 `updatedAt` 前进） */
  heartbeat(): void {
    this.#job.updatedAt = Date.now()
    this.flush(true)
  }

  async close(job: NodeBootstrapJob): Promise<void> {
    this.#closed = true
    this.#job = job
    await this.#writing
    await saveJob(job)
  }
}

/** 该实例是否已有在跑的任务（用于"重复点不叠跑"） */
async function runningJobId(instanceId: string): Promise<string | undefined> {
  const memory = inflight.get(instanceId)
  if (memory !== undefined) return memory
  const current = await getCurrentJob(instanceId)
  return current?.status === 'running' ? current.jobId : undefined
}

export interface StartedJob {
  job: NodeBootstrapJob
  /** `true` = 复用了已经在跑的那个任务（本次没有新起） */
  reused: boolean
}

/**
 * 启动（或复用）一个初始化任务，**立即返回**快照。
 *
 * ⚠️ 远端实例：本机没有执行权（要驱动的是那台的 Docker）⇒ 仍然是"带签名转发、等它跑完"的
 *    `POST /internal/node/bootstrap`。这段时间里本机**不知道它到哪一步**，所以快照只有
 *    「检测 + 执行（远端）」两行，并带一条说明 —— 诚实胜过假进度。
 */
export async function startBootstrapJob(
  target: NodeTarget,
  role: NodeRoleName,
  options: { isSelf: boolean },
): Promise<StartedJob> {
  // ★ 占位必须**同步**完成：两次点击相隔几毫秒时，若占位发生在任何 await 之后，
  //   第二次请求会走完下面的异步判重（Redis / 进程内都还没写）⇒ 叠跑两个任务。
  for (;;) {
    const claimed = inflight.get(target.instanceId)
    if (claimed === undefined) break
    const running = await getJob(target.instanceId, claimed)
    if (running !== undefined && running.status === 'running') return { job: running, reused: true }
    // 已经跑完了（或快照还没落盘）：把占位还回去再看 Redis 里有没有别的实例在跑
    if (inflight.get(target.instanceId) === claimed) inflight.delete(target.instanceId)
  }

  const existing = await runningJobId(target.instanceId)
  if (existing !== undefined) {
    const job = await getJob(target.instanceId, existing)
    if (job !== undefined && job.status === 'running') return { job, reused: true }
    inflight.delete(target.instanceId)
  }

  const now = Date.now()
  const job: NodeBootstrapJob = {
    jobId: newNodeJobId(now),
    instanceId: target.instanceId,
    status: 'running',
    percent: 0,
    completed: 0,
    total: PLAN.length,
    steps: planSteps(),
    startedAt: now,
    updatedAt: now,
  }
  // 同步占位：从这里到 `runLocal`/`runRemote` 之间**不再有"未知"窗口**
  inflight.set(target.instanceId, job.jobId)
  await createJob(job)

  if (!options.isSelf) {
    // 远端：只能等它一次性回结论（内部端点不提供进度流），如实呈现"两段式"
    const remote: NodeBootstrapJob = {
      ...job,
      total: 2,
      steps: [
        { key: 'remote', label: `在实例 ${target.instanceId} 上执行`, state: 'running', detail: '已带签名把初始化转发过去；远端完成后这里会给出逐条步骤', startedAt: now, events: [] },
        { key: 'recheck', label: '重新自检', state: 'pending', detail: '远端执行完会顺带回自检结论', events: [] },
      ],
    }
    void runRemote(remote, target, role)
    return { job: remote, reused: false }
  }

  void runLocal(job, role)
  return { job, reused: false }
}

async function runLocal(job: NodeBootstrapJob, role: NodeRoleName): Promise<void> {
  const recorder = new JobRecorder(job)
  const timer = setInterval(() => {
    recorder.heartbeat()
  }, HEARTBEAT_MS)
  const started = Date.now()
  try {
    const result = await bootstrapNode({ role, instanceId: job.instanceId, progress: recorder })
    const finished = finishJobWith(recorder.job, result)
    await recorder.close(finished)
    getLogger().info(
      { jobId: job.jobId, instanceId: job.instanceId, ok: finished.ok, ms: Date.now() - started },
      '节点一键初始化结束',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    getLogger().warn({ err: error, jobId: job.jobId }, '节点一键初始化抛错')
    const now = Date.now()
    const failed: NodeBootstrapJob = {
      ...recorder.job,
      status: 'failed',
      ok: false,
      error: message,
      finishedAt: now,
      updatedAt: now,
      steps: recorder.job.steps.map((step) =>
        step.state === 'running' ? { ...step, state: 'failed', detail: message, finishedAt: now } : step,
      ),
    }
    failed.completed = failed.steps.filter((step) => step.state === 'ok' || step.state === 'failed' || step.state === 'skipped').length
    failed.percent = jobPercent(failed.steps)
    await recorder.close(failed).catch(() => undefined)
  } finally {
    clearInterval(timer)
    inflight.delete(job.instanceId)
  }
}

async function runRemote(job: NodeBootstrapJob, target: NodeTarget, role: NodeRoleName): Promise<void> {
  const started = Date.now()
  try {
    const result = await bootstrapNodeOn(target, role)
    const now = Date.now()
    const steps: NodeBootstrapTaskStep[] = result.steps.map((step, index) => ({
      key: `remote-${String(index)}-${step.step}`,
      label: step.step,
      state: step.skipped === true ? 'skipped' : step.ok ? 'ok' : 'failed',
      detail: step.detail,
      events: [],
      finishedAt: now,
    }))
    steps.push({ key: 'recheck', label: '重新自检', state: 'ok', detail: result.report.ready ? '全部必需项就绪' : '仍有未就绪项', events: [], finishedAt: now })
    const finished = finishJobWith(
      { ...job, steps, total: steps.length },
      result,
      now,
    )
    finished.completed = finished.steps.length
    finished.percent = 100
    await saveJob(finished)
    getLogger().info({ jobId: job.jobId, instanceId: job.instanceId, ok: finished.ok, ms: now - started }, '远端节点初始化结束')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const now = Date.now()
    await saveJob({
      ...job,
      status: 'failed',
      ok: false,
      error: message,
      percent: 100,
      completed: job.total,
      finishedAt: now,
      updatedAt: now,
      steps: job.steps.map((step) => (step.state === 'running' ? { ...step, state: 'failed', detail: message, finishedAt: now } : step)),
    })
  } finally {
    inflight.delete(job.instanceId)
  }
}
