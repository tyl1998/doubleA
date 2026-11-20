/**
 * Skill 列表页（`/skills`，P1-24a-2）
 *
 * 依据：`docs/03-前端设计.md` §二（`/skills` = Skill 列表，**登录即可**）、§4.2（Agent 编辑页的 Skill 区）、
 *      §七（列表三态 / 创建形态）、`子方案/Skill能力.md` §5.1 / §5.2 / §5.3、`shared/src/skill.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 权限：登录即可；**可见性两档**（私有 / 公开）
 * ─────────────────────────────────────────────────────────────────────
 * 列表由服务端按"对我可见"过滤（公开 + 我的 + ADMIN 全部），私有 Skill 对他人**根本不出现**。
 * 改 / 删 / 重新导入 / 转移按服务端下发的 `canEdit` 渲染（所属人或 ADMIN）——
 * 前端**不**拿 `createdBy` 跟当前用户 id 比（那样 ADMIN 在界面上会连自己的编辑入口都没有）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 建 Skill 的入口（P1-24a-6 起有两个）
 * ─────────────────────────────────────────────────────────────────────
 * · **新建 Skill**：填名称 / 用途说明 / 运行时 → 建 `CREATE` 草稿（带一段正文模板）→ 进 `/skills/drafts/:draftId`
 *   写正文 → 「保存为我的 Skill」存 v1。**创建时就带正文模板**，不产生"只有元数据、没有 `SKILL.md`"的空壳。
 * · **导入 zip**：内容自带 `SKILL.md`。
 * 另有两个入口在别处：「另存为 Skill」由 Agent 工具发起（c-4c）；更新既有 Skill 走详情页（REVISION 草稿）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 分页在服务端（`offset/limit/query`）
 * ─────────────────────────────────────────────────────────────────────
 * 与知识库不同：Skill 的关键词与分页都下推到 SQL（`useSkills`），所以 `total` 是权威的
 * —— 页脚不会出现"筛选后只剩本页几条"那种看着像坏了的读数。
 */

import { Alert, Button, Input, Table, Tag, Modal, Upload, type TableColumnsType } from 'antd'
import { PlusOutlined, UploadOutlined } from '@ant-design/icons'
import { SKILL_DESCRIPTION_MAX_CHARS, SKILL_NAME_MAX_CHARS, type SkillItem } from '@doubulea/shared'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useCreateSkill, useForkSkill, useRemoveSkill, useSkills } from '../../api/skills.js'
import { useCreateSkillDraft } from '../../api/skillDrafts.js'
import { useCreateSkillProposalDraft } from '../../api/skillProposals.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { formatUpdatedAt } from '../../app/format.js'
import { SKILL_DRAFTS_PATH, skillDetailPath, skillDraftPath } from '../../app/paths.js'
import { UpstreamDiffModal } from '../../features/skills/UpstreamDiffModal.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { TransferOwnershipModal } from '../../components/TransferOwnershipModal.js'
import { VisibilityBadge } from '../../components/VisibilityBadge.js'

/** 一页取满 `listSkillsQuerySchema` 的上限（200），再由表格分 20/页 */
const SKILLS_PAGE_LIMIT = 200

