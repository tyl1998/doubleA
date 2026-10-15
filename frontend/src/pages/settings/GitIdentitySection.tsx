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

interface FormValues {
  name?: string
  email?: string
}

export function GitIdentitySection() {
  const feedback = useFeedback()
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
          onSuccess: () =>
            feedback.ok('已保存 git 身份（下一次重建容器时生效）'),
          onError: (error) => feedback.fail(error, '保存 git 身份失败'),
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
          <h2 className="card__title">Git 提交身份</h2>
          <p className="page__lead">
            Code 模式下 agent 在容器里 <code>git commit</code> 时用的署名（<code>user.name</code> /{' '}
            <code>user.email</code>）。配好后<strong>按你注入</strong>，agent 不必自己猜、也不写仓库本地 config。
            两个都留空 = 不注入（由 agent 自行处理）。
          </p>
        </div>
      </div>

      {query.isError ? (
        <ErrorState
          title="git 身份加载失败"
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
          <Form.Item name="name" label="名字（user.name）">
            <Input placeholder="如 Zhang San" maxLength={128} />
          </Form.Item>
          <Form.Item
            name="email"
            label="邮箱（user.email）"
            rules={[
              {
                validator: (_, value: string | undefined) =>
                  value === undefined || value === '' || /^[^\s@]+@[^\s@]+$/u.test(value)
                    ? Promise.resolve()
                    : Promise.reject(new Error('邮箱格式不正确（应形如 name@example.com）')),
              },
            ]}
          >
            <Input placeholder="如 zhangsan@example.com" maxLength={255} />
          </Form.Item>
          <Button type="primary" loading={update.isPending} onClick={submit}>
            保存
          </Button>
        </Form>
      )}
    </section>
  )
}
