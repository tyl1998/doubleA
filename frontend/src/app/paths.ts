/**
 * 路由路径常量（P0-1-30）
 *
 * 为什么要有这个文件：登录页、守卫、头像菜单、以及将来所有"跳去改密/跳到登录"的地方
 * 都要引用这几个地址。字符串散在各处时，`/login?view=password` 这种**带查询参数的重定向**
 * 一旦写歪（少一个 `?` 或参数名不一致），症状是"跳过去了但停在登录态"—— 很难联想。
 */

import type { Location } from 'react-router-dom'

export const LOGIN_PATH = '/login'
export const PASSWORD_PATH = '/settings/password'
/**
 * 首页 = **聊天主页**（P1-15 · 以聊天为主页）。
 *
 * ⚠️ P1-15 之前 `HOME_PATH` 是**智能体列表**；改造后 `/` 是聊天主页（跨智能体会话历史 +
 * 当前会话），智能体列表搬到 {@link AGENTS_PATH}。凡"回智能体列表"的动线要显式用
 * `AGENTS_PATH`，别再用 `HOME_PATH` 兜 —— 否则会把用户丢回聊天主页。
 */
export const HOME_PATH = '/'
export const ADMIN_USERS_PATH = '/admin/users'
export const ADMIN_MODELS_PATH = '/admin/models'
/** 出网策略（egress 黑白名单；平台级配置，**仅 ADMIN**） */
export const ADMIN_EGRESS_PATH = '/admin/egress'
/** 沙箱实例（实例在线注册表只读视图；平台级运维事实，**仅 ADMIN**；P1-14 · R5） */
export const ADMIN_SANDBOX_INSTANCES_PATH = '/admin/sandbox-instances'
/** 用量统计（`03` §二：`/admin/usage`；P1-7 接真页面；**P1-15 起登录即可**，见 §八） */
export const ADMIN_USAGE_PATH = '/admin/usage'

/**
 * 智能体列表（**管理页**；P1-15 从 `/` 搬到这里）。
 *
 * `03` §二 原表把列表放在 `/`；P1-15 把 `/` 让给聊天主页 ⇒ 列表成为「管理」目的地之一。
 */
export const AGENTS_PATH = '/agents'

/** 智能体（`/agents/new` 建、`/agents/:id/edit` 改；列表见 {@link AGENTS_PATH}） */
export const AGENTS_NEW_PATH = '/agents/new'

/** 知识库列表（`03` §二：`/knowledge`，登录即可 —— 与模型池相反，**不是** ADMIN） */
export const KNOWLEDGE_PATH = '/knowledge'

/** MCP server 管理（`03` §二：`/mcp`，登录即可） */
export const MCP_PATH = '/mcp'

/**
 * 我的凭据（`03` §二：`/settings/credentials`，登录即可）。
 *
 * ⚠️ 它是**个人凭据页**，与 MCP 解耦 —— 「代表你调用工具」是个人设置，
 * 归入 `/settings` 一族（与 `/settings/password` 同族），后续可扩展别的凭据类型。
 * 页面**内容**分四个分区（MCP 工具凭据 / 模型 Provider 凭据 / Git 凭据 / **开放调用 Key**），
 * 后端端点也仍是 `/api/mcp/credentials`、`/api/model-providers/my-*`、`/api/git-credentials`、
 * `/api/open-keys`。
 */
export const CREDENTIALS_PATH = '/settings/credentials'

/**
 * 「我的凭据」页的分区键（2026-10-16 修订：Provider 凭据与 MCP 工具凭据原先**堆叠**在一页，
 * 现分成分区；跨页深链用 `?section=` 直接落到对应分区）。
 *   · `mcp`      —— MCP 工具凭据（按 server 分组的长表单；默认分区）
 *   · `provider` —— 模型 Provider 凭据（各自 Key 可配 / 共享 Key 只读）
 *   · `git`      —— Git 凭据与 Git 身份（Code 模式容器内 `git clone` 用）
 *   · `openapi`  —— 开放调用 API Key（P1-22；**按人**管理，"我 × 哪个智能体"的调用凭据）
 */
