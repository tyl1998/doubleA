/**
 * Skill 详情页（`/skills/:id`，P1-24a-2）
 *
 * 依据：`docs/03-前端设计.md` §二（`/skills/:id` = 文件树 + 预览 + 版本历史）、
 *      `子方案/Skill能力.md` §5.1 / §5.2、`shared/src/skill.ts`。
 *
 * 交互约定（2026-11-13 修订）：
 * · 页面不再提供「回到列表 / 重新导入 / 编辑 / 删除」按钮；
 * · 元数据（名称 / 描述 / 可见范围）直接可编辑，有改动时才启用「保存」，`Ctrl/⌘+S` 等价；
 * · 版本与变更记录收进「查看版本」弹窗；
 * · 下载统一为整包 zip（与上传同形态），不再逐文件下载；
 * · 预览复用产物预览的渲染器（文本 / Markdown / CSV / HTML / SVG / 图片 / PDF / DOCX / XLSX）。
 *
 * ⚠️ 文件正文的在线编辑（保存后生成 vN+1）**不在本批范围**，见 `06` 的 P1-24a-5 规划。
 */

import { DownloadOutlined } from '@ant-design/icons'
import {
  ARTIFACT_PREVIEW_MAX_INLINE_BYTES,
  ARTIFACT_PREVIEW_MAX_TEXT_BYTES,
  ASSET_VISIBILITY_KEY,
  SKILL_ENTRY_PATH,
  previewKindOf,
  translate,
  type MessageKey,
  type PreviewKind,
  type SkillChange,
  type SkillDetail,
  type SkillProposalStatus,
  type SkillFileEntry,
  type SkillVersion,
  type UpdateSkillBody,
  type XmindOutline,
} from '@doubulea/shared'
import { Alert, Button, Col, Descriptions, Empty, Input, Modal, Row, Tag } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { ApiError, describeError } from '../../api/client.js'
import {
  downloadSkillArchive,
  fetchSkillFileOutline,
  fetchSkillFileRaw,
  saveDownloadedFile,
  skillFileRenderUrl,
  useForkSkill,
  useSkill,
  useUpdateSkill,
} from '../../api/skills.js'
import { usePublishSkillEdits } from '../../api/skillDrafts.js'
import {
  useCreateSkillProposalDraft,
  useMySkillProposals,
  useSkillProposalsForTarget,
} from '../../api/skillProposals.js'
import { SkillProposalReviewModal } from '../../features/skills/SkillProposalReviewModal.js'
import { UpstreamDiffModal } from '../../features/skills/UpstreamDiffModal.js'
import { usePageCrumb } from '../../app/crumbContext.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { formatUpdatedAt } from '../../app/format.js'
import { skillDetailPath, skillDraftPath } from '../../app/paths.js'
import { decodeUtf8Text } from '../../components/ArtifactPreview/artifactPreview.js'
import { ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { TransferOwnershipModal } from '../../components/TransferOwnershipModal.js'
import { VisibilityBadge } from '../../components/VisibilityBadge.js'
import { SkillBadge } from './skillModel.js'
import { DetailFilePane, DetailFileTree } from './SkillDetailFilePane.js'
import {
  EmptyTreeEdits,
  KEEP_FILE_NAME,
  detailStatusOf,
  effectiveDetailFiles,
  localContentOf,
  pendingDirsOf,
  planTreeSave,
  treeEditsEmpty,
  type TreeEditPlan,
  type TreeEdits,
} from './skillDetailTreeModel.js'

interface SkillDraft {
  name: string
  description: string
  visibility: 'PRIVATE' | 'PUBLIC'
}

const PROPOSAL_STATUS_KEY: Readonly<Record<SkillProposalStatus, MessageKey>> = {
  PENDING: 'skillProposal.statusPENDING',
  ACCEPTED: 'skillProposal.statusACCEPTED',
  REJECTED: 'skillProposal.statusREJECTED',
  NEEDS_REBASE: 'skillProposal.statusNEEDS_REBASE',
  CLOSED: 'skillProposal.statusCLOSED',
}

type TextPreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; text: string }
  | { phase: 'not-utf8' }
  | { phase: 'error'; message: string }

