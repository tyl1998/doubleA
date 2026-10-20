/**
 * 会话运行环境选择器（P1-17a × P1-14 多机）—— 工作区头部一个**按钮**，点开是**按实例列出环境的弹窗**。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2（有就提供、没有就按需构建）、
 *      `docs/子方案/沙箱多机部署.md` §八 4（实例能力来自心跳）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么改成"一个按钮 + 弹窗"（2026-10-19 用户反馈）
 * ─────────────────────────────────────────────────────────────────────
 * 旧形态在头部并排放了**两个**下拉（"在哪台实例" + "哪个运行时"），用户要先理解"实例"和"环境"
 * 是两个正交维度 —— 但产品语义上它们其实是一件事：**"这个会话在哪台机器、以什么环境跑"**。
 * 现在收成一个入口，弹窗里**以实例为第一层**：
 *   · 顶部：自动（按负载选择）—— 不选实例时的默认；
 *   · 下面：每台在线实例一张卡（繁忙度、地址、已有的环境标签）；
 *   · 卡片里的环境点一下就"选它"；**没有要的环境** ⇒ 卡片内提供"构建该环境"（需要那台能构建）。
 * 选择的结果仍是两个值（实例 + 运行时），由调用方落到 `POST /:id/instance` 与 `POST /:id/runtime`。
 *
 * ⚠️ 构建是**长任务**：启动拿 `buildId`、轮询进度（路径里带实例 id，任务只存在于那台），可取消。
 * ⚠️ 选中运行时 = **建容器时用哪份镜像**，下次派活生效；依赖在运行期装（P1-17b）。
 */

import { CloudServerOutlined, PlusOutlined } from '@ant-design/icons'
import { AutoComplete, Button, Checkbox, Modal, Progress, Radio, Tag, Tooltip, Typography, message } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { sandboxVariantIdFromSelection, sandboxVariantLabel } from '@doubulea/shared'
import type { SandboxBuildJob, SandboxInstanceRuntimeItem, SandboxRuntimeSelection } from '@doubulea/shared'

import {
  cancelSandboxBuildJob,
  fetchSandboxBuildJob,
  sandboxRuntimesQueryKey,
  startSandboxBuild,
  useSandboxRuntimes,
} from '../../api/sandbox.js'

/** 构建任务查询 key（按 `buildId`） */
const buildJobQueryKey = (buildId: string | null) => ['sandbox-build-job', buildId] as const

/** 繁忙度：槽位占用率 → 文案（没有负载快照 ⇒ "繁忙度未知"，不假装 0%） */
function busyText(item: SandboxInstanceRuntimeItem): string {
  const load = item.load
  if (load === null) return '繁忙度未知'
  if (load.slotsTotal <= 0) return '繁忙度未知'
  const ratio = Math.round((load.slotsUsed / load.slotsTotal) * 100)
  const queue = load.queueDepth > 0 ? `，排队 ${load.queueDepth}` : ''
  return `占用 ${load.slotsUsed}/${load.slotsTotal}（${ratio}%）${queue}`
}

export interface RuntimeSelectProps {
  /** 当前会话的运行时变体 id（自由字符串；空串 = 空环境） */
  runtime: string
  pending: boolean
  /**
   * 选中运行时的回调。`ready` = 所选实例上**已有**该环境镜像（`true`）/ 没有（`false`，需构建）。
   * ⚠️ 调用方拿到的是"目标实例 + 运行时"的意图，落点与运行时由它分别下发。
   */
  onSelect: (runtime: string, ready: boolean) => void
  /** 用户点名的实例（`null` = 自动） */
  preferredInstance?: string | null
  onPreferredInstanceChange?: (instanceId: string | null) => void
}

