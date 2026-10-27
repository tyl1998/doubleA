/**
 * MCP 界面的**纯逻辑**与展示口径（P0-2-11）
 *
 * 依据：`shared/src/mcp.ts`（server / 凭据模板 / 凭据清单的唯一一套投影与判据）、
 *      `shared/src/sse.ts`（确认流的 `source` / `expiresAt`）、`docs/02` §4.7（九条端点表）、
 *      §9.9（危险判定）/ §9.10（确认流契约）、`docs/03` §4.2（Agent 编辑页第 4 区）、
 *      §4.4（MCP 管理页）/ §4.5（我的凭据页）/ §七（列表三态、删除分级、文案词表）、
 *      `design/mcp.html`（视觉与结构）。
 *
 * 为什么单独一个文件（而不是写进页面）：它是"**这一行该显示什么 / 这次保存该发什么 /
 * 这个输入框该不该标红**"的唯一判据，全部是**纯函数** —— 没有 React、没有请求、也不 import antd。
 * 于是 `frontend/scripts/verify-mcp-ui.mjs` 能在 node 里直接跑它逐条断言
 * （本仓"纯逻辑拆进无依赖文件 ⇒ 断言进无依赖档"的同一手法：`knowledgeModel` /
 * `adminModel` / `agentModel` / `composerState` / `conversationList`）。
 *
 * ⚠️ 本文件里**每一个常量都可能来自别处**，抄一份就多一个会腐烂的地方：
 *   · 注入位置取值域 / 模板校验 / 凭据缺口        → `shared/src/mcp.ts`
 *   · 确认来源 / 倒计时的绝对时刻                  → `shared/src/sse.ts`
 *   · 错误码取值域与默认文案                       → `shared/src/errors.ts`
 * 本文件只做"把它们组织成界面用得上的形状"，**不新增事实**。
 */

import {
  CREDENTIAL_INJECT_LOCATIONS,
  MCP_CREDENTIAL_KEY_MAX,
  MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES,
  MCP_SERVER_NAME_MAX,
  translate,
  validateCredentialSchema,
  validationText,
  type KbMcpVisibility,
  type CredentialInjectLocation,
  type CredentialSchema,
  type CredentialSchemaEntry,
  type CreateMcpServerBody,
  type CredentialSchemaImpact,
  type Locale,
  type McpCredentialField,
  type McpCredentialItem,
  type McpServerItem,
  type McpServerStatus,
  type MessageKey,
  type UpdateMcpServerBody,
} from '@doubulea/shared'

// ───────────────────────────── 一、server 列表的展示口径 ─────────────────────────────

export interface ServerStatusView {
  /** 状态灯色（样式类，与 `styles/app.css` 的 `.led--*` 对齐） */
  led: 'ok' | 'warn' | 'fail' | 'idle'
  /** 状态标签的 i18n key（`03` §七 文案词表：界面不出现裸英文状态词；P1-23 起存 key 不存文案） */
  labelKey: MessageKey
  /** 一句话说明"这意味着什么"（悬浮提示）的 i18n key */
  hintKey: MessageKey
}

/**
 * 连通状态 → 界面读数。**唯一一份映射**（别在表格里再判一次 `status`）。
 *
 * ⚠️ `UNKNOWN` 的中文是「**未测试**」而不是「异常」：它表示"我们还没跟它握过手"
 * （刚注册、或注册信息刚改过、缓存被清），不是一条负面结论。
 * 把它显示成红色会让用户去查一个并不存在的问题 —— 这与 `/health` 的
 * 「说不出来的数字宁可留白」是同一条口径。
 */
const SERVER_STATUS_VIEW: Readonly<Record<McpServerStatus, ServerStatusView>> = {
  OK: { led: 'ok', labelKey: 'label.serverStatus.OK', hintKey: 'mcp.statusHint.OK' },
  ERROR: { led: 'fail', labelKey: 'label.serverStatus.ERROR', hintKey: 'mcp.statusHint.ERROR' },
  UNKNOWN: { led: 'idle', labelKey: 'label.serverStatus.UNKNOWN', hintKey: 'mcp.statusHint.UNKNOWN' },
}

