/**
 * Skill 草稿审核（P1-24c；2026-11-17 重做布局）
 *
 * 用户反馈旧审核弹层「信息密集的没法看」。本组件把审核拆成两栏：
 *   · 左：文件树（`SKILL.md` + 基准版本文件 + 草稿新增/替换文件），改动文件打「新增 / 修改」标记；
 *   · 右：选中文件的**对比 / 内容 / 编辑**（`SKILL.md` 可编辑正文，其它文本文件可替换、移除）。
 *
 * 元数据、脱敏复核、变更说明、影响范围等低频信息收进「设置」页签，默认不占屏。
 *
 * ⚠️ 保存 / 自动保存 / 心跳 / 脱敏闸门的语义**逐字沿用**旧 `SkillDraftEditor`：
 * 这些都是审核草稿的生命线，不能因为换布局而改变。深链 `/skills/drafts/:draftId`
 * 与聊天侧宽版 Drawer 共用本组件。
 */

import { UploadOutlined } from '@ant-design/icons'
import {
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_ENTRY_PATH,
  SKILL_NAME_MAX_CHARS,
  SKILL_REDACTION_MASK,
  computeSkillLineChanges,
  detectSkillRevisionRisks,
  isLikelyScriptPath,
  scanSkillSecrets,
  type MessageKey,
  type SkillDraft,
  type SkillRedactionKind,
  type SkillRevisionTarget,
} from '@doubulea/shared'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Checkbox, Empty, Input, Modal, Tag, Upload } from 'antd'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { ApiError, request } from '../../api/client.js'
import { useMyConversations } from '../../api/conversations.js'
import { skillQueryKey, useSkill } from '../../api/skills.js'
import { useSkillRevisionTargets } from '../../api/skillExtract.js'
import { useSubmitSkillProposal } from '../../api/skillProposals.js'
import {
  useConversationSkillOverrides,
  useCreateConversationSkillOverride,
  useReplaceConversationSkillOverride,
} from '../../api/skillOverrides.js'
import {
  fetchSkillDraftFile,
  useDeleteSkillDraft,
  useRemoveSkillDraftFile,
  useRenameSkillDraftPath,
  useSaveSkillFromDraft,
  useSaveSkillRevisionFromDraft,
  useSkillDraft,
  useUpdateSkillDraft,
  useUploadSkillDraftFile,
  useWriteSkillDraftFileContent,
} from '../../api/skillDrafts.js'
import { usePageCrumb } from '../../app/crumbContext.js'
import { useFeedback } from '../../app/feedback.js'
import { formatBytes } from '../../app/format.js'
import { useT } from '../../app/i18n.js'
import { SKILL_DRAFTS_PATH, SKILLS_PATH, skillDetailPath } from '../../app/paths.js'
import { MarkdownPreview } from '../../components/ArtifactPreview/MarkdownPreview.js'
import { isMarkdownMime } from '../../components/ArtifactPreview/artifactPreview.js'
import { ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { SkillFileTree } from '../../pages/skills/SkillFileTree.js'
import { SkillBadge } from '../../pages/skills/skillModel.js'
import {
  binsOf,
  buildReviewFiles,
  draftFormDiffers,
  draftFormOf,
  readSkillMarkdown,
  readSkillTextFile,
  type SkillDraftForm,
  type SkillReviewFile,
} from './skillDraftReviewModel.js'

/** 自动保存防抖（毫秒）与心跳（毫秒）—— 心跳必须明显小于服务端 TTL（1h） */
const AUTOSAVE_DEBOUNCE_MS = 800
const KEEPALIVE_MS = 60_000

const REDACTION_KEY: Readonly<Record<SkillRedactionKind, MessageKey>> = {
  credential: 'skillDraft.redactionCredential',
  url: 'skillDraft.redactionUrl',
  email: 'skillDraft.redactionEmail',
  id: 'skillDraft.redactionId',
}

type ReviewTab = 'files' | 'settings'
type FileViewMode = 'DIFF' | 'CONTENT' | 'EDIT'

function kindLabelKey(kind: SkillDraft['kind']): MessageKey {
  return kind === 'REVISION'
    ? 'skillDraft.kindRevision'
    : kind === 'SESSION_OVERRIDE'
      ? 'skillDraft.kindSessionOverride'
      : kind === 'CREATE'
        ? 'skillDraft.kindCreate'
        : 'skillDraftList.kindProposal'
}

function saveLabelKey(kind: SkillDraft['kind']): MessageKey {
  if (kind === 'REVISION') return 'skillDraft.saveRevision'
  if (kind === 'SESSION_OVERRIDE') return 'skillOverride.save'
  if (kind === 'PROPOSAL') return 'skillDraft.submitProposal'
  return 'skillDraft.saveCreate'
}

function statusLabelKey(status: SkillReviewFile['status']): MessageKey {
  if (status === 'ADDED') return 'skillDraft.statusAdded'
  if (status === 'REMOVED') return 'skillDraft.statusRemoved'
  if (status === 'RENAMED') return 'skillDraft.statusRenamed'
  if (status === 'MODIFIED') return 'skillDraft.statusModified'
  return 'skillDraft.statusUnchanged'
}

/** 状态标签颜色（`REMOVED` 用红色） */
function statusColor(status: SkillReviewFile['status']): string | undefined {
  if (status === 'ADDED' || status === 'RENAMED') return 'green'
  if (status === 'MODIFIED') return 'orange'
  if (status === 'REMOVED') return 'red'
  return undefined
}

export interface SkillDraftReviewProps {
  draftId: string
  /** `true` = 弹层里渲染（不上报面包屑；保存 / 丢弃后交给 `onDone`） */
  embedded?: boolean
  onDone?: (skillId: string) => void
}

export function SkillDraftReview({ draftId, embedded = false, onDone }: SkillDraftReviewProps) {
  const { t } = useT()
  const feedback = useFeedback()
  const navigate = useNavigate()

  const draftQuery = useSkillDraft(draftId)
  const updateDraft = useUpdateSkillDraft(draftId)
  const deleteDraft = useDeleteSkillDraft()
  const uploadFile = useUploadSkillDraftFile(draftId)
  const removeFile = useRemoveSkillDraftFile(draftId)
  const renamePath = useRenameSkillDraftPath(draftId)
  const writeFileContent = useWriteSkillDraftFileContent(draftId)
  const saveNew = useSaveSkillFromDraft()
  const saveRevision = useSaveSkillRevisionFromDraft(draftQuery.data?.targetSkillId ?? '')
  const submitProposal = useSubmitSkillProposal(draftQuery.data?.targetSkillId ?? '')
  const overrideConversationId = draftQuery.data?.overrideConversationId ?? undefined
  const createOverride = useCreateConversationSkillOverride(overrideConversationId ?? '')
  const replaceOverride = useReplaceConversationSkillOverride(overrideConversationId ?? '')
  const overridesQuery = useConversationSkillOverrides(
    draftQuery.data?.kind === 'SESSION_OVERRIDE' ? overrideConversationId : undefined,
  )

  const draft = draftQuery.data
  const isTargeted =
    draft?.kind === 'REVISION' || draft?.kind === 'SESSION_OVERRIDE' || draft?.kind === 'PROPOSAL'
  const submission = draft?.submission ?? null
  /** 已提交审核 / 已通过 / 已撤回的提案草稿只读；被打回（NEEDS_REBASE）后恢复可编辑 */
  const submissionLocked =
    submission !== null && (submission.status === 'PENDING' || submission.status === 'ACCEPTED')
  const submissionReturned =
    submission !== null && (submission.status === 'NEEDS_REBASE' || submission.status === 'REJECTED')
  
  usePageCrumb(embedded ? undefined : draft === undefined ? t('skillDraft.crumbFallback') : draft.name)

  const [form, setForm] = useState<SkillDraftForm | null>(null)
  const [changeSummary, setChangeSummary] = useState('')
  /** 变更说明只在"第一次拿到这份草稿"时预填；之后以用户输入为准（不随自动保存回写覆盖） */
  const summaryPrefilledFor = useRef<string | null>(null)
  /** 变更说明的自动保存基线（与表单的 `baseline` 同一条思路） */
  const summaryBaseline = useRef<string | null>(null)
  const [redactionConfirmed, setRedactionConfirmed] = useState(false)
  const [restored, setRestored] = useState<readonly SkillRedactionKind[]>([])
  const [pinAgent, setPinAgent] = useState(false)
  const [tab, setTab] = useState<ReviewTab>('files')
  const [selectedPath, setSelectedPath] = useState<string>(SKILL_ENTRY_PATH)
  const [replacingPath, setReplacingPath] = useState<string | null>(null)
  const [removingPath, setRemovingPath] = useState<string | null>(null)
  /** P1-24a-7：新建文件 / 文件夹 / 重命名的输入框 */
  const [pathModal, setPathModal] = useState<
    | null
    | { mode: 'CREATE_FILE'; dir: string; value: string }
    | { mode: 'CREATE_DIR'; dir: string; value: string }
    | { mode: 'RENAME'; from: string; kind: 'FILE' | 'DIR'; value: string }
  >(null)

  /** 每次 `PUT` 成功后的基线（避免把用户刚敲的字覆盖成服务端旧值） */
  const baseline = useRef<SkillDraftForm | null>(null)
  /** 哪份草稿已经应用过"沿用上次脱敏确认"（每份只应用一次） */
  const carriedConfirmedFor = useRef<string | null>(null)
  /**
   * P1-24a-7：树工具栏 / 目录行的「上传到此目录」。
   * 用一个**独立的隐藏 file input** 触发系统文件框，然后把文件 multipart 上传到该目录 ——
   * 不用 antd `Upload` 在点击时动态定位目标目录（那个 `beforeUpload` 闭包拿不到"刚点的哪一行"）。
   */
  const filePickerRef = useRef<HTMLInputElement | null>(null)
  const uploadDirRef = useRef<(dir: string) => void>(() => undefined)
  useEffect(() => {
    uploadDirRef.current = (dir: string) => {
      filePickerRef.current?.setAttribute('data-dir', dir)
      filePickerRef.current?.click()
    }
  })

  useEffect(() => {
    if (draftId === '') return
    setTab('files')
    setSelectedPath(SKILL_ENTRY_PATH)
    setRedactionConfirmed(false)
    setRestored([])
    setPinAgent(false)
    carriedConfirmedFor.current = null
  }, [draftId])

  /**
   * 内容原样来自一份**已确认过脱敏**的草稿（从覆写直接提建议 / 按上游重建覆写）⇒ 免一次重复确认。
   * 只应用一次；之后任何编辑都会走 `setField` 把确认关掉。
   */
  useEffect(() => {
    if (draft === undefined || draft.redactionCarried !== true) return
    if (carriedConfirmedFor.current === draft.id) return
    carriedConfirmedFor.current = draft.id
    setRedactionConfirmed(true)
  }, [draft?.id, draft?.redactionCarried])

  useEffect(() => {
    if (draft === undefined) {
      setForm(null)
      baseline.current = null
      return
    }
    // 只在"本地没有未保存改动"时重置表单（否则用户编辑到一半会被服务端的旧副本打回）
    if (form === null || baseline.current === null || !draftFormDiffers(form, baseline.current)) {
      const next = draftFormOf(draft)
      setForm(next)
      baseline.current = next
    }
  }, [draft?.id, draft?.updatedAt])

  /**
   * REVISION 的变更说明预填：抽取时模型写好的那句随草稿落库（c-4），审核页直接用，
   * 用户仍可改。只在首次拿到这份草稿时填一次 —— 之后自动保存刷新 `updatedAt` 不能把用户
   * 正在写的那句覆盖回去。
   */
  useEffect(() => {
    if (
      draft === undefined ||
      (draft.kind !== 'REVISION' && draft.kind !== 'SESSION_OVERRIDE' && draft.kind !== 'PROPOSAL')
    ) {
      return
    }
    if (summaryPrefilledFor.current === draft.id) return
    summaryPrefilledFor.current = draft.id
    summaryBaseline.current = draft.changeSummary
    setChangeSummary(draft.changeSummary)
  }, [draft?.id, draft?.kind, draft?.changeSummary])

  // ── 基准版本（REVISION / SESSION_OVERRIDE） ──
  const baseSkillId = isTargeted && draft?.targetSkillId != null ? draft.targetSkillId : ''
  const targetSkillQuery = useSkill(baseSkillId, { enabled: baseSkillId !== '' })
  const baseSkill = baseSkillId === '' ? null : (targetSkillQuery.data ?? null)
  const baseEntryExists = baseSkill?.files.some((file) => file.path === SKILL_ENTRY_PATH) === true
  const baseMarkdownQuery = useQuery({
    queryKey: [...skillQueryKey(baseSkillId), 'entry', draft?.baseVersion ?? 0] as const,
    queryFn: () => readSkillMarkdown(baseSkillId, draft?.baseVersion ?? undefined),
    enabled: baseSkillId !== '' && baseEntryExists,
    retry: false,
  })
  const baseMarkdown = baseMarkdownQuery.data ?? ''

  // ── 自动保存（800ms 防抖；`markdown` 不参与"未保存提示"的闪烁，但参与保存） ──
  const dirty = form !== null && baseline.current !== null && draftFormDiffers(form, baseline.current)
  const summaryDirty =
    isTargeted && summaryBaseline.current !== null && changeSummary !== summaryBaseline.current
  useEffect(() => {
    if (submissionLocked || form === null || (!dirty && !summaryDirty)) return
    const timer = window.setTimeout(() => {
      updateDraft.mutate(
        {
          name: form.name.trim() === '' ? undefined : form.name,
          description: form.description.trim() === '' ? undefined : form.description,
          runtime: form.runtime,
          markdown: form.markdown,
          requiresBins: binsOf(form.requiresBinsText),
          ...(isTargeted ? { changeSummary } : {}),
        },
        {
          onSuccess: (saved) => {
            baseline.current = draftFormOf(saved)
            summaryBaseline.current = saved.changeSummary
            // 基线变了 ⇒ 重新算 dirty（下一次 effect 会拿到新的 baseline）
            setForm((current) => (current === null ? current : { ...current }))
          },
          // 自动保存失败**不弹全屏通知**：每次键入都弹会把编辑区挡死。页面顶部一直有
          // 「草稿待保存」标记（dirty 在保存成功前不会消失）── 用户看得到"还没存上"，
          // 下一次改动会自动重试，手动保存失败时才会走 `feedback.fail` 给完整原因。
          onError: () => undefined,
        },
      )
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [form, dirty, summaryDirty, changeSummary, isTargeted, submissionLocked])

  // ② 心跳续期（只是开着页面也要续）。
  // ⚠️ **不能**用 `invalidateQueries`：那会触发 GET 并**改写缓存里的草稿**，而本组的表单基线来自
  // 缓存（`useEffect` 在"本地没有未保存改动"时才会重置）⇒ 一次心跳就可能把用户正在敲的内容回滚。
  // 这里直接发一个 `PUT {}`（空改动）：仍然续期 TTL，且缓存与表单都不动。
  useEffect(() => {
    if (draftId === '' || submissionLocked) return
    const timer = window.setInterval(() => {
      void request(`/api/skill-drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', body: {} }).catch(() => {
        // 续期失败不打扰用户：下一次自动保存或重新打开页面会再次续期 / 暴露过期
      })
    }, KEEPALIVE_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [draftId, submissionLocked])

  const scan = useMemo(() => scanSkillSecrets(form?.markdown ?? ''), [form?.markdown])

  /**
   * 影响范围（§10.5 必须展示的一项）：从「更新到 Skill」的候选清单里找这一条
   * （同一份 `GET /api/conversations/:id/skill-targets`，不另开一个"影响范围"端点）。
   */
  const targetsQuery = useSkillRevisionTargets(draft?.source?.conversationId, {
    enabled: draft?.kind === 'REVISION' && baseSkillId !== '',
  })
  const impact = useMemo<SkillRevisionTarget | null>(() => {
    if (baseSkillId === '') return null
    return (targetsQuery.data?.items ?? []).find((item) => item.skillId === baseSkillId) ?? null
  }, [baseSkillId, targetsQuery.data])

  /**
   * 抽取出处（P1-24c-2）：`draft.source` 只给会话 id 与消息条数，**显示名**要到会话列表里找
   * （会话可能已被删 —— 那时显示"来自一个会话"而不是报错）。复用聊天侧栏那份查询，不多打请求。
   */
  const conversationsQuery = useMyConversations()
  const source = useMemo(() => {
    const from = draft?.source ?? null
    if (from === null) return null
    const match = (conversationsQuery.data?.items ?? []).find((item) => item.id === from.conversationId)
    return { topic: match?.topic ?? null, count: from.messageIds.length }
  }, [draft?.source, conversationsQuery.data])

  const revisionRisks = useMemo(() => {
    if (!isTargeted || form === null) return []
    const detected = detectSkillRevisionRisks({
      correctionText: '',
      changeSummary,
      afterMarkdown: form.markdown,
      beforeMarkdown: baseMarkdown,
    })
    return [...new Set([...draft.risks, ...detected])]
  }, [draft?.kind, draft?.risks, changeSummary, form?.markdown, baseMarkdown])

  /** 保存选项 ②（固定当前 Agent 到新版本）：只在"从会话更新"且能定位到会话所属 Agent 时提供 */
  const pinAgentId = useMemo(() => {
    const sourceId = draft?.source?.conversationId
    if (sourceId === undefined) return undefined
    return (conversationsQuery.data?.items ?? []).find((item) => item.id === sourceId)?.agentId
  }, [draft?.source?.conversationId, conversationsQuery.data])
  const canPin = draft?.kind === 'REVISION' && pinAgentId !== undefined

  const credentialHits = scan.redactions.filter((item) => item.kind === 'credential')
  /** 用户「恢复」了某个业务形状 ⇒ 那些种类的命中不再阻止确认（保存时服务端仍会重扫） */
  const pendingRedactions = scan.redactions.filter(
    (item) => item.kind === 'credential' || !restored.includes(item.kind),
  )
  const formValid = form !== null && form.name.trim() !== '' && form.description.trim() !== ''
  const canConfirm = formValid && pendingRedactions.every((item) => item.kind !== 'credential')
  const needsSummary = isTargeted
  const summaryMissing = needsSummary && changeSummary.trim() === ''
  /** 脱敏确认是保存的硬闸门（没有命中也要用户点一次），所以未确认时始终在头部提示入口 */
  const redactionNeedsAttention = !redactionConfirmed
  const canSave =
    !submissionLocked &&
    canConfirm &&
    redactionConfirmed &&
    (!needsSummary || !summaryMissing) &&
    !saveNew.isPending &&
    !saveRevision.isPending &&
    !submitProposal.isPending &&
    !createOverride.isPending &&
    !replaceOverride.isPending

  /** 审核文件清单：`SKILL.md` + 基准文件 + 草稿文件（草稿覆盖同名基准） */
  const reviewFiles = useMemo(() => {
    if (form === null) return []
    return buildReviewFiles({
      markdown: form.markdown,
      baseMarkdown,
      draftFiles: draft?.files ?? [],
      // 提案草稿是整版快照：基准文件不再并入，否则副本里删掉的文件会在审核页被当成"未改动"
      baseFiles: draft?.kind === 'PROPOSAL' ? [] : (baseSkill?.files ?? []),
      isTargeted,
      removedPaths: draft?.removedPaths ?? [],
    })
  }, [form?.markdown, baseMarkdown, draft?.files, draft?.kind, draft?.removedPaths, baseSkill?.files, isTargeted])
  const selectedFile = reviewFiles.find((file) => file.path === selectedPath) ?? reviewFiles[0] ?? null
  const effectivePath = selectedFile?.path ?? null
  const baseReady = !isTargeted || baseSkill !== null || targetSkillQuery.isError

  if (draftQuery.isError) {
    return (
      <ErrorState
        title={t('skillDraft.expiredTitle')}
        error={draftQuery.error}
        retrying={draftQuery.isFetching}
        onRetry={() => {
          void draftQuery.refetch()
        }}
      />
    )
  }
  if (draftQuery.isPending || draft === undefined || form === null) return <TableSkeleton />

  const setField = <K extends keyof SkillDraftForm>(key: K, value: SkillDraftForm[K]): void => {
    setForm((current) => (current === null ? current : { ...current, [key]: value }))
    setRedactionConfirmed(false)
  }

  const submit = (): void => {
    if (!canSave) return
    const onSuccess = (result: {
      skill: { id: string; name: string }
      version: number
      bindError: string | null
      pinError?: string | null
    }): void => {
      if (result.bindError === null) feedback.ok(t('skillDraft.saved', { name: result.skill.name, version: result.version }))
      else feedback.note(t('skillDraft.savedBindFailed', { name: result.skill.name, reason: result.bindError }))
      // pinError 只在"带 pinAgentId 且固定失败"时非空：版本已经保存成功，独立说明
      if (result.pinError !== null && result.pinError !== undefined) {
        feedback.note(t('skillDraft.pinFailed', { reason: result.pinError }))
      } else if (pinAgent && pinAgentId !== undefined) {
        feedback.ok(t('skillDraft.pinnedOk', { version: result.version }))
      }
      if (onDone !== undefined) onDone(result.skill.id)
      else navigate(skillDetailPath(result.skill.id))
    }
    if (draft.kind === 'SESSION_OVERRIDE') {
      const overrideId =
        draft.overrideId ??
        (draft.expectedRevision === null
          ? null
          : (overridesQuery.data?.items ?? []).find((item) => item.skillId === draft.targetSkillId)?.id ?? null)
      const done = (): void => {
        feedback.ok(t('skillOverride.saved', { revision: draft.expectedRevision === null ? 1 : draft.expectedRevision + 1 }))
        if (onDone !== undefined) onDone('')
      }
      if (overrideId === null) {
        createOverride.mutate(draft.id, {
          onSuccess: done,
          onError: (error) => feedback.fail(error, t('skillOverride.saveFailed')),
        })
      } else {
        replaceOverride.mutate(
          { overrideId, draftId: draft.id, expectedRevision: draft.expectedRevision ?? 1 },
          { onSuccess: done, onError: (error) => feedback.fail(error, t('skillOverride.saveFailed')) },
        )
      }
      return
    }
    if (draft.kind === 'PROPOSAL') {
      submitProposal.mutate(
        {
          draftId: draft.id,
          baseVersion: draft.baseVersion ?? 1,
          changeSummary: changeSummary.trim(),
          markdown: form.markdown,
        },
        {
          onSuccess: (proposal) => {
            feedback.ok(t('skillProposal.submitted', { version: proposal.baseVersion }))
            // 提交后草稿仍保留在「我的草稿」并显示审核状态（不再消耗）
            if (onDone !== undefined) onDone(proposal.targetSkillId)
            else navigate(SKILL_DRAFTS_PATH)
          },
          onError: (error) => feedback.fail(error, t('skillProposal.submitFailed')),
        },
      )
      return
    }
    if (draft.kind === 'REVISION') {
      saveRevision.mutate(
        {
          draftId: draft.id,
          fromVersion: draft.baseVersion ?? 1,
          changeSummary: changeSummary.trim(),
          markdown: form.markdown,
          // 保存选项 ②（P1-24c-4）：固定的是**本会话的智能体**（来源会话所属 Agent，服务端校验权限）
          ...(pinAgent && pinAgentId !== undefined ? { pinAgentId } : {}),
        },
        {
          onSuccess,
          onError: (error) => feedback.fail(error, t('skillDraft.saveFailed')),
        },
      )
      return
    }
    saveNew.mutate(
      {
        draftId: draft.id,
        name: form.name.trim(),
        description: form.description.trim(),
        runtime: form.runtime,
        markdown: form.markdown,
      },
      {
        onSuccess,
        onError: (error) => {
          // 409 版本冲突 / 重名：原样把服务端文案端出来（页面不猜原因）
          if (error instanceof ApiError && error.status === 409) {
            feedback.fail(error, t('skillDraft.conflictTitle'))
            return
          }
          feedback.fail(error, t('skillDraft.saveFailed'))
        },
      },
    )
  }

  const discard = (): void => {
    Modal.confirm({
      title: t('skillDraft.discardTitle'),
      content: t('skillDraft.discardDesc'),
      okText: t('skillDraft.discardOk'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () =>
        new Promise<void>((resolve) => {
          deleteDraft.mutate(draft.id, {
            onSuccess: () => {
              feedback.ok(t('skillDraft.discarded'))
              if (onDone !== undefined) onDone('')
              else navigate(SKILLS_PATH)
              resolve()
            },
            onError: (error) => {
              feedback.fail(error, t('skillDraft.discardFailed'))
              resolve()
            },
          })
        }),
    })
  }

  async function replaceDraftFile(path: string, file: File): Promise<void> {
    if (form === null) return
    if (isLikelyScriptPath(path) && form.runtime !== 'SANDBOX') {
      feedback.note(t('skillDraft.scriptNeedsSandbox'))
      return
    }
    setReplacingPath(path)
    try {
      await uploadFile.mutateAsync({ file, path, replace: true })
      setRedactionConfirmed(false)
      feedback.ok(t('skillDraft.fileUploaded', { path }))
    } catch (error) {
      feedback.fail(error, t('skillDraft.fileUploadFailed'))
    } finally {
      setReplacingPath(null)
    }
  }

  function removeDraftFile(path: string, recursive = false): void {
    setRemovingPath(path)
    removeFile.mutate(
      { path, recursive },
      {
        onSuccess: () => feedback.ok(t('skillFile.deleted', { path })),
        onError: (error) => feedback.fail(error, t('skillFile.deleteFailed')),
        onSettled: () => setRemovingPath(null),
      },
    )
  }

  /**
   * 撤销删除：把原内容用 `PUT /files/content` 写回即把该路径从墓碑里摘掉。
   *
   * · **基准文件**：字节在基准前缀（只读），从基准读回正文再写回草稿；
   * · **草稿文件**：删除只从 `files` 摘掉行，草稿对象仍在，按原路径读回。
   * 二进制文件没有"正文"可写 ⇒ 只能提示（`skillDraft.fileBinaryHint`），不假装恢复成功。
   */
  async function restoreDraftPath(path: string): Promise<void> {
    try {
      const text =
        baseSkill?.files.some((file) => file.path === path) === true
          ? await readSkillTextFile(baseSkillId, path, draft?.baseVersion ?? undefined)
          : await fetchSkillDraftFile(draftId, path).then((preview) => (preview.kind === 'TEXT' ? preview.text : null))
      if (text === null || text === undefined) {
        feedback.note(t('skillDraft.fileBinaryHint'))
        return
      }
      await writeFileContent.mutateAsync({ path, text })
      feedback.ok(t('skillFile.restored', { path }))
    } catch (error) {
      feedback.fail(error, t('skillFile.fileCreateFailed'))
    }
  }

  // ── P1-24a-7：新建文件 / 文件夹 / 重命名（都在草稿里完成） ──

  function submitPathModal(): void {
    if (pathModal === null) return
    const raw = pathModal.value.trim()
    if (raw === '') return
    const parent = pathModal.mode === 'RENAME' ? null : pathModal.dir
    const path = parent === null || parent === '' ? raw : `${parent}/${raw.replace(/^\/+?/u, '')}`
    if (pathModal.mode === 'CREATE_FILE') {
      if (form !== null && isLikelyScriptPath(path) && form.runtime !== 'SANDBOX') {
        feedback.note(t('skillDraft.scriptNeedsSandbox'))
        return
      }
      writeFileContent.mutate(
        { path, text: `${t('skillFile.newFileTemplate')}\n` },
        {
          onSuccess: () => {
            setSelectedPath(path)
            feedback.ok(t('skillFile.fileCreated', { path }))
            setPathModal(null)
          },
          onError: (error) => feedback.fail(error, t('skillFile.fileCreateFailed')),
        },
      )
      return
    }
    if (pathModal.mode === 'CREATE_DIR') {
      // 空目录不落版本：新建文件夹只提供一个 `.keep` 占位文件，用户可随即删除
      const keep = `${path}/.keep`
      writeFileContent.mutate(
        { path: keep, text: `${t('skillFile.keepTemplate')}\n` },
        {
          onSuccess: () => {
            feedback.ok(t('skillFile.fileCreated', { path: keep }))
            setPathModal(null)
          },
          onError: (error) => feedback.fail(error, t('skillFile.fileCreateFailed')),
        },
      )
      return
    }
    if (pathModal.mode === 'RENAME') {
      renamePath.mutate(
        { from: pathModal.from, to: path, kind: pathModal.kind },
        {
          onSuccess: () => {
            feedback.ok(t('skillFile.renamed', { path }))
            setPathModal(null)
          },
          onError: (error) => feedback.fail(error, t('skillFile.renameFailed')),
        },
      )
    }
  }

  /** 删除文件 / 目录（目录先确认将删掉的文件数） */
  function requestDelete(path: string, kind: 'FILE' | 'DIR'): void {
    if (kind === 'FILE') {
      Modal.confirm({
        title: t('skillFile.deleteFileTitle'),
        content: t('skillFile.deleteFileDesc', { path }),
        okText: t('skillFile.confirm'),
        okButtonProps: { danger: true },
        cancelText: t('common.cancel'),
        onOk: () => removeDraftFile(path),
      })
      return
    }
    const count = reviewFiles.filter(
      (file) => file.path !== SKILL_ENTRY_PATH && file.status !== 'REMOVED' && (file.path === path || file.path.startsWith(`${path}/`)),
    ).length
    Modal.confirm({
      title: t('skillFile.deleteDirTitle'),
      content: t('skillFile.deleteDirDesc', { dir: path, count }),
      okText: t('skillFile.confirm'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => removeDraftFile(path, true),
    })
  }

  /** 在 `dir` 下上传文件（目录行菜单 / 左栏工具栏都由它决定去向） */
  function addDraftFileTo(file: File, dir: string): boolean {
    if (form === null) return false
    const name = file.name
    const path = dir === '' ? name : `${dir}/${name}`
    if (isLikelyScriptPath(path) && form.runtime !== 'SANDBOX') {
      feedback.note(t('skillDraft.scriptNeedsSandbox'))
      return false
    }
    uploadFile.mutate(
      { file, path },
      {
        onSuccess: () => {
          setRedactionConfirmed(false)
          feedback.ok(t('skillDraft.fileUploaded', { path }))
        },
        onError: (error) => feedback.fail(error, t('skillDraft.fileUploadFailed')),
      },
    )
    return false
  }

  /** 文本文件内容保存（右侧编辑器 / 撤销删除共用；走同一份草稿写入端点） */
  async function saveTextFile(path: string, text: string, baseline: string): Promise<void> {
    if (text === baseline) return
    try {
      await writeFileContent.mutateAsync({ path, text })
      setRedactionConfirmed(false)
      feedback.ok(t('skillFile.fileCreated', { path }))
    } catch (error) {
      feedback.fail(error, t('skillDraft.fileEditFailed'))
    }
  }

  /** 隐藏 file input 的回调：目标目录来自 input 的 `data-dir`（见 `uploadDirRef`） */
  function onPickUploadFile(input: HTMLInputElement): void {
    const file = input.files?.[0]
    const dir = input.getAttribute('data-dir') ?? ''
    input.value = ''
    if (file !== undefined) addDraftFileTo(file, dir)
  }

  const title = form.name.trim() === '' ? t('skillDraft.untitled') : form.name
  const modifiedCount = reviewFiles.filter((file) => file.status !== 'UNCHANGED').length
  const kindLabel = t(kindLabelKey(draft.kind))
  // P1-24a-6：页面新建（无来源 CREATE）的标题点明"还在草稿里"，避免和已保存的 Skill 混淆
  const headTitle =
    draft.kind === 'CREATE' && draft.source === null
      ? t('skillDraft.createHeadTitle', { name: title })
      : title

  const actionButtons = submissionLocked ? (
    <div className={embedded ? 'skill-review__actions' : 'page__head-actions'}>
      <Tag color={submission?.status === 'ACCEPTED' ? 'green' : 'orange'}>
        {submission?.status === 'ACCEPTED'
          ? t('skillDraft.submittedAccepted', { version: submission.acceptedVersion ?? '—' })
          : t('skillDraft.submittedPending')}
      </Tag>
    </div>
  ) : (
    <div className={embedded ? 'skill-review__actions' : 'page__head-actions'}>
      {dirty && <Tag className="tag--warn">{t('skillDraft.unsaved')}</Tag>}
      {updateDraft.isPending && <span className="ratio">{t('skillDraft.saving')}</span>}
      {redactionNeedsAttention && <Tag color="orange">{t('skillDraft.gateRedaction')}</Tag>}
      {summaryMissing && <Tag color="orange">{t('skillDraft.gateSummary')}</Tag>}
      {(!redactionConfirmed || !canConfirm || summaryMissing) && (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setTab('settings')}>
          {t('skillDraft.gateGoSettings')}
        </Button>
      )}
      <Button danger onClick={discard}>
        {t('skillDraft.discard')}
      </Button>
      <Button
        type="primary"
        loading={
          saveNew.isPending ||
          saveRevision.isPending ||
          submitProposal.isPending ||
          createOverride.isPending ||
          replaceOverride.isPending
        }
        disabled={!canSave}
        onClick={submit}
      >
        {submissionReturned ? t('skillDraft.resubmit') : t(saveLabelKey(draft.kind))}
      </Button>
    </div>
  )

  return (
    <div className={`skill-review${embedded ? ' skill-review--embedded' : ''}`}>
      {embedded ? (
        <div className="skill-review__head">
          <div className="skill-review__head-main">
            <strong>{headTitle}</strong>
            <span className="ratio">
              {kindLabel}
              {isTargeted && draft.baseVersion !== null ? ` · ${t('skillDraft.basedOn', { version: draft.baseVersion })}` : ''}
              {` · ${t('skillDraft.reviewFileSummary', { count: reviewFiles.length, changed: modifiedCount })}`}
            </span>
          </div>
          {actionButtons}
        </div>
      ) : (
        <div className="page__head">
          <div>
            <h1>{headTitle}</h1>
            <p className="page__lead">
              {t('skillDraft.lead', { kind: kindLabel })}
              {isTargeted && draft.baseVersion !== null ? ` · ${t('skillDraft.basedOn', { version: draft.baseVersion })}` : ''}
              {` · ${t('skillDraft.reviewFileSummary', { count: reviewFiles.length, changed: modifiedCount })}`}
            </p>
          </div>
          {actionButtons}
        </div>
      )}

      {submission === null ? null : submission.status === 'ACCEPTED' ? (
        <Alert
          type="success"
          showIcon
          message={t('skillDraft.submittedAccepted', { version: submission.acceptedVersion ?? '—' })}
        />
      ) : submissionReturned ? (
        <Alert
          type="warning"
          showIcon
          message={
            submission.reviewNote === null || submission.reviewNote.trim() === ''
              ? t('skillDraft.submittedReturnedNoNote')
              : t('skillDraft.submittedReturned', { note: submission.reviewNote })
          }
        />
      ) : submissionLocked ? (
        <Alert type="info" showIcon message={t('skillDraft.submittedPending')} description={t('skillDraft.submittedReadonly')} />
      ) : (
        <Alert type="warning" showIcon message={t('skillProposal.statusCLOSED')} />
      )}

      <div className="skill-review__toggle">
        <div className="seg" role="group" aria-label={t('skillDraft.reviewSections')}>
          <button type="button" aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
            {t('skillDraft.reviewFiles')}
          </button>
          <button
            type="button"
            aria-pressed={tab === 'settings'}
            onClick={() => {
              // 「设置」里既有元数据也有 `SKILL.md` 正文：默认落在概览，正文是一栏独立输入框
              setTab('settings')
            }}
          >
            {t('skillDraft.reviewSettings')}
          </button>
        </div>
        {selectedFile !== null && selectedFile.status !== 'UNCHANGED' && tab === 'files' ? (
          <Tag color={selectedFile.status === 'ADDED' ? 'green' : 'orange'}>{t(statusLabelKey(selectedFile.status))}</Tag>
        ) : null}
      </div>

      {tab === 'files' ? (
        <div className="skill-review__body">
          <div className="card card--pad skill-review__tree">
            <SkillFileTree
              files={reviewFiles}
              selectedPath={effectivePath}
              onSelect={setSelectedPath}
              statusOf={(path) => {
                if (!isTargeted || !baseReady) return null
                const file = reviewFiles.find((item) => item.path === path)
                return file === undefined || file.status === 'UNCHANGED' ? null : file.status
              }}
              {...(submissionLocked
                ? {}
                : {
                    actions: {
                      busy: uploadFile.isPending || writeFileContent.isPending || renamePath.isPending,
                      onCreateFile: (dir: string) => setPathModal({ mode: 'CREATE_FILE', dir, value: '' }),
                      onCreateDir: (dir: string) => setPathModal({ mode: 'CREATE_DIR', dir, value: '' }),
                      onUpload: (dir: string) => uploadDirRef.current?.(dir),
                      onRename: (path: string, kind: 'FILE' | 'DIR') =>
                        setPathModal({ mode: 'RENAME', from: path, kind, value: path }),
                      onDelete: requestDelete,
                      onRestore: (path: string) => {
                        void restoreDraftPath(path)
                      },
                    },
                  })}
            />
            <input
              ref={filePickerRef}
              type="file"
              style={{ display: 'none' }}
              onChange={(event) => onPickUploadFile(event.currentTarget)}
            />
          </div>

          <div className="card card--pad skill-review__pane">
            {selectedFile === null ? (
              <Empty description={t('skillDraft.filesEmpty')} />
            ) : (
              <ReviewFilePane
                key={selectedFile.path}
                draftId={draft.id}
                skillId={baseSkillId}
                baseVersion={draft.baseVersion ?? undefined}
                isTargeted={isTargeted}
                file={selectedFile}
                markdown={form.markdown}
                baseMarkdown={baseMarkdown}
                baseLoading={isTargeted && baseEntryExists && baseMarkdownQuery.isPending}
                baseFailed={isTargeted && baseEntryExists && baseMarkdownQuery.isError}
                readOnly={submissionLocked}
                onMarkdownChange={(text) => setField('markdown', text)}
                onReplaceFile={(path, file) => {
                  void replaceDraftFile(path, file)
                }}
                replacing={replacingPath === selectedFile.path}
                removing={removingPath === selectedFile.path}
                onRemoveFile={removeDraftFile}
                onSaveText={saveTextFile}
                savingText={writeFileContent.isPending}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="stack" style={{ marginTop: 0 }}>
          <p className="ratio" style={{ marginTop: 0 }}>
            {t('skillDraft.reviewSettingsHint')}
          </p>

          {draft.kind === 'SESSION_OVERRIDE' ? (
            <Alert
              type="warning"
              showIcon
              message={t('skillOverride.noticeTitle')}
              description={
                <>
                  {t('skillOverride.noticeDesc', { name: draft.name })}
                  {' · '}
                  {t('skillOverride.revisionLine', {
                    basedOn: draft.baseVersion ?? 1,
                    revision: draft.expectedRevision === null ? 1 : draft.expectedRevision + 1,
                  })}
                  {draft.files.some((file) => file.path.startsWith('scripts/'))
                    ? ` · ${t('skillOverride.scriptsNotice')}`
                    : ''}
                </>
              }
            />
          ) : null}

          {source === null ? null : (
            <Alert
              type="success"
              showIcon
              message={t('skillDraft.sourceTitle')}
              description={
                source.topic === null
                  ? t('skillDraft.sourceConversationUnknown', { count: source.count })
                  : t('skillDraft.sourceConversation', { topic: source.topic, count: source.count })
              }
            />
          )}

          {credentialHits.length > 0 && (
            <Alert
              type="error"
              showIcon
              message={t('skillDraft.credentialBlockTitle')}
              description={t('skillDraft.credentialBlockDesc', {
                labels: [...new Set(credentialHits.map((item) => item.label))].join('、'),
              })}
            />
          )}

          <div className="card card--pad">
            <p className="block-label">{t('skillDraft.nameLabel')}</p>
            <Input
              value={form.name}
              maxLength={SKILL_NAME_MAX_CHARS}
              disabled={submissionLocked}
              onChange={(event) => setField('name', event.target.value)}
            />
            <p className="block-label" style={{ marginTop: 'var(--sp-3)' }}>
              {t('skillDraft.descriptionLabel')}
            </p>
            <Input.TextArea
              rows={3}
              maxLength={SKILL_DESCRIPTION_MAX_CHARS}
              value={form.description}
              disabled={submissionLocked}
              onChange={(event) => setField('description', event.target.value)}
            />
            <p className="ratio">{t('skillDraft.descriptionHint')}</p>

            <p className="block-label" style={{ marginTop: 'var(--sp-3)' }}>
              {t('skillDraft.runtimeLabel')}
            </p>
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
              {(['INLINE', 'SANDBOX'] as const).map((option) => (
                <Button
                  key={option}
                  size="small"
                  type={form.runtime === option ? 'primary' : 'default'}
                  disabled={submissionLocked}
                  onClick={() => setField('runtime', option)}
                >
                  {t(option === 'SANDBOX' ? 'skillBadge.sandbox' : 'skillBadge.inline')}
                </Button>
              ))}
            </div>
            <div style={{ marginTop: 'var(--sp-2)' }}>
              <SkillBadge runtime={form.runtime} />
            </div>

            <p className="block-label" style={{ marginTop: 'var(--sp-3)' }}>
              {t('skillDraft.binsLabel')}
            </p>
            <Input
              value={form.requiresBinsText}
              placeholder="python3, jq"
              disabled={submissionLocked}
              onChange={(event) => setField('requiresBinsText', event.target.value)}
            />
            <p className="ratio">{t('skillDraft.binsHint')}</p>
          </div>

          <div className="card card--pad">
            <p className="block-label">{t('skillDraft.redactionTitle')}</p>
            {scan.redactions.length === 0 ? (
              <p className="ratio">{t('skillDraft.redactionNone')}</p>
            ) : (
              <div className="stack stack--tight">
                {scan.redactions.map((item) => (
                  <div key={`${item.kind}-${item.label}`} className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                    <Tag className={item.kind === 'credential' ? 'tag--warn' : undefined}>{t(REDACTION_KEY[item.kind])}</Tag>
                    <span>{item.label}</span>
                    <span className="ratio">{t('skillDraft.redactionCount', { count: item.count })}</span>
                    {item.kind === 'credential' ? (
                      <span className="ratio">{t('skillDraft.redactionCredentialLocked')}</span>
                    ) : (
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0 }}
                        disabled={submissionLocked}
                        onClick={() => {
                          setRestored((current) => [...current, item.kind])
                          setRedactionConfirmed(false)
                          feedback.note(t('skillDraft.redactionRestoreHint', { mask: SKILL_REDACTION_MASK }))
                        }}
                      >
                        {t('skillDraft.redactionRestore')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="row row--wrap" style={{ gap: 'var(--sp-3)', marginTop: 'var(--sp-3)' }}>
              <Button
                size="small"
                type={redactionConfirmed ? 'primary' : 'default'}
                disabled={submissionLocked || !canConfirm}
                onClick={() => setRedactionConfirmed(true)}
              >
                {redactionConfirmed ? t('skillDraft.redactionConfirmed') : t('skillDraft.redactionConfirm')}
              </Button>
              {!canConfirm && credentialHits.length > 0 && (
                <span className="ratio">{t('skillDraft.redactionCannotConfirm')}</span>
              )}
            </div>

            {needsSummary && (
              <>
                <p className="block-label" style={{ marginTop: 'var(--sp-3)' }}>
                  {t('skillDraft.changeSummaryLabel')}
                </p>
                <Input.TextArea
                  rows={2}
                  value={changeSummary}
                  disabled={submissionLocked}
                  onChange={(event) => setChangeSummary(event.target.value)}
                />
                <p className="ratio">{t('skillDraft.changeSummaryHint')}</p>
              </>
            )}

            {canPin && (
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <Checkbox checked={pinAgent} onChange={(event) => setPinAgent(event.target.checked)}>
                  {t('skillDraft.pinLabel')}
                </Checkbox>
                <p className="ratio">{t('skillDraft.pinHint')}</p>
              </div>
            )}

            <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
              {t('skillDraft.saveHint', { mask: SKILL_REDACTION_MASK })}
            </p>
          </div>

          {isTargeted && (draft.kind === 'REVISION' || revisionRisks.length > 0) ? (
            <div className="card card--pad">
              {draft.kind === 'REVISION' ? (
                <>
                  <p className="block-label">{t('skillDraft.impactTitle')}</p>
                  {impact === null ? (
                    <p className="ratio">
                      {targetsQuery.isPending ? t('common.loading') : t('skillDraft.impactUnknown')}
                    </p>
                  ) : (
                    <>
                      <p className="ratio">
                        {t('skillDraft.impactDesc', {
                          following: impact.impact.agentsFollowing,
                          pinned: impact.impact.agentsPinned,
                        })}
                      </p>
                      {impact.visibility === 'PUBLIC' ? <p className="ratio">{t('skillDraft.impactPublic')}</p> : null}
                    </>
                  )}
                </>
              ) : null}
              {revisionRisks.length > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  style={draft.kind === 'REVISION' ? { marginTop: 'var(--sp-3)' } : undefined}
                  message={t('skillDraft.riskTitle')}
                  description={t('skillDraft.riskDesc', { risks: revisionRisks.join('、') })}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <Modal
        open={pathModal !== null}
        title={
          pathModal === null
            ? ''
            : pathModal.mode === 'RENAME'
              ? t('skillFile.renameTitle')
              : pathModal.mode === 'CREATE_DIR'
                ? t('skillFile.newFolder')
                : t('skillFile.newFileTitle')
        }
        okText={t('skillFile.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ loading: writeFileContent.isPending || renamePath.isPending }}
        onOk={submitPathModal}
        onCancel={() => setPathModal(null)}
        destroyOnHidden
      >
        {pathModal !== null && pathModal.mode === 'RENAME' ? (
          <>
            <p className="block-label">{t('skillFile.renameFromLabel')}</p>
            <Input value={pathModal.from} disabled />
            <p className="block-label">{t('skillFile.renameToLabel')}</p>
            <Input
              value={pathModal.value}
              onChange={(event) => setPathModal({ ...pathModal, value: event.target.value })}
            />
          </>
        ) : (
          <>
            <p className="block-label">{t('skillFile.newFilePathLabel')}</p>
            <Input
              autoFocus
              value={pathModal?.value ?? ''}
              onChange={(event) => {
                if (pathModal !== null) setPathModal({ ...pathModal, value: event.target.value })
              }}
              onPressEnter={submitPathModal}
            />
            {pathModal !== null && pathModal.dir !== '' ? <p className="ratio">{pathModal.dir}/</p> : null}
          </>
        )}
      </Modal>
    </div>
  )
}

/**
 * 右侧单文件面板：对比 / 内容 / 编辑。
 *
 * `key={file.path}` 由父组件给 ⇒ 切换文件时组件重挂载，`mode` 直接按该文件的默认视图初始化，
 * 不需要一个"在 effect 里 setState"的同步逻辑。
 */
function ReviewFilePane({
  draftId,
  skillId,
  baseVersion,
  isTargeted,
  file,
  markdown,
  baseMarkdown,
  baseLoading,
  baseFailed,
  readOnly,
  onMarkdownChange,
  onReplaceFile,
  replacing,
  removing,
  onRemoveFile,
  onSaveText,
  savingText,
}: {
  draftId: string
  skillId: string
  baseVersion: number | undefined
  isTargeted: boolean
  file: SkillReviewFile
  markdown: string
  baseMarkdown: string
  baseLoading: boolean
  baseFailed: boolean
  readOnly: boolean
  onMarkdownChange: (text: string) => void
  onReplaceFile: (path: string, file: File) => void
  replacing: boolean
  removing: boolean
  onRemoveFile: (path: string) => void
  /** 文本文件（非 `SKILL.md`）内容保存（P1-24a-7：右侧编辑器直接写草稿） */
  onSaveText: (path: string, text: string, baseline: string) => void
  savingText: boolean
}) {
  const { t } = useT()
  const isEntry = file.path === SKILL_ENTRY_PATH
  const removed = file.removed
  /** 非 `SKILL.md` 的文本文件可以在右侧直接编辑（P1-24a-7） */
  const editableTextFile = !isEntry && !removed && file.previewable && !file.purged
  const [textDraft, setTextDraft] = useState<string | null>(null)
  const canDiff = isTargeted && file.status !== 'UNCHANGED' && !removed
  const [mode, setMode] = useState<FileViewMode>(canDiff ? 'DIFF' : 'CONTENT')
  /** 改动被用户在编辑里改回去后 `canDiff` 会变 false；此时 DIFF 按钮已隐藏，视图必须落回内容 */
  const canEditHere = isEntry || editableTextFile
  const effectiveMode: FileViewMode =
    (mode === 'DIFF' && !canDiff) || (readOnly && mode === 'EDIT') || (mode === 'EDIT' && !canEditHere)
      ? 'CONTENT'
      : mode

  const baseQuery = useQuery({
    queryKey: ['skill-review-base-text', skillId, baseVersion ?? 0, file.path] as const,
    queryFn: () => readSkillTextFile(skillId, file.path, baseVersion),
    enabled: !isEntry && file.inBase && file.previewable && !file.purged && skillId !== '',
    retry: false,
  })
  const draftQuery = useQuery({
    // `sha256` 进 key：替换同名文件后必须重新读，否则右栏会继续显示替换前的内容
    queryKey: ['skill-review-draft-text', draftId, file.path, file.sha256] as const,
    queryFn: async () => {
      const preview = await fetchSkillDraftFile(draftId, file.path)
      return preview.kind === 'TEXT' ? (preview.text ?? '') : null
    },
    enabled: !isEntry && file.inDraft && file.previewable,
    retry: false,
  })

  const beforeText = isEntry ? (isTargeted ? baseMarkdown : '') : file.inBase ? (baseQuery.data ?? null) : ''
  const afterText = isEntry ? markdown : file.inDraft ? (draftQuery.data ?? null) : (baseQuery.data ?? null)
  const loading = isEntry
    ? baseLoading
    : baseQuery.isPending || (file.inDraft && draftQuery.isPending)
  const failed = isEntry ? baseFailed : baseQuery.isError || draftQuery.isError
  const binary = !isEntry && (!file.previewable || file.purged)
  const afterEditableText = editableTextFile ? (textDraft ?? afterText ?? '') : ''

  function renderContent(text: string): ReactNode {
    if (isMarkdownMime(file.mime)) return <MarkdownPreview text={text} />
    return (
      <pre className="code-block" style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto', margin: 0 }}>
        <code>{text}</code>
      </pre>
    )
  }

  function renderDiff(): ReactNode {
    if (loading) return <p className="ratio">{t('skillDraft.diffFileLoading')}</p>
    if (failed) return <p className="ratio">{t('skillDraft.diffFileFailed')}</p>
    if (binary || beforeText === null || afterText === null) {
      return <p className="ratio">{t('skillDraft.fileBinaryHint')}</p>
    }
    if (beforeText === afterText) return <p className="ratio">{t('skillDraft.diffFileNoChanges')}</p>
    return <LineDiff before={beforeText} after={afterText} />
  }

  function renderContentPane(): ReactNode {
    if (isEntry) {
      return markdown.trim() === '' ? <Empty description={t('skillDraft.previewEmpty')} /> : <MarkdownPreview text={markdown} />
    }
    if (binary) {
      return (
        <Alert
          type="info"
          showIcon
          message={t('skillDraft.fileBinaryTitle')}
          description={t('skillDraft.fileBinaryHint')}
        />
      )
    }
    if (loading) return <p className="ratio">{t('skillDraft.diffFileLoading')}</p>
    if (failed) return <p className="ratio">{t('skillDraft.diffFileFailed')}</p>
    const text = editableTextFile ? afterEditableText : (afterText ?? '')
    return text === '' ? <Empty description={t('skillDraft.previewEmpty')} /> : renderContent(text)
  }

  function renderEditor(): ReactNode {
    if (!isEntry) {
      return (
        <div className="stack stack--tight">
          <p className="block-label">{t('skillDraft.fileEditLabel')}</p>
          <Input.TextArea
            autoSize={{ minRows: 16, maxRows: 40 }}
            value={afterEditableText}
            readOnly={readOnly || failed || loading}
            onChange={(event) => setTextDraft(event.target.value)}
            spellCheck={false}
            style={{ fontFamily: 'var(--font-mono)' }}
          />
          <p className="ratio">{t('skillDraft.fileEditHint')}</p>
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <Button
              size="small"
              type="primary"
              loading={savingText}
              disabled={textDraft === null || textDraft === (afterText ?? '')}
              onClick={() => {
                if (textDraft === null) return
                onSaveText(file.path, textDraft, afterText ?? '')
                setTextDraft(null)
              }}
            >
              {t('common.save')}
            </Button>
            {textDraft !== null && textDraft !== (afterText ?? '') ? (
              <Button size="small" onClick={() => setTextDraft(null)}>
                {t('common.cancel')}
              </Button>
            ) : null}
          </div>
        </div>
      )
    }
    return (
      <div className="skill-review__editor">
        <Input.TextArea
          autoSize={{ minRows: 16, maxRows: 40 }}
          value={markdown}
          readOnly={readOnly}
          onChange={(event) => onMarkdownChange(event.target.value)}
          spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)' }}
        />
        <div className="skill-review__editor-preview">
          <p className="ratio">{t('skillDraft.previewLabel')}</p>
          {markdown.trim() === '' ? (
            <Empty description={t('skillDraft.previewEmpty')} />
          ) : (
            <MarkdownPreview text={markdown} />
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="skill-review__pane-head">
        <code>{file.path}</code>
        {file.status === 'UNCHANGED' ? null : (
          <Tag color={statusColor(file.status)}>{t(statusLabelKey(file.status))}</Tag>
        )}
        <span className="ratio num">{formatBytes(file.size)}</span>
        {file.purged ? <span className="ratio">{t('skillDetail.purgedTag')}</span> : null}
      </div>

      <div className="skill-review__pane-head">
        <div className="seg" role="group" aria-label={t('skillDraft.viewMode')}>
          {canDiff ? (
            <button type="button" aria-pressed={mode === 'DIFF'} onClick={() => setMode('DIFF')}>
              {t('skillDraft.viewDiff')}
            </button>
          ) : null}
          <button type="button" aria-pressed={mode === 'CONTENT'} onClick={() => setMode('CONTENT')}>
            {t('skillDraft.viewContent')}
          </button>
          {(isEntry || editableTextFile) && !readOnly ? (
            <button type="button" aria-pressed={mode === 'EDIT'} onClick={() => setMode('EDIT')}>
              {t('skillDraft.viewEdit')}
            </button>
          ) : null}
        </div>
        {!isEntry && !readOnly && !removed ? (
          <Upload
            showUploadList={false}
            beforeUpload={(next) => {
              onReplaceFile(file.path, next)
              return false
            }}
          >
            <Button size="small" icon={<UploadOutlined />} loading={replacing}>
              {t('skillDraft.replaceFile')}
            </Button>
          </Upload>
        ) : null}
        {!isEntry && !readOnly && !removed && (file.inDraft || file.inBase) ? (
          <Button
            size="small"
            danger
            loading={removing}
            onClick={() => onRemoveFile(file.path)}
          >
            {t('skillDraft.fileRemove')}
          </Button>
        ) : null}
      </div>

      {removed ? (
        <Alert type="warning" showIcon message={t('skillDraft.fileDeletedHint')} />
      ) : null}
      {removed ? null : effectiveMode === 'DIFF' && canDiff ? renderDiff() : null}
      {removed ? null : effectiveMode === 'CONTENT' ? renderContentPane() : null}
      {removed ? null : effectiveMode === 'EDIT' && (isEntry || editableTextFile) ? renderEditor() : null}

      {!isEntry && file.inBase && file.inDraft && file.status !== 'UNCHANGED' ? (
        <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
          {t('skillDraft.replacedFrom', { version: baseVersion ?? '—' })}
        </p>
      ) : null}
    </>
  )
}

/** 行级 diff：只渲染改动行（`computeSkillLineChanges` 与后端审核页同一口径） */
function LineDiff({ before, after }: { before: string; after: string }): ReactNode {
  const { t } = useT()
  const diff = useMemo(() => computeSkillLineChanges(before, after), [before, after])
  if (diff.changes.length === 0) return <p className="ratio">{t('skillDraft.diffFileNoChanges')}</p>
  return (
    <>
      <div className="code-block skill-diff">
        {diff.changes.map((change, index) => (
          <span
            key={`${change.op}-${change.line}-${String(index)}`}
            className={`skill-diff__line ${change.op === 'add' ? 'skill-diff__line--add' : 'skill-diff__line--del'}`}
          >
            {change.op === 'add' ? '+' : '-'} {String(change.line).padStart(5, ' ')} {change.text}
            {'\n'}
          </span>
        ))}
      </div>
      {diff.truncated && (
        <p className="ratio">{t('skillDraft.diffFileTruncated', { count: diff.changes.length })}</p>
      )}
    </>
  )
}