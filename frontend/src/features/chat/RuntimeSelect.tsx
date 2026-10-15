/**
 * 会话运行时选择器（P1-17a）—— **工作区头部**的一个小控件（Code 会话内）。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2；**2026-10-14 用户定案 B**：
 *   · 已就绪的运行时由后端**探测本机镜像**得到（有就提供）；
 *   · 用户选了本机没有的组合 ⇒ **后端按需 `docker build`**。
 *
 * ★ 2026-10-14 修订：构建是**长任务** —— 启动拿 `buildId`、**轮询进度**（进度条 + 阶段文案）、
 *   **可取消**。见 `api/sandbox.ts` 与后端 `sandbox/runtimeBuild.ts`。
 *
 * ★ **2026-10-15 修订（用户定案）：不再枚举版本** —— 弹窗只列**语言**，勾选语言后在后面的**输入框填版本号**
 *   （带常见版本候选）；组合规范化与后端/构建侧共用 `@doubulea/shared` 的纯函数。
 *
 * ⚠️ 选运行时 = **建容器时用哪份镜像**（`ensureSandbox`），**下次派活生效**；镜像是**构建期预烘焙**，
 *    不是运行期"装/合并"；**依赖**才在容器里运行期拉（P1-17b）。
 */

import { PlusOutlined } from '@ant-design/icons'
import { AutoComplete, Button, Checkbox, Modal, Progress, Select, Space, Tag, Tooltip, Typography, message } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { sandboxVariantIdFromSelection, sandboxVariantLabel } from '@doubulea/shared'
import type { SandboxBuildJob, SandboxRuntimeSelection } from '@doubulea/shared'

import {
  cancelSandboxBuildJob,
  fetchSandboxBuildJob,
  sandboxRuntimesQueryKey,
  startSandboxBuild,
  useSandboxRuntimes,
} from '../../api/sandbox.js'

/** 构建任务查询 key（按 `buildId`） */
const buildJobQueryKey = (buildId: string | null) => ['sandbox-build-job', buildId] as const

export interface RuntimeSelectProps {
  /** 当前会话的运行时变体 id（自由字符串） */
  runtime: string
  pending: boolean
  /**
   * 选中一个运行时。`ready` = 该组合本机**已有**运行时镜像（`true`），
   * 还是**需要先构建**（`false`，本机暂无此镜像）。调用方据此区分提示文案。
   */
  onSelect: (runtime: string, ready: boolean) => void
}