export function serverStatusView(status: McpServerStatus): ServerStatusView {
  return SERVER_STATUS_VIEW[status]
}

/**
 * 工具数的显示文本。
 *
 * ⚠️ **`0` 有两种含义**（`shared#mcpServerItemSchema` 的 `toolCount` 注释）：
 * "没拉过"（`status === 'UNKNOWN'`）与"真的没有工具"。前者**留白 `—`**、
 * 后者显示 `0` —— 界面拿不出这两个数的区别就只能编，而"这个 server 有 0 个工具"
 * 会让用户去上游找一个其实不存在的配置问题。
 */
export function formatToolCount(server: Pick<McpServerItem, 'status' | 'toolCount'>): string {
  if (server.status === 'UNKNOWN' && server.toolCount === 0) return '—'
  return String(server.toolCount)
}

/** 表格里那一格「我的凭据」的读数 */
export type CredentialCell =
  | { kind: 'none'; labelKey: MessageKey; hintKey: MessageKey }
  | { kind: 'configured'; labelKey: MessageKey; hintKey: MessageKey; hintKeys?: readonly string[] }
  | { kind: 'missing'; labelKey: MessageKey; hintKey: MessageKey; missingKeys: readonly string[] }

/**
 * 「我的凭据」这一格。
 *
 * 三分支的**判据只有一个来源**：{@link McpCredentialItem}（`GET /api/mcp/credentials`）。
 * 本函数**不认识** server 对象以外的任何东西 —— Agent 编辑页的红点、顶部入口的徽标、
 * 表格这一格，三处都由同一个投影派生（`06` P0-2-11 坑预判 4：
 * "未配置红点/计数只有一个来源"）。
 *
 * ⚠️ 2026-10-16 修订：`configured` 现在是"**我是否真的填过值**"（按人判，见
 * `shared#isCredentialConfigured`）—— 这台 server 对**每个人**给出各自答案，"别人配过"
 * 不再让你这里显示"已配置"。`missingKeys`（必填缺哪些）只并入提示文案，不再决定分支。
 *
 * `item === undefined`（清单里没有这台 server ⇒ 请求还没回来/读失败）时**返回 `none` 之外的
 * 一个中性读数**：说不出来就说"未知"，不拿"未配置"去冒充（那会是一批假警报）。
 *
 * ⚠️ P1-23 第八批：`label`/`hint` 改为 `labelKey`/`hintKey`（存 key 不存文案）—— 组件侧
 * `translate(locale, ...)` 落译文；`hintKeys` 是 `{keys}` 占位符的取值（缺必填时的 key 列表）。
 */
export function credentialCell(item: McpCredentialItem | undefined): CredentialCell {
  if (item === undefined) {
    return { kind: 'none', labelKey: 'label.credentialCell.unknown', hintKey: 'mcp.credential.hintUnknown' }
  }
  // 模板为空 ⇒ 这台 server 不向用户要任何东西（内网无鉴权服务是最常见的一种）
  if (item.fields.length === 0) {
    return { kind: 'none', labelKey: 'label.credentialCell.none', hintKey: 'mcp.credential.hintNone' }
  }
  if (item.configured) {
    return {
      kind: 'configured',
      labelKey: 'label.credentialCell.configured',
      hintKey: item.missingKeys.length === 0 ? 'mcp.credential.hintConfigured' : 'mcp.credential.hintConfiguredMissing',
      hintKeys: item.missingKeys,
    }
  }
  return {
    kind: 'missing',
    labelKey: 'label.credentialCell.missing',
    hintKey: item.missingKeys.length === 0 ? 'mcp.credential.hintMissing' : 'mcp.credential.hintMissingKeys',
    missingKeys: item.missingKeys,
  }
}

