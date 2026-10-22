/**
 * 管理页的判据层（P0-1-36）——**零依赖纯逻辑**
 *
 * 依据：`docs/03-前端设计.md` §二（`/admin/users` 与 `/admin/models` 两条 ADMIN 路由）、
 *      §七（全局交互规范十条）、`docs/02-后端设计.md` §4.2（用户四端点）/ §4.3（Provider 与模型）、
 *      `shared/src/user.ts` / `modelProvider.ts` / `model.ts`（**唯一一套投影与三态约定**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 为什么这一批必须有一个零依赖文件（而不是把判据写在页面里）
 * ─────────────────────────────────────────────────────────────────────
 * 管理页的功能（建号、启停、重置密码、维护 Provider 与模型）几乎全是"请求体构造 + 请求体裁剪"，
 * 而这几件事的错法**都不会报错**：
 *   · `PATCH /api/model-providers/:id` 多带一个 `apiKey` ⇒ **把已配置的 Key 悄默声抹掉**
 *     （响应里只有 `hasKey:false`，要等到真正调模型时才炸）；
 *   · `PATCH /api/models/:id` 多带一个 `maxContext: null` ⇒ 把上下文长度清空；
 *   · 表面一致的"重置密码"背后是 `POST :id/reset-password`（不是 PATCH），写错就是一个 404；
 *   · **Key 的回显**：编辑弹窗如果把 `apiKeyPreview` 回填进输入框，用户一保存就把掩码
 *     当成真 Key 存了进去（`02` §4.3 的"Key 有进无出"在界面这一侧最容易被破坏）。
 * P0-1-37 又添了一族同性质的判据（上游协议）：
 *   · `protocol` 与 `type` 是**两个字段**；2026-10-22 起约束改为
 *     **该 Provider 下有向量模型 ⇒ 协议只能是默认值**（见 {@link protocolOptionsFor}），
 *     否则这次提交必然 400，且报错的字段是用户**没碰过**的那个下拉；
 *   · 可选协议列表由 `shared#vectorModelRequiresCompatProtocol` 过滤，前端不另写一遍判据。
 * 这些全是纯函数，所以判据拆到这里，由 `frontend/scripts/verify-admin-ui.mjs` 逐条断言
 * ——本仓"纯逻辑拆进无依赖文件 ⇒ 断言进无依赖档"的同一手法（对照 `verify-chat-sse` /
 * `verify-knowledge-ui`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 两条"文档没写就不发明"的边界（都是**少做一件事**，不是遗漏）
 * ─────────────────────────────────────────────────────────────────────
 * · **用户没有删除接口**（`02` §4.2 只有 列表/建号/启停改角色/重置密码 四个）⇒ 界面上
 *   **没有删除按钮**。画一个 disabled 的删除键比没有更糟：它暗示"以后会有"，而实际上
 *   停用就是这条需求（`01` §3.1）的全部含义。
 * · **用户不能改昵称**（`updateUserBodySchema` 只有 `status` / `role`）⇒ 编辑弹窗里
 *   `username` 与 `nickname` 是**只读展示**，不摆一个灰着的输入框让人以为是权限问题。
 */

import type {
  CreateModelBody,
  CreateModelProviderBody,
  CreateUserBody,
  ModelItem,
  ModelProviderItem,
  ModelType,
  ProviderCredentialMode,
  RemoteModelListResult,
  UpdateModelBody,
  UpdateModelProviderBody,
  UpdateUserBody,
  UpstreamProtocol,
  UserListItem,
  UserRole,
  UserStatus,
} from '@doubulea/shared'
import {
  DEFAULT_UPSTREAM_PROTOCOL,
  VECTOR_MODEL_PROTOCOL_CONFLICT_MESSAGE,
  UPSTREAM_PROTOCOLS,
  UPSTREAM_PROTOCOL_BASE_URL_HINTS,
  UPSTREAM_PROTOCOL_LABELS,
  vectorModelRequiresCompatProtocol,
} from '@doubulea/shared'

// ═══════════════════════════════ 词表 ═══════════════════════════════

/** 角色词表（`01` §3.1 只有两种角色，无自注册）。刻意与 `USER_ROLES` 同键，漏一个编译期就红 */
export const USER_ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  ADMIN: '管理员',
  MEMBER: '成员',
}

/** 状态词表。用「启用 / 已停用」而不是 `ACTIVE` / `DISABLED`：界面上不该出现数据库枚举 */
export const USER_STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  ACTIVE: '启用',
  DISABLED: '已停用',
}

// ═══════════════════════════════ 用户列表 ═══════════════════════════════

/** 用户行的状态读数（灯 + 字两重表达：只靠颜色在色觉障碍与暗色主题下读不出来） */
export interface UserStatusView {
  /** 复用 `styles/app.css` 已有的 `.led--*` 三态灯 */
  led: 'ok' | 'warn' | 'fail'
  label: string
  /** 一句"这意味着什么"；没有额外含义时为 `null`（不写废话） */
  hint: string | null
}

/**
 * 三态（不是两态）：`DISABLED` / `ACTIVE + 待首登改密` / `ACTIVE`。
 *
 * 为什么"待首次改密"要单独一档：那个状态下的用户**能登录但什么都做不了**（根级闸门只放行
 * 改密/看自己/登出，`02` §4.1）。管理员建完号最常收到的反馈就是"我登进去了但按钮都是灰的"
 * —— 列表里看得见这一档，就不必靠猜。
 */