export function RuntimeSelect({ runtime, pending, onSelect }: RuntimeSelectProps) {
  const query = useSandboxRuntimes()
  const queryClient = useQueryClient()
  const [pickerOpen, setPickerOpen] = useState(false)
  /** 勾选了哪些语言（`language → true/false`） */
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  /** 各语言输入框里的版本（未填时回退到该语言的默认版本） */
  const [versions, setVersions] = useState<Record<string, string>>({})
  /** 正在构建的任务 id；`null` = 没有正在构建的任务 */
  const [buildId, setBuildId] = useState<string | null>(null)
  /** 已启动构建的目标变体（用于"构建完成自动选用"与标题展示） */
  const [buildingVariant, setBuildingVariant] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [canceling, setCanceling] = useState(false)

  const data = query.data
  const runtimes = data?.runtimes ?? []
  const languages = data?.languages ?? []
  const canBuild = data?.canBuild === true

  const options = useMemo(() => {
    // 「空环境」恒为第一项：只带基础工具链、不额外装语言运行时（= 用户不选时的默认）
    const base = [{ value: '', label: '空环境（仅基础工具链）' }, ...runtimes.map((item) => ({ value: item.id, label: item.label }))]
    // 当前值可能不在探测结果里（老会话 / 镜像被删）⇒ 补一项，否则 antd 显示成一个光秃秃的 id
    if (runtime !== '' && !runtimes.some((item) => item.id === runtime)) {
      base.push({ value: runtime, label: `${sandboxVariantLabel(runtime)}（无环境镜像）` })
    }
    return base
  }, [runtimes, runtime])

  // 勾选的语言 + 填写的版本 → 选择项（未填版本回退到该语言默认版本；空版本忽略）
  const selection: SandboxRuntimeSelection[] = useMemo(
    () =>
      languages
        .filter((lang) => checked[lang.language] === true)
        .map((lang) => ({ language: lang.language, version: (versions[lang.language] ?? lang.defaultVersion).trim() }))
        .filter((sel) => sel.version !== ''),
    [languages, checked, versions],
  )
  const pickedVariant = sandboxVariantIdFromSelection(selection)

  const resetPicker = (): void => {
    setChecked({})
    setVersions({})
  }

  /**
   * 构建任务状态轮询：**只在有活动任务时**开启（`buildId !== null`），终态后自动停。
   * `refetchInterval` 返回 `false` 会让 react-query 停止轮询（成功/失败/取消都是终态）。
   */
  const jobQuery = useQuery({
    queryKey: buildJobQueryKey(buildId),
    queryFn: () => fetchSandboxBuildJob(buildId as string),
    enabled: buildId !== null,
    refetchInterval: (q) => {
      const status = q.state.data?.status
      return status === undefined || status === 'running' ? 1500 : false
    },
  })
  const job: SandboxBuildJob | undefined = jobQuery.data

  // 终态收口：成功 ⇒ 刷新列表 + 选用 + 关弹窗；失败/取消 ⇒ 提示（弹窗留在原地允许重试）
  useEffect(() => {
    if (job === undefined) return
    if (job.status === 'succeeded') {
      const variant = job.variant
      message.success(`运行时已就绪：${job.label}`)
      void queryClient.invalidateQueries({ queryKey: sandboxRuntimesQueryKey })
      setPickerOpen(false)
      resetPicker()
      setBuildId(null)
      setBuildingVariant(null)
      // 刚构建完 ⇒ 这份组合现在**已就绪**（ready=true）
      onSelect(variant, true)
    } else if (job.status === 'failed') {
      message.error(`构建失败：${job.error ?? '未知错误'}`)
      setBuildId(null)
      setBuildingVariant(null)
    } else if (job.status === 'canceled') {
      message.info('已取消构建')
      setBuildId(null)
      setBuildingVariant(null)
    }
  }, [job, onSelect, queryClient])

  const doBuild = (): void => {
    if (selection.length === 0 || starting) return
    setStarting(true)
    startSandboxBuild(selection)
      .then((started) => {
        // 已就绪直接命中 ⇒ 后端回的也是 `succeeded`（这里同样走终态收口去选用 + 刷新）
        setBuildingVariant(started.variant)
        setBuildId(started.buildId)
      })
      .catch((error: unknown) => {
        message.error(`构建启动失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => setStarting(false))
  }

  const doCancel = (): void => {
    if (buildId === null || canceling) return
    setCanceling(true)
    cancelSandboxBuildJob(buildId)
      .catch((error: unknown) =>
        message.error(`取消失败：${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => setCanceling(false))
  }

  const building = buildId !== null
  const progressPercent = Math.round((job?.progress ?? 0) * 100)

  return (
    <Space size={4}>
      <Select
        size="small"
        className="ws__runtime-select"
        value={runtime}
        loading={query.isLoading || pending}
        disabled={pending}
        // 空串 = 空环境（基础工具链），恒可用 ⇒ ready=true；其余看是否在本机已就绪列表里
        onChange={(value: string) => onSelect(value, value === '' || runtimes.some((item) => item.id === value))}
        options={options}
        placeholder={runtimes.length === 0 ? '选择环境（暂无环境镜像）' : undefined}
        title="会话运行时：建容器（派活）时用哪份镜像。只装运行时、不装依赖；依赖运行期安装。下次派活生效"
      />
      {canBuild ? (
        <Tooltip title={runtimes.length === 0 ? '还没有环境镜像？点这里勾语言填版本，后端按需构建' : '组合本机还没有？勾语言填版本，后端按需构建（首次较慢，之后命中缓存）'}>
          <Button size="small" icon={<PlusOutlined />} onClick={() => setPickerOpen(true)} />
        </Tooltip>
      ) : null}
      {runtimes.length === 0 && !canBuild ? (
        <Tooltip title="本机暂无环境镜像，且当前不可按需构建；请运维先构建运行时镜像">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            去创建环境
          </Typography.Text>
        </Tooltip>
      ) : null}

      <Modal
        title={building ? `构建运行时镜像（${buildingVariant ?? ''}）` : '构建运行时镜像'}
        open={pickerOpen}
        onCancel={() => {
          // 构建中不允许直接关（先取消再关，避免留下"看不见但还在跑"的任务）
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
        width={520}
        footer={
          building
            ? [
                <Button key="cancel-build" danger loading={canceling} onClick={doCancel}>
                  取消构建
                </Button>,
              ]
            : undefined
        }
      >
        {building ? (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {job?.phaseLabel ?? '构建中…'}
            </Typography.Paragraph>
            <Progress percent={progressPercent} status="active" />
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              构建可能需要几分钟（会下载语言运行时）；可点「取消构建」中止。
            </Typography.Paragraph>
            {job !== undefined && job.log !== '' ? (
              <Typography.Paragraph
                style={{ marginTop: 8, marginBottom: 0, maxHeight: 120, overflow: 'auto' }}
                code
              >
                {job.log.slice(-1200)}
              </Typography.Paragraph>
            ) : null}
          </>
        ) : (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              勾选这个项目需要的语言，并在后面填版本号；后端会按这份组合构建运行时镜像（本机已有组合则直接命中缓存）。
              <br />
              ⚠️ 版本由镜像**构建期**固定；**依赖**在运行期安装（不在这一步）。
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
                      // 首次勾选时把输入框预填成该语言的默认版本（之后不再覆盖用户输入）
                      setVersions((prev) => (prev[lang.language] === undefined ? { ...prev, [lang.language]: lang.defaultVersion } : prev))
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
    </Space>
  )
}