/** 便利：把 {@link CredentialCell} 落到某个语言的文案（组件只关心"这一格显示什么"） */
export function credentialCellText(
  cell: CredentialCell,
  locale: Locale,
): { label: string; hint: string } {
  const keys =
    cell.kind === 'missing'
      ? cell.missingKeys
      : cell.kind === 'configured'
        ? (cell.hintKeys ?? [])
        : []
  return {
    label: translate(locale, cell.labelKey),
    hint:
      keys.length === 0
        ? translate(locale, cell.hintKey)
        : translate(locale, cell.hintKey, { keys: keys.join(translate(locale, 'mcp.listSeparator')) }),
  }
}

/**
 * 顶部「我的凭据」入口的徽标数：**未配置的 server 台数**。
 *
 * 判据 = `unconfigured.length`，而 `unconfigured` 是服务端从同一份 `items` 派生的瘦投影
 * ⇒ 与表格那一格**逐条同源**。前端**不自己数一遍** `items.filter(...)`
 * （数两遍就迟早会出现"徽标说 2、表格里只有 1 台标红"这种没有编译期错误的偏差）。
 */
export function unconfiguredCount(unconfigured: readonly unknown[]): number {
  return unconfigured.length
}

/**
 * 凭据页的分组顺序：**未配置的置顶**（`03` §4.5 原文），组内保持服务端给的顺序
 * （`createdAt asc`）。
 *
 * sort 是**稳定的**（ES2019 起 `Array.prototype.sort` 保证稳定）⇒ 同档内不会自己换位，
 * 于是"服务端顺序"这一份事实没有被前端悄悄改写。⚠️ 这也是唯一一处前端排序：
 * server 列表页**不排**（照服务端顺序）。
 */
export function sortCredentialGroups(items: readonly McpCredentialItem[]): McpCredentialItem[] {
  return [...items].sort((a, b) => Number(a.configured) - Number(b.configured))
}

/** 锚点 id（`?serverId=` 定位的目标）。**唯一构造点** —— 页面与滚动逻辑共用它 */
export function credentialGroupAnchorId(serverId: string): string {
  return `cred-${serverId}`
}

/**
 * `?serverId=` 的定位目标解析。
 *
 * 返回 `null` 表示"不用滚"：没带参数、带了个不在这份清单里的 id（server 被删了 / 别人发的链接）、
 * 或清单还没读到。**三种情况都返回 `null`** —— 页面对它们做的事完全一样（什么都不做），
 * 而把它们分成三个分支只会多出三条永远走不到的代码。
 *
 * ⚠️ 判据是"**在不在清单里**"，不是"格式对不对"：`serverId` 是个 uuid，
 * 但页面不该拿 uuid 正则去判它（`shared#mcpCredentialServerIdParamsSchema` 的注释里
 * 已经有一条同款教训：id 的形态是**实现细节**，要判的是"在不在"，不是"像不像"）。
 */
export function resolveScrollTarget(
  serverIdParam: string | null,
  items: readonly McpCredentialItem[],
): string | null {
  if (serverIdParam === null || serverIdParam === '') return null
  return items.some((item) => item.serverId === serverIdParam) ? credentialGroupAnchorId(serverIdParam) : null
}

// ───────────────────────────── 二、凭据表单：**只写不改** ─────────────────────────────

/**
 * 凭据输入框的一行草稿。
 *
 * ⚠️ **值不下发**（`shared#mcpCredentialFieldSchema`：连掩码都没有）⇒ 草稿的初值**恒为空串**，
 * 占位符写"留空 = 不变"。界面上**没有**"当前值"这个东西可以回填 —— 谁要是给它填了个
 * 什么，那一定是编的。
 */
export interface CredentialDraftRow {
  key: string
  label: string
  inject: CredentialInjectLocation
  required: boolean
  placeholder: string
  /** 我这边这个 key 有没有值（来自服务端，**只有真假**） */
  hasValue: boolean
  /** 输入框当前内容（空串 = 用户什么都没填 ⇒ 不进提交体） */
  value: string
}

