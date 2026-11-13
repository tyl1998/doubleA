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
  previewKindOf,
  translate,
  type PreviewKind,
  type SkillChange,
  type SkillDetail,
  type SkillFileEntry,
  type SkillVersion,
  type UpdateSkillBody,
} from '@doubulea/shared'
import { Alert, Button, Col, Descriptions, Empty, Input, Modal, Row, Tag } from 'antd'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'

import { ApiError, describeError } from '../../api/client.js'
import {
  downloadSkillArchive,
  fetchSkillFileRaw,
  saveDownloadedFile,
  skillFileRawUrl,
  skillFileRenderUrl,
  useSkill,
  useUpdateSkill,
} from '../../api/skills.js'
import { usePageCrumb } from '../../app/crumbContext.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { formatUpdatedAt } from '../../app/format.js'
import { CsvPreview } from '../../components/ArtifactPreview/CsvPreview.js'
import { HtmlPreview } from '../../components/ArtifactPreview/HtmlPreview.js'
import { ImagePreview } from '../../components/ArtifactPreview/ImagePreview.js'
import { MarkdownPreview } from '../../components/ArtifactPreview/MarkdownPreview.js'
import { PdfPreview } from '../../components/ArtifactPreview/PdfPreview.js'
import { TextPreview } from '../../components/ArtifactPreview/TextPreview.js'
import {
  csvDelimiterOf,
  decodeUtf8Text,
  formatBytes,
  isMarkdownMime,
} from '../../components/ArtifactPreview/artifactPreview.js'
import { ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { TransferOwnershipModal } from '../../components/TransferOwnershipModal.js'
import { VisibilityBadge } from '../../components/VisibilityBadge.js'
import { SkillBadge } from './skillModel.js'

interface SkillDraft {
  name: string
  description: string
  visibility: 'PRIVATE' | 'PUBLIC'
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

  const skillQuery = useSkill(id)
  const updateSkill = useUpdateSkill()

  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [versionOpen, setVersionOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [textState, setTextState] = useState<TextPreviewState>({ phase: 'idle' })

  const detail = skillQuery.data
  usePageCrumb(detail?.name ?? t('skillDetail.crumbFallback'))

  useEffect(() => {
    if (detail === undefined) {
      setDraft(null)
      return
    }
    setDraft({ name: detail.name, description: detail.description, visibility: detail.visibility })
  }, [detail?.id, detail?.updatedAt, detail?.name, detail?.description, detail?.visibility])

  const effectiveVersion = selectedVersion ?? detail?.version ?? 1
  const selectedEntry = detail?.files.find((entry) => entry.path === selectedPath) ?? null
  const selectedKind = selectedEntry === null ? null : skillPreviewKind(selectedEntry)

  const draftName = draft?.name ?? ''
  const draftDescription = draft?.description ?? ''
  const dirty =
    detail !== undefined &&
    draft !== null &&
    (draftName.trim() !== detail.name ||
      draftDescription.trim() !== detail.description ||
      draft.visibility !== detail.visibility)
  const valid = draftName.trim() !== '' && draftDescription.trim() !== ''
  const canSave = detail?.canEdit === true && dirty && valid && !updateSkill.isPending

  const save = useCallback(() => {
    if (detail === undefined || draft === null || !dirty || !valid || updateSkill.isPending) return
    const body: UpdateSkillBody = { expectedUpdatedAt: detail.updatedAt }
    const name = draft.name.trim()
    const description = draft.description.trim()
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
  }, [detail, draft, dirty, valid, updateSkill, feedback, t])

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
  const entry = selectedEntry

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

  function renderTextPreview(): ReactNode {
    if (textState.phase === 'loading') return <TableSkeleton rows={4} />
    if (textState.phase === 'error') {
      return (
        <Alert type="warning" showIcon message={t('skillDetail.previewFailed')} description={textState.message} />
      )
    }
    if (textState.phase === 'not-utf8') {
      return (
        <Alert
          type="warning"
          showIcon
          message={t('skillDetail.previewFailed')}
          description={t('skillDetail.previewNotUtf8')}
        />
      )
    }
    if (textState.phase !== 'ready' || entry === null) {
      return <p className="ratio">{t('skillDetail.previewLoading')}</p>
    }
    if (isMarkdownMime(entry.mime)) return <MarkdownPreview text={textState.text} />
    const delimiter = csvDelimiterOf(entry.mime)
    if (delimiter !== null) return <CsvPreview text={textState.text} delimiter={delimiter} />
    return <TextPreview text={textState.text} />
  }

  function renderPreview(): ReactNode {
    if (selectedPath === null) return <p className="ratio">{t('skillDetail.previewPick')}</p>
    if (entry === null || selectedKind === null) return <p className="ratio">{t('skillDetail.previewEmpty')}</p>
    if (entry.purged) {
      return <Alert type="warning" showIcon message={t('skillDetail.previewFailed')} description={t('skillDetail.purgedFile')} />
    }
    if (selectedKind === 'none') {
      return (
        <Alert
          type="info"
          showIcon
          message={t('artifact.preview.unsupportedTitle')}
          description={t('artifact.preview.unsupported')}
        />
      )
    }
    if (selectedKind === 'text') {
      const overLimit = entry.size > ARTIFACT_PREVIEW_MAX_TEXT_BYTES
      return overLimit ? (
        <Alert
          type="warning"
          showIcon
          message={t('artifact.preview.tooLargeTitle')}
          description={t('artifact.preview.tooLarge', {
            size: formatBytes(entry.size),
            limit: formatBytes(ARTIFACT_PREVIEW_MAX_TEXT_BYTES),
          })}
        />
      ) : (
        renderTextPreview()
      )
    }
    if (entry.size > ARTIFACT_PREVIEW_MAX_INLINE_BYTES) {
      return (
        <Alert
          type="warning"
          showIcon
          message={t('artifact.preview.tooLargeTitle')}
          description={t('artifact.preview.tooLarge', {
            size: formatBytes(entry.size),
            limit: formatBytes(ARTIFACT_PREVIEW_MAX_INLINE_BYTES),
          })}
        />
      )
    }

    const rawUrl = skillFileRawUrl(skill.id, { path: entry.path, version: effectiveVersion })
    const renderUrl = skillFileRenderUrl(skill.id, { path: entry.path, version: effectiveVersion })
    switch (selectedKind) {
      case 'html':
        return <HtmlPreview fileName={entry.path} src={rawUrl} />
      case 'image':
        return <ImagePreview fileName={entry.path} src={rawUrl} />
      case 'pdf':
        return <PdfPreview fileName={entry.path} src={rawUrl} />
      case 'docx':
      case 'xlsx':
        return <HtmlPreview fileName={entry.path} src={renderUrl} />
      default:
        return null
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
          {dirty && <Tag className="tag--warn">{t('skillDetail.unsaved')}</Tag>}
          {skill.canEdit && (
            <Button type="primary" loading={updateSkill.isPending} disabled={!canSave} onClick={save}>
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
            { key: 'runtime', label: t('skillDetail.runtime'), children: <SkillBadge runtime={skill.runtime} /> },
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
          <div className="card card--pad">
            <p className="block-label">{t('skillDetail.filesTitle')}</p>
            <div className="stack stack--tight">
              {files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={`pick${selectedPath === file.path ? ' pick--active' : ''}`}
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => {
                    setSelectedPath(file.path)
                    setTextState({ phase: 'idle' })
                  }}
                >
                  <span className="pick__title">{file.path}</span>
                  <span className="pick__meta num">
                    {formatBytes(file.size)}
                    {!file.previewable && ` · ${t('skillDetail.binaryHint')}`}
                    {file.purged && ` · ${t('skillDetail.purgedTag')}`}
                  </span>
                </button>
              ))}
              {files.length === 0 && <p className="ratio">{t('skillDetail.noFiles')}</p>}
            </div>
          </div>
        </Col>
        <Col xs={24} lg={17}>
          <div className="card card--pad">
            <p className="block-label">
              {t('skillDetail.previewTitle')}
              {selectedPath !== null && <code style={{ marginLeft: 8 }}>{selectedPath}</code>}
              {selectedPath !== null && (
                <span className="ratio"> {t('skillDetail.previewVersion', { version: effectiveVersion })}</span>
              )}
            </p>
            {renderPreview()}
          </div>
        </Col>
      </Row>

      <TransferOwnershipModal
        open={transferOpen}
        assetKind="SKILL"
        assetId={skill.id}
        assetName={skill.name}
        currentOwnerName={skill.creatorName}
        onClose={() => setTransferOpen(false)}
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

function skillPreviewKind(entry: Pick<SkillFileEntry, 'mime' | 'previewable'>): PreviewKind {
  const kind = previewKindOf(entry.mime)
  return kind === 'none' && entry.previewable ? 'text' : kind
}