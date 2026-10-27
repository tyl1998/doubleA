/**
 * Git 凭据**区块**（P1-9 · R11；由 `/settings/credentials`「我的凭据」页内嵌）
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五 7（git 凭据：平台配置 + 容器内注入）+ §7.4（两种凭据的接法）；
 *      `shared/src/gitCredential.ts`（契约）。交互参照 MCP「我的凭据」页（`pages/mcp/McpCredentialsPage.tsx`）。
 *
 * ⚠️ 它**不再是独立页面**（原 `/settings/git-credentials`）：「我的凭据」是**个人凭据**的唯一入口，
 *    MCP 工具凭据与 Git 凭据都在这里，免得左侧栏多出一个"管凭据的页"。于是这里只出一个区块头
 *    （`admin-section` 家族，与 `ModelsPage` 的分区同款），页面级 `h1` 由宿主页给。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条与 MCP 凭据页同族的口径
 * ─────────────────────────────────────────────────────────────────────
 * ① 表单是**只写**的：值不下发（连掩码都没有）⇒ 输入框恒为空、占位符写「留空 = 不变」，
 *    已配置的行标一个「已配置 ✓」。提交只带这次真填过的字段（合并语义），否则会把没填的清掉。
 * ② 权限：只动我自己的（服务端按 `user_id` 收窄）。
 * ③ 这份凭据用于 **agent 在容器里 `git clone` 私有仓库**（`$HOME/.ssh` 落 tmpfs、token 只进 env）。
 */

import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Tag } from 'antd'
import { useState } from 'react'