/** `McpCredentialField[]` → 表单草稿（`value` 恒空串，见 {@link CredentialDraftRow}） */
export function credentialDraftsFromFields(fields: readonly McpCredentialField[]): CredentialDraftRow[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    inject: field.inject,
    required: field.required,
    placeholder: field.placeholder ?? '',
    hasValue: field.hasValue,
    value: '',
  }))
}

/** 改某一行（`key` 不可改 —— 它是模板定义的，改名等于换一个参数） */
export function setCredentialDraftValue(
  rows: readonly CredentialDraftRow[],
  key: string,
  value: string,
): CredentialDraftRow[] {
  return rows.map((row) => (row.key === key ? { ...row, value } : row))
}

/**
 * 构造 `PUT` 的 `values`：**只带真改过的 key**。没改就返回 `null`（⇒ 调用方不发请求）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是"合并"而不是"整体替换"（与 Agent `components` **刻意相反**）
 * ─────────────────────────────────────────────────────────────────────
 * 值不下发 ⇒ 前端**无从回填** ⇒ 若把整张表都提交一遍，用户只改一个 key 时，
 * 其余空的输入框会以**空串**提交，而空串的语义是"清空该 key"
 * （`shared#putMyCredentialBodySchema`）⇒ **他什么都没做，值却没了**。
 * 分辨方式只有一条：**不可回填的字段只能合并**。
 *
 * 判定"改过"用的是**原始输入与空串的比较**（`value.length > 0`），**不是 `trim()` 后非空**：
 * 空格是合法的凭据内容（有些 token 带尾随空格是上游要求），`trim()` 会把"我填了一个空格"
 * 悄悄变成"我没填"。空格**是不是值**由用户决定，不由我们替他裁掉。
 *
 * `Object.keys(values).length === 0` 时返回 `null` 而不是 `{values:{}}`：
 * 空对象会被后端 **400**（"请至少提交一个凭据参数"），而"一个都没改"根本不是一次错误。
 */
export function buildCredentialSubmitValues(
  rows: readonly CredentialDraftRow[],
): Record<string, string> | null {
  const values: Record<string, string> = {}
  for (const row of rows) if (row.value.length > 0) values[row.key] = row.value
  return Object.keys(values).length === 0 ? null : values
}

/** 有任何一个输入框被填过（用它决定"保存"按钮是否可点，与 {@link buildCredentialSubmitValues} 同源） */
export function hasCredentialInput(rows: readonly CredentialDraftRow[]): boolean {
  return rows.some((row) => row.value.length > 0)
}

/**
 * 一次提交是否"填齐了必填项"（本地预检，省掉一次必然失败的往返）。
 *
 * ⚠️ 它是**合并语义下的判据**：一个必填 key 满足条件的方式有两种 ——
 * **本次填了**，或**本来就有值**（`hasValue`）。少判后者会让"已有值的必填项没重填"
 * 被误判成"没填齐"，而用户明明什么都不用做（这正是 `03` §4.5 的"已配置 ✓"那一列存在的理由）。
 */
export function missingAfterSubmit(rows: readonly CredentialDraftRow[]): string[] {
  return rows
    .filter((row) => row.required && !row.hasValue && row.value.length === 0)
    .map((row) => row.key)
}

// ───────────────────────────── 三、凭据参数模板编辑器 ─────────────────────────────

/** 模板编辑器的一行草稿（`rowId` 只用于 React key 与错误定位，**不进契约**） */
export interface TemplateRowDraft {
  rowId: string
  key: string
  label: string
  inject: CredentialInjectLocation
  required: boolean
  placeholder: string
}

/** 一行模板错误（`rowId` 定位到输入框；`field` 决定标在哪一列） */
export interface TemplateRowIssue {
  rowId: string | null
  field: 'key' | 'label' | 'inject' | 'required' | 'placeholder' | null
  message: string
}

/** 新增行的初值：注入位置给 `HEADER`（`03` §4.4 的模板编辑器三个值里最常见的一个） */
export function createTemplateRow(rowId: string): TemplateRowDraft {
  return { rowId, key: '', label: '', inject: 'HEADER', required: false, placeholder: '' }
}