export function describeUserStatus(user: Pick<UserListItem, 'status' | 'mustChangePassword'>): UserStatusView {
  if (user.status === 'DISABLED') {
    return { led: 'fail', label: USER_STATUS_LABELS.DISABLED, hint: '下个请求即 401（会话快照已失效）' }
  }
  if (user.mustChangePassword) {
    return { led: 'warn', label: '启用 · 待首次改密', hint: '首登闸门下只能改密 / 看自己 / 登出' }
  }
  return { led: 'ok', label: USER_STATUS_LABELS.ACTIVE, hint: null }
}

export type AdminUserActionKey = 'edit' | 'toggle' | 'reset'

/** 用户行的一个操作（`disabled` 时 `reason` 必须给全 —— 灰按钮不加解释等于"页面坏了"） */
export interface AdminUserAction {
  key: AdminUserActionKey
  label: string
  danger: boolean
  disabled: boolean
  /** `disabled` 的原因，挂在该按钮的 `title` 与 `Tooltip` 上 */
  reason: string | null
}

/**
 * 用户行的操作矩阵。
 *
 * 三个操作**恒在**（不像文档表格那样按状态显隐 —— 用户只有两种状态，且两种下这三件事都成立），
 * 唯一的判据是 **"是不是自己"**：`02` §4.2 定案「不能操作自己」——停用、降级、重置自己的密码
 * 一律 `409`。理由（原文）："本系统只有 ADMIN 能进 `/api/users`，管理员把自己停用/降级后
 * 没有任何入口能改回来"。
 *
 * ⚠️ 所以这里**不禁用整个操作列**、也不隐藏这三个键，而是**逐个标灰 + 写明为什么**：
 * 直接少三个键会让管理员以为"我漏了什么权限"，而 `02` 里那条约束是**业务约束**（防止自锁），
 * 不是权限差异。同级先例：知识库表格按状态显隐操作项时也把"为什么没有"写进了提示。
 */
export function userRowActions(user: Pick<UserListItem, 'id' | 'status'>, currentUserId: string): AdminUserAction[] {
  const isSelf = user.id === currentUserId
  const selfReason = '不能对自己做这个操作（后端会 409）：本系统只有管理员能进这一页，自锁后没人能改回来'

  return [
    {
      key: 'edit',
      label: '编辑',
      danger: false,
      // 改角色对"自己"也是被拒的（降级自己 = 自锁）；但**保留可点**，由弹窗说清楚，
      // 因为编辑弹窗里还有只读的 username/nickname 可看（它不只是"改角色"）
      disabled: false,
      reason: null,
    },
    {
      key: 'toggle',
      label: user.status === 'ACTIVE' ? '停用' : '启用',
      // 危险操作用红色（§七 表格规范）；「启用」不是危险操作
      danger: user.status === 'ACTIVE',
      disabled: isSelf,
      reason: isSelf ? selfReason : null,
    },
    {
      key: 'reset',
      label: '重置密码',
      danger: false,
      disabled: isSelf,
      reason: isSelf ? '本人改密请走右上角头像菜单里的「修改密码」（后端同样拒绝对自己重置）' : null,
    },
  ]
}

// ═══════════════════════════════ 建号 / 编辑 ═══════════════════════════════

/** 建号表单的取值（`role` 缺省 `MEMBER`，与 DB 默认一致） */
export interface UserFormValues {
  username: string
  nickname: string
  role: UserRole
}

export const EMPTY_USER_FORM_VALUES: UserFormValues = { username: '', nickname: '', role: 'MEMBER' }

/** 编辑态的初值：只有 `role` 是可改的（见文件头 ②），另两个字段仅用于只读展示 */
export function userEditValuesOf(user: UserListItem): UserFormValues {
  return { username: user.username, nickname: user.nickname ?? '', role: user.role }
}

/**
 * 建号请求体。
 *
 * ⚠️ 三条与 `createUserBodySchema` 的逐字对齐：
 *   · `nickname` 空串 ⇒ **不带该字段**（schema 里空串会被 `transform` 成 `undefined`，
 *     前端也按同一口径：不带键，而不是 `nickname: ''`）；
 *   · `role` 总是带上（用户明确选了，而 schema 有默认值 —— 依赖服务端默认值会让
 *     "表单显示 MEMBER、实际存了别的"这种事无法从请求体看出来）；
 *   · **不带任何密码字段**：初始密码由服务端生成，调用方不能指定（`02` §4.2）。
 */
export function buildCreateUserBody(values: UserFormValues): CreateUserBody {
  const nickname = values.nickname.trim()
  return {
    username: values.username.trim(),
    ...(nickname === '' ? {} : { nickname }),
    role: values.role,
  }
}

/**
 * 改角色请求体（`PATCH /api/users/:id`）。
 *
 * 返回值 `null` = **没有任何改动 ⇒ 不发请求**（与 `buildKnowledgeUpdateBody` 同一处置）：
 * 少一次写，也少掉一次"保存成功、其实什么都没改"的误导。
 */
export function buildUpdateUserBody(user: UserListItem, nextRole: UserRole): UpdateUserBody | null {
  if (nextRole === user.role) return null
  return { role: nextRole }
}

/**
 * 建号 / 重置成功后那句一次性密码的说明（弹窗正文，`02` §4.2 的"仅此一次明文"）。
 *
 * ⚠️ 这是一段**纯文本**（会被原样放进 JSX 文本子节点）⇒ 里面不能出现 Markdown 的 `**`，
 * 否则界面上就是一串星号（P0-1-31 已踩过：JSX 文本子节点不认 Markdown，要加粗得用
 * `<strong>`）。所以这里只用标点与「」表达重点。
 */