export const CREDENTIALS_SECTIONS = ['mcp', 'provider', 'git', 'openapi'] as const
export type CredentialsSection = (typeof CREDENTIALS_SECTIONS)[number]

/** 分区锚点 id（分区 `<section>` 与跳转共用；**唯一构造点**） */
export function credentialsSectionAnchorId(section: CredentialsSection): string {
  return `credentials-${section}`
}

/**
 * 「我的凭据」地址，可带 `?serverId=` 定位到某一台 server 的分组（`03` §二 的引注、§4.5）。
 *
 * ⚠️ **这是"从别处跳到凭据页 MCP 分区"的唯一构造点**，三个入口共用（`03` §4.5 的原文就点了三个）：
 *   · Agent 编辑页 MCP 多选框旁的「未配置」红点（`03` §4.2 第 4 区）；
 *   · 会话里失败工具卡的「去配置凭据」（`02` §9.3，`errorCode === 'NEED_CREDENTIAL'`）；
 *   · MCP 管理页「我的凭据」列（未配置时）。
 *
 * 不传 `serverId` ⇒ **裸路径**（不是 `?serverId=`）：凭据页据此区分"要定位到某台"与"就看看全部"，
 * 而空串会让它去 `document.getElementById('cred-')` 找一个不存在的锚点（静默什么都不发生）。
 */
export function credentialsPath(serverId?: string): string {
  return serverId === undefined
    ? CREDENTIALS_PATH
    : `${CREDENTIALS_PATH}?section=mcp&serverId=${encodeURIComponent(serverId)}`
}

/**
 * 跳到「我的凭据」的某个分区（`provider` / `git`）。
 *
 * ⚠️ 与 {@link credentialsPath} 的分工：那个专供 MCP（可带 server 锚点），这个供其余分区 ——
 * 于是"从外部跳到对应的地方"有了两条语义清楚的构造点，而不是让调用方自己拼查询串。
 */
export function credentialsSectionPath(section: Exclude<CredentialsSection, 'mcp'>): string {
  return `${CREDENTIALS_PATH}?section=${section}`
}

/** 会话产物（跨会话汇总本人全部产物，含删除会话后保留的那些；登录即可、仅本人可见） */
export const ARTIFACT_COLLECTION_PATH = '/artifacts'

/** 任务中心（`03` §二：`/tasks`，登录即可 —— **定时任务**管理；P1-6） */
export const TASKS_PATH = '/tasks'

/**
 * 知识库详情（`03` §二 的 `/knowledge/:id`）。
 *
 * `encodeURIComponent` 的理由与 {@link agentEditPath} 相同（P0-1-31 已写在那里的注释）：
 * 不是防注入，而是让"这个 id 不该出现在路径里"这类错误尽早表现为一个查不到的地址，
 * 而不是拼出一个**看着对、打过去 404** 的链接。
 */
export function knowledgeDetailPath(kbId: string): string {
  return `/knowledge/${encodeURIComponent(kbId)}`
}

/**
 * 编辑某智能体。
 *
 * `encodeURIComponent` 在这儿**不是**防注入（调用方给的都是服务端下发的 uuid），而是为了
 * 让"这个 id 不该出现在路径里"这类错误尽早表现为一个查不到的地址，而不是拼出一个**看着对、
 * 打过去 404** 的链接 —— 后者排查时第一反应是"后端路由没注册"。
 */
