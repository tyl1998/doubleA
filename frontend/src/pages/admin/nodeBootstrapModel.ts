/**
 * 节点初始化任务的**展示口径**（2026-10-20，配合 `shared/src/node.ts#NodeBootstrapJob`）
 *
 * 为什么单独成文件：页面里最容易被写错、且错了不报错的几件事都在这 —— 步骤图标、活动步骤、
 * 耗时文案、"还能不能收起进度"。和 `sandboxInstanceModel.ts` 同一个纪律：**零依赖纯函数**，
 * 能进无依赖验收档（`verify-sandbox-instances-ui.mjs`）逐条断言。
 */

import type {
  Locale,
  MessageKey,
  NodeBootstrapJob,
  NodeBootstrapStatus,
  NodeBootstrapStepState,
  NodeBootstrapTaskStep,
} from '@doubulea/shared'
import { translate } from '@doubulea/shared'

/** 任务状态 → i18n key（P1-23：存 key 不存文案） */
export const JOB_STATUS_LABEL_KEY: Readonly<Record<NodeBootstrapStatus, MessageKey>> = {
  running: 'bootstrap.state.running',
  succeeded: 'bootstrap.state.succeeded',
  failed: 'bootstrap.state.failed',
}

/** antd 进度条状态：跑着 = active（有条纹动效）；失败 = exception；成功 = success */
export function jobProgressStatus(job: NodeBootstrapJob): 'active' | 'success' | 'exception' {
  if (job.status === 'running') return 'active'
  return job.ok === true && job.status === 'succeeded' ? 'success' : 'exception'
}

/**
 * 步骤图标（终端里也看得懂）：`✅` 成功 / `❌` 失败 / `⏭️` 本来就健康（跳过） / `⏳` 执行中 / `⚪` 等待。
 * ⚠️ `skipped` **不能**画成 ✅：运维需要一眼分清"这次真修了"和"本来就好的"。
 */
export function stepIcon(state: NodeBootstrapStepState): string {
  switch (state) {
    case 'ok':
      return '✅'
    case 'failed':
      return '❌'
    case 'skipped':
      return '⏭️'
    case 'running':
      return '⏳'
    case 'pending':
      return '⚪'
  }
}

/** 当前应在视觉上"高亮"的步骤：真正在跑的那个；没有在跑的（刚建快照）就取第一个未结束的 */
export function activeStepKey(job: NodeBootstrapJob): string | undefined {
  const running = job.steps.find((step) => step.state === 'running')
  if (running !== undefined) return running.key
  return job.steps.find((step) => step.state === 'pending')?.key
}

/** 步骤耗时（`12s` / `3m20s`）；没开始返回 `null` */
export function stepDurationText(step: NodeBootstrapTaskStep, now: number): string | null {
  if (step.startedAt === undefined) return null
  const end = step.finishedAt ?? now
  const seconds = Math.max(0, Math.round((end - step.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** 这次初始化一共动了哪些项 / 跳过了哪些（结果摘要用） */
export function jobSummary(job: NodeBootstrapJob): { fixed: number; skipped: number; failed: number } {
  let fixed = 0
  let skipped = 0
  let failed = 0
  for (const step of job.steps) {
    if (step.state === 'ok') fixed += 1
    else if (step.state === 'skipped') skipped += 1
    else if (step.state === 'failed') failed += 1
  }
  return { fixed, skipped, failed }
}

/**
 * 进度区是否该显示：`running` ⇒ 总是；结束后 ⇒ 保留（用户能回看步骤与结论）。
 * 只在"从未跑过"时隐藏。
 */
export function shouldShowJob(job: NodeBootstrapJob | null | undefined): job is NodeBootstrapJob {
  return job !== null && job !== undefined
}

/** 结论一句话（结果区标题） */
export function jobHeadline(job: NodeBootstrapJob, locale: Locale): string {
  if (job.status === 'running') return translate(locale, 'bootstrap.running', { id: job.instanceId })
  if (job.status === 'failed' && job.ok !== true) {
    return translate(
      locale,
      job.report?.ready === true ? 'bootstrap.finishedReady' : 'bootstrap.finishedNotReady',
      { id: job.instanceId },
    )
  }
  return translate(locale, 'bootstrap.completed', { id: job.instanceId })
}