export function initialPasswordNotice(username: string, forReset: boolean): string {
  const action = forReset ? '重置' : '创建'
  return (
    `${action}成功。下面的初始密码只会出现这一次（列表与详情接口此后都不再带它），` +
    `请立刻复制并通过可靠渠道发给「${username}」；对方首次登录会被强制改密。`
  )
}

/** 复制按钮的候选文本（独立出来是为了让"复制什么"可被断言，而不是散在组件里拼） */
export function initialPasswordCopyText(username: string, initialPassword: string): string {
  return `用户名：${username}\n初始密码：${initialPassword}`
}

// ═══════════════════════════════ Provider ═══════════════════════════════

export interface ProviderFormValues {
  name: string
  baseUrl: string
  /**
   * 自定义 URL：为 `true` 时 `baseUrl` 就是完整端点，后端原样发请求、不拼后缀
   * （见 `shared` 的 `customUrl` / `backend#resolveUpstreamUrl`）。
   */
  customUrl: boolean
  /**
   * 上游协议（P0-1-37）。2026-10-22 起约束改为：**该 Provider 下有向量模型 ⇒ 只能是默认协议**
   * （见 {@link protocolOptionsFor}）。
   *
   * ⚠️ 2026-10-22：**删除了 `type`** —— Provider 不再有类型（`models.type` 是模型自己的用途）。
   */
  protocol: UpstreamProtocol
  enabled: boolean
  /** ⚠️ 编辑态**恒为空串**（`apiKeyPreview` 绝不回填）；空串 + 未动 = "不动原 Key" */
  apiKey: string
  /** P1-18：凭据模式（共享 Key / 各自 Key） */
  credentialMode: ProviderCredentialMode
}

export const EMPTY_PROVIDER_FORM_VALUES: ProviderFormValues = {
  name: '',
  baseUrl: '',
  customUrl: false,
  protocol: DEFAULT_UPSTREAM_PROTOCOL,
  enabled: true,
  apiKey: '',
  credentialMode: 'SHARED',
}

/**
 * Provider 编辑态的初值。
 *
 * ⚠️ `apiKey` 是**空串**，不是 `provider.apiKeyPreview` —— 这是"Key 有进无出"在界面侧的落点：
 * 回填掩码会让管理员一点保存就把 `sk-****abcd` 当成真 Key 写进库（`02` §4.3 的口径是
 * "渲染成掩码 + 「重新设置」按钮，**不回填输入框**"）。
 *
 * ⚠️ `protocol` 则**必须回填**：它就是要给管理员看的既有配置（`ModelProviderItem` 里带它），
 * 与 Key 的处置刻意相反 —— 拿不到真值的是 Key，不是协议。
 */
export function providerEditValuesOf(provider: ModelProviderItem): ProviderFormValues {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    customUrl: provider.customUrl,
    protocol: provider.protocol,
    enabled: provider.enabled,
    apiKey: '',
    credentialMode: provider.credentialMode,
  }
}

// ───────────────────────── 上游协议（P0-1-37） ─────────────────────────

/** 协议下拉的选项（顺序 = `shared` 的 `UPSTREAM_PROTOCOLS`，也就是后端枚举的顺序） */
export const PROTOCOL_OPTIONS: readonly { value: UpstreamProtocol; label: string }[] =
  UPSTREAM_PROTOCOLS.map((protocol) => ({ value: protocol, label: UPSTREAM_PROTOCOL_LABELS[protocol] }))

/**
 * Provider 的协议下拉里**可选**的取值。
 *
 * 判据委托 `shared` 的 `vectorModelRequiresCompatProtocol` —— 与后端 service **同一份实现**。
 * 前端另写一遍 `hasEmbeddingModel && protocol !== …` 就会出现"界面能选、后端 400"这种最招人烦的错配。
 *
 * ⚠️ 2026-10-22 起判据的**输入从"Provider 的 type"换成了"该 Provider 下有没有向量模型"**：
 * 同一个 baseUrl 下可以同时挂对话与向量模型，所以"这个 Provider 能不能配非兼容协议"取决于
 * 它**实际挂了什么模型**，而不是它自称的默认类型。
 * ⚠️ **创建态**（`provider === null`）时下边还没有任何模型 ⇒ `hasEmbeddingModel` 恒 `false`，
 * 三种协议都可选（建完之后想挂向量模型，那一侧会再判一次）。
 *
 * ⚠️ 返回**可变**数组（不是 `readonly`）：AntD 的 `Select.options` 收的是可变数组，
 * 传 `readonly` 会编译期报 TS4104。`.filter` 本来就产出一份新数组，没有共享可变状态的风险。
 */
export function protocolOptionsFor(hasEmbeddingModel: boolean): { value: UpstreamProtocol; label: string }[] {
  return PROTOCOL_OPTIONS.filter((option) =>
    vectorModelRequiresCompatProtocol(hasEmbeddingModel, option.value),
  )
}

/** 协议被"该 Provider 下有向量模型"锁住时选择器的说明（就是后端那条 400 字段级文案，不加一个字的翻译） */
export const PROTOCOL_LOCKED_BY_VECTOR_MODEL_REASON = VECTOR_MODEL_PROTOCOL_CONFLICT_MESSAGE

/**
 * ⚠️ 2026-10-22 **删掉了** `protocolAfterTypeChange`（原用于"改 Provider 类型时把协议收回默认值"）。
 *
 * 它当年成立的前提是"Provider 的 `type` 决定协议可用集"——而现行判据是"该 Provider 下**有没有
 * 向量模型**"（{@link protocolOptionsFor}），**与 `type` 无关** ⇒ 改 `type` 不该动协议，
 * 那个"收回"动作也就没有了对象。留着它会让人以为改默认类型会影响协议。
 */

