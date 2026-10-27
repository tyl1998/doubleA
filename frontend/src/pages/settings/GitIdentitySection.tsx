/**
 * Git 提交身份**区块**（P1-20；由 `/settings/credentials`「我的凭据」页内嵌）
 *
 * 依据（用户反馈 2026-10-15）：容器里原本没有 git 身份 ⇒ agent 只能自己猜署名（沿用 SSH key 的身份）
 * 并写进仓库本地 config，错了还得 `git commit --amend` + 强推。这里让**每个用户**配自己的提交身份，
 * 派活时经 `GIT_CONFIG_*` 注入容器 git 的 `user.name`/`user.email`。
 *
 * ⚠️ 与 git **凭据**同页、但属性相反：身份是**公开信息**（提交署名），可读可回填；
 *    两个字段都留空 = 平台不注入（回到 agent 自行处理的旧行为）。
 * ⚠️ 身份随建容器那一刻的 env 定死 ⇒ **改完要等下一次重建容器生效**（已起的容器不会热更新）。
 */

import { Button, Form, Input } from 'antd'
import { useEffect } from 'react'

import { useGitIdentity, useUpdateGitIdentity } from '../../api/gitIdentity.js'
import { ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { useFeedback } from '../../app/feedback.js'
import { useT } from '../../app/i18n.js'

interface FormValues {
  name?: string
  email?: string
}

export function GitIdentitySection() {
  const feedback = useFeedback()
  const { t } = useT()
  const query = useGitIdentity()
  const update = useUpdateGitIdentity()
  const [form] = Form.useForm<FormValues>()

  // 拉到现值后回填（身份是公开信息，可回填；与只写的凭据表单不同）
  useEffect(() => {
    if (query.data !== undefined) {
      form.setFieldsValue({ name: query.data.name ?? '', email: query.data.email ?? '' })
    }
  }, [query.data, form])

  function submit(): void {
    void form.validateFields().then((values) => {
      update.mutate(
        // 两个字段始终一起提交：空串 = 清空该字段（服务端归一成 null）
        { name: values.name ?? '', email: values.email ?? '' },
        {
          onSuccess: () => feedback.ok(t('settings.gitIdentity.saved')),
          onError: (error) => feedback.fail(error, t('settings.gitIdentity.saveFailed')),
        },
      )
    })
  }

  return (
    <section
      className="admin-section"
      style={{ marginTop: 'var(--sp-8)', paddingTop: 'var(--sp-6)', borderTop: '1px solid var(--rule-strong)' }}
    >
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 className="card__title">{t('settings.gitIdentity.title')}</h2>
          <p className="page__lead">
            {t('settings.gitIdentity.leadA')} <code>git commit</code> {t('settings.gitIdentity.leadB')}
            <code>user.name</code> / <code>user.email</code>
            {t('settings.gitIdentity.leadC')}
            <strong>{t('settings.gitIdentity.leadStrong')}</strong>
            {t('settings.gitIdentity.leadD')}
          </p>
        </div>
      </div>

      {query.isError ? (
        <ErrorState
          title={t('settings.gitIdentity.loadFailed')}
          error={query.error}
          retrying={query.isFetching}
          onRetry={() => {
            void query.refetch()
          }}
        />
      ) : query.isPending ? (
        <TableSkeleton rows={2} />
      ) : (
        <Form form={form} layout="vertical" style={{ maxWidth: 480 }}>
          <Form.Item name="name" label={t('settings.gitIdentity.nameLabel')}>
            <Input placeholder={t('settings.gitIdentity.namePlaceholder')} maxLength={128} />
          </Form.Item>
          <Form.Item
            name="email"
            label={t('settings.gitIdentity.emailLabel')}
            rules={[
              {
                validator: (_, value: string | undefined) =>
                  value === undefined || value === '' || /^[^\s@]+@[^\s@]+$/u.test(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('settings.gitIdentity.emailInvalid'))),
              },
            ]}
          >
            <Input placeholder={t('settings.gitIdentity.emailPlaceholder')} maxLength={255} />
          </Form.Item>
          <Button type="primary" loading={update.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </Form>
      )}
    </section>
  )
}
