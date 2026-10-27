/**
 * 智能体创建 / 编辑（`/agents/new` 与 `/agents/:id/edit` 共用一页，P0-1-31）
 *
 * 依据：`docs/03-前端设计.md` §4.2（**独立页分区表单**：基本信息 / 模型 / 提示词 / 组件绑定四区；
 *      保存 = `PATCH /api/agents/:id` + `PUT …/components` **串行**；任一失败停留页面并标注
 *      未保存区块，不静默部分成功）、§七（保存语义、创建与编辑同形态、删除分级确认）、
 *      `design/agent-edit.html`（四区 + 吸底保存条 + 右侧摘要 + 危险区）；`shared/src/agent.ts`（三态）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 本批**必须兑现**的修复项：双请求保存的失败处理（`06` P0-1-31 的坑预判，不是可选项）
 * ─────────────────────────────────────────────────────────────────────
 * 保存要发两个请求，而它们**各自可能成功/失败**。三种错误做法：
 *   · 两个都发、只看最后一个的结果 ⇒ 文本没保存却提示"保存成功"（静默部分成功）；
 *   · 第一个失败就 return ⇒ 用户以为"什么都没变"，而库里可能已经变了一半；
 *   · 用 `Promise.all` ⇒ 两个请求的**顺序**没了（"先 PATCH 再 PUT"的约定被破坏），
 *     而且一个失败时另一个仍可能落库，返回的错误却只有一个。
 * 本页的做法（{@link AgentForm} 的 `runSave`）：
 *   **串行执行 + 每步各自记账**。每个成功的步骤立刻把"最后一次落库的快照"往前推一格，
 *   失败的步骤把错误记到**它覆盖的那个区块**上。全程结束后：
 *   还有失败 ⇒ 停留本页，页面顶部列出「哪个区块 + 错误码 + 文案」，区块左侧刻度变红并挂
 *   「保存失败」标签（对照：只是改了还没保存的区块挂「未保存」）；全成功 ⇒ 提示 + 回列表。
 *   「重试未保存的区块」重跑同一段逻辑 —— 因为它是按**差异**决定发哪个请求的，
 *   重试天然只重发还没落库的那部分（已成功的部分不会再发一次）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 三态不是"多写一个分支"，而是别把没改的字段也发出去
 * ─────────────────────────────────────────────────────────────────────
 * `PATCH` 的字段语义是 **不带 = 不动 / `null` = 清空 / 值 = 设置**。所以"只发变化了的字段"
 * 由 `agentModel.ts` 的 `buildUpdateBody` 统一算（含"清空 = 发 null"），本文件不自己拼 body
 * —— 手拼一次就多一份会漂移的口径。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 表单校验直接用 `shared` 的 schema（`03` §一 的纪律）
 * ─────────────────────────────────────────────────────────────────────
 * 提交前对请求体跑一次 `createAgentBodySchema` / `updateAgentBodySchema` 的 `safeParse`，
 * 失败就把 issue 落到对应输入框上。这样"前端不让填的、后端也不会过"，且**长度上限、必填文案
 * 只有一份**（`shared` 里的常量 + 消息）。AntD 的 `rules` 只保留"必填"这种纯表单约定。
 * ⚠️ 原型上的"长度上限 8 000 字"是**装饰数字**（真上限 10000，取 `shared` 的常量）：照抄原型
 * 会让用户按一个不存在的规则删改自己的提示词。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ MCP 区在本阶段是**诚实的空态**，不是"忘了做"
 * ─────────────────────────────────────────────────────────────────────
 * `06` P0-1-23 定案：`mcp_servers` 表属 P0-2，本阶段 `PUT …/components` **明确拒绝 MCP 引用（400）**。
 * 所以这里**不渲染 server 多选**（渲染了就是让用户选完再吃一个 400），而是说明"属 P0-2"；
 * 若库里**已经**有 MCP 绑定（只可能由手工写库产生），给一条警示：本页保存时会被清掉
 * （整体替换的语义就是"提交的集合就是全部"）—— 不藏。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑤ 他人创建的智能体：深链进来只给一页说明，不渲染表单
 * ─────────────────────────────────────────────────────────────────────
 * `03` §二 的权限列是「创建者/ADMIN」。列表里已经不给入口（`AgentItem.canEdit`），但**手敲 URL**
 * 依然到得了本页 —— 那时后端会给 `canEdit: false`。这里刻意**不渲染禁用态的表单**：
 * 表单禁用只能表达"现在不能改"，而用户真正的疑问是"为什么"以及"我还能拿它做什么"。
 * 一页说明 + 「用这个智能体开一个会话」把两件事都答了（且不用维护第二套布局）。
 */

import { Alert, Button, Checkbox, Form, Input, Radio, Select, Tag } from 'antd'
import {
  AGENT_DESCRIPTION_MAX_CHARS,
  AGENT_OPENING_REMARKS_MAX_CHARS,
  AGENT_SYSTEM_PROMPT_MAX_CHARS,
  AGENT_TYPES,
  ASSET_VISIBILITIES,
  ASSET_VISIBILITY_KEY,
  GUIDE_QUESTION_MAX_CHARS,
  GUIDE_QUESTIONS_MAX,
  createAgentBodySchema,
  translate,
  updateAgentBodySchema,
  type AgentComponentInput,
  type AgentItem,
} from '@doubulea/shared'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { useAgent, useCreateAgent, useReplaceAgentComponents, useUpdateAgent } from '../../api/agents.js'
import { describeError } from '../../api/client.js'
import { useMyConversationCount } from '../../api/conversations.js'
import { useKnowledgeBases } from '../../api/knowledgeBases.js'
import { useMcpServers, useMcpServerTools, useMyCredentials } from '../../api/mcp.js'
import { useAvailableChatModels } from '../../api/models.js'
import { useFeedback } from '../../app/feedback.js'
import { usePageCrumb } from '../../app/crumbContext.js'
import { useT } from '../../app/i18n.js'
import { AGENTS_PATH, chatPath, credentialsPath, credentialsSectionPath } from '../../app/paths.js'
import { AudiencePicker } from '../../components/AudiencePicker.js'
import { ErrorState, TableSkeleton } from '../../components/ListStates.js'
import { DeleteAgentModal } from './DeleteAgentModal.js'
import {
  AGENT_SECTIONS,
  AGENT_SECTION_LABEL_KEY,
  AGENT_TYPE_HINT_KEY,
  AGENT_TYPE_LABEL,
  EMPTY_AGENT_FORM_VALUES,
  buildCreateBody,
  buildUpdateBody,
  changedSections,
  componentsFromAgent,
  formatUpdatedAt,
  knowledgeIdsOf,
  knowledgeSelectionOf,
  mcpIdsOf,
  mcpSelectionOf,
  orderSections,
  pinnedMcpToolsOf,
  sameComponentSet,
  sectionOrdinal,
  sectionsOfUpdateBody,
  submittableComponents,
  valuesFromAgent,
  type AgentFormValues,
  type AgentPageSectionKey,
  type AgentSectionKey,
} from './agentModel.js'

