/**
 * 路由表（P0-1-30 建表；P0-1-31 接上智能体三条；**P1-15 改为"以聊天为主页"的信息架构**）
 *
 * 依据：`docs/03-前端设计.md` §二 的路由与权限列 + `子方案/聊天主页与信息架构改造.md` §二
 *      （新信息架构：`/` = 聊天主页、`/c/:conversationId` 定位会话、`/new/:agentId` 新会话态）。
 *
 * ## 单一外壳（P1-15 修订 R2）
 *
 * **所有受保护路由都挂在同一个外壳** {@link AppShell} 下：左列永远是会话栏（`ConvRail`），
 * 只有右侧主区随路由换形态（聊天视图 / 页面视图，判据 `isChatHomePath`）。
 * —— 首版曾把聊天与管理拆成两种外壳，导致"点管理功能就跳回旧版 rail 页"，本次修订取消。
 * 管理入口（智能体 / 知识库 / … / 用量）收在会话栏底部的 popover 里（设计 I3：管理跟会话走），
 * 不再有独立的常驻导航列。
 *
 * ## P1-15 的路径变化
 *
 * - `/` 从"智能体列表"变成"聊天主页"；智能体列表搬到 `/agents`（管理目的地之一）。
 * - `chatPath(agentId[, conversationId])` 产出 `/new/:agentId` 或 `/c/:conversationId`（规范路径）。
 * - ⚠️ **老深链 `/chat/:agentId/:conversationId?` 保留并重定向**（旧书签、文档里的地址仍有效）：
 *   有 `conversationId` ⇒ `/c/:id`；没有 ⇒ `/new/:agentId`。**不做 404**。
 *
 * ## 守卫的嵌套顺序不是随意的
 *
 * `RequireAuth` 在外、`RequireAdmin` 在内：外层的等待（`/auth/me`）必须先完成，
 * 内层才有"这个人是谁"可判。反过来会让未登录用户在刷新时看到一次"没有权限"。
 * ⚠️ **P1-15：`/admin/usage` 移出 `RequireAdmin`**（用量统计登录即可，`子方案` §八）——
 * 这是有意的产品放宽，别当成漏写。
 */

import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { AppShell } from './AppShell.js'
import { RequireAdmin } from './RequireAdmin.js'
import { RequireAuth } from './RequireAuth.js'
import { conversationPath, newConversationPath } from './paths.js'
import { NotFoundPage } from '../pages/NoticePage.js'
import { ModelsPage } from '../pages/admin/ModelsPage.js'
import { UsagePage } from '../pages/admin/UsagePage.js'
import { UsersListPage } from '../pages/admin/UsersListPage.js'
import { AgentCreatePage, AgentEditPage } from '../pages/agents/AgentFormPage.js'
import { AgentsListPage } from '../pages/agents/AgentsListPage.js'
import { ArtifactCollectionPage } from '../pages/artifacts/ArtifactCollectionPage.js'
import { ChatHomePage } from '../pages/chat/ChatHomePage.js'
import { KnowledgeDetailPage } from '../pages/knowledge/KnowledgeDetailPage.js'
import { KnowledgeListPage } from '../pages/knowledge/KnowledgeListPage.js'
import { LoginPage } from '../pages/login/LoginPage.js'
import { McpCredentialsPage } from '../pages/mcp/McpCredentialsPage.js'
import { McpServersPage } from '../pages/mcp/McpServersPage.js'
import { PasswordPage } from '../pages/settings/PasswordPage.js'
import { TasksPage } from '../pages/tasks/TasksPage.js'

/** 老深链 `/chat/:agentId/:conversationId?` ⇒ 重定向到规范路径（见文件头） */
function LegacyChatRedirect() {
  const { agentId, conversationId } = useParams<{ agentId?: string; conversationId?: string }>()
  if (conversationId !== undefined) return <Navigate to={conversationPath(conversationId)} replace />
  if (agentId !== undefined) return <Navigate to={newConversationPath(agentId)} replace />
  return <Navigate to="/" replace />
}

export function App() {
  return (
    <Routes>
      {/* 公开路由：不带应用外壳（`design/login.html` 的构成） */}
      <Route path="/login" element={<LoginPage />} />

      {/* 受保护路由：先登录态，最后才是页面；**全部走同一个 AppShell**（单一外壳） */}
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          {/* ── 聊天视图（会话栏常驻；主区是消息流 / 欢迎态，不带全局顶栏）── */}
          {/* `/`：进站即聊天主页（跨智能体会话历史 + 当前会话；无选中时是欢迎态） */}
          <Route index element={<ChatHomePage />} />
          {/* `/c/:conversationId`：定位某个会话（`agentId` 由会话数据自带，路径里不带） */}
          <Route path="/c/:conversationId" element={<ChatHomePage />} />
          {/* `/new/:agentId`：新会话态（展示开场白 + 引导问题，**不建会话**） */}
          <Route path="/new/:agentId" element={<ChatHomePage />} />
          {/* 老深链兼容：`/chat/:agentId[/:conversationId]` 重定向到上面两条（不做 404） */}
          <Route path="/chat/:agentId/:conversationId?" element={<LegacyChatRedirect />} />

          {/* ── 页面视图（同一外壳；主区换成「顶栏面包屑 + `.page`」）── */}
          {/* S-02 · 智能体（P1-15 从 `/` 搬来）：登录即可看全部 */}
          <Route path="/agents" element={<AgentsListPage />} />
          <Route path="/agents/new" element={<AgentCreatePage />} />
          <Route path="/agents/:id/edit" element={<AgentEditPage />} />
          {/* S-05 · 知识库：列表与详情**都是登录即可**（知识库没有 owner 列，是全员共享资源） */}
          <Route path="/knowledge" element={<KnowledgeListPage />} />
          <Route path="/knowledge/:id" element={<KnowledgeDetailPage />} />
          {/* S-06 · MCP：登录即可（`mcp_servers` 没有 owner 列） */}
          <Route path="/mcp" element={<McpServersPage />} />
          {/* S-08b · 我的凭据（个人设置族，与 MCP 解耦；Git 凭据内嵌为区块） */}
          <Route path="/settings/credentials" element={<McpCredentialsPage />} />
          {/* S-10 · 会话产物：跨会话汇总**本人**全部产物，登录即可、仅本人可见 */}
          <Route path="/artifacts" element={<ArtifactCollectionPage />} />
          {/* S-09 · 任务中心（定时任务管理）：登录即可、仅本人 */}
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/settings/password" element={<PasswordPage />} />

          {/* S-07c · 用量统计（P1-7）：**P1-15 起登录即可**（移出 `RequireAdmin`，见文件头） */}
          <Route path="/admin/usage" element={<UsagePage />} />

          {/* ADMIN 专属（`03` §三：这两页仅 ADMIN 可见） */}
          <Route element={<RequireAdmin />}>
            <Route path="/admin/users" element={<UsersListPage />} />
            <Route path="/admin/models" element={<ModelsPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