/** 模板（契约形态）→ 编辑器草稿 */
export function templateRowsFromSchema(schema: CredentialSchema): TemplateRowDraft[] {
  return schema.map((entry, index) => ({
    rowId: `t${index}`,
    key: entry.key,
    label: entry.label,
    inject: entry.inject,
    required: entry.required === true,
    placeholder: entry.placeholder ?? '',
  }))
}

/** 追加一行（`rowId` 由调用方给 —— 保持本模块纯函数、可在 node 里直接断言） */
export function appendTemplateRow(rows: readonly TemplateRowDraft[], rowId: string): TemplateRowDraft[] {
  return [...rows, createTemplateRow(rowId)]
}

/**
 * 移除第 `index` 行；越界时**原样返回同一个引用**（不抛、也不生成新数组）。
 *
 * ⚠️ 返回同一引用不只是省一次渲染：调用方据此可以判断"这一下什么也没发生"，
 * 而不必自己再判一次边界 —— 边界判两遍，迟早有一遍判错。
 *
 * ⚠️ 形参/返回都是**可变**数组（与 `updateTemplateRow` 一致）：草稿状态本身是
 * `ServerFormDraft['credentialSchema']: TemplateRowDraft[]`，"越界返回同一引用"这条
 * 契约要求把入参**原样交回**，而 `readonly` 入参没法原样交回可变出参 ——
 * 强行标注只会让每个调用点写一句 `[...removeTemplateRow(...)]`，把这条契约淹掉。
 */
export function removeTemplateRow(rows: TemplateRowDraft[], index: number): TemplateRowDraft[] {
  if (index < 0 || index >= rows.length) return rows
  return rows.filter((_, i) => i !== index)
}

/** 改第 `index` 行的某几列（`rowId` 不可改） */
export function updateTemplateRow(
  rows: readonly TemplateRowDraft[],
  index: number,
  patch: Partial<Omit<TemplateRowDraft, 'rowId'>>,
): TemplateRowDraft[] {
  return rows.map((row, i) => (i === index ? { ...row, ...patch } : row))
}

/**
 * 草稿 → 契约形态（提交用）。**在这里 `trim()`**：前后空格在 header 名/参数名里
 * 一定是笔误，而 `.trim()` 也正是 `credentialSchemaEntrySchema` 自己做的事
 * ⇒ 本地先裁一次，能避免"提交后被后端裁掉、本地看着却已经变了"的那种对不上。
 */
export function templateRowsToSchema(rows: readonly TemplateRowDraft[]): CredentialSchema {
  return rows.map((row) => {
    const entry: CredentialSchemaEntry = {
      key: row.key.trim(),
      label: row.label.trim(),
      type: 'string',
      inject: row.inject,
    }
    // `required` / `placeholder` 只在"有内容"时才带上（契约里它们是可省的二态：
    // 「没声明」与「声明了 false」在归一化后等价，但少写一个键能少一份会腐烂的差异）
    if (row.required) entry.required = true
    const placeholder = row.placeholder.trim()
    if (placeholder !== '') entry.placeholder = placeholder
    return entry
  })
}

/** 校验行数上限（`shared` 的 `MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES`，**同一个常量**） */
export function templateRowLimit(): number {
  return MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES
}

export function canAppendTemplateRow(rows: readonly TemplateRowDraft[]): boolean {
  return rows.length < MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES
}

/**
 * 逐行校验（**与后端同一份实现**：`shared#validateCredentialSchema`）。
 *
 * ⚠️ 判据**只有一个来源**：本地不重新实现"HEADER 名不能撞保留头 / QUERY 名不能含 `&=` /
 * BODY 名不能撞 JSON-RPC 保留键 / 同模板内不得重名"这四条语义规则
 * （它们都在 `credentialSchemaDeepIssues` 里）。前端自己写一遍的后果不是"多写几行"，
 * 而是**两处的判据会各自演化** —— 症状是"本地放行、后端 400"，而且错误文案还长得不一样。
 *
 * 入参传**原始未裁切的草稿**（`templateRowsToSchema` 会 trim，而这里要按原样判 ——
 * 用户在 `key` 里敲了空格时就该当场看到提示，而不是等提交后由后端裁完再报）。
 * `rowId` 的还原按**下标**：`validateCredentialSchema` 给的 path 首段就是数组下标。
 */