/**
 * 受众字段的 AntD 适配层（P1-18）：把 `Form.Item name="audience"` 的 `{ value, onChange }`
 * 接到 {@link AudiencePicker} 的 `userIds`/`groupIds` 两个入参上 —— 于是 zod 的
 * `path: ['audience']` 能精确挂到这一项（空受众的 400 文案有处可显）。
 */
function AudienceField({
  value,
  onChange,
  knownUsers,
  disabled,
}: {
  value?: { userIds: string[]; groupIds: string[] }
  onChange?: (next: { userIds: string[]; groupIds: string[] }) => void
  /** 已保存受众的用户回显（`id + 显示名`），用于打开时展示名字而非 id */
  knownUsers?: { id: string; name: string }[]
  disabled?: boolean
}) {
  return (
    <AudiencePicker
      userIds={value?.userIds ?? []}
      groupIds={value?.groupIds ?? []}
      knownUsers={knownUsers}
      onChange={(next) => onChange?.(next)}
      disabled={disabled}
    />
  )
}

// ═════════════════════════════ 数据编排（两条路由各自入口） ═════════════════════════════/** 新建入口（`/agents/new`） */
export function AgentCreatePage() {
  return <AgentFormPage />
}

/** 编辑入口（`/agents/:id/edit`）。`:id` 一定存在（路由里有），拿不到时下面的分支会兜住 */
export function AgentEditPage() {
  const { id } = useParams<{ id: string }>()
  return <AgentFormPage agentId={id} />
}

function AgentFormPage({ agentId }: { agentId?: string }) {
  const agentQuery = useAgent(agentId)
  const { t } = useT()

  // 面包屑已挪到顶栏：这里把"创建 / 编辑 · 名称"作为「细节段」上报
  //（顶栏渲染 `工作台 / 智能体 / <detail>`）
  const crumbDetail =
    agentId === undefined
      ? t('agentForm.crumbCreate')
      : agentQuery.data !== undefined
        ? t('agentForm.crumbEditName', { name: agentQuery.data.name })
        : t('agentForm.crumbEdit')
  usePageCrumb(crumbDetail)

  if (agentId !== undefined && agentQuery.isPending) {
    return (
      <>
        <EditHead title={t('agentForm.editTitle')} lead={t('agentForm.loadingLead')} />
        <TableSkeleton rows={4} />
      </>
    )
  }

  if (agentId !== undefined && agentQuery.isError) {
    return (
      <>
        <EditHead title={t('agentForm.editTitle')} lead={t('agentForm.notFoundLead')} />
        <ErrorState
          title={t('agentForm.loadFailedTitle')}
          error={agentQuery.error}
          retrying={agentQuery.isFetching}
          onRetry={() => {
            void agentQuery.refetch()
          }}
        />
      </>
    )
  }

  // `initialItem` 只在**挂载那一刻**决定表单初值（`key` 保证换 id 时重挂载），之后别的页面写操作
  // 引发的失效重拉**不会**覆盖用户正在编辑的内容 —— 见文件头 ① 的"快照往前走"。
  return <AgentForm key={agentId ?? 'new'} initialItem={agentQuery.data} />
}

function EditHead({ title, lead }: { title: string; lead: string }) {
  return (
    <>
      <div className="page__head">
        <div>
          <h1>{title}</h1>
          <p className="page__lead">{lead}</p>
        </div>
      </div>
    </>
  )
}

// ═════════════════════════════ 表单主体 ═════════════════════════════

/** 一次保存里某个区块的失败记录（驱动"标红 + 列出原因"） */
interface SaveFailure {
  section: AgentSectionKey
  code: string
  message: string
}

/** "最后一次落库的快照"：文本/模型字段 + 组件绑定（分别由 PATCH 与 PUT 推进） */
interface SavedSnapshot {
  values: AgentFormValues
  components: AgentComponentInput[]
}

function toFailures(sections: readonly AgentSectionKey[], error: unknown): SaveFailure[] {
  const { code, message } = describeError(error)
  return sections.map((section) => ({ section, code, message }))
}

