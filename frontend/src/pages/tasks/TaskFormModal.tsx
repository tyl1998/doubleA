/**
 * 定时任务表单弹窗（P1-6，2026-10-09 需求变更）—— 新建 / 编辑
 *
 * 依据：`docs/03` §4.7、`shared/src/task.ts`。
 *
 * 五个字段：任务名 / 目标 TaskAgent / 指令 / cron / 启停。
 * ⚠️ **目标 Agent 不可在编辑时改**（换 Agent = 换任务意图，删了重建更清楚；后端 `agentId` 也不收），
 * 故编辑态把 Agent 下拉禁用并说明原因。
 * ⚠️ cron 合法性用 `shared#isValidCron` 即时校验（与后端同一份解析器），错误文案来自 `shared`。
 */

import { AutoComplete, Button, Form, Input, Modal, Select, Switch } from 'antd'
import { useEffect } from 'react'
import type { AgentItem, NotifyType, ScheduledTaskItem } from '@doubulea/shared'
import type { MessageKey } from '@doubulea/shared'
import { isValidCron, NOTIFY_TEMPLATE_PLACEHOLDERS, NOTIFY_TYPES } from '@doubulea/shared'

/** 通知模板占位符的 key（`shared#NOTIFY_TEMPLATE_PLACEHOLDERS` 的前端覆盖，§3.5） */
const NOTIFY_PLACEHOLDER_KEY: Record<(typeof NOTIFY_TEMPLATE_PLACEHOLDERS)[number]['key'], MessageKey> = {
  task: 'label.notifyPlaceholder.task',
  time: 'label.notifyPlaceholder.time',
  status: 'label.notifyPlaceholder.status',
  result: 'label.notifyPlaceholder.result',
}

import { useT } from '../../app/i18n.js'
import { CRON_PRESETS, NOTIFY_TYPE_KEY, cronHint } from './taskModel.js'

export interface TaskFormValues {
  name: string
  agentId: string
  prompt: string
  cronExpr: string
  enabled: boolean
  autoApprove: boolean
  notifyType: NotifyType
  notifyUrl: string
  notifySecret: string
  notifyTemplate: string
}

export interface TaskFormModalProps {
  open: boolean
  /** 编辑时给当前任务；新建时为 `null` */
  task: ScheduledTaskItem | null
  /** 可选的目标智能体（ChatBot / TaskAgent 都可被定时派活） */
  agents: readonly AgentItem[]
  submitting: boolean
  onCancel: () => void
  onSubmit: (values: TaskFormValues) => void
}