/** `baseUrl` 输入框下方的提示 —— 每种协议的路径后缀不同，填错的表现是 404（`02` §6.1） */
export function protocolBaseUrlHint(protocol: UpstreamProtocol): string {
  return UPSTREAM_PROTOCOL_BASE_URL_HINTS[protocol]
}

/** Key 那一列/那一行的读数：已配置给掩码（后端解密后生成），未配置给一句人话 */
export function describeProviderKey(provider: Pick<ModelProviderItem, 'hasKey' | 'apiKeyPreview'>): string {
  if (!provider.hasKey) return '未配置'
  return provider.apiKeyPreview ?? '已配置'
}

/**
 * 这次提交对 Key 的**意图** —— 三态的唯一判据。
 *
 * | 结果 | 什么时候 | 请求体 |
 * |------|----------|--------|
 * | `keep` | 输入框是空的（用户没碰它） | **不带 `apiKey` 键** |
 * | `clear` | 用户显式点了「清除 Key」 | `apiKey: null` |
 * | `set` | 输入框有内容 | `apiKey: '<新值>'` |
 *
 * ⚠️ 空串**不能**当成 `clear`：`providerApiKeySchema` 明确拒绝空串（400），只留
 * "不带 = 不动" 与 "`null` = 清空" 两条明确的路（`02` §4.3）。把空串当清空 = 让
 * "改个名字"顺手抹掉 Key —— 这正是本批最要防的那一件事。
 */
export function providerKeyIntent(
  values: Pick<ProviderFormValues, 'apiKey'>,
  clearRequested: boolean,
): 'keep' | 'clear' | 'set' {
  if (values.apiKey.trim() !== '') return 'set'
  return clearRequested ? 'clear' : 'keep'
}

/** 建 Provider 请求体（`apiKey` 可缺省 —— 先建后配 Key 是正常流程） */
export function buildCreateProviderBody(values: ProviderFormValues): CreateModelProviderBody {
  const apiKey = values.apiKey.trim()
  // P1-18：`PER_USER`（各自 Key）模式下，表单里那把 Key 是**创建人自己的 Key**（会写入「我的凭据」，
  // 见 `ProviderFormModal`），**不是**共享 Key ⇒ 不进 Provider 创建体（共享 Key 在这个模式下不参与调用）。
  // `SHARED` 模式下它才是共享 Key，照旧带上（空串不带 = "先建后配"）。
  const sharedKey = values.credentialMode === 'PER_USER' || apiKey === '' ? undefined : apiKey
  return {
    name: values.name.trim(),
    baseUrl: values.baseUrl.trim(),
    // 总是带上 customUrl（同 protocol 的理由：用户在开关上明确设过，不靠服务端默认值）
    customUrl: values.customUrl,
    // ⚠️ 总是带上 protocol（哪怕它就是默认值）：用户在下拉里**明确选过**，
    //    而依赖服务端默认值会让"界面显示 OpenAI 兼容、实际存了别的"无法从请求体看出来
    //    （与 `role` 总是带上同一个理由，见 `buildCreateUserBody`）
    protocol: values.protocol,
    enabled: values.enabled,
    credentialMode: values.credentialMode,
    ...(sharedKey === undefined ? {} : { apiKey: sharedKey }),
  }
}

/**
 * 表单里那把 Key 在**这一次提交**里代表什么（P1-18）。
 *
 * · `SHARED` ⇒ 它是 **Provider 共享 Key**（进 Provider 的建/改体，由 `apiKey*` 三态处理）；
 * · `PER_USER` ⇒ 它是**创建人自己的 Key**（写「我的凭据」，不进 Provider 体）。
 *
 * 判据只有一个：`credentialMode`。抽成函数是为了让页面与 body 构造器读**同一份**口径
 * —— 各写一遍必然会在"换模式"时出现一边当共享、一边当个人的错配。
 */
export function providerKeyRole(values: Pick<ProviderFormValues, 'credentialMode'>): 'SHARED' | 'PER_USER' {
  return values.credentialMode
}

/**
 * 改 Provider 请求体。返回值 `null` = 没有任何改动 ⇒ 不发请求。
 *
 * 三处三态/守卫都在这里收口（页面只负责收集表单值）：
 *   · `apiKey` 按 {@link providerKeyIntent} 决定带不带、带什么（见上）；
 *   · `protocol` **逐字比较后只在真变了才带**（同 `name`/`baseUrl` 的处置）——
 *     每次刷新 `updated_at` 会把"最近更新"这一列搅乱，而后端那条排序正是按它来的。
 *     ⚠️ 界面侧对它唯一要做的是"下拉里不摆必然被 400 的选项"（{@link protocolOptionsFor}），
 *     不在请求体构造里拦（那一层拦不住手改的请求）；
 *   · `baseUrl` 归一化（去尾斜杠）**交给契约层**（`providerBaseUrlSchema` 的 `transform`），
 *     前端不自己 `replace` —— 否则"存下来的到底是什么"会有两个答案。
 *
 * ⚠️ 2026-10-22：**不再构造 `type`** —— Provider 不再有类型（列已删）。
 */