/** `shared` 的 `GUIDE_QUESTION_MAX_CHARS` 之外，单条引导问题在这里没有额外约束 */
function AgentForm({ initialItem }: { initialItem?: AgentItem }) {
  const navigate = useNavigate()
  const feedback = useFeedback()
  const { t, locale } = useT()

  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()
  const replaceComponents = useReplaceAgentComponents()

  const initialValues = initialItem === undefined ? EMPTY_AGENT_FORM_VALUES : valuesFromAgent(initialItem)
  const initialComponents = initialItem === undefined ? [] : componentsFromAgent(initialItem)

  const [form] = Form.useForm<AgentFormValues>()
  const [values, setValues] = useState<AgentFormValues>(initialValues)
  const [snapshot, setSnapshot] = useState<SavedSnapshot>({ values: initialValues, components: initialComponents })
  /** 新建成功后拿到的那条记录（`POST` 的响应）—— 之后本页以"编辑"的方式继续跑 */
  const [created, setCreated] = useState<AgentItem | undefined>(undefined)
  const [failures, setFailures] = useState<SaveFailure[]>([])
  const [saving, setSaving] = useState(false)
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>(knowledgeIdsOf(initialComponents))
  /**
   * 已勾选的 MCP server（**P0-2-11 接回**：P0-1-23 时期这里没有它，
   * 因为 `mcp_servers` 表还不存在、后端也明确拒绝 MCP 引用）。
   * 初值走 `mcpIdsOf`（与知识库那条同款），保证"编辑一个已绑定的智能体"时勾选状态是对的。
   */
  const [selectedMcpIds, setSelectedMcpIds] = useState<string[]>(mcpIdsOf(initialComponents))
  /**
   * 常驻工具（P1-19）：server id → MCP 原始工具名。工具总数超过阈值时只有这些直接下发给模型，
   * 其余走工具网关（`mcp_list_tools` / `mcp_call_tool` 按需发现）。初值从已保存的绑定里取。
   */
  const [pinnedMcpTools, setPinnedMcpTools] = useState<Record<string, string[]>>(
    pinnedMcpToolsOf(initialComponents),
  )
  const [deleteOpen, setDeleteOpen] = useState(false)

  const item = initialItem ?? created
  /** 类型创建后不可改（`shared` 的 `updateAgentBodySchema` 同样有这条：传异值 409） */
  const typeLocked = item !== undefined

  const kbQuery = useKnowledgeBases()
  const modelQuery = useAvailableChatModels()
  const conversationCount = useMyConversationCount(item?.id)
  /**
   * MCP 两个查询（P0-2-11）：server 列表（多选框的数据源）+ 我的凭据清单
   * （**红点的唯一来源** —— `06` P0-2-11 坑预判 4：未配置红点/计数只有一个来源，
   * 本页**不自己数一遍**"哪些 server 我没配凭据"，那样会与凭据页的徽标各说各话）。
   */
  const mcpQuery = useMcpServers()
  const credQuery = useMyCredentials()
  const kbItems = kbQuery.data?.items ?? []
  const mcpItems = mcpQuery.data?.items ?? []
  const modelOptions = modelQuery.data?.items ?? []

  const selectedComponents = [
    ...knowledgeSelectionOf(selectedKbIds),
    ...mcpSelectionOf(selectedMcpIds, pinnedMcpTools),
  ]

  /**
   * 已勾选、但**不在知识库列表里**的 id（列表重拉后消失的那些）。
   *
   * `kbQuery.data === undefined`（还没读到 / 读失败）时**一律返回空**：那时"列表里没有"只说明
   * "还不知道"，据此渲染一批「已失效」是**假警报** —— 而且会在每次进页面时闪一下。
   */
  const kbIdSet = new Set(kbItems.map((kb) => kb.id))
  const missingKbIds = kbQuery.data === undefined ? [] : selectedKbIds.filter((id) => !kbIdSet.has(id))

  /**
   * 已勾选、但**不在 MCP server 列表里**的 server id。
   *
   * ⚠️ 与 `missingKbIds` **同一条推理**，而且这里更可能真发生：MCP server 是**全员可删**的
   * （第五族权限），别人删掉一台你绑过的 server 完全正常。若不把这行显式列出来，
   * 用户会**被卡死**在 P0-1-31 那个坑里：`sameComponentSet` 永远为假 ⇒ 每次保存都重发
   * 同一个失败的 `PUT`，而提示里那串 uuid 在页面上找不到任何对应物。
   */
  const mcpIdSet = new Set(mcpItems.map((server) => server.id))
  const missingMcpIds = mcpQuery.data === undefined ? [] : selectedMcpIds.filter((id) => !mcpIdSet.has(id))

  /**
   * 「未配置凭据」的 server id 集合（红点判据）。
   *
   * ⚠️ 判据只有一条来源：`GET /api/mcp/credentials` 的 `unconfigured`（瘦投影），
   * 它是服务端从同一份 `items` 派生的**结论**。本页**不重新算**
   * `fields`/`missingKeys`（那会造出第二份判据，且与凭据页的徽标可能不一致）。
   */
  const unconfiguredMcpIds = new Set((credQuery.data?.unconfigured ?? []).map((server) => server.serverId))

  /**
   * 脏区块 = 文本/模型字段的差异 ∪ 组件绑定的集合差异。
   *
   * ⚠️ 组件那一路比较的是 `submittableComponents(snapshot.components)` —— **P0-2-11 起它含
   * `KNOWLEDGE` 与 `MCP` 两类**（`agentModel#submittableComponents` 是唯一的"哪些绑定会被提交"
   * 判据）。少算一类 ⇒ 每次保存都白发一个 `PUT` 且永远显示"未保存"；多算一类 ⇒ 把不该动的
   * 绑定一起交上去。两条都是没有编译期错误的错。
   */
  const componentsDirty = !sameComponentSet(submittableComponents(snapshot.components), selectedComponents)
  const dirtySections = orderSections([
    ...changedSections(snapshot.values, values),
    ...(componentsDirty ? (['components'] as const) : []),
  ])
  const failedSections = new Set(failures.map((failure) => failure.section))

  // ── 他人创建 ⇒ 只读说明页（文件头 ⑤）─────────────────────────────────────────────
  if (initialItem !== undefined && !initialItem.canEdit) {
    return (
      <>
        <EditHead
          title={t('agentForm.editTitle')}
          lead={t('agentForm.readOnlyLead', { name: initialItem.name, creator: initialItem.creatorName })}
        />
        <div className="stack">
          <Alert
            type="info"
            showIcon
            message={t('agentForm.readOnlyTitle')}
            description={t('agentForm.readOnlyDesc')}
          />
          <div className="row">
            <Link to={chatPath(initialItem.id)}>
              <Button type="primary">{t('agentForm.openSession')}</Button>
            </Link>
            <Link to={AGENTS_PATH}>
              <Button>{t('agentForm.backToList')}</Button>
            </Link>
          </div>

          {/* 开放调用（P1-22）：**入口在「我的凭据」**（Key 的主语是「我 × 智能体」），
              这里只留一个指路条 —— 受众用户也能给自己签（R3），只是不该在本页操作。 */}
          <FormSection section="openKeys" dirty={false} failed={false}>
            <OpenApiKeysHelp agentId={initialItem.id} />
          </FormSection>
        </div>
      </>
    )
  }

  /** 把 zod 的 issue 落到输入框上（`path` 形如 `['systemPrompt']`；数组元素的 path 也归到该字段） */
  const applyZodIssues = (issues: readonly { path: (string | number)[]; message: string }[]) => {
    form.setFields(
      issues.map((issue) => ({
        name: (issue.path[0] ?? 'name') as keyof AgentFormValues,
        errors: [issue.message],
      })),
    )
  }

  // ───────────────────────── 保存：PATCH + PUT 串行，每步各自记账（文件头 ①） ─────────────────────────

  const runSave = async (next: AgentFormValues) => {
    setFailures([])

    // 落库快照的"下一个版本"：成功的步骤往前推一格，失败的步骤原地不动 ⇒ 它覆盖的区块保持脏
    const nextSnapshot: SavedSnapshot = { values: snapshot.values, components: snapshot.components }
    const problems: SaveFailure[] = []
    let currentId = item?.id

    setSaving(true)
    try {
      if (currentId === undefined) {
        // ① 新建：`POST` 一次写入全部字段
        const body = buildCreateBody(next)
        // 与后端同一份 schema：能过这里就一定不会被服务端 400 拦下（`03` §一 的纪律）
        const parsed = createAgentBodySchema.safeParse(body)
        if (!parsed.success) {
          applyZodIssues(parsed.error.issues)
          return
        }
        try {
          const createdItem = await createAgent.mutateAsync(body)
          currentId = createdItem.id
          setCreated(createdItem)
          nextSnapshot.values = valuesFromAgent(createdItem)
          nextSnapshot.components = componentsFromAgent(createdItem)
        } catch (error) {
          // `POST` 一次写全部字段 ⇒ 失败时四个区块都还没落库
          problems.push(...toFailures(AGENT_SECTIONS, error))
        }
      } else {
        // ② 编辑：`PATCH` 只发改过的字段（三态由 `buildUpdateBody` 统一算）
        const body = buildUpdateBody(snapshot.values, next)
        if (body !== null) {
          const parsed = updateAgentBodySchema.safeParse(body)
          if (!parsed.success) {
            applyZodIssues(parsed.error.issues)
            return
          }
          try {
            const updated = await updateAgent.mutateAsync({ id: currentId, body })
            nextSnapshot.values = valuesFromAgent(updated)
          } catch (error) {
            problems.push(...toFailures(sectionsOfUpdateBody(body), error))
          }
        }
      }

      // ③ 组件绑定（整体替换）。新建失败时 `currentId` 仍是 undefined ⇒ 这一步自然跳过
      if (
        currentId !== undefined &&
        !sameComponentSet(submittableComponents(nextSnapshot.components), selectedComponents)
      ) {
        try {
          const updated = await replaceComponents.mutateAsync({
            id: currentId,
            body: { components: selectedComponents },
          })
          nextSnapshot.components = componentsFromAgent(updated)
        } catch (error) {
          problems.push(...toFailures(['components'], error))
        }
      }
    } finally {
      setSaving(false)
    }

    setSnapshot(nextSnapshot)
    setFailures(problems)
    if (problems.length > 0) {
      // **不静默部分成功**：留在本页并列出未保存的区块。若 `POST` 已经成功，先把
      // "对象已经建出来了"这件事说出来（否则用户会以为整次操作都没生效而重复建一个）。
      if (initialItem === undefined && currentId !== undefined) {
        feedback.fail(new Error(t('agentForm.partialFailed')), t('agentForm.partialFailedTitle'))
      }
      return
    }

    feedback.ok(initialItem === undefined ? t('agentForm.created') : t('agentForm.saved'))
    navigate(AGENTS_PATH)
  }

  // ───────────────────────── 渲染 ─────────────────────────

  // ── 模型池 / 默认模型的下拉选项 ──
  // 可用（已启用）CHAT 模型的选项（模型池多选框的主数据源）
  const availableModelOptions = modelOptions.map((option) => ({
    value: option.id,
    label: `${option.label}${t('agentForm.modelOptionMeta', {
      context: option.maxContext === null ? t('agentForm.modelContextUnset') : option.maxContext,
      vision: option.supportsVision ? t('agentForm.modelVisionYes') : t('agentForm.modelVisionNo'),
    })}`,
  }))
  // 编辑时：池里"已停用/已删"的成员（不在可用列表里）也要能显示与保留，否则 Select 只剩裸 uuid，
  // 用户看不出绑的是什么。停用成员的名字来自投影 `item.models`。
  const stalePoolOptions =
    item === undefined
      ? []
      : item.models
          .filter((m) => !modelOptions.some((option) => option.id === m.modelId))
          .map((m) => ({ value: m.modelId, label: `${m.modelLabel}${t('agentForm.staleModelSuffix')}` }))
  const modelPoolSelectOptions = [...availableModelOptions, ...stalePoolOptions]
  // 默认模型只能在**当前池**内选（保证默认模型恒为池成员，与后端一致）
  const defaultModelSelectOptions = modelPoolSelectOptions.filter((option) =>
    values.modelIds.includes(option.value),
  )

  /**
   * 池里那些「各自 Key」且**我还没配 Key** 的模型所属 Provider 名（P1-18）。
   *
   * 判据来自服务端随模型下发的 `providerCredentialMode` / `providerUserHasKey`
   * （`GET /api/models/available`）—— 前端**不自己猜**凭据模式。这些 Provider 的模型选了也能存，
   * 但发消息会 424「尚未配置所需凭据」⇒ 就地提示并引导去「我的凭据」配（唯一配置入口）。
   */
  const unconfiguredCredProviders = [
    ...new Map(
      modelOptions
        .filter(
          (option) =>
            values.modelIds.includes(option.id) &&
            option.providerCredentialMode === 'PER_USER' &&
            !option.providerUserHasKey,
        )
        .map((option) => [option.providerId, option.providerName]),
    ).values(),
  ]

  const toggleKb = (kbId: string, checked: boolean) => {
    setSelectedKbIds((current) =>
      checked ? [...current.filter((id) => id !== kbId), kbId] : current.filter((id) => id !== kbId),
    )
  }

  /** MCP 多选的勾选/取消（与 `toggleKb` 同款：保持"最后勾的排在后面"的追加语义） */
  const toggleMcp = (serverId: string, checked: boolean) => {
    setSelectedMcpIds((current) =>
      checked ? [...current.filter((id) => id !== serverId), serverId] : current.filter((id) => id !== serverId),
    )
    // 解绑时顺手丢掉它的常驻工具（P1-19）：解绑后再留着这批名字，一旦重新勾选会"凭空复活"
    if (!checked) {
      setPinnedMcpTools((current) => {
        if (current[serverId] === undefined) return current
        const next = { ...current }
        delete next[serverId]
        return next
      })
    }
  }

  /** 设置某台 server 的常驻工具（P1-19）；空数组 = 清掉常驻 */
  const setPinnedForServer = (serverId: string, names: string[]) => {
    setPinnedMcpTools((current) => {
      const next = { ...current }
      if (names.length === 0) delete next[serverId]
      else next[serverId] = names
      return next
    })
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1>{initialItem === undefined ? t('agentForm.createTitle') : t('agentForm.editTitle')}</h1>
          <p className="page__lead">
            {t('agentForm.leadPrefix')}
            <code>PATCH /api/agents/:id</code>
            {t('agentForm.leadMid')}
            <code>PUT /api/agents/:id/components</code>
            {t('agentForm.leadSuffix')}
          </p>
        </div>
        <div className="page__head-actions">
          <Tag className="tag--accent">{AGENT_TYPE_LABEL[values.type]}</Tag>
          {typeLocked && <Tag title={t('agentForm.typeLockedTitle')}>{t('agentForm.typeLocked')}</Tag>}
        </div>
      </div>

      <div className="split split--form">
        <Form
          form={form}
          layout="vertical"
          initialValues={initialValues}
          /**
           * ⚠️ 必须用 `form.getFieldsValue(true)`（取**整个 store**），**不能**用 `onValuesChange` 的第二个入参。
           *
           * 那个入参是 `getFieldsValue()` 的结果 —— 它**只含当前已注册（已挂载）的字段**。本表单里的
           * `audience` 是**条件渲染**的（仅 `visibility=SHARED` 才挂 `Form.Item`）⇒ 私有/公开时它不是
           * 注册字段、不出现在那个入参里。用 `setValues(all)` 会把 `values.audience` 覆盖成 `undefined`
           * ⇒ 紧接着 `changedSections → audienceChanged` 读 `values.audience.userIds` 抛 TypeError，
           * React 卸载整棵子树 = **页面白屏**（勾选模型池只是"任意一次 onValuesChange"的一个触发点）。
           * `getFieldsValue(true)` 取的是 store 全量（含 initialValues 与未挂载字段的值）⇒ `values` 始终是
           * 表单的完整镜像，`audience` 不会凭空消失。
           */
          onValuesChange={() => setValues(form.getFieldsValue(true))}
          onFinish={(submitted) => {
            void runSave(submitted)
          }}
        >
          <div className="stack" style={{ gap: 'var(--sp-7)' }}>
            {failures.length > 0 && (
              <Alert
                type="error"
                showIcon
                message={t('agentForm.failuresTitle')}
                description={
                  <>
                    <ul>
                      {failures.map((failure) => (
                        <li key={failure.section}>
                          <strong>{t(AGENT_SECTION_LABEL_KEY[failure.section])}</strong>（{failure.code}）·{' '}
                          {failure.message}
                        </li>
                      ))}
                    </ul>
                    <p className="ratio">
                      {t('agentForm.failuresNote')}
                      <strong>{t('agentForm.failuresNoteStrong')}</strong>
                      {t('agentForm.failuresNoteTail')}
                    </p>
                  </>
                }
                action={
                  <Button
                    size="small"
                    loading={saving}
                    onClick={() => {
                      void runSave(values)
                    }}
                  >
                    {t('agentForm.retryFailed')}
                  </Button>
                }
              />
            )}

            {/* ① 基本信息 */}
            <FormSection section="basic" dirty={dirtySections.includes('basic')} failed={failedSections.has('basic')}>
              <div className="stack stack--tight">
                <Form.Item name="name" label={t('agentForm.name')} rules={[{ required: true, message: t('agentForm.nameRequired') }]}>
                  <Input placeholder={t('agentForm.namePlaceholder')} />
                </Form.Item>
                <Form.Item
                  name="description"
                  label={t('agentForm.description')}
                  extra={t('agentForm.descriptionExtra', { max: AGENT_DESCRIPTION_MAX_CHARS })}
                >
                  <Input placeholder={t('agentForm.descriptionPlaceholder')} />
                </Form.Item>
                <Form.Item
                  name="visibility"
                  label={t('agentForm.visibility')}
                  extra={t('agentForm.visibilityExtra')}
                >
                  <Radio.Group>
                    {ASSET_VISIBILITIES.map((value) => (
                      <Radio key={value} value={value}>
                        {translate(locale, ASSET_VISIBILITY_KEY[value])}
                      </Radio>
                    ))}
                  </Radio.Group>
                </Form.Item>
                {values.visibility === 'SHARED' && (
                  <Form.Item
                    name="audience"
                    label={t('agentForm.audience')}
                    required
                    extra={t('agentForm.audienceExtra')}
                  >
                    <AudienceField knownUsers={item?.audience.users} />
                  </Form.Item>
                )}
                {(values.visibility === 'PUBLIC' || values.visibility === 'SHARED') && (
                  <p className="ratio" style={{ marginTop: 'var(--sp-2)' }}>
                    {t('agentForm.sharedNote')}
                  </p>
                )}
                {typeLocked ? (
                  <div>
                    <p className="block-label">{t('agentForm.type')}</p>
                    <span className="row">
                      <Tag>{AGENT_TYPE_LABEL[values.type]}</Tag>
                      <span className="ratio">{t(AGENT_TYPE_HINT_KEY[values.type])}</span>
                    </span>
                  </div>
                ) : (
                  // 迭代 `shared` 的 `AGENT_TYPES`（本仓取值域的唯一来源）。
                  // ⚠️ 原型把 TaskAgent 画成 `disabled`（并配了个 `.check` 的 `opacity: .6`），
                  //    但 `06` P0-1-31 的验收是"**创建两种类型** Agent" —— 照抄原型会让这条验收
                  //    永远过不了。两种类型都可选，创建后由后端锁定（传异值 409）。
                  <Form.Item name="type" label={t('agentForm.type')}>
                    <Radio.Group>
                      <div className="stack stack--tight">
                        {AGENT_TYPES.map((type) => (
                          <Radio key={type} value={type} className="pick">
                            <span className="pick__title">{AGENT_TYPE_LABEL[type]}</span>
                            <span className="pick__meta">{t(AGENT_TYPE_HINT_KEY[type])}</span>
                          </Radio>
                        ))}
                      </div>
                    </Radio.Group>
                  </Form.Item>
                )}
              </div>
            </FormSection>

            {/* ② 模型 */}
            <FormSection section="model" dirty={dirtySections.includes('model')} failed={failedSections.has('model')}>
              <div className="stack stack--tight">
                <Form.Item
                  name="modelIds"
                  label={t('agentForm.modelPool')}
                  rules={[{ required: true, message: t('agentForm.modelPoolRequired'), type: 'array', min: 1 }]}
                  extra={t('agentForm.modelPoolExtra')}
                >
                  <Select
                    mode="multiple"
                    showSearch
                    optionFilterProp="label"
                    loading={modelQuery.isPending}
                    options={modelPoolSelectOptions}
                    placeholder={modelQuery.isPending ? t('agentForm.modelPoolLoading') : t('agentForm.modelPoolPlaceholder')}
                    notFoundContent={t('agentForm.modelPoolEmpty')}
                    onChange={(next: string[]) => {
                      // 池里移除了当前默认模型 ⇒ 清空默认模型选择，逼用户重选（避免默认模型不在池里）
                      const currentDefault = form.getFieldValue('modelId') as string
                      if (currentDefault !== '' && !next.includes(currentDefault)) {
                        form.setFieldValue('modelId', '')
                        setValues((prev) => ({ ...prev, modelId: '', modelIds: next }))
                      }
                    }}
                  />
                </Form.Item>
                <Form.Item
                  name="modelId"
                  label={t('agentForm.defaultModel')}
                  rules={[{ required: true, message: t('agentForm.defaultModelRequired') }]}
                  extra={t('agentForm.defaultModelExtra')}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={defaultModelSelectOptions}
                    placeholder={values.modelIds.length === 0 ? t('agentForm.defaultModelNeedPool') : t('agentForm.defaultModelPlaceholder')}
                    notFoundContent={t('agentForm.defaultModelEmpty')}
                  />
                </Form.Item>
                {unconfiguredCredProviders.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    message={t('agentForm.needKeyTitle', { providers: unconfiguredCredProviders.join(t('mcp.listSeparator')) })}
                    description={
                      <>
                        {t('agentForm.needKeyDescPrefix')}
                        <br />
                        <Link to={credentialsSectionPath('provider')}>{t('agentForm.needKeyLink')}</Link>
                      </>
                    }
                  />
                )}
              </div>
            </FormSection>

            {/* ③ 提示词 */}
            <FormSection
              section="prompt"
              dirty={dirtySections.includes('prompt')}
              failed={failedSections.has('prompt')}
            >
              <div className="stack stack--tight">
                <Form.Item
                  name="systemPrompt"
                  label={t('agentForm.systemPrompt')}
                  extra={t('agentForm.systemPromptExtra', { max: AGENT_SYSTEM_PROMPT_MAX_CHARS })}
                >
                  <Input.TextArea
                    rows={7}
                    placeholder={t('agentForm.systemPromptPlaceholder')}
                  />
                </Form.Item>
                <Form.Item
                  name="openingRemarks"
                  label={t('agentForm.openingRemarks')}
                  extra={t('agentForm.openingRemarksExtra', { max: AGENT_OPENING_REMARKS_MAX_CHARS })}
                >
                  <Input.TextArea rows={3} placeholder={t('agentForm.openingRemarksPlaceholder')} />
                </Form.Item>

                <div>
                  <p className="block-label">{t('agentForm.guideQuestions')}</p>
                  <Form.List name="guideQuestions">
                    {(fields, { add, remove }) => (
                      <div className="stack stack--tight">
                        {fields.map((field, index) => (
                          <div className="guide-row" key={field.key}>
                            <Form.Item {...field} noStyle>
                              <Input placeholder={t('agentForm.guideQuestionPlaceholder', { n: index + 1 })} maxLength={GUIDE_QUESTION_MAX_CHARS} />
                            </Form.Item>
                            <Button size="small" onClick={() => remove(field.name)}>
                              {t('agentForm.remove')}
                            </Button>
                          </div>
                        ))}
                        <div className="row row--wrap">
                          <Button size="small" disabled={fields.length >= GUIDE_QUESTIONS_MAX} onClick={() => add('')}>
                            {t('agentForm.addGuideQuestion')}
                          </Button>
                          <span className="ratio">
                            {t('agentForm.guideQuestionsNotePrefix', { max: GUIDE_QUESTIONS_MAX, chars: GUIDE_QUESTION_MAX_CHARS })}
                            <strong>{t('agentForm.guideQuestionsNoteStrong')}</strong>
                            {t('agentForm.guideQuestionsNoteTail')}
                          </span>
                        </div>
                      </div>
                    )}
                  </Form.List>
                </div>
              </div>
            </FormSection>

            {/* ④ 组件绑定 */}
            <FormSection
              section="components"
              dirty={dirtySections.includes('components')}
              failed={failedSections.has('components')}
            >
              <div className="stack">
                <div>
                  <p className="block-label">{t('agentForm.knowledge')}</p>
                  {kbQuery.isPending ? (
                    <p className="ratio">{t('agentForm.kbLoading')}</p>
                  ) : kbQuery.isError ? (
                    <Alert
                      type="error"
                      showIcon
                      message={t('agentForm.kbLoadFailed')}
                      description={describeError(kbQuery.error).message}
                      action={
                        <Button
                          size="small"
                          onClick={() => {
                            void kbQuery.refetch()
                          }}
                        >
                          {t('common.retry')}
                        </Button>
                      }
                    />
                  ) : kbItems.length === 0 ? (
                    <Alert type="info" showIcon message={t('agentForm.noKb')} />
                  ) : (
                    <div className="stack stack--tight">
                      {/* ⚠️ `.pick` 落在 **AntD Checkbox 自己那个 `<label>` 根节点**上，
                          不再自己套一层 `<label>`/`<div>`：套了就变成 label 嵌 label，
                          点击行为会被切成"点文字切勾选、点空白什么都不做"两块。 */}
                      {kbItems.map((kb) => (
                        <Checkbox
                          className="pick"
                          key={kb.id}
                          checked={selectedKbIds.includes(kb.id)}
                          onChange={(event) => toggleKb(kb.id, event.target.checked)}
                        >
                          <span className="pick__title">{kb.name}</span>
                          <span className="pick__meta">
                            {t('agentForm.kbMeta', { docs: kb.documentCount, agents: kb.agentCount })}
                            {kb.embeddingModelChanged === true && t('agentForm.kbEmbeddingChanged')}
                          </span>
                        </Checkbox>
                      ))}
                      <span className="ratio">
                        {t('agentForm.kbListNote', { count: kbItems.length })}
                      </span>
                    </div>
                  )}

                  {/* ⚠️ 「已勾选但已不在列表里」的知识库**必须显式列出来，而且必须能取消勾选**。
                      这条是 P0-1-31 端测实测出来的（不是设想）：保存时若 `PUT` 因为某个库已被删
                      而失败，`PATCH` 成功会把 `['knowledge-bases']` 标脏 ⇒ 列表重拉 ⇒ 那个库从
                      勾选框里**消失**，而它仍然在 `selectedKbIds` 里。后果是用户**被卡死**：
                      界面既没有那一行可以取消，`sameComponentSet` 又永远为假 ⇒ 每次保存都重发同一个
                      失败的 `PUT`，而顶部提示里的那串 uuid 在页面上找不到任何对应物。
                      （同族的处理见 `staleModelOption`：绑定的模型被停用后要留在下拉里，
                        否则用户只见一个裸 uuid，无从判断该换成什么。） */}
                  {missingKbIds.length > 0 && (
                    <div className="stack stack--tight" style={{ marginTop: 'var(--sp-3)' }}>
                      {missingKbIds.map((kbId) => (
                        <Checkbox key={kbId} className="pick" checked onChange={() => toggleKb(kbId, false)}>
                          <span className="pick__title">
                            {t('agentForm.staleKb')} <Tag className="tag--danger">{t('agentForm.unbindTag')}</Tag>
                          </span>
                          <span className="pick__meta">{t('agentForm.staleKbMeta', { id: kbId })}</span>
                        </Checkbox>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <p className="block-label">{t('agentForm.mcpTools')}</p>

                  {mcpQuery.isPending ? (
                    <TableSkeleton rows={2} />
                  ) : mcpQuery.isError ? (
                    <Alert
                      type="error"
                      showIcon
                      message={t('agentForm.mcpLoadFailed')}
                      description={describeError(mcpQuery.error).message}
                      action={
                        <Button
                          size="small"
                          onClick={() => {
                            void mcpQuery.refetch()
                          }}
                        >
                          {t('common.retry')}
                        </Button>
                      }
                    />
                  ) : mcpItems.length === 0 ? (
                    <Alert
                      type="info"
                      showIcon
                      message={t('agentForm.noMcp')}
                      description={t('agentForm.noMcpDesc')}
                      action={
                        <Link to="/mcp">
                          <Button size="small">{t('agentForm.goMcp')}</Button>
                        </Link>
                      }
                    />
                  ) : (
                    <div className="stack stack--tight">
                      {mcpItems.map((server) => {
                        const needsCredential = unconfiguredMcpIds.has(server.id)
                        return (
                          <Checkbox
                            className="pick"
                            key={server.id}
                            checked={selectedMcpIds.includes(server.id)}
                            onChange={(event) => toggleMcp(server.id, event.target.checked)}
                          >
                            <span className="pick__title">
                              {server.name}
                              {/* ⚠️ 「未配置凭据」红点的**唯一来源**是 `GET /api/mcp/credentials`
                                  的 `unconfigured`（见 `unconfiguredMcpIds` 的注释）。它不是
                                  "不能绑"—— 绑得上，只是这个智能体跑到那个工具时会 424 */}
                              {needsCredential && (
                                <Tag className="tag--warn" style={{ marginLeft: 'var(--sp-2)' }}>
                                  {t('agentForm.needCredential')}
                                </Tag>
                              )}
                            </span>
                            <span className="pick__meta">
                              {server.toolCount === 0 ? t('agentForm.noTools') : t('agentForm.toolCount', { count: server.toolCount })}
                              {' · mcp_'}
                              {server.slug}
                              {needsCredential ? (
                                <>
                                  {' · '}
                                  <Link to={credentialsPath(server.id)}>{t('agentForm.configureCredential')}</Link>
                                </>
                              ) : null}
                            </span>
                          </Checkbox>
                        )
                      })}
                      <span className="ratio">
                        {t('agentForm.mcpListNotePrefix', { count: mcpItems.length })}
                      </span>
                    </div>
                  )}

                  {/* 常驻工具（P1-19）：工具多时（超过 MCP_INLINE_TOOL_LIMIT）只有这些**直接**下发给模型，
                      其余仍可用 —— 模型先用「列出 MCP 工具」发现，再用「调用 MCP 工具」触达。
                      工具少时本设置不生效（全部直接下发）。 */}
                  {selectedMcpIds.length > 0 && mcpItems.length > 0 && (
                    <div className="stack stack--tight" style={{ marginTop: 'var(--sp-3)' }}>
                      <p className="block-label">{t('agentForm.pinnedTools')}</p>
                      <span className="ratio">
                        {t('agentForm.pinnedToolsNote')}
                      </span>
                      {selectedMcpIds.map((serverId) => (
                        <McpPinnedToolsRow
                          key={serverId}
                          server={serverId}
                          serverName={mcpItems.find((server) => server.id === serverId)?.name ?? serverId}
                          value={pinnedMcpTools[serverId] ?? []}
                          onChange={(names) => setPinnedForServer(serverId, names)}
                        />
                      ))}
                    </div>
                  )}

                  {/* ⚠️ 「已勾选但已不在列表里」的 server **必须显式列出来，而且必须能取消勾选**
                      （与上面知识库那一段同一条推理，而 MCP 这边更可能真发生：server 是全员可删的）。 */}
                  {missingMcpIds.length > 0 && (
                    <div className="stack stack--tight" style={{ marginTop: 'var(--sp-3)' }}>
                      {missingMcpIds.map((serverId) => (
                        <Checkbox
                          key={serverId}
                          className="pick"
                          checked
                          onChange={() => toggleMcp(serverId, false)}
                        >
                          <span className="pick__title">
                            {t('agentForm.staleMcp')} <Tag className="tag--danger">{t('agentForm.unbindTag')}</Tag>
                          </span>
                          <span className="pick__meta">{t('agentForm.staleMcpMeta', { id: serverId })}</span>
                        </Checkbox>
                      ))}
                    </div>
                  )}

                  {credQuery.isError ? (
                    <Alert
                      type="warning"
                      style={{ marginTop: 'var(--sp-3)' }}
                      showIcon
                      message={t('agentForm.credLoadFailed')}
                      description={t('agentForm.credLoadFailedDesc')}
                    />
                  ) : null}
                </div>

                <Alert
                  type="info"
                  showIcon
                  message={t('agentForm.componentsReplaceTitle')}
                  description={t('agentForm.componentsReplaceDesc')}
                />
              </div>
            </FormSection>

            {/* ⑤ 开放调用（P1-22）：**只指路，不放 Key 管理**（见 `OpenApiKeysHelp`）。
                该区块不参与本页保存链路（`agentModel#AGENT_PAGE_SECTIONS` 的 `openKeys` 不在
                `AGENT_SECTIONS` 里）—— 它没有任何可提交的表单值。 */}
            <FormSection section="openKeys" dirty={false} failed={false}>
              <OpenApiKeysHelp agentId={item?.id} />
            </FormSection>

            <div className="savebar">
              <span className="ratio">
                {item === undefined
                  ? t('agentForm.savebarUnsaved')
                  : t('agentForm.savebarSaved', { time: formatUpdatedAt(item.updatedAt), creator: item.creatorName })}
                {dirtySections.length > 0 &&
                  t('agentForm.savebarDirty', {
                    sections: dirtySections.map((section) => t(AGENT_SECTION_LABEL_KEY[section])).join(t('mcp.listSeparator')),
                  })}
              </span>
              <div className="row u-right" style={{ gap: 'var(--sp-3)' }}>
                <Link to={AGENTS_PATH}>
                  <Button type="text">{t('common.cancel')}</Button>
                </Link>
                <Button type="primary" htmlType="submit" loading={saving}>
                  {t('common.save')}
                </Button>
              </div>
            </div>
          </div>
        </Form>

        <aside className="aside-card stack stack--tight">
          <div className="card bracket card--pad">
            <p className="kicker">{t('agentForm.summary')}</p>
            <p className="aside-card__name">{values.name.trim() === '' ? t('agentForm.unnamed') : values.name}</p>
            <div className="stack stack--tight" style={{ marginTop: 'var(--sp-4)' }}>
              <SummaryRow label={t('agentForm.summaryType')} value={AGENT_TYPE_LABEL[values.type]} />
              <SummaryRow
                label={t('agentForm.summaryModel')}
                value={item?.modelName ?? modelOptions.find((option) => option.id === values.modelId)?.label ?? t('agentForm.summaryModelUnselected')}
              />
              <SummaryRow label={t('agentForm.summaryKb')} value={t('agentForm.summaryKbCount', { count: selectedKbIds.length })} />
              <SummaryRow label={t('agentForm.summaryMcp')} value={t('agentForm.summaryMcpCount', { count: selectedMcpIds.length })} />

              <SummaryRow
                label={t('agentForm.summaryConversations')}
                value={conversationCount.data === undefined ? '—' : String(conversationCount.data)}
                last
              />
            </div>
            {item !== undefined && (
              <Link to={chatPath(item.id)} style={{ display: 'block', marginTop: 'var(--sp-5)' }}>
                <Button style={{ width: '100%' }}>{t('agentForm.openSession')}</Button>
              </Link>
            )}
          </div>

          {item !== undefined && item.canEdit && (
            <div className="card card--flat card--pad">
              <p className="kicker">{t('agentForm.dangerZone')}</p>
              <p className="ratio" style={{ marginTop: 'var(--sp-3)' }}>
                {t('agentForm.dangerNote', { components: item.components.length })}
              </p>
              <Button danger style={{ marginTop: 'var(--sp-4)' }} onClick={() => setDeleteOpen(true)}>
                {t('agentForm.deleteAgent')}
              </Button>
            </div>
          )}
        </aside>
      </div>

      <DeleteAgentModal
        agent={deleteOpen && item !== undefined ? item : null}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => navigate(AGENTS_PATH)}
      />
    </>
  )
}

/**
 * 「开放调用」指路条（P1-22；2026-10-22 定案）。
 *
 * Key 的主语是「**我** × 智能体」，所以它不是智能体的属性 —— 放在编辑页会让人以为
 * "给这个智能体开了 Key 就所有人都能用"。管理入口因此在「我的凭据」的新分区
 * （`/settings/credentials?section=openapi`），本页只解释"它是什么、去哪配"。
 *
 * ⚠️ 不给"在这里新建"的按钮：那等于把语义问题又搬回来一次（而且新建必须先在凭据页选智能体，
 * 本页的上下文只是"预选"，跳过去带 cookie 更省事）。
 */
function OpenApiKeysHelp({ agentId }: { agentId: string | undefined }) {
  const { t } = useT()
  return (
    <div className="stack stack--tight">
      <p className="ratio">
        {t('agentForm.openApiHelpPrefix')}
        <strong>{t('agentForm.openApiHelpStrong1')}</strong>
        {t('agentForm.openApiHelpMid')}
        <strong>{t('agentForm.openApiHelpStrong2')}</strong>
        {t('agentForm.openApiHelpTail')}
      </p>
      <div className="row">
        <Link to={credentialsSectionPath('openapi')}>
          <Button>{t('agentForm.openApiLink')}</Button>
        </Link>
        {agentId !== undefined && (
          <span className="ratio">{t('agentForm.openApiFilterNote')}</span>
        )}
      </div>
    </div>
  )
}

// ═════════════════════════════ 局部组件 ═════════════════════════════

/**
 * 表单分区：左侧刻度线是"这一区落库了没有"的读数（`design/agent-edit.html` 的 `.form-section`）。
 *
 * 三种状态各有明确含义，刻意**不合并成"有没有改动"一种**：
 *   · 常态（灰）—— 与服务端一致；
 *   · `is-dirty`（琥珀）+「未保存」—— 改了但还没提交；
 *   · `is-failed`（红）+「保存失败」—— 提交过但**这一区没落库**（文件头 ① 的可见形态）。
 *
 * `data-*` 两个属性是给验收用的**可观测标记**（浏览器端测要能断言"哪一个区块没保存"，
 * 而不是只能读肉眼可见的红线）。
 */
function FormSection({
  section,
  dirty,
  failed,
  children,
}: {
  section: AgentPageSectionKey
  dirty: boolean
  failed: boolean
  children: ReactNode
}) {
  const { t } = useT()
  const className = failed ? 'form-section is-failed' : dirty ? 'form-section is-dirty' : 'form-section'
  return (
    <section className={className} data-section={section} data-dirty={dirty} data-failed={failed}>
      <div className="form-section__head">
        <span className="kicker">
          {sectionOrdinal(section)} / {t(AGENT_SECTION_LABEL_KEY[section])}
        </span>
        {failed ? (
          <Tag className="tag--danger">{t('agentForm.sectionSaving')}</Tag>
        ) : dirty ? (
          <Tag className="tag--warn">{t('agentForm.sectionDirty')}</Tag>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function SummaryRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div className="summary-row" style={last ? { borderBottom: 0 } : undefined}>
      <span className="summary-row__label">{label}</span>
      <span className="ratio">{value}</span>
    </div>
  )
}

/**
 * 某台 MCP server 的**常驻工具**选择器（P1-19）。
 *
 * 工具清单来自 `GET /api/mcp/servers/:id/tools`（读缓存，不联网）；`value`/`onChange` 是
 * **MCP 原始工具名**（与后端 `agent_components.config.pinnedMcpTools` 同一口径）。
 */
function McpPinnedToolsRow({
  server,
  serverName,
  value,
  onChange,
}: {
  server: string
  serverName: string
  value: string[]
  onChange: (names: string[]) => void
}) {
  const { t } = useT()
  const toolsQuery = useMcpServerTools(server)
  const tools = toolsQuery.data?.tools ?? []
  return (
    <div>
      <span className="pick__title">{serverName}</span>
      <Select
        mode="multiple"
        allowClear
        style={{ width: '100%', marginTop: 'var(--sp-1)' }}
        loading={toolsQuery.isPending}
        value={value}
        onChange={(names: string[]) => onChange(names)}
        optionFilterProp="label"
        placeholder={
          toolsQuery.isPending
            ? t('agentForm.mcpToolsLoading')
            : tools.length === 0
              ? t('agentForm.mcpToolsEmpty')
              : t('agentForm.mcpToolsPlaceholder')
        }
        options={tools.map((tool) => ({ label: tool.name, value: tool.name }))}
      />
    </div>
  )
}