export function templateRowIssues(rows: readonly TemplateRowDraft[], locale: Locale): TemplateRowIssue[] {
  const result = validateCredentialSchema(templateRowsToSchema(rows))
  if (result.ok) return []
  return result.issues.map((issue) => {
    const [head, field] = issue.path
    const index = typeof head === 'number' ? head : null
    const row = index === null ? undefined : rows[index]
    return {
      rowId: row?.rowId ?? null,
      field: (field ?? null) as TemplateRowIssue['field'],
      // `validateCredentialSchema` 从 P1-23 收尾 ②-6 起给的是 `@validation.*` key（`shared` 里零中文），
      // 落译文只在这一处 —— 组件与守门脚本因此看到的是**当前语言**的正文。
      message: validationText(locale, issue.message),
    }
  })
}

/** 某个 `rowId` 的 `key` 列上的第一条错误（渲染红字用；没有就 `undefined`） */
export function keyIssueFor(issues: readonly TemplateRowIssue[], rowId: string): string | undefined {
  return issues.find((issue) => issue.rowId === rowId && issue.field === 'key')?.message
}

/** 没有归属到某一行的错误（数量超限 —— `path` 是空串） */
export function formLevelTemplateIssues(issues: readonly TemplateRowIssue[]): TemplateRowIssue[] {
  return issues.filter((issue) => issue.rowId === null)
}

// ───────────────────────────── 四、server 表单：新建 / 编辑的请求体 ─────────────────────────────

export interface ServerFormDraft {
  name: string
  endpointUrl: string
  credentialSchema: TemplateRowDraft[]
}

export function emptyServerFormDraft(): ServerFormDraft {
  return { name: '', endpointUrl: '', credentialSchema: [] }
}

/** 编辑态初值（模板从 server 的 `credentialSchema` 反推） */
export function serverFormDraftFrom(server: McpServerItem): ServerFormDraft {
  return {
    name: server.name,
    endpointUrl: server.endpointUrl,
    credentialSchema: templateRowsFromSchema(server.credentialSchema),
  }
}

/**
 * 新建请求体。**永远返回一个 body**（新建时"什么都没改"不是一种状态 —— 空表单就该被
 * 前端的必填校验拦住，而不是靠"构造不出 body"来间接拦）。
 *
 * ⚠️ `authType` **不提交**：P0 恒为 `NONE`（`shared` 文件头 ②），而契约里它是 `optional`
 * 且省略即 `NONE` ⇒ 提交一个恒定的值只会让"将来支持 OAUTH 时要改前端"多一个地方。
 *
 * 模板**空数组也照提交**（`credentialSchema: []`）：它的含义是明确的
 * ——"这台 server 不向用户要任何东西" —— 比"省略"更清楚（省略与 `[]` 归一化后等价，
 * 但这个键存在与否在界面上有区别：空模板的凭据格显示「无需凭据」）。
 */
export function buildCreateServerBody(draft: ServerFormDraft, visibility?: KbMcpVisibility): CreateMcpServerBody {
  return {
    name: draft.name.trim(),
    endpointUrl: draft.endpointUrl.trim(),
    credentialSchema: templateRowsToSchema(draft.credentialSchema),
    // P1-13：可见性由表单单独维护（`ServerFormDraft` 不含它，见 `McpServerFormModal`）。
    // `undefined` ⇒ 不带（契约里省略即 PRIVATE）
    ...(visibility === undefined ? {} : { visibility }),
  }
}