export function buildProviderUpdateBody(
  provider: ModelProviderItem,
  values: ProviderFormValues,
  clearRequested: boolean,
): UpdateModelProviderBody | null {
  const body: Record<string, unknown> = {}

  const name = values.name.trim()
  if (name !== provider.name) body.name = name

  const baseUrl = values.baseUrl.trim()
  if (baseUrl !== provider.baseUrl) body.baseUrl = baseUrl

  // 布尔开关：逐字比较后只在真变了才带（同 `enabled` 的处置）。
  // ⚠️ 与 `protocol` 同款三态：`undefined`（调用方没给这个键）= 没改，**不**当成改动 ——
  // 否则会往请求体里塞一个 `customUrl: undefined`（被 JSON.stringify 丢掉、却已破坏
  // "零改动 ⇒ return null" 的判据，见下方 `protocol` 那段注释）。
  if (values.customUrl !== undefined && values.customUrl !== provider.customUrl) body.customUrl = values.customUrl

  /**
   * ⚠️ `protocol` 要显式判 `undefined`（**三态**，与后端 `apiKey`/`maxContext` 同款）：
   * 不判的话，`values.protocol === undefined` 会被"`undefined !== 'OPENAI_COMPAT'`"判成一次改动，
   * 于是请求体里多出一个 `protocol: undefined` —— 它被 `JSON.stringify` 悄悄丢掉，**但**
   * `Object.keys(body).length === 0` 这句已经被它破坏了 ⇒ 本该 `return null` 的"零改动"
   * 变成一次 `PATCH {}`，而契约的"至少带一个字段"会把这次必然无效的请求打成 400。
   * （这不是假想：本仓的无依赖验收档 D4/D5/E2 当时就是这么红的。）
   */
  if (values.protocol !== undefined && values.protocol !== provider.protocol) body.protocol = values.protocol

  if (values.enabled !== provider.enabled) body.enabled = values.enabled

  // P1-18：凭据模式（两态：只在真变了才带）。⚠️ 与 `protocol` 同款 —— `undefined` = 没给这个键 = 不改，
  // 绝不能把 `undefined !== 'SHARED'` 判成一次改动（那会破坏"零改动 ⇒ 不发请求"）。
  if (values.credentialMode !== undefined && values.credentialMode !== provider.credentialMode) {
    body.credentialMode = values.credentialMode
  }

  // P1-18：`PER_USER`（各自 Key）模式下 Provider 的共享 Key 不参与调用，那把 Key 归「我的凭据」管
  // ⇒ 编辑体**不碰** `apiKey`（个人 Key 的设置 / 清除由页面走 `my-credential` 端点）。
  // `SHARED` 模式照旧走三态（见 {@link providerKeyIntent}）。
  if (providerKeyRole(values) === 'SHARED') {
    const intent = providerKeyIntent(values, clearRequested)
    if (intent === 'set') body.apiKey = values.apiKey.trim()
    if (intent === 'clear') body.apiKey = null
  }

  if (Object.keys(body).length === 0) return null
  return body as UpdateModelProviderBody
}

/**
 * ⚠️ 2026-10-22 **删掉了** `providerTypeChangeBlocked` / `PROVIDER_TYPE_LOCKED_REASON`
 * （原用于"该 Provider 下有模型 ⇒ 类型选择器标灰"）。
 *
 * 方案A 废除后 `Provider.type` 只是"新建模型的默认类型"，改它不动任何模型数据 ⇒ 后端不再 409、
 * 界面也就不该再摆一个"点了必然失败"的灰选择器。
 */

// ═══════════════════════════════ 模型 ═══════════════════════════════

export interface ModelFormValues {
  providerId: string
  modelName: string
  label: string
  type: ModelType
  /** `null` = 未填写（界面上显示"未知"）。⚠️ 与"清空"共用 `null`，靠**与已存值比较**区分 */
  maxContext: number | null
  /** **向量模型专属**：输出维度（可手动填写；留空则保存时后端尽力探测） */
  embeddingDim: number | null
  /** **向量模型专属**：是否走多模态 embedding 端点（`/embeddings/multimodal` + content 分片 input） */
  embeddingMultimodal: boolean
  supportsVision: boolean
  /** 是否支持"深度思考"（reasoning / thinking）。对话链路会据此决定是否向上游请求思考 */
  supportsReasoning: boolean
  enabled: boolean
}

export const EMPTY_MODEL_FORM_VALUES: ModelFormValues = {
  providerId: '',
  modelName: '',
  label: '',
  type: 'CHAT',
  maxContext: null,
  embeddingDim: null,
  embeddingMultimodal: false,
  supportsVision: false,
  supportsReasoning: false,
  enabled: true,
}

export function modelEditValuesOf(model: ModelItem): ModelFormValues {
  return {
    providerId: model.providerId,
    modelName: model.modelName,
    label: model.label,
    type: model.type,
    maxContext: model.maxContext,
    embeddingDim: model.embeddingDim,
    embeddingMultimodal: model.embeddingMultimodal,
    supportsVision: model.supportsVision,
    supportsReasoning: model.supportsReasoning,
    enabled: model.enabled,
  }
}

/** `maxContext` 的界面校验（与 `maxContextSchema` 同口径：1 ~ 1000 万整数） */
export const MAX_CONTEXT_MIN = 1
export const MAX_CONTEXT_MAX = 10_000_000

export function validateMaxContext(value: number | null): string | null {
  if (value === null) return null
  if (!Number.isInteger(value)) return '上下文长度必须是整数'
  if (value < MAX_CONTEXT_MIN) return `上下文长度至少为 ${MAX_CONTEXT_MIN}`
  if (value > MAX_CONTEXT_MAX) return `上下文长度最多 ${MAX_CONTEXT_MAX}（填的是 token 数，不是字节数）`
  return null
}

