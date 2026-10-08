/**
 * 路由表（P0-1-30 建表；P0-1-31 接上智能体三条）
 *
 * 依据：`docs/03-前端设计.md` §二 的 14 条路由与权限列。
 *
 * ## 已落地的链路
 *
 * P0-1-30：登录 → 首登强制改密 → 进首页，加上 `/settings/password`。
 * P0-1-31：`/`（智能体列表）、`/agents/new`、`/agents/:id/edit` 换成真实页面。
 * P0-1-32：`/chat/:agentId/:conversationId?` 换成真实的对话页（SSE 客户端 + 消息流七种卡片）。
 * P0-1-35：`/knowledge` 与 `/knowledge/:id` 换成真实的知识库列表与详情页
 *          （文档上传 / 覆盖重传 / 重试 / 下载 / 删除 + 检索测试抽屉 + 状态轮询）。
 * P0-1-36：`/admin/users` 与 `/admin/models` 换成真实的用户管理与模型池管理
 *          （ADMIN 专属；两级路由的守卫顺序仍然是 `RequireAuth` 在外、`RequireAdmin` 在内）。
 * P0-2-11：`/mcp` 与 `/settings/credentials` 换成真实的 MCP 管理页与我的凭据页
 *          （**至此 `03` §二 的 P0 十条路由全部落地**，`BatchPlaceholderPage` 只剩 `/tasks`
 *           与 `/admin/usage` 两条 P1 路由，以及那个 `*` 未找到页）。
 *          ⚠️ 我的凭据页**与 MCP 解耦**：路由从 `/mcp/credentials` 改为 `/settings/credentials`
 *          （个人设置族，与 `/settings/password` 同族），页面内容仍按 MCP server 分组。
 *
 * 其余路由**按 `03` §二 全部登记**，但指向 {@link BatchPlaceholderPage} —— 写清"属哪一批、会包含什么"。
 *
 * 为什么不是先只登记已实现的路由：`03` §二 的路由表是**产品结构**，导航项的多寡本身就是
 * 验收内容（"ADMIN 与非 ADMIN 的导航项差异正确"）；而且一个能点进去、明说"属 P0-1-35"的入口，
 * 比一个 404 或一个消失的入口好得多。占位页**不接任何后端**，不会污染任何验收。
 *
 * ⚠️ `/chat/:agentId/:conversationId?` 里的**可选段**是本批加的（P0-1-32）：
 * `03` §二 写的就是 `:conversationId? 可选定位`，而"刷新后历史还能重画"这件事
 * **只有 URL 能承载**（会话 id 放在组件 state 里，刷新就没了 ⇒ 验收里的"刷新后形态一致"
 * 根本验不了）。侧栏（在会话之间切换）仍属 P0-1-34。
 *
 * ## 守卫的嵌套顺序不是随意的
 *
 * `RequireAuth` 在外、`RequireAdmin` 在内：外层的等待（`/auth/me`）必须先完成，
 * 内层才有"这个人是谁"可判。反过来会让未登录用户在刷新时看到一次"没有权限"。
 */

import { Route, Routes } from 'react-router-dom'

import { AppLayout } from './AppLayout.js'
import { RequireAdmin } from './RequireAdmin.js'
import { RequireAuth } from './RequireAuth.js'
import { BatchPlaceholderPage, NotFoundPage } from '../pages/NoticePage.js'
import { ModelsPage } from '../pages/admin/ModelsPage.js'
import { UsersListPage } from '../pages/admin/UsersListPage.js'
import { AgentCreatePage, AgentEditPage } from '../pages/agents/AgentFormPage.js'
import { AgentsListPage } from '../pages/agents/AgentsListPage.js'
import { ArtifactCollectionPage } from '../pages/artifacts/ArtifactCollectionPage.js'
import { ChatPage } from '../pages/chat/ChatPage.js'
import { KnowledgeDetailPage } from '../pages/knowledge/KnowledgeDetailPage.js'
import { KnowledgeListPage } from '../pages/knowledge/KnowledgeListPage.js'
import { LoginPage } from '../pages/login/LoginPage.js'
import { McpCredentialsPage } from '../pages/mcp/McpCredentialsPage.js'
import { McpServersPage } from '../pages/mcp/McpServersPage.js'
import { PasswordPage } from '../pages/settings/PasswordPage.js'

export function App() {
  return (
    <Routes>
      {/* 公开路由：不带应用外壳（`design/login.html` 的构成） */}
      <Route path="/login" element={<LoginPage />} />

      {/* 受保护路由：先登录态，再 ADMIN，最后才是页面 */}
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          {/* S-02 · 智能体：首页就是列表（`03` §二：`/` = 智能体列表，登录即可看全部） */}
          <Route index element={<AgentsListPage />} />
          <Route path="/agents/new" element={<AgentCreatePage />} />
          <Route path="/agents/:id/edit" element={<AgentEditPage />} />
          {/* S-04 · 对话（P0-1-32 接真页面）。`:conversationId?` 可选：**省略即新会话态**
              （`03` §4.1：展示开场白，首条消息发送时才创建会话、并把 id 写进 URL）——
              于是"刷新"这件事能定位到同一个会话，历史与流式走同一套组件重画。 */}
          <Route path="/chat/:agentId/:conversationId?" element={<ChatPage />} />
          {/* S-05 · 知识库（P0-1-35 接真页面）。列表与详情**都是登录即可**：
              知识库没有 owner 列，是全员共享资源（`docs/02` §4.6 的权限口径与模型池相反）。 */}
          <Route path="/knowledge" element={<KnowledgeListPage />} />
          <Route path="/knowledge/:id" element={<KnowledgeDetailPage />} />
          {/* S-06 · MCP（P0-2-11 接真页面）。**两条都是登录即可**：`mcp_servers` 没有 owner 列
              ⇒ 人人可改可删（第五族，`02` §4.7）；凭据那一族的收窄在 `user_id` 上、只在服务端，
              界面上没有任何"别人的凭据"可看。 */}
          <Route path="/mcp" element={<McpServersPage />} />
          {/* S-08b · 我的凭据（P0-2-11 接真页面）。它是**个人凭据页、与 MCP 解耦**：
              归入 `/settings` 一族（与 `/settings/password` 同族），后端端点仍是 `/api/mcp/credentials`。 */}
          <Route path="/settings/credentials" element={<McpCredentialsPage />} />
          {/* S-10 · 会话产物：跨会话汇总**本人**全部产物（含删除会话后保留的那些），
              登录即可、**仅本人可见**（服务端按 `user_id` 过滤）。可预览 / 下载 / 删除。 */}
          <Route path="/artifacts" element={<ArtifactCollectionPage />} />
          <Route
            path="/tasks"
            element={
              <BatchPlaceholderPage
                serial="S-09 · 任务中心"
                title="任务中心"
                bullets={['TaskAgent 的会话视图：任务 / Agent / 状态 / 最近活动', '继续对话与停止']}
              />
            }
          />
          <Route path="/settings/password" element={<PasswordPage />} />

          {/* ADMIN 专属（`03` §三：管理入口仅 ADMIN 可见）。两页都在 P0-1-36 接上真页面 */}
          <Route element={<RequireAdmin />}>
            <Route path="/admin/users" element={<UsersListPage />} />
            <Route path="/admin/models" element={<ModelsPage />} />
            <Route
              path="/admin/usage"
              element={
                <BatchPlaceholderPage
                  serial="S-07c · 用量"
                  title="用量统计"
                  bullets={['按用户 / 模型 / 时间维度的 token 与费用统计']}
                />
              }
            />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
