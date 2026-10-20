/**
 * 初始化进度面板（2026-10-20 用户反馈：要有**步骤动效 + 步骤详情**，切页回来还得看得见）
 *
 * 依据：`shared/src/node.ts#NodeBootstrapJob`（后端任务快照）、`pages/admin/nodeBootstrapModel.ts`（展示口径）。
 *
 * 三条刻意的做法：
 * 1. **进度是真的**：百分比来自后端按步骤算出的 `percent`，不是前端缓动的假条 —— 所以切页回来看到的
 *    数字和离开前一致，且能对上真实进展。
 * 2. **动效挂在"当前步骤"上**：只有 `running` 的那一行有转圈与进度条流动，其余行静态；
 *    这样一眼能看出"卡在哪一步"，而不是整块都在闪。
 * 3. **详情默认展开当前步**：`events[]` 是后端在这一步里记录的动作（拉哪个镜像、执行哪个脚本），
 *    长步骤（`docker pull` / 构建）能看出它到底在忙什么。
 */

import { CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, LoadingOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { Alert, Collapse, Progress, Space, Tag, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type { NodeBootstrapJob, NodeBootstrapTaskStep } from '@doubulea/shared'

import {
  activeStepKey,
  JOB_STATUS_LABELS,
  jobHeadline,
  jobProgressStatus,
  jobSummary,
  stepDurationText,
  stepIcon,
} from './nodeBootstrapModel.js'

/** 每 500ms 重渲染一次，让"执行中"那行的耗时时走（只在有步骤在跑时开） */
function useTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

function StepIcon({ state }: { state: NodeBootstrapTaskStep['state'] }) {
  if (state === 'running') return <LoadingOutlined style={{ color: 'var(--accent)' }} />
  if (state === 'ok') return <CheckCircleFilled style={{ color: 'var(--ok, #52c41a)' }} />
  if (state === 'failed') return <CloseCircleFilled style={{ color: 'var(--danger, #ff4d4f)' }} />
  if (state === 'skipped') return <MinusCircleOutlined style={{ color: 'var(--muted)' }} />
  return <span style={{ color: 'var(--muted)' }}>○</span>
}

function StepRow({ step, active, now }: { step: NodeBootstrapTaskStep; active: boolean; now: number }) {
  const duration = stepDurationText(step, now)
  const running = step.state === 'running'
  return (
    <div className={`node-step${active ? ' is-active' : ''} is-${step.state}`} data-testid={`node-step-${step.key}`}>
      <div className="node-step__head">
        <StepIcon state={step.state} />
        <span className="node-step__label" title={step.label}>
          {step.label}
        </span>
        {running && <span className="node-step__badge">执行中</span>}
        {step.state === 'skipped' && <span className="node-step__badge node-step__badge--muted">已就绪，跳过</span>}
        {duration !== null && step.state !== 'pending' && (
          <span className="node-step__time">
            {running ? `已 ${duration}` : duration}
          </span>
        )}
      </div>
      <div className="node-step__detail">
        {/* 执行中的行：细节持续变色流动（CSS 动画），静止时全灰 —— 动效只在这里，避免整块闪 */}
        <span className={running ? 'node-step__detail-text is-running' : 'node-step__detail-text'}>{step.detail}</span>
      </div>
      {step.events.length > 0 && (
        <ul className="node-step__events">
          {step.events.map((event, index) => (
            <li key={`${String(index)}-${event}`} className={index === step.events.length - 1 && running ? 'is-latest' : undefined}>
              {event}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function NodeBootstrapProgressPanel({
  job,
  compact = false,
}: {
  job: NodeBootstrapJob
  /** 表格展开态里空间有限：收起"跳过"的行 */
  compact?: boolean
}) {
  const running = job.status === 'running'
  const now = useTicker(running)
  const active = activeStepKey(job)
  const summary = jobSummary(job)
  const steps = compact ? job.steps.filter((step) => step.state !== 'skipped') : job.steps

  return (
    <div className="node-job" data-testid={`node-job-${job.jobId}`}>
      <div className="node-job__head">
        <Tag color={running ? 'processing' : jobProgressStatus(job) === 'success' ? 'green' : 'orange'}>
          {JOB_STATUS_LABELS[job.status]}
        </Tag>
        <Typography.Text strong>{jobHeadline(job)}</Typography.Text>
        <span className="node-job__meta">
          {job.completed}/{job.total} 步
          {summary.failed > 0 ? ` · ${String(summary.failed)} 项失败` : ''}
          {!running && summary.skipped > 0 ? ` · ${String(summary.skipped)} 项本来就绪` : ''}
        </span>
        <Tooltip title="任务由后端执行并记录在实例上：换页面 / 换实例查看都能接着看到进度">
          <span className="node-job__meta node-job__meta--dim">{job.jobId}</span>
        </Tooltip>
      </div>

      <Progress
        percent={job.percent}
        size="small"
        status={jobProgressStatus(job)}
        showInfo
        // 最后一步（重新自检）在跑时百分比会停在 ~93% —— 这是真的，不是卡住
        format={(percent) => `${String(percent ?? 0)}%`}
      />

      <Collapse
        ghost
        size="small"
        // 执行中默认展开：用户是在等它，步骤必须直接可见
        defaultActiveKey={running ? ['steps'] : []}
        items={[
          {
            key: 'steps',
            label: (
              <Space size={6}>
                <CaretRightOutlined />
                <span>步骤详情</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  （{compact ? '隐藏已就绪项' : '执行顺序：检查 → 修复 → 复检'}）
                </Typography.Text>
              </Space>
            ),
            children: (
              <div className="node-steps">
                {steps.map((step) => (
                  <StepRow key={step.key} step={step} active={step.key === active} now={now} />
                ))}
              </div>
            ),
          },
        ]}
      />

      {running && (
        <div className="node-job__hint">
          可以离开本页：初始化在实例上继续执行，回来时会自动显示最新进度。
        </div>
      )}

      {!running && job.error !== undefined && job.error !== '' && (
        <Alert style={{ marginTop: 8 }} type="error" showIcon message="初始化失败" description={job.error} />
      )}

      {!running && job.report !== undefined && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          结束后复检：{job.report.ready ? '全部必需项就绪' : `仍有未就绪：${job.report.items
            .filter((item) => item.required && !item.ok)
            .map((item) => item.label)
            .join('、')}`}
        </Typography.Text>
      )}
    </div>
  )
}

// 保留导出：终端/验收档里用得上步骤图标
export { stepIcon }