export function SkillListPage() {
  const navigate = useNavigate()
  const { t } = useT()
  const feedback = useFeedback()
  const [keyword, setKeyword] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [pickedFile, setPickedFile] = useState<File | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createRuntime, setCreateRuntime] = useState<'INLINE' | 'SANDBOX'>('INLINE')
  const [transferFor, setTransferFor] = useState<SkillItem | null>(null)
  const [upstreamFor, setUpstreamFor] = useState<SkillItem | null>(null)

  const skillsQuery = useSkills({ limit: SKILLS_PAGE_LIMIT, query: keyword })
  const createSkill = useCreateSkill()
  const createDraft = useCreateSkillDraft()
  const removeSkill = useRemoveSkill()
  const forkSkill = useForkSkill()
  const createProposalDraft = useCreateSkillProposalDraft()

  const items = skillsQuery.data?.items ?? []
  const total = skillsQuery.data?.total ?? 0
  const pendingReviewTotal = items.reduce(
    (sum, skill) => sum + (skill.canEdit ? skill.pendingProposalCount : 0),
    0,
  )

  function closeImport(): void {
    setImportOpen(false)
    setPickedFile(null)
  }

  function submitImport(): void {
    if (pickedFile === null) return
    createSkill.mutate(
      { zip: pickedFile, fields: {} },
      {
        onSuccess: (result) => {
          feedback.ok(t('skillList.imported', { name: result.skill.name, version: result.version }))
          closeImport()
          navigate(skillDetailPath(result.skill.id))
        },
        onError: (error) => {
          // 校验失败（`SKILL_IMPORT_INVALID`）的服务端文案带逐条原因（`reasons[]` 拼进 `msg`）
          feedback.fail(error, t('skillList.importFailed'))
        },
      },
    )
  }

  function openCreate(): void {
    setCreateName('')
    setCreateDescription('')
    setCreateRuntime('INLINE')
    setCreateOpen(true)
  }

  function closeCreate(): void {
    setCreateOpen(false)
  }

  /** 新建 Skill：建一个带正文模板的 CREATE 草稿 → 进编辑页写正文 → 保存 v1（P1-24a-6） */
  function submitCreate(): void {
    const name = createName.trim()
    const description = createDescription.trim()
    if (name === '' || description === '') return
    createDraft.mutate(
      {
        kind: 'CREATE',
        name,
        description,
        runtime: createRuntime,
        // 正文模板随创建一起写进草稿：即使编辑器里一个字没改，也不会存出"只有元数据的空壳"
        markdown: t('skillList.createBodyTemplate', { name }),
      },
      {
        onSuccess: (draft) => {
          closeCreate()
          navigate(skillDraftPath(draft.id))
        },
        onError: (error) => feedback.fail(error, t('skillList.createFailed')),
      },
    )
  }

  function startProposal(skill: SkillItem): void {
    createProposalDraft.mutate(
      { id: skill.id },
      {
        onSuccess: (draft) => navigate(skillDraftPath(draft.id)),
        onError: (error) => feedback.fail(error, t('skillProposal.createFailed')),
      },
    )
  }

  function copySkill(skill: SkillItem): void {
    forkSkill.mutate(
      { id: skill.id },
      {
        onSuccess: (copy) => {
          feedback.ok(t('skillFork.copyOk', { name: copy.name }))
          navigate(skillDetailPath(copy.id))
        },
        onError: (error) => feedback.fail(error, t('skillFork.copyFailed')),
      },
    )
  }

  const columns: TableColumnsType<SkillItem> = [
    {
      title: t('skillList.colName'),
      dataIndex: 'name',
      width: 300,
      render: (_, skill) => (
        <div className="kb-cell">
          <Link to={skillDetailPath(skill.id)} className="kb-cell__name">
            {skill.name}
          </Link>
          <span className="kb-cell__sub">{skill.description}</span>
          {/* 待审核徽标（2026-11-18）：所属人在列表上就能看到有人提交了更新建议，不必先点进详情 */}
          {skill.canEdit && skill.pendingProposalCount > 0 ? (
            <span className="kb-cell__sub">
              <Link to={skillDetailPath(skill.id)}>
                <Tag color="orange">{t('skillProposal.pendingReviewBadge', { count: skill.pendingProposalCount })}</Tag>
              </Link>
            </span>
          ) : null}
          {/* 来源徽标（P1-24c-2）：从会话抽出来的 Skill 标出处；会话已删 ⇒ 明说，不给跳转 */}
          {skill.sourceType === 'CONVERSATION' ? (
            <span className="kb-cell__sub">
              <Tag>{t('skillSource.conversation')}</Tag>
              <span className="ratio">
                {skill.sourceAvailable ? `${skill.sourceMessageIds.length}` : t('skillSource.conversationDeleted')}
              </span>
            </span>
          ) : null}
          {/* 副本徽标（P1-24c-5）：来源 + 基于版本 + 上游状态 */}
          {skill.parentSkillId !== null ? (
            <span className="kb-cell__sub">
              <Tag>{t('skillFork.badge')}</Tag>
              <span className="ratio">
                {t('skillFork.rowLine', {
                  name: skill.parentName ?? t('skillFork.sourceDeletedName'),
                  basedOn: skill.parentVersion ?? '—',
                  status: skill.parentDeleted
                    ? t('skillFork.sourceDeleted')
                    : !skill.parentAvailable
                      ? t('skillFork.statusUnavailable')
                      : skill.parentLatestVersion !== null &&
                          skill.parentVersion !== null &&
                          skill.parentLatestVersion > skill.parentVersion
                        ? t('skillFork.statusUpstream', { version: skill.parentLatestVersion })
                        : t('skillFork.statusSynced', {
                            version: skill.parentLatestVersion ?? skill.parentVersion ?? '—',
                          }),
                })}
              </span>
            </span>
          ) : null}
        </div>
      ),
    },
    {
      title: t('skillList.colSlug'),
      dataIndex: 'slug',
      width: 170,
      render: (_, skill) => <code>{skill.slug}</code>,
    },
    {
      title: t('skillList.colRuntime'),
      dataIndex: 'runtime',
      width: 170,
      render: (_, skill) => (
        <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
          {skill.runtime === 'SANDBOX' ? (
            <>
              <Tag className="tag--warn">{t('skillBadge.sandbox')}</Tag>
              <span className="ratio">{t('skillBadge.sandboxHint')}</span>
            </>
          ) : skill.runtime === 'INLINE' ? (
            <Tag>{t('skillBadge.inline')}</Tag>
          ) : (
            <Tag>{t('skillBadge.undeclared')}</Tag>
          )}
          {skill.hasScripts && <Tag color="orange">{t('skillBadge.hasScripts')}</Tag>}
          {skill.runtime !== 'SANDBOX' && !skill.hasScripts && (
            <span className="ratio">{t('skillBadge.inlineBindable')}</span>
          )}
          {skill.runtime !== 'SANDBOX' && skill.hasScripts && (
            <span className="ratio">{t('skillBadge.scriptTaskAgentOnly')}</span>
          )}
        </span>
      ),
    },
    {
      title: t('skillList.colVersion'),
      dataIndex: 'version',
      width: 90,
      align: 'right',
      render: (_, skill) => <span className="num">v{skill.version}</span>,
    },
    {
      title: t('skillList.colOwner'),
      dataIndex: 'creatorName',
      width: 140,
      render: (_, skill) =>
        skill.canEdit ? (
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setTransferFor(skill)}>
            {skill.creatorName}
          </Button>
        ) : (
          <span>{skill.creatorName}</span>
        ),
    },
    {
      title: t('skillList.colVisibility'),
      dataIndex: 'visibility',
      width: 110,
      render: (_, skill) => <VisibilityBadge visibility={skill.visibility} />,
    },
    {
      title: t('skillList.colUpdated'),
      dataIndex: 'updatedAt',
      width: 130,
      render: (_, skill) => <span className="num">{formatUpdatedAt(skill.updatedAt)}</span>,
    },
    {
      title: t('skillList.colActions'),
      key: 'actions',
      width: 220,
      align: 'right',
      render: (_, skill) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-3)' }}>
          <Link to={skillDetailPath(skill.id)}>{t('skillList.open')}</Link>
          {skill.parentSkillId !== null ? (
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setUpstreamFor(skill)}>
              {t('skillFork.viewUpstream')}
            </Button>
          ) : null}
          {skill.parentSkillId !== null &&
          skill.canEdit &&
          skill.parentAvailable &&
          !skill.parentDeleted ? (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              loading={createProposalDraft.isPending && createProposalDraft.variables?.id === skill.id}
              onClick={() => startProposal(skill)}
            >
              {t('skillProposal.submit')}
            </Button>
          ) : null}
          {!skill.canEdit && skill.visibility === 'PUBLIC' ? (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              loading={forkSkill.isPending && forkSkill.variables?.id === skill.id}
              onClick={() => copySkill(skill)}
            >
              {t('skillFork.copy')}
            </Button>
          ) : null}
          {skill.canEdit ? (
            <Button
              type="link"
              danger
              size="small"
              style={{ padding: 0 }}
              loading={removeSkill.isPending && removeSkill.variables === skill.id}
              onClick={() => {
                // 被 Agent 绑定时服务端 409 并给引用数 ⇒ 这里不做前端预判，原样把服务端的话端出来
                Modal.confirm({
                  title: t('skillList.removeTitle', { name: skill.name }),
                  content: t('skillList.removeDesc'),
                  okText: t('common.delete'),
                  okButtonProps: { danger: true },
                  cancelText: t('common.cancel'),
                  onOk: () =>
                    new Promise<void>((resolve) => {
                      removeSkill.mutate(skill.id, {
                        onSuccess: (result) => {
                          feedback.ok(t('skillList.deleted', { name: result.name }))
                          resolve()
                        },
                        onError: (error) => {
                          feedback.fail(error, t('skillList.removeFailed'))
                          resolve()
                        },
                      })
                    }),
                })
              }}
            >
              {t('common.delete')}
            </Button>
          ) : (
            <span className="ratio" title={t('skillList.noEditPermTitle')}>
              {t('skillList.noEditPerm')}
            </span>
          )}
        </div>
      ),
    },
  ]

  /**
   * 建一个 Skill 的三个入口（P1-24c 起：**没有**"空白标题 + 空正文"的手建入口）。
   *
   * · 导入 zip（本页主页按钮，内容自带 `SKILL.md`）；
   * · 「另存为 Skill」（在会话头部，`SaveAsSkillButton`）⇒ 会话抽取 → 草稿（c-2）；
   * · 更新既有 Skill（详情页的版本编辑 ⇒ `REVISION` 草稿，c-1 已落地）。
   *
   * ⚠️ c-2 起 `POST /api/skill-drafts` 不再接受 `CREATE`（来源与消息范围必须由服务端判定），
   * 故原先那个"新建本地草稿"按钮在此移除 —— 它建出来的正是"只有元数据、没有正文"的空壳。
   */

  const head = (
    <div className="page__head">
      <div>
        <h1>{t('skillList.title')}</h1>
        <p className="page__lead">
          {skillsQuery.isPending ? t('skillList.loading') : t('skillList.lead', { total })}
        </p>
      </div>
      <div className="page__head-actions">
        <Link to={SKILL_DRAFTS_PATH}>
          <Button>{t('skillDraftList.entry')}</Button>
        </Link>
        <Button icon={<PlusOutlined />} onClick={openCreate}>
          {t('skillList.create')}
        </Button>
        <Button type="primary" onClick={() => setImportOpen(true)}>
          {t('skillList.import')}
        </Button>
      </div>
    </div>
  )

  return (
    <>
      {head}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--sp-5)' }}
        message={t('skillList.introTitle')}
        description={t('skillList.introDesc')}
      />

      {pendingReviewTotal > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 'var(--sp-5)' }}
          message={t('skillProposal.pendingReviewBanner', { count: pendingReviewTotal })}
        />
      )}

      <div className="row row--wrap" style={{ marginBottom: 'var(--sp-5)' }}>
        <Input.Search
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('skillList.searchPlaceholder')}
          style={{ width: 260 }}
          aria-label={t('skillList.searchAria')}
        />
        {total > items.length && (
          <span className="ratio u-right">
            {t('skillList.truncatedPrefix', { total, shown: items.length })}
          </span>
        )}
      </div>

      {skillsQuery.isError ? (
        <ErrorState
          title={t('skillList.loadFailed')}
          error={skillsQuery.error}
          retrying={skillsQuery.isFetching}
          onRetry={() => {
            void skillsQuery.refetch()
          }}
        />
      ) : skillsQuery.isPending ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={keyword.trim() === '' ? t('skillList.emptyTitle') : t('skillList.noMatchTitle')}
            lead={keyword.trim() === '' ? t('skillList.emptyLead') : t('skillList.noMatchLead')}
            action={
              keyword.trim() === '' ? (
                <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'center' }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                    {t('skillList.create')}
                  </Button>
                  <Button onClick={() => setImportOpen(true)}>{t('skillList.import')}</Button>
                </div>
              ) : (
                <Button onClick={() => setKeyword('')}>{t('skillList.clearFilter')}</Button>
              )
            }
          />
        </div>
      ) : (
        <div className="card">
          <Table<SkillItem>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={items}
            loading={false}
            scroll={{ x: 'max-content' }}
            pagination={{
              pageSize: 20,
              showSizeChanger: false,
              showTotal: (count) => t('skillList.pageTotal', { count }),
            }}
          />
        </div>
      )}

      <Modal
        open={createOpen}
        title={t('skillList.createTitle')}
        okText={t('skillList.createOk')}
        cancelText={t('common.cancel')}
        okButtonProps={{
          disabled: createName.trim() === '' || createDescription.trim() === '',
          loading: createDraft.isPending,
        }}
        onOk={submitCreate}
        onCancel={closeCreate}
        maskClosable={!createDraft.isPending}
      >
        <div className="stack stack--tight">
          <p className="ratio">{t('skillList.createLead')}</p>
          <div>
            <p className="block-label">{t('skillList.createName')}</p>
            <Input
              value={createName}
              maxLength={SKILL_NAME_MAX_CHARS}
              placeholder={t('skillList.createNameRequired')}
              onChange={(event) => setCreateName(event.target.value)}
            />
          </div>
          <div>
            <p className="block-label">{t('skillList.createDescription')}</p>
            <Input.TextArea
              rows={3}
              value={createDescription}
              maxLength={SKILL_DESCRIPTION_MAX_CHARS}
              placeholder={t('skillList.createDescriptionRequired')}
              onChange={(event) => setCreateDescription(event.target.value)}
            />
            <p className="ratio">{t('skillList.createDescriptionHint')}</p>
          </div>
          <div>
            <p className="block-label">{t('skillList.createRuntime')}</p>
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
              {(['INLINE', 'SANDBOX'] as const).map((option) => (
                <Button
                  key={option}
                  size="small"
                  type={createRuntime === option ? 'primary' : 'default'}
                  onClick={() => setCreateRuntime(option)}
                >
                  {t(option === 'SANDBOX' ? 'skillList.createRuntimeSandbox' : 'skillList.createRuntimeInline')}
                </Button>
              ))}
            </div>
            <p className="ratio">{t('skillList.createRuntimeHint')}</p>
          </div>
        </div>
      </Modal>

      <Modal
        open={importOpen}
        title={t('skillList.importTitle')}
        okText={t('skillList.importOk')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: pickedFile === null, loading: createSkill.isPending }}
        onOk={submitImport}
        onCancel={closeImport}
        maskClosable={!createSkill.isPending}
      >
        <div className="stack stack--tight">
          <p className="ratio">{t('skillList.importLead')}</p>
          <Upload
            accept=".zip,application/zip"
            maxCount={1}
            beforeUpload={(file) => {
              setPickedFile(file)
              // 返回 `false` = 不自动上传（本页自己发 multipart，见 `api/skills.ts`）
              return false
            }}
            onRemove={() => {
              setPickedFile(null)
            }}
            fileList={pickedFile === null ? [] : [{ uid: 'picked', name: pickedFile.name, status: 'done' }]}
          >
            <Button icon={<UploadOutlined />}>{t('skillList.pickZip')}</Button>
          </Upload>
        </div>
      </Modal>

      <TransferOwnershipModal
        open={transferFor !== null}
        assetKind="SKILL"
        assetId={transferFor?.id ?? ''}
        assetName={transferFor?.name ?? ''}
        currentOwnerName={transferFor?.creatorName ?? ''}
        onClose={() => setTransferFor(null)}
      />

      <UpstreamDiffModal
        open={upstreamFor !== null}
        skillId={upstreamFor?.id ?? ''}
        skillName={upstreamFor?.name ?? ''}
        onClose={() => setUpstreamFor(null)}
      />
    </>
  )
}