import {
  useCreateGitCredential,
  useGitCredentials,
  useRemoveGitCredential,
  useUpdateGitCredential,
} from '../../api/gitCredentials.js'
import { EmptyState, ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'
import { localeTag } from '../../app/locale.js'
import {
  GIT_CREDENTIAL_KIND_KEY,
  gitCredentialCreateBody,
  gitCredentialUpdateBody,
  type GitCredentialFormValues,
} from './gitCredentialModel.js'
import type { GitCredentialItem } from '@doubulea/shared'

const KIND_KEY = GIT_CREDENTIAL_KIND_KEY

type FormValues = GitCredentialFormValues

export function GitCredentialsSection() {
  const feedback = useFeedback()
  const { t, locale } = useT()
  const query = useGitCredentials()
  const createCredential = useCreateGitCredential()
  const updateCredential = useUpdateGitCredential()
  const removeCredential = useRemoveGitCredential()

  const [form] = Form.useForm<FormValues>()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<GitCredentialItem | null>(null)
  const kind = Form.useWatch('kind', form) ?? 'SSH_KEY'

  function openCreate(): void {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ kind: 'SSH_KEY' })
    setOpen(true)
  }

  function openEdit(item: GitCredentialItem): void {
    setEditing(item)
    form.resetFields()
    form.setFieldsValue({ label: item.label, kind: item.kind, host: item.host ?? undefined })
    setOpen(true)
  }

  function submit(): void {
    void form.validateFields().then((values) => {
      if (editing === null) {
        createCredential.mutate(gitCredentialCreateBody(values), {
          onSuccess: () => {
            feedback.ok(t('settings.gitCredentials.saved'))
            setOpen(false)
          },
          onError: (error) => feedback.fail(error, t('settings.gitCredentials.saveFailed')),
        })
        return
      }
      // 编辑：只带真改过的字段（值不下发 ⇒ 空输入不可回填 ⇒ 不能整体替换）
      updateCredential.mutate(
        { id: editing.id, body: gitCredentialUpdateBody(editing, values) },
        {
          onSuccess: () => {
            feedback.ok(t('settings.gitCredentials.updated'))
            setOpen(false)
          },
          onError: (error) => feedback.fail(error, t('settings.gitCredentials.updateFailed')),
        },
      )
    })
  }

  const items = query.data?.items ?? []

  const head = (
    <div className="admin-section__head">
      <div>
        <h2 className="card__title">{t('settings.gitCredentials.title')}</h2>
        <p className="page__lead">
          {t('settings.gitCredentials.leadA')} <code>git clone</code> / <code>commit</code>
          {t('settings.gitCredentials.leadB')}
          <strong>{t('settings.gitCredentials.leadStrongEncrypted')}</strong>
          {t('settings.gitCredentials.leadC')}
          <strong>{t('settings.gitCredentials.leadStrongNotInWorkspace')}</strong>
          {t('settings.gitCredentials.leadD')}
          <br />
          <strong>{t('settings.gitCredentials.leadStrongRecommendSsh')}</strong>
          {t('settings.gitCredentials.leadE')}
          <code>host</code>
          {t('settings.gitCredentials.leadF')}
        </p>
      </div>
      <Button type="primary" onClick={openCreate}>
        {t('settings.gitCredentials.new')}
      </Button>
    </div>
  )

  return (
    <section
      className="admin-section"
      style={{ marginTop: 'var(--sp-8)', paddingTop: 'var(--sp-6)', borderTop: '1px solid var(--rule-strong)' }}
    >
      {head}

      {query.isError ? (
        <ErrorState
          title={t('settings.gitCredentials.loadFailed')}
          error={query.error}
          retrying={query.isFetching}
          onRetry={() => {
            void query.refetch()
          }}
        />
      ) : query.isPending ? (
        <TableSkeleton rows={3} />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={t('settings.gitCredentials.emptyTitle')}
            lead={t('settings.gitCredentials.emptyLead')}
            action={
              <Button type="primary" onClick={openCreate}>
                {t('settings.gitCredentials.new')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="stack">
          {items.map((item) => (
            <div className="card" key={item.id}>
              <div className="card__head">
                <p className="card__title">{item.label}</p>
                <Tag>{t(KIND_KEY[item.kind])}</Tag>
                {item.hasValue ? (
                  <Tag className="tag--ok">{t('settings.gitCredentials.configured')}</Tag>
                ) : (
                  <Tag className="tag--warn">{t('settings.gitCredentials.noValue')}</Tag>
                )}
                <div className="card__head-right">
                  <span className="ratio">
                    {item.host === null
                      ? t('settings.gitCredentials.unlimitedHost')
                      : t('settings.gitCredentials.hostValue', { host: item.host })}{' '}
                    ·{' '}
                    {t('settings.gitCredentials.updatedAt', {
                      time: new Date(item.updatedAt).toLocaleString(localeTag(locale), { hour12: false }),
                    })}
                  </span>
                </div>
              </div>
              <div className="card__body row" style={{ gap: 'var(--sp-3)' }}>
                <Button onClick={() => openEdit(item)}>{t('common.edit')}</Button>
                <Popconfirm
                  title={t('settings.gitCredentials.deleteTitle', { label: item.label })}
                  description={t('settings.gitCredentials.deleteDescription')}
                  okText={t('common.delete')}
                  okButtonProps={{ danger: true }}
                  cancelText={t('common.cancel')}
                  onConfirm={() => {
                    removeCredential.mutate(item.id, {
                      onSuccess: (result) =>
                        feedback.ok(t('settings.gitCredentials.deletedOk', { label: result.label })),
                      onError: (error) => feedback.fail(error, t('settings.gitCredentials.deleteFailed')),
                    })
                  }}
                >
                  <Button danger>{t('common.delete')}</Button>
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        title={
          editing === null
            ? t('settings.gitCredentials.modalCreateTitle')
            : t('settings.gitCredentials.modalEditTitle', { label: editing.label })
        }
        open={open}
        confirmLoading={createCredential.isPending || updateCredential.isPending}
        onOk={submit}
        onCancel={() => setOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 'var(--sp-4)' }}
          message={t('settings.gitCredentials.modalAlert')}
        />
        <Form form={form} layout="vertical" initialValues={{ kind: 'SSH_KEY' }}>
          <Form.Item
            name="label"
            label={t('settings.gitCredentials.labelName')}
            rules={[{ required: true, message: t('settings.gitCredentials.labelNameRule') }]}
          >
            <Input placeholder={t('settings.gitCredentials.labelNamePlaceholder')} maxLength={128} />
          </Form.Item>
          <Form.Item name="kind" label={t('settings.gitCredentials.labelKind')} rules={[{ required: true }]}>
            <Select
              disabled={editing !== null}
              options={[
                { value: 'SSH_KEY', label: t('settings.gitCredentials.kindSshOption') },
                { value: 'HTTPS_TOKEN', label: t('settings.gitCredentials.kindHttpsOption') },
              ]}
            />
          </Form.Item>
          <Form.Item name="host" label={t('settings.gitCredentials.labelHost')}>
            <Input placeholder={t('settings.gitCredentials.hostPlaceholder')} maxLength={255} />
          </Form.Item>

          {kind === 'SSH_KEY' ? (
            <>
              <Form.Item
                name="privateKey"
                label={
                  editing === null
                    ? t('settings.gitCredentials.privateKeyLabelNew')
                    : t('settings.gitCredentials.privateKeyLabelEdit')
                }
                rules={editing === null ? [{ required: true, message: t('settings.gitCredentials.privateKeyRule') }] : []}
              >
                <Input.TextArea rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
              </Form.Item>
              <Form.Item name="knownHosts" label={t('settings.gitCredentials.knownHostsLabel')}>
                <Input.TextArea rows={2} placeholder={t('settings.gitCredentials.knownHostsPlaceholder')} />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item
                name="token"
                label={
                  editing === null
                    ? t('settings.gitCredentials.tokenLabelNew')
                    : t('settings.gitCredentials.tokenLabelEdit')
                }
                rules={editing === null ? [{ required: true, message: t('settings.gitCredentials.tokenRule') }] : []}
              >
                <Input.Password placeholder="ghp_…" />
              </Form.Item>
              <Form.Item name="username" label={t('settings.gitCredentials.usernameLabel')}>
                <Input placeholder={t('settings.gitCredentials.usernamePlaceholder')} maxLength={128} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </section>
  )
}