export function agentEditPath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/edit`
}

/**
 * 定位某个会话（P1-15 的规范路径：`/c/:conversationId`）。
 *
 * `agentId` 由会话数据自带（`ConversationItem.agentId` / `agentName` / `agentType` 已是快照），
 * 故路径里**不再带**它 —— 一个会话只可能属于一个智能体，重复放在 URL 里就有了第二份真值。
 */
export function conversationPath(conversationId: string): string {
  return `/c/${encodeURIComponent(conversationId)}`
}

/**
 * 与某智能体的**新会话态**（P1-15：`/new/:agentId`）。
 *
 * 只展示开场白 + 引导问题，**不建会话**（`03` §4.1：首条消息发送时才建）。
 */
export function newConversationPath(agentId: string): string {
  return `/new/${encodeURIComponent(agentId)}`
}

/**
 * 进入某智能体的对话：有会话 id ⇒ 定位它（`/c/:id`），没有 ⇒ 新会话态（`/new/:agentId`）。
 *
 * ⚠️ 这是全仓"跳去对话"的**唯一构造点**（列表页、任务页、产物页、编辑页都用它）。
 * P1-15 起它产出的是规范路径；老地址 `/chat/:agentId[/:conversationId]` 由 `App.tsx` 里的
 * `LegacyChatRedirect` 内部重定向到这两条 —— 旧书签 / 文档里的链接仍然有效，不做 404。
 *
 * `encodeURIComponent` 与 {@link agentEditPath} 同款：不是防注入（调用方给的都是服务端 uuid），
 * 而是让"这个 id 不该出现在路径里"这类错误尽早表现为查不到的地址。
 */
export function chatPath(agentId: string, conversationId?: string): string {
  return conversationId === undefined ? newConversationPath(agentId) : conversationPath(conversationId)
}

/**
 * 当前路径是否属于**聊天视图**（统一外壳 `AppShell` 用它决定主区形态）。
 *
 * 聊天视图覆盖：`/`（欢迎态）、`/c/:conversationId`（定位会话）、`/new/:agentId`（新会话态），
 * 以及老深链 `/chat/:agentId[/:conversationId]`（重定向途中也会经过这里）。
 * 其余路径（智能体 / 知识库 / MCP / 任务 / 产物 / 凭据 / 用量 / ADMIN 两页）走**同一外壳的页面形态**：
 * 会话栏仍在左，右侧主区换成「顶栏面包屑 + `.page`」。**两个形态共用一个外壳**，
 * 切换功能时左侧会话栏不重挂载、不换样（P1-15 修订：管理跟会话走，外壳统一）。
 */
export function isChatHomePath(pathname: string): boolean {
  return (
    pathname === HOME_PATH ||
    pathname.startsWith('/c/') ||
    pathname.startsWith('/new/') ||
    pathname === '/chat' ||
    pathname.startsWith('/chat/')
  )
}

/**
 * 从路径里还原当前会话 id —— 只有规范路径 `/c/:conversationId` 带它（其余返回 `undefined`）。
 *
 * 与 {@link conversationPath} 的 `encodeURIComponent` 对称（这里负责解开）。
 * 外层外壳拿它给 `ConvRail` 高亮当前会话；解不开时退回原串（高亮不到，但不至于抛错）。
 */
export function conversationIdFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith('/c/')) return undefined
  const raw = pathname.slice('/c/'.length).split('/')[0]
  if (raw === undefined || raw === '') return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 登录页的两种视图（`docs/03` §二：`/login` 是"登录（含首登改密）"，两态同屏） */
export type LoginView = 'login' | 'password'

/** 登录页地址。`view=password` = 首登强制改密那一态 */
export function loginPath(view: LoginView = 'login'): string {
  return view === 'login' ? LOGIN_PATH : `${LOGIN_PATH}?view=password`
}

/**
 * 从 `location` 还原"登录后该回哪去"。
 *
 * 只接受**站内路径**（以单个 `/` 开头）：`from` 是放进 `location.state` 的，
 * 而 state 会被 301/分享链接等途径带过来，若直接 `navigate(from)` 就等于开放了一个
 * 任意跳转点（`//evil.com` 会被浏览器当作协议相对 URL 跳到站外）。
 */
export function safeRedirectTarget(location: Location | undefined, fallback = HOME_PATH): string {
  const from = (location?.state as { from?: unknown } | null)?.from
  if (typeof from !== 'string') return fallback
  if (!from.startsWith('/') || from.startsWith('//')) return fallback
  return from
}
