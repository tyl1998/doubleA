/**
 * 「系统模型」区块（模型池页 `/admin/models` 内嵌；**仅 ADMIN** 渲染）
 *
 * 依据：契约 `shared/src/titleModel.ts`、服务 `services/titleModel.service.ts`。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是模型池页里的一个区块，而不是单开一页
 * ─────────────────────────────────────────────────────────────────────
 * 它配的就是"**模型池里选哪个模型**"（会话标题生成用哪个模型）—— 与模型池是同一个主题、
 * 同一批下拉数据（`GET /api/models/available?type=CHAT`），单开一页会成为"只有两个控件的孤岛"。
 * 故并入模型池页，作为页顶一个 ADMIN 才看得见的区块。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这一块在配什么
 * ─────────────────────────────────────────────────────────────────────
 * 会话标题默认由**首条消息原文截断**得到（`deriveConversationTopic`）—— 简单、零成本、永不失败，
 * 但标题就是原话（长、不精炼）。这里可以**额外**指定一个**廉价模型**，把首条消息压成更精炼的短标题。
 *
 * 三条口径：
 *   · **总开关**（`enabled`）：关掉即全体回落确定性截断（模型留着但不生效）；
 *   · **选定模型**（`modelId`）：模型池里 `type=CHAT` 的模型；留空 = 未配置（同样回落）；
 *   · **失败一律回落**：未配置 / 模型被删 / 停用 / Provider 停用 / 缺 Key / 调用报错 / 回复解析不出，
 *     都会**保留**那条确定性标题 —— 这里的配置永远不会让会话标题"变成新会话"。
 */

import { Alert, Button, Select, Spin, Switch, Tag } from 'antd'
import { useEffect, useState } from 'react'

import { useAvailableChatModels } from '../../api/models.js'
import { useTitleModel, useUpdateTitleModel } from '../../api/titleModel.js'
import { useFeedback } from '../../app/feedback.js'

export function SystemModelSection() {
  const feedback = useFeedback()
  const query = useTitleModel()
  const models = useAvailableChatModels()
  const save = useUpdateTitleModel()

  /** 表单态；`null` = 还没从服务端铺过（首帧）。`modelId` 空串表示"未配置" */
  const [form, setForm] = useState<{ enabled: boolean; modelId: string } | null>(null)

  useEffect(() => {
    if (query.data !== undefined && form === null) {
      setForm({ enabled: query.data.enabled, modelId: query.data.modelId ?? '' })
    }
  }, [query.data, form])

  const submit = (): void => {
    if (form === null) return
    save.mutate(
      { enabled: form.enabled, modelId: form.modelId === '' ? null : form.modelId },
      {
        onSuccess: () => feedback.ok('标题模型配置已保存'),
        onError: (error) => feedback.fail(error, '保存标题模型配置失败'),
      },
    )
  }

  const options = (models.data?.items ?? []).map((model) => ({
    value: model.id,
    label: `${model.label}（${model.providerName} · ${model.modelName}）`,
  }))

  const active = query.data?.enabled === true && query.data.modelId !== null

  return (
    <section className="admin-section">
      <div className="card">
        <div className="card__head">
          <h2 className="card__title">系统模型</h2>
          <Tag>平台级</Tag>
          <div className="card__head-right">
            <span className="ratio">
              会话标题：
              {active ? (
                <Tag color="green" style={{ marginInlineStart: 6 }}>
                  {query.data?.modelLabel ?? '已启用'}
                </Tag>
              ) : (
                <Tag style={{ marginInlineStart: 6 }}>原文截断</Tag>
              )}
            </span>
          </div>
        </div>

        <div className="card__body stack">
          <Alert
            type="info"
            showIcon
            message="会话标题生成"
            description={
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                <li>
                  会话标题默认取自<strong>首条消息的原文截断</strong>；指定一个<strong>廉价模型</strong>
                  后，会用它把首条消息压成更精炼的短标题（平台级，所有会话共用）。
                </li>
                <li>
                  <strong>失败一律回落</strong>：未配置 / 模型被删 / 停用 / Provider 停用 / 缺 Key / 调用报错，
                  都<strong>保留</strong>原文截断的标题 —— 本配置不会让标题变成「新会话」。
                </li>
                <li>
                  生成发生在<strong>首条消息落库之后、异步</strong>，不阻塞回答；只升级<strong>自动生成</strong>
                  的标题，<strong>用户手动改过的标题永不被覆盖</strong>。
                </li>
                <li>要求所选 Provider 已配 Key；「各自 Key」模式的 Provider 不适用于平台级标题生成。</li>
              </ul>
            }
          />

          {query.isLoading || form === null ? (
            <Spin />
          ) : (
            <>
              <div className="stack stack--tight" style={{ maxWidth: 560 }}>
                <div className="row" style={{ gap: 'var(--sp-3)' }}>
                  <Switch checked={form.enabled} onChange={(checked) => setForm({ ...form, enabled: checked })} />
                  <span className="block-label" style={{ marginBottom: 0 }}>
                    启用模型生成标题
                  </span>
                  <span className="ratio">关闭 = 只用原文截断</span>
                </div>

                <label className="block-label" htmlFor="system-title-model">
                  标题模型
                </label>
                <Select
                  id="system-title-model"
                  style={{ width: '100%' }}
                  allowClear
                  placeholder="留空 = 未配置（回落原文截断）"
                  value={form.modelId === '' ? undefined : form.modelId}
                  loading={models.isLoading}
                  options={options}
                  onChange={(value: string | undefined) => setForm({ ...form, modelId: value ?? '' })}
                />
              </div>

              <div className="row" style={{ gap: 'var(--sp-3)' }}>
                <Button type="primary" loading={save.isPending} onClick={submit}>
                  保存
                </Button>
                {query.data !== undefined && (
                  <span className="ratio">上次更新 {new Date(query.data.updatedAt).toLocaleString()}</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}