/**
 * 模板**整体判等**（2026-10-17 修订）：键序无关（jsonb 往返会重排对象键，直比会出假阳性）、
 * **行序有关**（顺序即界面顺序，是刻意保留的事实 —— 调了行序却"没改"等于白调）。
 *
 * 为什么**不能用** `shared#diffCredentialSchema` 做这个判定：它回答的是
 * "**已存凭据会受什么影响**"（只看 key 的增/删/换注入位置，`label`/`placeholder`/`required`
 * 按定义不参与）。拿它当"用户改没改模板"的判据，症状就是本 bug：
 * **只改参数提示（label）⇒ diff 为空 ⇒ `credentialSchema` 不进请求体 ⇒ 改动静默丢失**
 * —— 弹窗里看着改了、保存也"成功"，重开弹窗还是旧文案（backend 的 `sameJson` 本来
 * 就预期收下并处理它，见 `shared` 文件头 ④"连 label 改了也清缓存"）。
 *
 * 三个判据各答各的问题，别互相合并（`docs/06` §六 第 ⑰ 条）：
 *   · 本函数 → "**用户这次改没改模板**"（决定发不发 `credentialSchema`）；
 *   · 服务层 `sameJson` → "**模板整体变没变**"（决定清不清工具缓存）；
 *   · `diffCredentialSchema` → "**已存凭据受什么影响**"（决定 impact 提示，服务端算）。
 *
 * 实现 = 一份规范化序列化：对象键排序、跳过 `undefined` 值（与"可省键"等价）、数组保持顺序。
 * 两侧都是**归一化后**的形状（服务端投影过 `normalizeCredentialSchema`、草稿经
 * {@link templateRowsToSchema} trim），因此不需要再做语义层折算。
 */
function canonicalTemplateJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTemplateJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalTemplateJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** {@link canonicalTemplateJson} 的判等出口（true = 两份模板**没有**任何差异） */
export function credentialSchemaEquals(
  a: readonly CredentialSchemaEntry[],
  b: readonly CredentialSchemaEntry[],
): boolean {
  return canonicalTemplateJson(a) === canonicalTemplateJson(b)
}

/**
 * 编辑请求体：**只带真改过的字段**；一个都没改 ⇒ 返回 `null`（调用方不发请求）。
 *
 * ⚠️ `credentialSchema` 的比较是**整体结构判等**（{@link credentialSchemaEquals}）：
 * `label`（参数提示）/ `placeholder` / `required` / **行序**的任何差异都要提交 ——
 * 这份模板就是"我的凭据"页的表单定义，漏发它们 = 用户改了等于没改（本函数 2026-10-16 之前
 * 的行为，即本 bug）。反过来，纯粹的视觉调整（改 label）也**不会**误弹"影响了 N 份凭据"：
 * 那条提示由服务端按 `diffCredentialSchema`（key 级）计算，文案级改动 ⇒ diff 为空 ⇒ `null`。
 *
 * ⚠️ 三个字段的"清空"形态：`credentialSchema` 的清空就是提交 `[]`（数组语义）；
 * `name` / `endpointUrl` 都是必填，**不存在清空**（空了就是本地校验拦下的非法输入）。
 */
export function buildServerUpdateBody(
  server: McpServerItem,
  draft: ServerFormDraft,
  visibility?: KbMcpVisibility,
): UpdateMcpServerBody | null {
  const body: UpdateMcpServerBody = {}

  const name = draft.name.trim()
  if (name !== server.name) body.name = name

  const endpointUrl = draft.endpointUrl.trim()
  if (endpointUrl !== server.endpointUrl) body.endpointUrl = endpointUrl

  const nextSchema = templateRowsToSchema(draft.credentialSchema)
  if (!credentialSchemaEquals(server.credentialSchema, nextSchema)) {
    body.credentialSchema = nextSchema
  }

  // P1-13：可见性只在真的变了时带上；`undefined`（旧调用方）视为"没给"，不凭空造键
  if (visibility !== undefined && visibility !== server.visibility) body.visibility = visibility

  return Object.keys(body).length === 0 ? null : body
}

