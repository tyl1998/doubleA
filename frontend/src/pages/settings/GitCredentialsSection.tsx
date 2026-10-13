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
import {
  GIT_CREDENTIAL_KIND_LABEL,
  gitCredentialCreateBody,
  gitCredentialUpdateBody,
  type GitCredentialFormValues,
} from './gitCredentialModel.js'
import type { GitCredentialItem } from '@doubulea/shared'

const KIND_LABEL = GIT_CREDENTIAL_KIND_LABEL

type FormValues = GitCredentialFormValues

export function GitCredentialsSection() {
  const feedback = useFeedback()
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
            feedback.ok('已保存 git 凭据（仅你可见；下一次派活时注入容器）')
            setOpen(false)
          },
          onError: (error) => feedback.fail(error, '保存 git 凭据失败'),
        })
        return
      }
      // 编辑：只带真改过的字段（值不下发 ⇒ 空输入不可回填 ⇒ 不能整体替换）
      updateCredential.mutate(
        { id: editing.id, body: gitCredentialUpdateBody(editing, values) },
        {
          onSuccess: () => {
            feedback.ok('已更新 git 凭据')
            setOpen(false)
          },
          onError: (error) => feedback.fail(error, '更新 git 凭据失败'),
        },
      )
    })
  }

  const items = query.data?.items ?? []

  const head = (
    <div className="admin-section__head">
      <div>
        <h2 className="card__title">Git 凭据</h2>
        <p className="page__lead">
          Code 模式下，agent 会在容器里跑 <code>git clone</code> / <code>commit</code>。这里配置的凭据
          <strong>按用户加密存平台</strong>，每次新建容器时解密注入到容器的临时目录（<code>$HOME</code> 是 tmpfs，
          容器回收即消失），<strong>绝不写进工作区</strong>。列表接口永不返回明文或掩码。
        </p>
      </div>
      <Button type="primary" onClick={openCreate}>
        新建凭据
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
          title="凭据清单加载失败"
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
            title="还没有 git 凭据"
            lead="需要克隆私有仓库时，在这里配一把只读 deploy key（SSH_KEY）或一个 PAT（HTTPS_TOKEN）。"
            action={
              <Button type="primary" onClick={openCreate}>
                新建凭据
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
                <Tag>{KIND_LABEL[item.kind]}</Tag>
                {item.hasValue ? <Tag className="tag--ok">已配置 ✓</Tag> : <Tag className="tag--warn">无值</Tag>}
                <div className="card__head-right">
                  <span className="ratio">
                    {item.host === null ? '不限主机' : `主机 ${item.host}`} · 更新于{' '}
                    {new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                  </span>
                </div>
              </div>
              <div className="card__body row" style={{ gap: 'var(--sp-3)' }}>
                <Button onClick={() => openEdit(item)}>编辑</Button>
                <Popconfirm
                  title={`删除凭据「${item.label}」？`}
                  description="删除后，依赖它的 git 操作会退回系统默认身份（git clone 私有仓库会失败），直到你重新配置。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => {
                    removeCredential.mutate(item.id, {
                      onSuccess: (result) => feedback.ok(`已删除凭据「${result.label}」`),
                      onError: (error) => feedback.fail(error, '删除凭据失败'),
                    })
                  }}
                >
                  <Button danger>删除</Button>
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        title={editing === null ? '新建 git 凭据' : `编辑「${editing.label}」`}
        open={open}
        confirmLoading={createCredential.isPending || updateCredential.isPending}
        onOk={submit}
        onCancel={() => setOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 'var(--sp-4)' }}
          message="值只在保存时提交一次，之后界面上不再展示（不提供掩码）。编辑时秘密字段留空 = 不变。"
        />
        <Form form={form} layout="vertical" initialValues={{ kind: 'SSH_KEY' }}>
          <Form.Item name="label" label="名称" rules={[{ required: true, message: '给这条凭据起个名字' }]}>
            <Input placeholder="如 github-work" maxLength={128} />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select
              disabled={editing !== null}
              options={[
                { value: 'SSH_KEY', label: 'SSH 私钥（deploy key）' },
                { value: 'HTTPS_TOKEN', label: 'HTTPS 令牌（PAT）' },
              ]}
            />
          </Form.Item>
          <Form.Item name="host" label="限定主机（可选）">
            <Input placeholder="如 github.com；留空 = 不限" maxLength={255} />
          </Form.Item>

          {kind === 'SSH_KEY' ? (
            <>
              <Form.Item
                name="privateKey"
                label={editing === null ? '私钥（OpenSSH 文本）' : '替换私钥（留空 = 不变）'}
                rules={editing === null ? [{ required: true, message: '粘贴私钥内容' }] : []}
              >
                <Input.TextArea rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
              </Form.Item>
              <Form.Item name="knownHosts" label="known_hosts（可选）">
                <Input.TextArea rows={2} placeholder="留空则首次连接自动接受主机指纹（accept-new）" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item
                name="token"
                label={editing === null ? '访问令牌（PAT）' : '替换令牌（留空 = 不变）'}
                rules={editing === null ? [{ required: true, message: '粘贴访问令牌' }] : []}
              >
                <Input.Password placeholder="ghp_…" />
              </Form.Item>
              <Form.Item name="username" label="用户名（可选）">
                <Input placeholder="默认 x-access-token（GitLab 可用 oauth2）" maxLength={128} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </section>
  )
}