export function RuntimeSelect({
  runtime,
  pending,
  onSelect,
  preferredInstance = null,
  onPreferredInstanceChange,
}: RuntimeSelectProps) {
  const query = useSandboxRuntimes()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  /** 弹窗里**尚未提交**的实例选择（确认时才下发；`null` = 自动） */
  const [draftInstance, setDraftInstance] = useState<string | null>(preferredInstance)
  /** 正在构建的目标实例（决定构建上下文来自哪张卡） */
  const [buildTarget, setBuildTarget] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [versions, setVersions] = useState<Record<string, string>>({})
  const [buildId, setBuildId] = useState<string | null>(null)
  const [buildingVariant, setBuildingVariant] = useState<string | null>(null)
  const [buildInstanceId, setBuildInstanceId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [canceling, setCanceling] = useState(false)

  const data = query.data
  const instances = data?.instances ?? []
  const languages = data?.languages ?? []
  /**
   * **自动** 卡下的环境并集（P1-14 × P1-17a）：同一 id 只出现一次，并列出"哪几台有它"。
   * `buildable` = 没有任何实例具备该环境的 id 时，由用户在自动卡里点「构建新环境」——
   * 后端会挑一台 `canBuild` 的实例去构建（见 `POST /:id/instance` 的自动分支）。
   */
  const union = useMemo(() => {
    const map = new Map<string, { id: string; label: string; instances: string[] }>()
    for (const item of instances) {
      for (const entry of item.runtimes) {
        const found = map.get(entry.id)
        if (found === undefined) map.set(entry.id, { id: entry.id, label: entry.label, instances: [item.instanceId] })
        else if (!found.instances.includes(item.instanceId)) found.instances.push(item.instanceId)
      }
    }
    return [...map.values()].sort((left, right) => left.id.localeCompare(right.id))
  }, [instances])
  const autoBuildable = instances.find((item) => item.canBuild)?.instanceId ?? null
  const selected = instances.find((item) => item.instanceId === preferredInstance)

  useEffect(() => {
    if (open) setDraftInstance(preferredInstance)
  }, [open, preferredInstance])

  const jobQuery = useQuery({
    queryKey: buildJobQueryKey(buildId),
    // 任务只存在于**发起它的那台**：轮询路径里带上实例 id，网关据此点名路由
    queryFn: () => fetchSandboxBuildJob(buildId as string, buildInstanceId),
    enabled: buildId !== null,
    refetchInterval: (q) => {
      const status = q.state.data?.status
      return status === undefined || status === 'running' ? 1500 : false
    },
  })
  const job: SandboxBuildJob | undefined = jobQuery.data

  const resetPicker = (): void => {
    setChecked({})
    setVersions({})
  }

  // 终态收口：成功 ⇒ 刷新列表 + 选用（落点=构建的实例）+ 关弹窗；失败/取消 ⇒ 提示
  useEffect(() => {
    if (job === undefined) return
    if (job.status === 'succeeded') {
      message.success(`运行时已就绪：${job.label}（实例 ${job.instanceId ?? '未知'}）`)
      void queryClient.invalidateQueries({ queryKey: sandboxRuntimesQueryKey })
      setPickerOpen(false)
      resetPicker()
      setBuildId(null)
      setBuildingVariant(null)
      setBuildInstanceId(null)
      setBuildTarget(null)
      onPreferredInstanceChange?.(job.instanceId)
      onSelect(job.variant, true)
    } else if (job.status === 'failed') {
      message.error(`构建失败${job.instanceId === null ? '' : `（实例 ${job.instanceId}）`}：${job.error ?? '未知错误'}`)
      setBuildId(null)
      setBuildingVariant(null)
      setBuildInstanceId(null)
    } else if (job.status === 'canceled') {
      message.info('已取消构建')
      setBuildId(null)
      setBuildingVariant(null)
      setBuildInstanceId(null)
    }
  }, [job, onSelect, onPreferredInstanceChange, queryClient])

  const selection: SandboxRuntimeSelection[] = useMemo(
    () =>
      languages
        .filter((lang) => checked[lang.language] === true)
        .map((lang) => ({ language: lang.language, version: (versions[lang.language] ?? lang.defaultVersion).trim() }))
        .filter((sel) => sel.version !== ''),
    [languages, checked, versions],
  )
  const pickedVariant = sandboxVariantIdFromSelection(selection)

  const doBuild = (): void => {
    if (selection.length === 0 || starting || buildTarget === null) return
    setStarting(true)
    startSandboxBuild(selection, buildTarget)
      .then((started) => {
        setBuildingVariant(started.variant)
        setBuildInstanceId(started.instanceId)
        setBuildId(started.buildId)
        if (started.instanceId !== null && started.instanceId !== buildTarget && started.status === 'failed') {
          message.warning(`构建请求落到了实例 ${started.instanceId}，不是所选实例 ${buildTarget}，请重试`)
        }
      })
      .catch((error: unknown) => {
        message.error(`构建启动失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => setStarting(false))
  }

  const doCancel = (): void => {
    if (buildId === null || canceling) return
    setCanceling(true)
    cancelSandboxBuildJob(buildId, buildInstanceId)
      .catch((error: unknown) => message.error(`取消失败：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setCanceling(false))
  }

  const building = buildId !== null
  const progressPercent = Math.round((job?.progress ?? 0) * 100)

  const openBuild = (instanceId: string): void => {
    setBuildTarget(instanceId)
    resetPicker()
    setPickerOpen(true)
  }

  const confirm = (): void => {
    setOpen(false)
    // 实例变化 → 先下发落点（后端可能 409：已被钉在别台 / 离线 / 缺能力，文案由它给）
    if (draftInstance !== preferredInstance) onPreferredInstanceChange?.(draftInstance)
  }

  /** 按钮上显示"在哪台 · 什么环境"（没有选择时是"自动"） */
  const summary = `${preferredInstance ?? '自动'}`
  const envLabel = runtime === '' ? '空环境' : sandboxVariantLabel(runtime)
  /**
   * 点名了实例，但它不在 `instances` 里（未就绪被后端滤掉 / 已离线）：
   * 这时弹窗里没有任何一张卡是选中的，用户会以为"选择丢了"—— 如实说出来。
   */
  const missingInstance = preferredInstance !== null && selected === undefined

  return (
    <>
      <Tooltip title="选择这个会话在哪台实例上跑、用哪个环境（下次派活生效）">
        <Button size="small" icon={<CloudServerOutlined />} loading={pending} onClick={() => setOpen(true)}>
          {summary} · {envLabel}
        </Button>
      </Tooltip>

      {/* ── ① 选实例 + 选环境（按实例列卡片）────────────────────────────── */}
      <Modal
        title="运行位置与环境"
        open={open}
        width={640}
        onCancel={() => setOpen(false)}
        onOk={confirm}
        okText="确定"
        okButtonProps={{ loading: pending }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          会话的容器与 Code 工作区都在**选定实例**上；不选实例则由网关按负载自动选择。
          {selected === undefined || selected.known ? null : ' 该实例尚未上报环境能力，显示可能不全。'}
        </Typography.Paragraph>
        {missingInstance ? (
          <Typography.Paragraph type="warning" style={{ marginBottom: 8 }}>
            这条会话在实例 <strong>{preferredInstance}</strong> 上，但它此刻不在可选列表里（未就绪或已离线）。
            派活会失败，请等它就绪，或在本会话回收后选择别的实例。
          </Typography.Paragraph>
        ) : null}
        <Radio.Group
          value={draftInstance ?? ''}
          onChange={(event) => setDraftInstance(event.target.value === '' ? null : String(event.target.value))}
          style={{ display: 'block' }}
        >
          <div className="ws-env-list">
            <div
              className={`ws-env-card ws-env-card--auto${draftInstance === null ? ' is-selected' : ''}`}
              data-testid="ws-env-auto"
              onClick={() => setDraftInstance(null)}
            >
              <Radio value="" />
              <div className="ws-env-card__body">
                <div className="ws-env-card__title">自动（按负载选择实例）</div>
                <div className="ws-env-card__meta">
                  不钉机：按所选环境挑一台**具备它**（或能构建它）的实例；以下环境取自所有在线实例的并集
                </div>
                <div className="ws-env-card__envs">
                  <Tag
                    color={runtime === '' ? 'blue' : undefined}
                    style={{ cursor: 'pointer' }}
                    onClick={(event) => {
                      event.stopPropagation()
                      setDraftInstance(null)
                      onSelect('', true)
                    }}
                  >
                    空环境（仅基础工具链）
                  </Tag>
                  {union.map((entry) => (
                    <Tooltip key={entry.id} title={`可用实例：${entry.instances.join('、')}`}>
                      <Tag
                        color={runtime === entry.id ? 'blue' : undefined}
                        style={{ cursor: 'pointer' }}
                        onClick={(event) => {
                          event.stopPropagation()
                          setDraftInstance(null)
                          onSelect(entry.id, true)
                        }}
                      >
                        {entry.label}
                        {entry.instances.length > 1 ? ` ×${entry.instances.length}` : ''}
                      </Tag>
                    </Tooltip>
                  ))}
                  {union.length === 0 && instances.length > 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      所有实例都只有空环境
                    </Typography.Text>
                  ) : null}
                  <Tooltip
                    title={
                      autoBuildable === null
                        ? '当前没有能按需构建的实例'
                        : `将自动选一台可构建的实例（优先较空闲）并切换到它：${autoBuildable}`
                    }
                  >
                    <Button
                      size="small"
                      type="link"
                      icon={<PlusOutlined />}
                      disabled={autoBuildable === null}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (autoBuildable !== null) openBuild(autoBuildable)
                      }}
                    >
                      构建新环境
                    </Button>
                  </Tooltip>
                </div>
                {runtime !== '' && !union.some((entry) => entry.id === runtime) ? (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    当前没有实例具备「{envLabel}」：可点「构建新环境」自动选一台可构建的实例
                  </Typography.Text>
                ) : null}
              </div>
            </div>
            {instances.map((item) => {
              const has = item.runtimes.some((entry) => entry.id === runtime)
              // ★ 未就绪（节点自检失败）的实例**可见但不可选**：后端已把它从列表里滤掉，
              //   这里再挡一次只为兜住缓存里的旧数据（选择器不应该给出一个"能用但其实用不了"的选项）
              const unavailable = item.ready === false
              return (
                <div
                  key={item.instanceId}
                  className={`ws-env-card${draftInstance === item.instanceId ? ' is-selected' : ''}${unavailable ? ' is-disabled' : ''}`}
                  data-testid={`ws-env-instance-${item.instanceId}`}
                >
                  <Radio value={item.instanceId} disabled={unavailable} />
                  <div className="ws-env-card__body">
                    <div className="ws-env-card__title">
                      实例 {item.instanceId}
                      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                        {item.advertiseAddr}
                      </Typography.Text>
                    </div>
                    <div className="ws-env-card__meta">
                      {unavailable ? `未就绪：${item.missing.join('、') || '节点自检未通过'}（不可选）` : busyText(item)}
                    </div>
                    <div className="ws-env-card__envs">
                      {/* ★ 空环境恒可用（派活时回退 SANDBOX_IMAGE，不依赖任何运行时镜像） */}
                      <Tag
                        color={runtime === '' && draftInstance === item.instanceId ? 'blue' : undefined}
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          setDraftInstance(item.instanceId)
                          onSelect('', true)
                        }}
                      >
                        空环境
                      </Tag>
                      {item.known ? (
                        <>
                          {item.runtimes.length === 0 ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              （无额外运行时）
                            </Typography.Text>
                          ) : null}
                          {item.runtimes.map((entry) => (
                            <Tag
                              key={entry.id}
                              color={runtime === entry.id ? 'blue' : undefined}
                              style={{ cursor: 'pointer' }}
                              onClick={() => {
                                setDraftInstance(item.instanceId)
                                onSelect(entry.id, true)
                              }}
                            >
                              {entry.label}
                            </Tag>
                          ))}
                        </>
                      ) : (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          环境能力未知（该实例未上报）
                        </Typography.Text>
                      )}
                      <Tooltip
                        title={
                          item.canBuild
                            ? '在这台实例上按需构建一个环境（勾选语言 + 版本）'
                            : '该实例不能按需构建（构建上下文不可见）；请在能构建的实例上构建，或运维预先分发镜像'
                        }
                      >
                        <Button
                          size="small"
                          type="link"
                          icon={<PlusOutlined />}
                          disabled={!item.canBuild}
                          onClick={() => openBuild(item.instanceId)}
                        >
                          构建新环境
                        </Button>
                      </Tooltip>
                    </div>
                    {runtime !== '' && item.known && !has && draftInstance === item.instanceId ? (
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        这台没有「{envLabel}」：派活会回退空环境并在日志留 warn；可点「构建新环境」
                      </Typography.Text>
                    ) : null}
                  </div>
                </div>
              )
            })}
            {instances.length === 0 ? (
              <Typography.Text type="secondary">{query.isLoading ? '加载实例中…' : '当前没有在线实例'}</Typography.Text>
            ) : null}
          </div>
        </Radio.Group>
      </Modal>

      {/* ── ② 构建新环境（在指定实例上；长任务 + 进度 + 可取消）────────────── */}
      <Modal
        title={
          building
            ? `在实例 ${job?.instanceId ?? buildInstanceId ?? '（未知）'} 上构建运行时镜像（${buildingVariant ?? ''}）`
            : `构建运行时镜像（实例：${buildTarget ?? '未选择'}）`
        }
        open={pickerOpen}
        width={520}
        onCancel={() => {
          if (building) return
          setPickerOpen(false)
        }}
        onOk={doBuild}
        okText={starting ? '启动中…' : '构建并选用'}
        okButtonProps={{ disabled: selection.length === 0 || starting || building }}
        cancelButtonProps={{ disabled: building }}
        confirmLoading={starting}
        maskClosable={!building}
        closable={!building}
        footer={building ? [<Button key="cancel-build" danger loading={canceling} onClick={doCancel}>取消构建</Button>] : undefined}
      >
        {building ? (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              构建实例：<Tag color="blue">{job?.instanceId ?? buildInstanceId ?? '（未知）'}</Tag>
              {buildTarget !== null && job?.instanceId !== null && job?.instanceId !== undefined && job.instanceId !== buildTarget ? (
                <Tag color="orange">与所选实例 {buildTarget} 不一致</Tag>
              ) : null}
              {job?.phaseLabel ?? '构建中…'}
            </Typography.Paragraph>
            <Progress percent={progressPercent} status="active" />
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              构建可能需要几分钟（会下载语言运行时）；可点「取消构建」中止。
            </Typography.Paragraph>
            {job !== undefined && job.log !== '' ? (
              <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0, maxHeight: 120, overflow: 'auto' }} code>
                {job.log.slice(-1200)}
              </Typography.Paragraph>
            ) : null}
          </>
        ) : (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              构建将在实例 <Tag color="blue">{buildTarget ?? '未选择'}</Tag> 上执行；勾选需要的语言并填版本号
              （该组合在那台已有镜像则直接命中缓存）。⚠️ 版本构建期固定，**依赖**在运行期安装。
            </Typography.Paragraph>
            {languages.map((lang) => {
              const on = checked[lang.language] === true
              return (
                <div key={lang.language} style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Checkbox
                    style={{ minWidth: 92 }}
                    checked={on}
                    onChange={(event) => {
                      const next = event.target.checked
                      setChecked((prev) => ({ ...prev, [lang.language]: next }))
                      setVersions((prev) =>
                        prev[lang.language] === undefined ? { ...prev, [lang.language]: lang.defaultVersion } : prev,
                      )
                    }}
                  >
                    {lang.label}
                  </Checkbox>
                  {on ? (
                    <AutoComplete
                      size="small"
                      style={{ width: 160 }}
                      value={versions[lang.language] ?? lang.defaultVersion}
                      options={lang.suggestions.map((value) => ({ value }))}
                      placeholder={lang.hint}
                      onChange={(value: string) => setVersions((prev) => ({ ...prev, [lang.language]: value }))}
                    />
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {lang.hint}
                      {lang.baseVersion !== null ? `（自带 ${lang.baseVersion}）` : ''}
                    </Typography.Text>
                  )}
                </div>
              )
            })}
            <div style={{ marginTop: 12 }}>
              将构建：<Tag color="blue">{sandboxVariantLabel(pickedVariant)}</Tag>
              {selection.length === 0 ? <Typography.Text type="secondary">（还没选语言）</Typography.Text> : null}
            </div>
          </>
        )}
      </Modal>
    </>
  )
}