/** 上下文长度的读数（`null` ⇒ 「未知」而不是 `0`；与检索分那处同一口径） */
export function maxContextText(value: number | null): string {
  return value === null ? '未知' : value.toLocaleString('en-US')
}

export function buildCreateModelBody(values: ModelFormValues): CreateModelBody {
  // 向量模型没有"上下文/图片/思考"这些对话侧概念 ⇒ 不发送这些字段（后端也会忽略）
  const isEmbedding = values.type === 'EMBEDDING'
  return {
    providerId: values.providerId,
    modelName: values.modelName.trim(),
    label: values.label.trim(),
    type: values.type,
    ...(isEmbedding
      ? {
          // 向量模型：可手动给维度；留空则后端保存时尽力探测
          ...(values.embeddingDim === null ? {} : { embeddingDim: values.embeddingDim }),
          embeddingMultimodal: values.embeddingMultimodal,
        }
      : {
          // ⚠️ 留空 ⇒ **不带这个键**（`null` 与缺省在 create 侧同义，但"不带"更明确）
          ...(values.maxContext === null ? {} : { maxContext: values.maxContext }),
          supportsVision: values.supportsVision,
          supportsReasoning: values.supportsReasoning,
        }),
    enabled: values.enabled,
  }
}

/**
 * 改模型请求体。返回值 `null` = 没有任何改动 ⇒ 不发请求。
 *
 * 三处"不可改/三态"，都在这里与 `02` §4.3 / `updateModelBodySchema` 逐条对齐：
 *
 * · **`providerId` 不带上**：契约里"可传但改不了"（值不同 → 409）。界面上 Provider 是
 *   **只读展示**（迁移应新建一条再改绑智能体），所以这里刻意不构造这个键 ——
 *   带上同值虽然幂等放行，但会让"这一条到底迁没迁"在请求体里看不出来。
 * · **`maxContext` 三态**：`null` 只有两种来路，靠**与已存值比较**区分 ——
 *   原值 `null` 且现在还是 `null` ⇒ 不动（不带键）；原值是数字而现在被清空 ⇒ **显式
 *   `null`**（否则用户清掉的值刷新后会回来，与知识库的"清空描述必须显式 null"同款）。
 * · **`type` 被引用时不可改**：`agentCount > 0` 时后端 409，故不带上该键（见
 *   {@link modelTypeChangeBlocked}）。
 */
export function buildModelUpdateBody(model: ModelItem, values: ModelFormValues): UpdateModelBody | null {
  const body: Record<string, unknown> = {}

  const modelName = values.modelName.trim()
  if (modelName !== model.modelName) body.modelName = modelName

  const label = values.label.trim()
  if (label !== model.label) body.label = label

  if (values.type !== model.type && !modelTypeChangeBlocked(model)) body.type = values.type

  // 向量模型不带"上下文/图片/思考"（对话侧字段）—— 用**生效类型**（类型改不动时以库里的为准）
  const typeChanging = values.type !== model.type && !modelTypeChangeBlocked(model)
  const isEmbedding = (typeChanging ? values.type : model.type) === 'EMBEDDING'
  if (isEmbedding) {
    // 维度：只在给了新值且与原值不同时才带（不支持"清空维度"—— null 无法表达，且无意义）
    if (values.embeddingDim !== null && values.embeddingDim !== model.embeddingDim) {
      body.embeddingDim = values.embeddingDim
    }
    if (values.embeddingMultimodal !== model.embeddingMultimodal) {
      body.embeddingMultimodal = values.embeddingMultimodal
    }
  } else {
    if (values.maxContext !== model.maxContext) body.maxContext = values.maxContext
    if (values.supportsVision !== model.supportsVision) body.supportsVision = values.supportsVision
    if (values.supportsReasoning !== model.supportsReasoning) body.supportsReasoning = values.supportsReasoning
  }

  if (values.enabled !== model.enabled) body.enabled = values.enabled

  if (Object.keys(body).length === 0) return null
  return body as UpdateModelBody
}

/**
 * 本次编辑是否会让**引用该模型的知识库**已有向量作废（P1-5 补）。
 *
 * 命中即"这些库需要重建索引"：改**型号**（换了上游模型）、改**维度**、改**多模态**、
 * 或把启用中的模型**停用**。只改别名 / 上下文等则不影响。
 * 判据与 `buildModelUpdateBody` 同源（都看"与已存值是否不同"），仅对 `EMBEDDING` 类型有意义。
 */
export function modelEditAffectsVectors(model: ModelItem, values: ModelFormValues): boolean {
  if (model.type !== 'EMBEDDING') return false
  return (
    values.modelName.trim() !== model.modelName ||
    (values.embeddingDim !== null && values.embeddingDim !== model.embeddingDim) ||
    values.embeddingMultimodal !== model.embeddingMultimodal ||
    (model.enabled && !values.enabled)
  )
}

/** 从知识库列表里挑出**绑定到该模型**的库（`embedding_model_id === modelId`）—— 弹窗据此列出库名 */
export function knowledgeBasesUsingModel<T extends { embeddingModelId: string | null }>(
  modelId: string,
  knowledgeBases: readonly T[],
): T[] {
  return knowledgeBases.filter((kb) => kb.embeddingModelId === modelId)
}

/**
 * 该模型的 `type` 能不能改（`02` §4.3 第三条守卫：被 Agent 引用时 409）。
 *
 * CHAT / EMBEDDING 不可互换，改了等于让已上线的智能体静默换一类模型（下一次发消息才暴露）。
 */
