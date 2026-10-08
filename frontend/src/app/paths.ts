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
export const HOME_PATH = '/'
export const ADMIN_USERS_PATH = '/admin/users'
export const ADMIN_MODELS_PATH = '/admin/models'

/** 智能体（`03` §二：`/` 是列表、`/agents/new` 建、`/agents/:id/edit` 改） */
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
 * 页面**内容**仍是按 MCP server 分组的表单，后端端点也仍是 `/api/mcp/credentials`。
 */
export const CREDENTIALS_PATH = '/settings/credentials'

/** 会话产物（跨会话汇总本人全部产物，含删除会话后保留的那些；登录即可、仅本人可见） */
export const ARTIFACT_COLLECTION_PATH = '/artifacts'

/**
 * 「我的凭据」地址，可带 `?serverId=` 定位到某一台 server 的分组（`03` §二 的引注、§4.5）。
 *
 * ⚠️ **这是"从别处跳到凭据页"的唯一构造点**，三个入口共用（`03` §4.5 的原文就点了三个）：
 *   · Agent 编辑页 MCP 多选框旁的「未配置」红点（`03` §4.2 第 4 区）；
 *   · 会话里失败工具卡的「去配置凭据」（`02` §9.3，`errorCode === 'NEED_CREDENTIAL'`）；
 *   · 顶部「我的凭据」入口（不带 `serverId`，落在全清单上）。
 *
 * 不传 `serverId` ⇒ **裸路径**（不是 `?serverId=`）：凭据页据此区分"要定位到某台"与"就看看全部"，
 * 而空串会让它去 `document.getElementById('cred-')` 找一个不存在的锚点（静默什么都不发生）。
 */
export function credentialsPath(serverId?: string): string {
  return serverId === undefined ? CREDENTIALS_PATH : `${CREDENTIALS_PATH}?serverId=${encodeURIComponent(serverId)}`
}

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
 * 与某智能体对话（`03` §二 的 `/chat/:agentId`，`conversationId` 可选定位）。
 *
 * `conversationId` 省略 = **新会话态**（`03` §4.1：展示开场白，首条消息发送时才创建会话）；
 * 带上 = 定位到那个会话。P0-1-32 起"发第一条消息"会把它写进 URL（`replace`），
 * 于是**刷新后仍停在同一会话**、历史用同一套组件重画 —— 这是本批验"刷新后形态一致"的前提。
 *
 * ⚠️ 侧栏、新建/重命名/删除会话属 **P0-1-34**：本批只有"URL 里带着的那个会话"，
 * 没有"在会话之间切换"的入口（从列表页进来永远是**新会话态**）。
 */
export function chatPath(agentId: string, conversationId?: string): string {
  const base = `/chat/${encodeURIComponent(agentId)}`
  return conversationId === undefined ? base : `${base}/${encodeURIComponent(conversationId)}`
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
