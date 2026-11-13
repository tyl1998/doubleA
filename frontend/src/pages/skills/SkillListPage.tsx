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
 * ② 建 = 上传 zip（没有"只填元数据"的建法）
 * ─────────────────────────────────────────────────────────────────────
 * 内容只能来自包（`PATCH` 不接 markdown / files），手工建出来的会是一个没有 `SKILL.md` 的空壳，
 * 绑上去之后 `load_skill` 必然失败 ⇒ 这里只给「导入 Skill」一个入口。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 分页在服务端（`offset/limit/query`）
 * ─────────────────────────────────────────────────────────────────────
 * 与知识库不同：Skill 的关键词与分页都下推到 SQL（`useSkills`），所以 `total` 是权威的
 * —— 页脚不会出现"筛选后只剩本页几条"那种看着像坏了的读数。
 */

import { Alert, Button, Input, Table, Tag, Modal, Upload, type TableColumnsType } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import type { SkillItem } from '@doubulea/shared'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useCreateSkill, useRemoveSkill, useSkills } from '../../api/skills.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { formatUpdatedAt } from '../../app/format.js'
import { skillDetailPath } from '../../app/paths.js'
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
  const [transferFor, setTransferFor] = useState<SkillItem | null>(null)

  const skillsQuery = useSkills({ limit: SKILLS_PAGE_LIMIT, query: keyword })
  const createSkill = useCreateSkill()
  const removeSkill = useRemoveSkill()

  const items = skillsQuery.data?.items ?? []
  const total = skillsQuery.data?.total ?? 0

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
      render: (_, skill) =>
        skill.runtime === 'SANDBOX' ? (
          <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <Tag className="tag--warn">{t('skillBadge.sandbox')}</Tag>
            <span className="ratio">{t('skillBadge.sandboxHint')}</span>
          </span>
        ) : (
          <Tag>{t('skillBadge.inline')}</Tag>
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

  const head = (
    <div className="page__head">
      <div>
        <h1>{t('skillList.title')}</h1>
        <p className="page__lead">
          {skillsQuery.isPending ? t('skillList.loading') : t('skillList.lead', { total })}
        </p>
      </div>
      <div className="page__head-actions">
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
                <Button type="primary" onClick={() => setImportOpen(true)}>
                  {t('skillList.import')}
                </Button>
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
    </>
  )
}