export function modelTypeChangeBlocked(model: Pick<ModelItem, 'agentCount'>): boolean {
  return model.agentCount > 0
}

export const MODEL_TYPE_LOCKED_REASON =
  '该模型已被智能体绑定，后端不允许改类型（409）：对话模型与向量模型不可互换，改了等于让已上线的智能体悄悄换一类模型。请先到智能体列表改绑。'

/**
 * ⚠️ 2026-10-22 **删掉了** `defaultTypeForProvider`（原"新建模型时取所属 Provider 的 type 作初值"）。
 *
 * Provider 上的 `type` 列已整列删除 ⇒ 没有"默认类型"可取了。新建模型时 `type` 的初值就是
 * `EMPTY_MODEL_FORM_VALUES.type`（`CHAT`，最常见的那个），用户在下拉里按需改。
 * 真正的合法性判据在后端：`type=EMBEDDING` 要求该 Provider 的协议是 OpenAI 兼容
 * （`shared#embeddingModelAllowedOnProtocol`），前端按同一判据把提示写在表单里。
 */
export const MODEL_TYPE_HINT =
  '类型是**模型自己的用途**（对话 / 向量）。同一个 Provider（同一个 baseUrl / 同一把 Key）下可以同时挂两类模型；向量模型要求该 Provider 的协议是 OpenAI 兼容。'

/**
 * 删模型前的"点下去会怎样"。`null` = 可以直接删（走 Popconfirm）。
 *
 * ⚠️ 引用口径有**五处**（与后端 `removeModel` 逐条同口径）：
 *  ① 在线智能体（默认模型 / 模型池成员，`agentCount`）；
 *  ② 知识库把它当**向量**模型用（`knowledgeBaseCount`）；
 *  ③ 知识库把它当**图片描述**模型用（`captionKnowledgeBaseCount`）；
 *  ④ 平台把它选为**会话标题**模型（`usedAsTitleModel`，单例）；
 *  ⑤ 均已按 `ON DELETE SET NULL` / `CASCADE` 会**静默**产生副作用 ⇒ 任一命中都不能删。
 */
export function modelDeleteBlockedNotice(
  model: Pick<ModelItem, 'agentCount' | 'knowledgeBaseCount' | 'captionKnowledgeBaseCount' | 'usedAsTitleModel'>,
): string | null {
  const reasons: string[] = []
  if (model.agentCount > 0) reasons.push(`被 ${model.agentCount} 个在线智能体绑定`)
  if (model.knowledgeBaseCount > 0) reasons.push(`被 ${model.knowledgeBaseCount} 个知识库用作向量模型`)
  if (model.captionKnowledgeBaseCount > 0)
    reasons.push(`被 ${model.captionKnowledgeBaseCount} 个知识库用作图片描述模型`)
  if (model.usedAsTitleModel) reasons.push('被平台用作会话标题生成模型')
  if (reasons.length === 0) return null

  const targets: string[] = []
  if (model.agentCount > 0) targets.push('智能体列表把它们改绑到别的模型')
  if (model.knowledgeBaseCount > 0) targets.push('这些知识库改用别的向量模型')
  if (model.captionKnowledgeBaseCount > 0) targets.push('这些知识库改用别的图片描述模型')
  if (model.usedAsTitleModel) targets.push('「系统设置 · 会话标题模型」改用别的模型')

  return `该模型正${reasons.join('、')}，后端会拒绝这次删除（409）。请先到${targets.join('、')}。`
}

// ═══════════════════════════════ 按 Provider 分组（顺序不许重排） ═══════════════════════════════

/**
 * 每一行在「Provider」那一列上的 `rowSpan`：**相邻同 Provider 的首行给这一段的条数、
 * 段内其余行给 0**。
 *
 * 为什么用 rowSpan 而不是"每个 Provider 一张小表"：一张表只有一个操作列、一套分页、一次
 * `fixed: 'right'`（`03` §七 的表格规范），而 N 张小表会得到 N 套分页与 N 个"共几条"，
 * 且"跨 Provider 找某个模型"从一次滚动变成 N 次滚动。
 *
 * ⚠️ 三点最容易写错的地方：
 *  ① **只合并"相邻"的同 Provider 行**，不做全局归集。服务端的顺序是 `createdAt asc`（`02` §4.3）,
 *     而"先建 Provider A、再建 B、之后又给 A 加模型"是常态 ⇒ 同一个 Provider 的两批模型
 *     在列表里**本来就不相邻**，会显示成两个都写着 A 的合并块。这是**如实**的（表格顺序就是
 *     服务端顺序），而上一版实现用 Map 做全局归集，会与这份顺序打架 —— 两个"分组结果"
 *     必然先腐烂一个，所以只留这一份。
 *  ② 返回值与入参**逐位对应**（`[0]` 是第 0 行的 rowSpan）。
 *  ③ 因此表格**不许对这个列开启客户端排序**：按别的列排一次，同 Provider 的行就不再相邻，
 *     rowSpan 会错位成"合并到别人头上"—— 那是一种看起来只是"表格有点怪"、实际数据归属
 *     错了的显示。
 */
export function providerGroupSpans(models: readonly ModelItem[]): number[] {
  const spans = new Array<number>(models.length).fill(0)
  let index = 0
  while (index < models.length) {
    const providerId = models[index]?.providerId
    let end = index
    while (end < models.length && models[end]?.providerId === providerId) end += 1
    spans[index] = end - index
    index = end
  }
  return spans
}

/** 出现在这批模型里的 Provider 个数（列表页页脚"覆盖 N 个 Provider"用的读数） */
export function countProviders(models: readonly ModelItem[]): number {
  return new Set(models.map((model) => model.providerId)).size
}