export function TaskFormModal({ open, task, agents, submitting, onCancel, onSubmit }: TaskFormModalProps) {
  const [form] = Form.useForm<TaskFormValues>()
  const { t, locale } = useT()
  const isEdit = task !== null
  // 联动：只有选了具体渠道才显示 webhook 地址/密钥（`NONE` 时整块隐藏）
  const notifyType = Form.useWatch('notifyType', form)
  const notifySelected = notifyType !== undefined && notifyType !== 'NONE'
  const cronExprValue = Form.useWatch('cronExpr', form)
  const cronParsed = cronExprValue === undefined ? { description: null, next: [] } : cronHint(cronExprValue, locale)
  // cron 的辅助说明：合法时带上"一句话描述 + 接下来 3 次"，交给 AntD 的 extra 排版（不用手写 div，避免重叠）
  // ⚠️ `cronParsed.description` 来自 `shared#describeCron(expr, locale)`（P1-23 末批起走字典），
  // 故 en 下"约 每天 09:00；"这句也是英文；`next` 的周几读数同样走 `label.weekday.*`。
  const cronExtra =
    cronParsed.next.length > 0
      ? t('tasks.form.cronHintParsed', {
          approx:
            cronParsed.description === null
              ? ''
              : t('tasks.form.cronApprox', { desc: cronParsed.description }),
          next: cronParsed.next.join(t('tasks.form.cronNextSeparator')),
        })
      : t('tasks.form.cronHintPlain')

  useEffect(() => {
    if (!open) return
    if (task === null) {
      form.setFieldsValue({
        name: '',
        agentId: undefined,
        prompt: '',
        cronExpr: '0 9 * * *',
        enabled: true,
        autoApprove: true,
        notifyType: 'NONE',
        notifyUrl: '',
        notifySecret: '',
        notifyTemplate: '',
      })
    } else {
      form.setFieldsValue({
        name: task.name,
        agentId: task.agentId,
        prompt: task.prompt,
        cronExpr: task.cronExpr,
        enabled: task.enabled,
        autoApprove: task.autoApprove,
        notifyType: task.notifyType,
        notifyUrl: '',
        notifySecret: '',
        notifyTemplate: task.notifyTemplate ?? '',
      })
    }
  }, [open, task, form])

  return (
    <Modal
      open={open}
      title={isEdit ? t('tasks.form.editTitle') : t('tasks.form.createTitle')}
      onCancel={onCancel}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel}>
          {t('common.cancel')}
        </Button>,
        <Button
          key="ok"
          type="primary"
          loading={submitting}
          onClick={() => {
            void form.validateFields().then(onSubmit)
          }}
        >
          {t('common.save')}
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="name"
          label={t('tasks.form.name')}
          rules={[
            { required: true, message: t('tasks.form.nameRequired') },
            { max: 120, message: t('tasks.form.nameMax') },
          ]}
        >
          <Input placeholder={t('tasks.form.namePlaceholder')} maxLength={120} />
        </Form.Item>

        <Form.Item
          name="agentId"
          label={t('tasks.form.agent')}
          rules={[{ required: true, message: t('tasks.form.agentRequired') }]}
          extra={isEdit ? t('tasks.form.agentLockedExtra') : t('tasks.form.agentFreeExtra')}
        >
          <Select
            placeholder={t('tasks.form.agentPlaceholder')}
            disabled={isEdit}
            options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>

        <Form.Item
          name="prompt"
          label={t('tasks.form.prompt')}
          rules={[{ required: true, message: t('tasks.form.promptRequired') }]}
        >
          <Input.TextArea
            rows={4}
            placeholder={t('tasks.form.promptPlaceholder')}
            maxLength={20_000}
            showCount
          />
        </Form.Item>

        <Form.Item
          name="cronExpr"
          label={t('tasks.form.cron')}
          rules={[
            { required: true, message: t('tasks.form.cronRequired') },
            {
              validator: (_rule, value: string) =>
                value === undefined || value.trim() === '' || isValidCron(value.trim())
                  ? Promise.resolve()
                  : Promise.reject(new Error(t('tasks.form.cronInvalid'))),
            },
          ]}
          extra={cronExtra}
        >
          <AutoComplete
            placeholder="0 9 * * *"
            options={CRON_PRESETS.map((preset) => ({ value: preset.expr, label: `${t(preset.labelKey)}  ·  ${preset.expr}` }))}
            filterOption={(input, option) =>
              String(option?.label ?? option?.value ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item name="enabled" label={t('tasks.form.enabled')} valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item
          name="autoApprove"
          label={t('tasks.form.autoApprove')}
          valuePropName="checked"
          extra={t('tasks.form.autoApproveExtra')}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="notifyType"
          label={t('tasks.form.notifyType')}
          extra={t('tasks.form.notifyTypeExtra')}
        >
          <Select options={NOTIFY_TYPES.map((type) => ({ value: type, label: t(NOTIFY_TYPE_KEY[type]) }))} />
        </Form.Item>

        {notifySelected && (
          <>
            <Form.Item
              name="notifyUrl"
              label={t('tasks.form.webhookUrl')}
              rules={[
                {
                  validator: (_rule, value: string) =>
                    isEdit && task.notifyUrlSet
                      ? Promise.resolve() // 已配置且留空 = 保持不变
                      : value !== undefined && value.trim() !== ''
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('tasks.form.webhookRequired'))),
                },
              ]}
              extra={
                isEdit && task.notifyUrlSet
                  ? t('tasks.form.webhookConfigured')
                  : notifyType === 'WECOM'
                    ? t('tasks.form.webhookWecom')
                    : notifyType === 'FEISHU'
                      ? t('tasks.form.webhookFeishu')
                      : t('tasks.form.webhookGeneric')
              }
            >
              <Input placeholder={isEdit && task.notifyUrlSet ? t('tasks.form.webhookPlaceholderConfigured') : 'https://…'} />
            </Form.Item>

            {notifyType === 'FEISHU' && (
              <Form.Item
                name="notifySecret"
                label={t('tasks.form.secret')}
                extra={isEdit && task.notifySecretSet ? t('tasks.form.secretConfigured') : t('tasks.form.secretHint')}
              >
                <Input.Password
                  placeholder={
                    isEdit && task.notifySecretSet
                      ? t('tasks.form.webhookPlaceholderConfigured')
                      : t('tasks.form.secretPlaceholder')
                  }
                />
              </Form.Item>
            )}

            <Form.Item
              name="notifyTemplate"
              label={t('tasks.form.template')}
              extra={t('tasks.form.templateExtra', {
                placeholders: NOTIFY_TEMPLATE_PLACEHOLDERS
                  .map((item) => `{{${item.key}}} = ${t(NOTIFY_PLACEHOLDER_KEY[item.key])}`)
                  .join(t('tasks.form.cronNextSeparator')),
              })}
            >
              <Input.TextArea
                rows={3}
                maxLength={2000}
                placeholder={t('tasks.form.templatePlaceholder')}
              />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  )
}