/**
 * 模板变更的影响 → **一句人话**（`shared#credentialSchemaImpactSchema` 的口径原文）。
 *
 * ⚠️ 措辞里**绝不能出现"已清理/已删除"**：这条路径**只提示、绝不自动清理**
 * （`06` P0-2-3 坑预判 2）—— 用户只是临时改错了模板时，"值没了"是不可逆的，
 * 而他什么都没做。清理由用户自己在凭据页点。
 *
 * `null`（本次没有需要提示的影响）⇒ 返回 `null`，**不编一句"没有影响"**：
 * 那会让"改了个名字"这种零影响的操作也弹一条提示。
 */
export function credentialImpactHint(impact: CredentialSchemaImpact | null, locale: Locale): string | null {
  if (impact === null) return null
  const join = (keys: readonly string[]): string => keys.join(translate(locale, 'mcp.listSeparator'))
  const parts: string[] = []
  if (impact.removedKeys.length > 0) {
    const affected =
      impact.affectedCredentials > 0
        ? translate(locale, 'mcp.impact.affectedFilled', { count: impact.affectedCredentials })
        : translate(locale, 'mcp.impact.affectedBare')
    parts.push(translate(locale, 'mcp.impact.removed', { keys: join(impact.removedKeys), affected }))
  }
  if (impact.retargetedKeys.length > 0) {
    parts.push(translate(locale, 'mcp.impact.retargeted', { keys: join(impact.retargetedKeys) }))
  }
  if (impact.addedKeys.length > 0) {
    parts.push(translate(locale, 'mcp.impact.added', { keys: join(impact.addedKeys) }))
  }
  if (parts.length === 0) return null
  return `${parts.join(translate(locale, 'mcp.impact.join'))}${translate(locale, 'mcp.impact.tail')}`
}

/** 连通用途之外的一处小读数：`name` / `endpointUrl` 的长度上限（提示文案与 `maxLength` 用） */
export const SERVER_NAME_MAX = MCP_SERVER_NAME_MAX
export const CREDENTIAL_KEY_MAX = MCP_CREDENTIAL_KEY_MAX

/** 注入位置的中文标签 key（三处受控下拉共用；**不出现裸英文**；`translate(locale, ...)` 落译文） */
export const INJECT_LOCATION_KEY: Readonly<Record<CredentialInjectLocation, MessageKey>> = {
  HEADER: 'label.injectLocation.HEADER',
  QUERY: 'label.injectLocation.QUERY',
  BODY: 'label.injectLocation.BODY',
}

/** 注入位置随语言变体的短形（凭据页那一行说明用） */
export const INJECT_HINT_KEY: Readonly<Record<CredentialInjectLocation, MessageKey>> = {
  HEADER: 'label.injectHint.HEADER',
  QUERY: 'label.injectHint.QUERY',
  BODY: 'label.injectHint.BODY',
}

/** 注入位置的取值域（与 `shared` 同源，供下拉渲染；顺序即下拉顺序） */
export const INJECT_LOCATIONS = CREDENTIAL_INJECT_LOCATIONS

/**
 * ⚠️ **确认卡**（倒计时 / 来源文案 / 答复结果）的纯逻辑**不在本文件**，而在
 * `features/chat/confirmModel.ts`：确认卡是对话域组件，而让 `features/chat/` 反过来 import
 * `pages/` 是一条方向错误的依赖。**也别把它复制回来一份**
 * —— 两份判据必然各自演化（`docs/06` §六 第 ⑰ 条）。
 *
 * 同理，**工具卡上那条「去配置凭据」的判据**（`canConfigureCredential`）与 `toolErrorHint`
 * 住在 `features/chat/messageModel.ts` —— 它们消费的是 `ToolCallView`，属于对话域。
 * 三处消费者的分工：
 *   · 本文件 → 两个 MCP 页面（列表 / 凭据）与模板编辑器；
 *   · `features/chat/confirmModel.ts` → 确认卡；
 *   · `features/chat/messageModel.ts` → 工具卡。
 */