/** 排序口径只有一个来源（服务端）。本函数只回答"屏幕上这批里有没有停用项"，不改顺序 */
export function summarizeModels(models: readonly ModelItem[]): {
  total: number
  providers: number
  disabled: number
  vision: number
} {
  return {
    total: models.length,
    providers: countProviders(models),
    disabled: models.filter((model) => !model.enabled).length,
    vision: models.filter((model) => model.supportsVision).length,
  }
}

// ═══════════════════════════════ 删除（分级确认） ═══════════════════════════════
/**
 * 删 Provider 走**级联那一档**（`03` §七：「级联删除 = Modal + 红色危险按钮 + 明示影响范围」）。
 *
 * 为什么它是级联而删模型不是：`models.provider_id` 是 `ON DELETE CASCADE`（`02` §4.3）
 * —— 删一个 Provider 会连带删掉它下面的**全部**模型。删模型只删它自己。
 *
 * ⚠️ 需求优化：删除**不再**要求逐字输入确认（去掉重复输入），也**不再**因"有模型被引用"
 * 而 409 拦截；引用这些模型的在线智能体会被**自动解绑**（`agents.model_id` 置空）。
 * 弹窗改为提前列出"会解绑哪些模型"（见 `DeleteProviderModal.tsx` + `useProviderBoundModels`）。
 */
export const PROVIDER_DELETE_IMPACT_HINT =
  '删除 Provider 会连带删除它下面的**全部模型**（数据库外键是 ON DELETE CASCADE）。正在绑定这些模型的在线智能体会被自动解绑，变为"未绑定模型"，需到智能体编辑页重新绑定后才能对话。密文里的 API Key 也会一起消失，重建后需要重新填写。'

// ═══════════════════════════════ 拉取上游模型 ═══════════════════════════════

/** 上游列表的一行读数（`contextLength` 缺失为 `null` —— 标准 /models 多半不返回） */
export interface RemoteModelRow {
  id: string
  ownedBy: string | null
  /** 上游给的上下文长度（token），缺失为 `null`（新建模型时用它默认填充上下文长度） */
  contextLength: number | null
  /**
   * **类型推测**（`guessModelType` 的结果）：给该行的类型下拉一个**默认值**。
   *
   * ⚠️ 上游 `/models` **不返回类型**（没有任何标准字段区分对话与向量），所以只能按型号名猜。
   * 它**只是默认值**、不锁死：用户可在该行改。方向上刻意偏"猜对话"（最常见、且不会被协议守卫拦；
   * 猜错成对话只是"建错了再改"，反向会直接调不通）。
   */
  guessedType: ModelType
}

/** 向量型号名的**保守**启发式：命中才猜 `EMBEDDING`，否则一律 `CHAT`（见 {@link RemoteModelRow.guessedType}） */
const EMBEDDING_MODEL_NAME_PATTERNS: readonly RegExp[] = [
  /embed/i,
  /(^|[-_/])bge([-_/]|$)/i,
  /(^|[-_/])gte([-_/]|$)/i,
  /\bm3e/i,
  /voyage/i,
  /(^|[-_/])e5([-_/]|$)/i,
]

/**
 * 按型号名**保守**推测类型：命中向量特征才 `EMBEDDING`，其余一律 `CHAT`。
 *
 * ⚠️ 这是**启发式**、不是判据 —— 上游不返回类型，只能猜，所以会误伤（如某些 `*-e5*` 的对话变体）。
 * 因此它只作**每行下拉的默认值**，用户可逐行改；方向上偏"猜对话"（把向量误建成对话只是再改一次，
 * 而把对话误建成向量会被协议守卫拦 / 调不通）。
 */
export function guessModelType(modelName: string): ModelType {
  return EMBEDDING_MODEL_NAME_PATTERNS.some((pattern) => pattern.test(modelName)) ? 'EMBEDDING' : 'CHAT'
}

export function remoteModelRows(result: RemoteModelListResult): RemoteModelRow[] {
  return result.items.map((item) => ({
    id: item.id,
    ownedBy: item.ownedBy,
    contextLength: item.contextLength,
    guessedType: guessModelType(item.id),
  }))
}

/**
 * 抽屉顶部那句"这次探到了什么"。`null` = 什么都不用说（没有需要提醒的边界）。
 *
 * ⚠️ 探到的清单**只是参考**，不是"应该配哪些模型"：上游的 `/models` 里常混着一堆不能用的
 * （embedding、图像、老版本），所以这里明确写"由你自己挑"。三个提醒各有来路：
 *   · `truncated` —— 后端**显式**截断（500 条上限），不静默（`02` §4.3）；
 *   · `total === 0` —— 真的一个都没探到（不是"还在加载"）；
 *   · `!hasKey` 的 Provider 也可能探得到（内网实现常免鉴权），所以探到了不能说成"Key 配好了"。
 */
export function remoteModelNotice(result: RemoteModelListResult, hasKey: boolean): string | null {
  if (result.total === 0) return '上游没有返回任何模型。请核对 baseUrl；该实现可能不提供模型列表，那就手工录入型号名。'
  const parts: string[] = []
  if (result.truncated) {
    parts.push(`上游共 ${result.total} 个，这里只列了前 ${result.items.length} 个（上限截断，不是全部）`)
  }
  if (!hasKey) parts.push('这个 Provider 还没配 API Key —— 也能探到说明上游免鉴权，但不代表能正常调用')
  return parts.length === 0 ? null : parts.join('；')
}
