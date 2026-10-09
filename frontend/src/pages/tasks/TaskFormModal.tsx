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
import { isValidCron, NOTIFY_TEMPLATE_PLACEHOLDERS, NOTIFY_TYPES } from '@doubulea/shared'

import { CRON_PRESETS, NOTIFY_TYPE_LABELS, cronHint } from './taskModel.js'

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
  const isEdit = task !== null
  // 联动：只有选了具体渠道才显示 webhook 地址/密钥（`NONE` 时整块隐藏）
  const notifyType = Form.useWatch('notifyType', form)
  const notifySelected = notifyType !== undefined && notifyType !== 'NONE'
  const cronExprValue = Form.useWatch('cronExpr', form)
  const cronParsed = cronExprValue === undefined ? { description: null, next: [] } : cronHint(cronExprValue)
  // cron 的辅助说明：合法时带上"一句话描述 + 接下来 3 次"，交给 AntD 的 extra 排版（不用手写 div，避免重叠）
  const cronExtra =
    cronParsed.next.length > 0
      ? `可直接手填，也可从常用周期里选。${cronParsed.description !== null ? `约 ${cronParsed.description}；` : ''}接下来：${cronParsed.next.join('、')}`
      : '可直接手填，也可从常用周期里选；例如 0 9 * * * = 每天 09:00、0 9 * * 1 = 每周一 09:00（时区 = 服务器本地时区）'

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
      title={isEdit ? '编辑定时任务' : '新建定时任务'}
      onCancel={onCancel}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button
          key="ok"
          type="primary"
          loading={submitting}
          onClick={() => {
            void form.validateFields().then(onSubmit)
          }}
        >
          保存
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="name"
          label="任务名"
          rules={[{ required: true, message: '请填写任务名' }, { max: 120, message: '最长 120 个字符' }]}
        >
          <Input placeholder="例如：每日销售汇总" maxLength={120} />
        </Form.Item>

        <Form.Item
          name="agentId"
          label="目标智能体"
          rules={[{ required: true, message: '请选择智能体' }]}
          extra={isEdit ? '目标智能体不可修改（换智能体请删除后重建）' : 'ChatBot 与任务型智能体（TaskAgent）都可以被定时派活'}
        >
          <Select
            placeholder="选择一个智能体"
            disabled={isEdit}
            options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>

        <Form.Item
          name="prompt"
          label="指令（到点发给该智能体）"
          rules={[{ required: true, message: '请填写指令' }]}
        >
          <Input.TextArea rows={4} placeholder="例如：统计昨天的订单并生成汇总表" maxLength={20_000} showCount />
        </Form.Item>

        <Form.Item
          name="cronExpr"
          label="cron 周期（分 时 日 月 周）"
          rules={[
            { required: true, message: '请填写 cron 表达式' },
            {
              validator: (_rule, value: string) =>
                value === undefined || value.trim() === '' || isValidCron(value.trim())
                  ? Promise.resolve()
                  : Promise.reject(new Error('cron 表达式不合法（5 段：分 时 日 月 周）')),
            },
          ]}
          extra={cronExtra}
        >
          <AutoComplete
            placeholder="0 9 * * *"
            options={CRON_PRESETS.map((preset) => ({ value: preset.expr, label: `${preset.label}  ·  ${preset.expr}` }))}
            filterOption={(input, option) =>
              String(option?.label ?? option?.value ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item
          name="autoApprove"
          label="允许执行危险工具（MCP 破坏性操作）"
          valuePropName="checked"
          extra="定时任务无人值守运行、没有第二个人能确认。打开 = 遇到危险工具自动放行；关闭 = 一律拒绝。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="notifyType"
          label="通知渠道"
          extra="任务跑完会把结果自动推送到该渠道；智能体也能用 send_notification 工具主动发消息。"
        >
          <Select options={NOTIFY_TYPES.map((type) => ({ value: type, label: NOTIFY_TYPE_LABELS[type] }))} />
        </Form.Item>

        {notifySelected && (
          <>
            <Form.Item
              name="notifyUrl"
              label="webhook 地址"
              rules={[
                {
                  validator: (_rule, value: string) =>
                    isEdit && task.notifyUrlSet
                      ? Promise.resolve() // 已配置且留空 = 保持不变
                      : value !== undefined && value.trim() !== ''
                        ? Promise.resolve()
                        : Promise.reject(new Error('选择了通知渠道就必须填写 webhook 地址')),
                },
              ]}
              extra={
                isEdit && task.notifyUrlSet
                  ? '已配置；留空保持不变（把「通知渠道」改为「不通知」即可停用）'
                  : notifyType === 'WECOM'
                    ? '企业微信群机器人的完整 webhook URL（含 key，加密存储、不回显）'
                    : notifyType === 'FEISHU'
                      ? '飞书自定义机器人的完整 webhook URL（加密存储、不回显）'
                      : '通用 webhook URL：后端会 POST `{ text }`（加密存储、不回显）'
              }
            >
              <Input placeholder={isEdit && task.notifyUrlSet ? '（已配置，留空保持不变）' : 'https://…'} />
            </Form.Item>

            {notifyType === 'FEISHU' && (
              <Form.Item
                name="notifySecret"
                label="签名密钥（飞书自定义机器人可选）"
                extra={
                  isEdit && task.notifySecretSet
                    ? '已配置；留空保持不变'
                    : '仅飞书机器人开启「签名校验」时才需要；未开启可留空'
                }
              >
                <Input.Password placeholder={isEdit && task.notifySecretSet ? '（已配置，留空保持不变）' : '可留空'} />
              </Form.Item>
            )}

            <Form.Item
              name="notifyTemplate"
              label="通知模板（可选）"
              extra={`占位符：${NOTIFY_TEMPLATE_PLACEHOLDERS.map((item) => `{{${item.key}}} = ${item.label}`).join('、')}；留空用内置默认（抬头 + 时间/状态 + 正文）`}
            >
              <Input.TextArea
                rows={3}
                maxLength={2000}
                placeholder={'【定时任务】{{task}}\n时间：{{time}}　状态：{{status}}\n\n{{result}}'}
              />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  )
}