export function SkillDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const { t, locale } = useT()
  const feedback = useFeedback()
  const navigate = useNavigate()

  const skillQuery = useSkill(id)
  const updateSkill = useUpdateSkill()
  const publishEdits = usePublishSkillEdits()
  const forkSkill = useForkSkill()
  const createProposalDraft = useCreateSkillProposalDraft()

  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [versionOpen, setVersionOpen] = useState(false)
  const [upstreamOpen, setUpstreamOpen] = useState(false)
  const [proposalReviewId, setProposalReviewId] = useState('')
  const [proposalReviewMode, setProposalReviewMode] = useState<'review' | 'mine'>('review')
  const [downloading, setDownloading] = useState(false)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [textState, setTextState] = useState<TextPreviewState>({ phase: 'idle' })
  /** `xmind` 的大纲（按当前选中路径 / 版本取回；`undefined` = 取数中） */
  const [outlineState, setOutlineState] = useState<
    { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; data: XmindOutline | undefined; error: string | null }
  >({ phase: 'idle' })
  /** P1-24a-5：文本文件的内联改动（路径 → 正文；`SKILL.md` 也在这张表里） */
  const [textEdits, setTextEdits] = useState<ReadonlyMap<string, string>>(new Map())
  /** P1-24a-5：二进制文件只允许整文件替换（路径不变） */
  /** P1-24a-7：详情页文件树编辑（新建 / 重命名 / 删除先在本地累积，保存时一次发布） */
  const [treeEdits, setTreeEdits] = useState<TreeEdits>(() => new EmptyTreeEdits())
  /** 新建文件 / 新建文件夹 / 重命名的路径输入框 */
  const [treePrompt, setTreePrompt] = useState<
    | null
    | { mode: 'newFile' | 'newFolder'; dir: string; value: string }
    | { mode: 'rename'; from: string; kind: 'FILE' | 'DIR'; value: string }
  >(null)
  /** 右键「上传到此目录」用的隐藏选择框（与树共用一份，`data-dir` 记录目标目录） */
  const uploadInputRef = useRef<HTMLInputElement | null>(null)

  const detail = skillQuery.data
  const isFork = detail?.parentSkillId != null
  const targetProposals = useSkillProposalsForTarget(
    detail?.id ?? '',
    'PENDING',
    detail?.canEdit === true && detail?.parentSkillId == null,
  )
  const myProposals = useMySkillProposals(undefined, isFork && detail?.canEdit === true)
  const myProposalsForParent = (myProposals.data?.items ?? []).filter(
    (proposal) => proposal.targetSkillId === detail?.parentSkillId,
  )
  usePageCrumb(detail?.name ?? t('skillDetail.crumbFallback'))

  useEffect(() => {
    if (detail === undefined) {
      setDraft(null)
      setTreeEdits(new EmptyTreeEdits())
      return
    }
    setDraft({ name: detail.name, description: detail.description, visibility: detail.visibility })
    // 换 Skill / 外部改了版本 ⇒ 本地树改动全部作废（不能把 A 的改动发布到 B）。
    // ⚠️ 必须带上这一版的基准文件路径（`forBase`）：删除基准文件要据此加墓碑，漏了就抛错白屏。
    setTreeEdits(new EmptyTreeEdits().forBase(detail.files))
    setTextEdits(new Map())
  }, [detail?.id, detail?.updatedAt, detail?.name, detail?.description, detail?.visibility])

  const effectiveVersion = selectedVersion ?? detail?.version ?? 1
  /** 本地改过的 `SKILL.md` 正文（`null` = 没改；**不要**在这里退回 `''` —— 那等于把正文清空） */
  const markdownBaseline = treeEdits.markdown
  const detailFiles = detail === undefined ? [] : effectiveDetailFiles(detail.files, treeEdits, markdownBaseline)
  /** 新建但还没放文件的目录（空目录不落版本；只在树里看得见、能继续往里建文件 / 删掉） */
  const pendingDirs = pendingDirsOf(treeEdits, detailFiles)
  const selectedEntry = detailFiles.find((entry) => entry.path === selectedPath) ?? null
  const selectedKind = selectedEntry === null ? null : skillPreviewKind(selectedEntry)

  const draftName = draft?.name ?? ''
  const draftDescription = draft?.description ?? ''
  const metadataDirty =
    detail !== undefined &&
    draft !== null &&
    (draftName.trim() !== detail.name ||
      draftDescription.trim() !== detail.description ||
      draft.visibility !== detail.visibility)
  const contentDirty = !treeEditsEmpty(treeEdits)
  const dirty = metadataDirty || contentDirty
  const valid = draftName.trim() !== '' && draftDescription.trim() !== ''
  const saving = updateSkill.isPending || publishEdits.isPending
  const canSave = detail?.canEdit === true && dirty && valid && !saving

  const save = useCallback(() => {
    if (detail === undefined || draft === null || !dirty || !valid || saving) return
    const name = draft.name.trim()
    const description = draft.description.trim()
    if (!contentDirty) {
      const body: UpdateSkillBody = { expectedUpdatedAt: detail.updatedAt }
      if (name !== detail.name) body.name = name
      if (description !== detail.description) body.description = description
      if (draft.visibility !== detail.visibility) body.visibility = draft.visibility
      updateSkill.mutate(
        { id: detail.id, body },
        {
          onSuccess: () => feedback.ok(t('skillDetail.saved')),
          onError: (error) => feedback.fail(error, t('skillDetail.saveFailed')),
        },
      )
      return
    }
    void (async () => {
      try {
        // `SKILL.md` 正文即使没改也要一起提交：草稿的 `markdown` 是**整篇正文**的唯一来源。
        // ⚠️ **不能**把"没改"当成空串（2026-11-19 事故：只改文件时正文被写成 0 B）。
        let markdown = markdownBaseline
        if (markdown === null) {
          const file = await fetchSkillFileRaw(detail.id, { path: SKILL_ENTRY_PATH, version: detail.version })
          const text = decodeUtf8Text(await file.blob.arrayBuffer())
          if (text === null) throw new Error(t('skillDetail.skillMarkdownNotUtf8'))
          markdown = text
        }
        const plan = planTreeSave(treeEdits, markdown, `${t('skillFile.keepTemplate')}\n`)
        const changedPaths = plan.textWrites.length + plan.uploads.length + plan.renames.length + plan.removals.length
        await publishEdits.mutateAsync({
          skill: detail,
          metadata: { name, description, visibility: draft.visibility },
          markdown,
          changeSummary:
            changedPaths === 0
              ? t('skillDetail.changeSummaryMarkdownOnly')
              : t('skillDetail.treeChangeSummary', {
                  added: plan.textWrites.length + plan.uploads.length,
                  renamed: plan.renames.length,
                  removed: plan.removals.length,
                }),
          textFiles: plan.textWrites,
          binaryFiles: plan.uploads
            .filter((item): item is typeof item & { file: File } => item.file !== undefined)
            .map((item) => ({ path: item.path, file: item.file })),
          renames: plan.renames,
          removals: plan.removals,
        })
        setTreeEdits(new EmptyTreeEdits())
        setTextEdits(new Map())
      } catch (error) {
        feedback.fail(error, t('skillDetail.saveFailed'))
      }
    })()
  }, [detail, draft, dirty, valid, saving, contentDirty, treeEdits, markdownBaseline, textEdits, updateSkill, publishEdits, feedback, t])

  // ── P1-24a-7：树右键动作（与 Code 模式同一套手势，见 `SkillDetailFilePane.tsx`） ──

  /** 新建文件 / 文件夹与重命名：都是"路径输入 + 确认"，只是落到树编辑里的方式不同 */
  const submitTreePrompt = (): void => {
    if (treePrompt === null) return
    const raw = treePrompt.value.trim()
    if (raw === '') return
    if (treePrompt.mode === 'rename') {
      const next = raw.replace(/^\.\//u, '')
      if (next === treePrompt.from) {
        setTreePrompt(null)
        return
      }
      setTreeEdits((current) => current.withRename({ from: treePrompt.from, to: next, kind: treePrompt.kind }))
      setTreePrompt(null)
      return
    }
    // 目录名里的 `/` 也允许（`a/b` 一次建两层），去掉首尾多余的 `/`，避免建出空目录名
    const path = (treePrompt.dir === '' ? raw.replace(/^\.\//u, '') : `${treePrompt.dir}/${raw.replace(/^\/+?/u, '')}`)
      .replace(/\/+$/u, '')
    if (path === '') return
    if (treePrompt.mode === 'newFolder') {
      setTreeEdits((current) => current.withDir(path))
      setTreePrompt(null)
      return
    }
    setTreeEdits((current) => current.withTextWrite(path, ''))
    setTreePrompt(null)
    setSelectedPath(path)
    setTextState({ phase: 'ready', text: '' })
  }

  /** 删除（文件直接删；目录先说明会删掉几个文件） */
  const requestRemovePath = (path: string, kind: 'FILE' | 'DIR' = 'FILE'): void => {
    if (path === SKILL_ENTRY_PATH) return
    if (kind === 'FILE') {
      setTreeEdits((current) => current.withRemoval(path))
      return
    }
    const count = detailFiles.filter((file) => file.path !== SKILL_ENTRY_PATH && file.path.startsWith(`${path}/`)).length
    Modal.confirm({
      title: t('skillFile.deleteDirTitle'),
      content: t('skillFile.deleteDirDesc', { dir: path, count }),
      okText: t('skillFile.confirm'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => setTreeEdits((current) => current.withRemovalOfDir(path)),
    })
  }

  /** 右键「上传到此目录」：记下目标目录并唤起隐藏的文件选择框 */
  const uploadIntoDir = (dir: string): void => {
    uploadInputRef.current?.setAttribute('data-dir', dir)
    uploadInputRef.current?.click()
  }

  const onPickUploadFiles = (input: HTMLInputElement): void => {
    const dir = input.getAttribute('data-dir') ?? ''
    const picked = [...(input.files ?? [])]
    input.value = ''
    if (picked.length === 0) return
    setTreeEdits((current) => {
      let next = current
      for (const file of picked) {
        const path = dir === '' ? file.name : `${dir}/${file.name}`
        next = next.withUpload(path, file)
      }
      return next
    })
    const first = picked[0]
    if (first !== undefined) {
      setSelectedPath(dir === '' ? first.name : `${dir}/${first.name}`)
      setTextState({ phase: 'idle' })
    }
  }

  /** `SKILL.md` 正文编辑：与"已保存正文"比较，相同就回到基线 */
  const setFieldMarkdown = (text: string): void => {
    setTreeEdits((current) => current.withMarkdown(text === markdownBaseline ? null : text))
  }

  /** 在线编辑某个文本文件（详情页「编辑」模式）：在右栏看得到"改了什么" */
  const commitTextFile = (path: string, text: string): void => {
    setTextEdits((current) => {
      const next = new Map(current)
      next.set(path, text)
      return next
    })
    setTreeEdits((current) => current.withTextWrite(path, text))
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      save()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  useEffect(() => {
    if (
      selectedEntry === null ||
      selectedKind !== 'text' ||
      selectedEntry.purged ||
      selectedEntry.size > ARTIFACT_PREVIEW_MAX_TEXT_BYTES
    ) {
      setTextState({ phase: 'idle' })
      return
    }
    const controller = new AbortController()
    setTextState({ phase: 'loading' })
    void (async () => {
      try {
        const file = await fetchSkillFileRaw(id, {
          path: selectedEntry.path,
          version: effectiveVersion,
          signal: controller.signal,
        })
        const text = decodeUtf8Text(await file.blob.arrayBuffer())
        setTextState(text === null ? { phase: 'not-utf8' } : { phase: 'ready', text })
      } catch (error) {
        if (controller.signal.aborted) return
        setTextState({ phase: 'error', message: describeError(error).message })
      }
    })()
    return () => controller.abort()
  }, [id, selectedEntry?.path, selectedEntry?.purged, selectedEntry?.size, selectedKind, effectiveVersion])

  useEffect(() => {
    if (
      selectedEntry === null ||
      selectedKind !== 'xmind' ||
      selectedEntry.purged ||
      selectedEntry.size > ARTIFACT_PREVIEW_MAX_INLINE_BYTES
    ) {
      setOutlineState({ phase: 'idle' })
      return
    }
    const controller = new AbortController()
    setOutlineState({ phase: 'loading' })
    void (async () => {
      try {
        const outline = await fetchSkillFileOutline(id, {
          path: selectedEntry.path,
          version: effectiveVersion,
          signal: controller.signal,
        })
        setOutlineState({ phase: 'ready', data: outline, error: null })
      } catch (error) {
        if (controller.signal.aborted) return
        // 失败也要让右栏说得出原因（`XmindOutlinePreview` 的 `error` 分支）
        setOutlineState({ phase: 'ready', data: undefined, error: describeError(error).message })
      }
    })()
    return () => controller.abort()
  }, [id, selectedEntry?.path, selectedEntry?.purged, selectedEntry?.size, selectedKind, effectiveVersion])

  if (skillQuery.isPending) {
    return (
      <>
        <div className="page__head">
          <div>
            <h1>{t('skillDetail.title')}</h1>
            <p className="page__lead">{t('skillDetail.loadingLead')}</p>
          </div>
        </div>
        <TableSkeleton />
      </>
    )
  }

  if (skillQuery.isError) {
    const notFound = skillQuery.error instanceof ApiError && skillQuery.error.status === 404
    return (
      <>
        <div className="page__head">
          <div>
            <h1>{notFound ? t('skillDetail.notFoundTitle') : t('skillDetail.loadFailedTitle')}</h1>
          </div>
        </div>
        {notFound ? (
          <Empty
            description={t('skillDetail.notFoundDesc')}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ marginTop: 'var(--sp-6)' }}
          />
        ) : (
          <ErrorState
            title={t('skillDetail.loadFailedTitle')}
            error={skillQuery.error}
            retrying={skillQuery.isFetching}
            onRetry={() => {
              void skillQuery.refetch()
            }}
          />
        )}
      </>
    )
  }

  if (detail === undefined) return null

  const skill: SkillDetail = detail
  const files = skill.files

  /**
   * 只有当前版本可编辑（历史版本只读；保存总是发布到 `skill.version + 1`）。
   * ⚠️ 「未保存改动」的状态与摘要放在这里算（**由树编辑本身**，不经过渲染层的过滤结果），
   * 保证「新建一个文件、又删掉它」之后 `dirty` 仍然为真 —— 否则页面上没有任何入口能把这个改动发出去。
   */
  const editableVersion = effectiveVersion === skill.version
  const pendingTreeChanges = planTreeSave(treeEdits, treeEdits.markdown ?? '')
  const pendingTreeSummary = t('skillDetail.treeChangeSummary', {
    // 新建目录的 `.keep` 不计入"新增文件"（用户新建的是文件夹，不是文件）
    added:
      pendingTreeChanges.textWrites.length +
      pendingTreeChanges.uploads.length -
      newKeepsIn(pendingTreeChanges, treeEdits),
    renamed: pendingTreeChanges.renames.length,
    removed: pendingTreeChanges.removals.length,
  })

  function startProposal(): void {
    if (detail === undefined) return
    createProposalDraft.mutate(
      { id: detail.id },
      {
        onSuccess: (proposalDraft) => navigate(skillDraftPath(proposalDraft.id)),
        onError: (error) => feedback.fail(error, t('skillProposal.createFailed')),
      },
    )
  }

  function copyAsMine(): void {
    if (detail === undefined) return
    forkSkill.mutate(
      { id: detail.id },
      {
        onSuccess: (copy) => {
          feedback.ok(t('skillFork.copyOk', { name: copy.name }))
          navigate(skillDetailPath(copy.id))
        },
        onError: (error) => feedback.fail(error, t('skillFork.copyFailed')),
      },
    )
  }

  async function downloadArchive(): Promise<void> {
    setDownloading(true)
    try {
      const file = await downloadSkillArchive(skill.id, effectiveVersion)
      saveDownloadedFile(file, `${skill.slug}-v${effectiveVersion}.zip`)
      feedback.ok(t('artifact.preview.downloadOk'))
    } catch (error) {
      feedback.fail(error, t('skillDetail.downloadFailed'))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{skill.name}</h1>
          <p className="page__lead">
            <code>{skill.slug}</code> · v{skill.version} · {t('skillDetail.fileCount', { count: files.length })}
          </p>
        </div>
        <div className="page__head-actions">
          {!skill.canEdit && skill.visibility === 'PUBLIC' ? (
            <Button type="primary" loading={forkSkill.isPending} onClick={copyAsMine}>
              {t('skillFork.copy')}
            </Button>
          ) : null}
          {skill.parentSkillId !== null ? (
            <Button onClick={() => setUpstreamOpen(true)}>{t('skillFork.viewUpstream')}</Button>
          ) : null}
          {skill.parentSkillId !== null &&
          skill.canEdit &&
          skill.parentAvailable &&
          !skill.parentDeleted ? (
            <Button loading={createProposalDraft.isPending} onClick={startProposal}>
              {t('skillProposal.submit')}
            </Button>
          ) : null}
          {dirty && <Tag className="tag--warn">{t('skillDetail.unsaved')}</Tag>}
          {skill.canEdit && (
            <Button type="primary" loading={saving} disabled={!canSave} onClick={save}>
              {t('common.save')}
            </Button>
          )}
          <Button onClick={() => setVersionOpen(true)}>{t('skillDetail.viewVersions')}</Button>
          <Button icon={<DownloadOutlined />} loading={downloading} onClick={() => void downloadArchive()}>
            {t('skillDetail.downloadArchive')}
          </Button>
        </div>
      </div>

      <div className="card card--pad" style={{ marginBottom: 'var(--sp-5)' }}>
        <Descriptions
          size="small"
          column={{ xs: 1, md: 2 }}
          items={[
            {
              key: 'runtime',
              label: t('skillDetail.runtime'),
              children: <SkillBadge runtime={skill.runtime} hasScripts={skill.hasScripts} />,
            },
            { key: 'visibility', label: t('skillDetail.visibility'), children: <VisibilityBadge visibility={skill.visibility} /> },
            {
              key: 'owner',
              label: t('skillDetail.owner'),
              children: skill.canEdit ? (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setTransferOpen(true)}>
                  {skill.creatorName}
                </Button>
              ) : (
                skill.creatorName
              ),
            },
            { key: 'agents', label: t('skillDetail.agentCount'), children: <span className="num">{skill.agentCount}</span> },
            { key: 'bins', label: t('skillDetail.bins'), children: skill.requiresBins.length === 0 ? '—' : <code>{skill.requiresBins.join(', ')}</code> },
            { key: 'updated', label: t('skillDetail.updated'), children: <span className="num">{formatUpdatedAt(skill.updatedAt)}</span> },
          ]}
        />

        {skill.canEdit ? (
          <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
            <p className="block-label">{t('skillDetail.nameLabel')}</p>
            <Input
              value={draftName}
              onChange={(event) => setDraft((current) => (current === null ? current : { ...current, name: event.target.value }))}
            />
            <p className="block-label">{t('skillDetail.descriptionLabel')}</p>
            <Input.TextArea
              rows={3}
              value={draftDescription}
              onChange={(event) =>
                setDraft((current) => (current === null ? current : { ...current, description: event.target.value }))
              }
            />
            <p className="ratio">{t('skillDetail.descriptionHint')}</p>
            <p className="block-label">{t('skillDetail.visibility')}</p>
            <div className="seg" role="group" aria-label={t('skillDetail.visibility')}>
              {(['PRIVATE', 'PUBLIC'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={draft?.visibility === option}
                  onClick={() =>
                    setDraft((current) => (current === null ? current : { ...current, visibility: option }))
                  }
                >
                  {translate(locale, ASSET_VISIBILITY_KEY[option])}
                </button>
              ))}
            </div>
            <p className="ratio">{t('skillDetail.saveShortcut')}</p>
          </div>
        ) : (
          <p style={{ marginTop: 'var(--sp-4)' }}>
            <span className="block-label">{t('skillDetail.description')}</span> {skill.description}
          </p>
        )}
      </div>

      {skill.parentSkillId !== null ? (
        <div className="card card--pad" style={{ marginBottom: 'var(--sp-5)' }}>
          <p className="block-label">{t('skillFork.sourceTitle')}</p>
          <p style={{ marginTop: 0 }}>
            {t('skillFork.sourceLine', {
              name: skill.parentName ?? t('skillFork.sourceDeletedName'),
              basedOn: skill.parentVersion ?? '—',
            })}{' '}
            <Tag color={skill.parentDeleted || !skill.parentAvailable ? 'default' : 'blue'}>
              {skill.parentDeleted
                ? t('skillFork.sourceDeleted')
                : !skill.parentAvailable
                  ? t('skillFork.statusUnavailable')
                  : skill.parentLatestVersion !== null &&
                      skill.parentVersion !== null &&
                      skill.parentLatestVersion > skill.parentVersion
                    ? t('skillFork.statusUpstream', { version: skill.parentLatestVersion })
                    : t('skillFork.statusSynced', {
                        version: skill.parentLatestVersion ?? skill.parentVersion ?? '—',
                      })}
            </Tag>
          </p>
        </div>
      ) : null}

      {skill.canEdit && skill.parentSkillId === null ? (
        <div className="card card--pad" style={{ marginBottom: 'var(--sp-5)' }}>
          <p className="block-label">
            {t('skillProposal.ownerTitle')}
            {(targetProposals.data?.pendingCount ?? 0) > 0 && (
              <Tag color="orange" style={{ marginLeft: 8 }}>
                {t('skillProposal.pendingCount', { count: targetProposals.data?.pendingCount ?? 0 })}
              </Tag>
            )}
          </p>
          {(targetProposals.data?.items.length ?? 0) === 0 ? (
            <p className="ratio">{t('skillProposal.ownerEmpty')}</p>
          ) : (
            <div className="stack stack--tight">
              {(targetProposals.data?.items ?? []).map((proposal) => (
                <div key={proposal.id} className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                  <Tag>{t(PROPOSAL_STATUS_KEY[proposal.status])}</Tag>
                  <span>{t('skillProposal.fromProposer', { name: proposal.proposerName })}</span>
                  <span className="ratio">{t('skillProposal.basedOn', { version: proposal.baseVersion })}</span>
                  <span>{proposal.changeSummary}</span>
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0 }}
                    onClick={() => {
                      setProposalReviewMode('review')
                      setProposalReviewId(proposal.id)
                    }}
                  >
                    {t('skillProposal.review')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {skill.parentSkillId !== null && myProposalsForParent.length > 0 ? (
        <div className="card card--pad" style={{ marginBottom: 'var(--sp-5)' }}>
          <p className="block-label">{t('skillProposal.mineTitle')}</p>
          <div className="stack stack--tight">
            {myProposalsForParent.map((proposal) => (
              <div key={proposal.id} className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                <Tag>{t(PROPOSAL_STATUS_KEY[proposal.status])}</Tag>
                <span className="ratio">{t('skillProposal.basedOn', { version: proposal.baseVersion })}</span>
                <span>{proposal.changeSummary}</span>
                {proposal.acceptedVersion !== null && (
                  <Tag color="green">{t('skillProposal.mergedInto', { version: proposal.acceptedVersion })}</Tag>
                )}
                {proposal.reviewNote !== null && <span className="ratio">{proposal.reviewNote}</span>}
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0 }}
                  onClick={() => {
                    setProposalReviewMode('mine')
                    setProposalReviewId(proposal.id)
                  }}
                >
                  {t('skillProposal.viewMine')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {skill.agentCount > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 'var(--sp-5)' }}
          message={t('skillDetail.boundTitle', { count: skill.agentCount })}
          description={t('skillDetail.boundDesc')}
        />
      )}

      <Row gutter={16}>
        <Col xs={24} lg={7}>
          <div className="card card--pad skill-detail__tree-card">
            <p className="block-label">{t('skillDetail.filesTitle')}</p>
            {editableVersion && skill.canEdit ? (
              <p className="ratio" style={{ marginTop: 0 }}>
                {t('skillFile.contextHint')}
              </p>
            ) : null}
            <DetailFileTree
              files={detailFiles}
              removedPaths={[...treeEdits.removals]}
              emptyDirs={pendingDirs}
              editable={editableVersion && skill.canEdit}
              statusOf={(path) => (editableVersion ? detailStatusOf(path, files, treeEdits) : null)}
              selectedPath={selectedPath}
              onOpen={(path) => {
                // 重复点击同一文件时 `selectedPath` 不变，预览副作用不会重跑；
                // 无条件打回 `idle` 会让预览永远停在「正在读取预览…」。
                setSelectedPath((current) => {
                  if (current !== path) setTextState({ phase: 'idle' })
                  return path
                })
              }}
              actions={{
                rename: (path, kind) => setTreePrompt({ mode: 'rename', from: path, kind, value: path }),
                remove: requestRemovePath,
                removeDir: (dir) => requestRemovePath(dir, 'DIR'),
                newFile: (dir) => setTreePrompt({ mode: 'newFile', dir, value: '' }),
                newFolder: (dir) => setTreePrompt({ mode: 'newFolder', dir, value: '' }),
                upload: uploadIntoDir,
                restore: (path) => setTreeEdits((current) => current.withoutRemoval(path)),
              }}
            />
            {treeEdits.removals.size > 0 ? (
              <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                {pendingTreeSummary}
              </p>
            ) : null}
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(event) => onPickUploadFiles(event.currentTarget)}
            />
          </div>
        </Col>
        <Col xs={24} lg={17}>
          <div className="card card--pad">
            <DetailFilePane
              entry={selectedEntry}
              visible={selectedEntry}
              selectedKind={selectedKind}
              outline={
                outlineState.phase === 'ready'
                  ? { data: outlineState.data, error: outlineState.error }
                  : undefined
              }
              renderUrl={
                selectedEntry === null || selectedEntry.purged
                  ? null
                  : skillFileRenderUrl(id, { path: selectedEntry.path, version: effectiveVersion })
              }
              textState={textState}
              textEdit={selectedPath === null ? undefined : textEdits.get(selectedPath)}
              pendingText={selectedPath === null ? undefined : localContentOf(treeEdits, selectedPath)?.text}
              markdown={
                treeEdits.markdown ??
                (selectedPath === SKILL_ENTRY_PATH && textState.phase === 'ready' ? textState.text : '')
              }
              editableVersion={editableVersion}
              canEdit={skill.canEdit}
              version={effectiveVersion}
              onCommitText={commitTextFile}
              onCommitMarkdown={setFieldMarkdown}
              onReplaceBinary={(path, file) => setTreeEdits((current) => current.withUpload(path, file))}
              onRemove={requestRemovePath}
              onRestore={(path) => setTreeEdits((current) => current.withoutRemoval(path))}
              basePaths={files.map((file) => file.path)}
            />
          </div>
        </Col>
      </Row>

      <Modal
        open={treePrompt !== null}
        title={
          treePrompt === null
            ? ''
            : treePrompt.mode === 'rename'
              ? t('skillFile.renameTitle')
              : treePrompt.mode === 'newFolder'
                ? t('skillFile.newFolder')
                : t('skillFile.newFileTitle')
        }
        okText={t('skillFile.confirm')}
        cancelText={t('common.cancel')}
        onOk={submitTreePrompt}
        onCancel={() => setTreePrompt(null)}
        destroyOnHidden
      >
        {treePrompt !== null && treePrompt.mode === 'rename' ? (
          <>
            <p className="block-label">{t('skillFile.renameFromLabel')}</p>
            <Input value={treePrompt.from} disabled />
            <p className="block-label">{t('skillFile.renameToLabel')}</p>
          </>
        ) : (
          <>
            <p className="block-label">{t('skillFile.newFilePathLabel')}</p>
            {treePrompt !== null && treePrompt.dir !== '' ? <p className="ratio">{treePrompt.dir}/</p> : null}
          </>
        )}
        {treePrompt !== null ? (
          <Input
            autoFocus
            value={treePrompt.value}
            onChange={(event) => setTreePrompt({ ...treePrompt, value: event.target.value })}
            onPressEnter={submitTreePrompt}
          />
        ) : null}
      </Modal>

      <TransferOwnershipModal
        open={transferOpen}
        assetKind="SKILL"
        assetId={skill.id}
        assetName={skill.name}
        currentOwnerName={skill.creatorName}
        onClose={() => setTransferOpen(false)}
      />

      <UpstreamDiffModal
        open={upstreamOpen}
        skillId={skill.id}
        skillName={skill.name}
        onClose={() => setUpstreamOpen(false)}
      />

      <SkillProposalReviewModal
        open={proposalReviewId !== ''}
        proposalId={proposalReviewId}
        mode={proposalReviewMode}
        onClose={() => setProposalReviewId('')}
        onAccepted={() => {
          void skillQuery.refetch()
          void targetProposals.refetch()
        }}
      />

      <Modal
        open={versionOpen}
        title={t('skillDetail.versionModalTitle')}
        footer={null}
        onCancel={() => setVersionOpen(false)}
        width={720}
      >
        <div className="stack stack--tight">
          <p className="block-label">{t('skillDetail.versionTitle')}</p>
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            {skill.versions.map((version: SkillVersion) => (
              <Button
                key={version.version}
                size="small"
                type={version.version === effectiveVersion ? 'primary' : 'default'}
                onClick={() => {
                  setSelectedVersion(version.version === skill.version ? null : version.version)
                  setTextState({ phase: 'idle' })
                  setVersionOpen(false)
                }}
              >
                v{version.version}
                {version.version === skill.version && (
                  <span className="ratio"> · {t('skillDetail.versionCurrent')}</span>
                )}
                {version.purged && <span className="ratio"> · {t('skillDetail.purgedTag')}</span>}
              </Button>
            ))}
          </div>
          <p className="ratio">{t('skillDetail.versionHint')}</p>
          <p className="block-label" style={{ marginTop: 'var(--sp-4)' }}>
            {t('skillDetail.changesTitle')}
          </p>
          <div className="stack stack--tight">
            {skill.changes.map((change: SkillChange) => (
              <div key={change.id} className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                <Tag>
                  v{change.fromVersion === 0 ? '—' : change.fromVersion} → v{change.toVersion}
                </Tag>
                <span>{change.changeSummary}</span>
                <span className="ratio num">
                  {change.creatorName} · {formatUpdatedAt(change.createdAt)}
                </span>
              </div>
            ))}
            {skill.changes.length === 0 && <p className="ratio">{t('skillDetail.noChanges')}</p>}
          </div>
        </div>
      </Modal>
    </>
  )
}

/** 保存计划里"由新建目录自动补出来的 `.keep`"条数（摘要里不算作新增文件） */
function newKeepsIn(plan: TreeEditPlan, edits: TreeEdits): number {
  return plan.textWrites.filter(
    (item) => item.path.endsWith(`/${KEEP_FILE_NAME}`) && !edits.textWrites.has(item.path),
  ).length
}

function skillPreviewKind(entry: Pick<SkillFileEntry, 'mime' | 'previewable'>): PreviewKind {
  const kind = previewKindOf(entry.mime)
  return kind === 'none' && entry.previewable ? 'text' : kind
}