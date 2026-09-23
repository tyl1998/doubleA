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
import { AgentCreatePage, AgentEditPage } from '../pages/agents/AgentFormPage.js'
import { AgentsListPage } from '../pages/agents/AgentsListPage.js'
import { ChatPage } from '../pages/chat/ChatPage.js'
import { LoginPage } from '../pages/login/LoginPage.js'
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
          <Route
            path="/knowledge"
            element={
              <BatchPlaceholderPage
                serial="S-05 · 知识库"
                title="知识库"
                batch="P0-1-35"
                blockedBy="D 包接口已就绪（P0-1-21 已 ✓）"
                bullets={[
                  '列表 + 弹窗形态创建（字段 ≤6 用弹窗，03 §七）',
                  '详情页：名称描述与检索配置编辑 / 上传 / 检索测试',
                  '文档表格：状态三态、chunk 数、覆盖重传 / 重试 / 下载原始 / 删除',
                  '检索测试抽屉显示双路得分与融合排名',
                  '.doc 在前端 accept 白名单就拦下，不发请求',
                ]}
              />
            }
          />
          <Route
            path="/knowledge/:id"
            element={
              <BatchPlaceholderPage
                serial="S-05 · 知识库"
                title="知识库详情"
                batch="P0-1-35"
                bullets={[
                  '解析中的文档需要轮询刷新（TanStack Query refetchInterval）',
                  '扫描件会落到 FAILED 并给出原因',
                  '上传后是 PARSING 中间态，chunk 数要等流水线跑完',
                ]}
              />
            }
          />
          <Route
            path="/mcp"
            element={
              <BatchPlaceholderPage
                serial="S-06 · MCP"
                title="MCP server 管理"
                batch="P0-2"
                blockedBy="MCP 端点尚不存在；P0-1 阶段后端明确拒绝 MCP 组件引用（400 + 指向 P0-2）"
                bullets={[
                  'server 列表与注册 / 编辑 / 删除',
                  '每个 server 的工具清单与凭据状态',
                  '未配置凭据时给出 424 NEED_CREDENTIAL 对应文案',
                ]}
              />
            }
          />
          <Route
            path="/mcp/credentials"
            element={
              <BatchPlaceholderPage
                serial="S-06b · 凭据"
                title="我的凭据"
                batch="P0-2"
                blockedBy="凭据端点尚不存在"
                bullets={[
                  '按 server 分组管理个人凭据，写入后不回显明文',
                  '支持 ?serverId= 定位并高亮该分组（从编辑页与工具失败卡直达）',
                ]}
              />
            }
          />
          <Route
            path="/tasks"
            element={
              <BatchPlaceholderPage
                serial="S-09 · 任务中心"
                title="任务中心"
                batch="P1"
                bullets={['TaskAgent 的会话视图：任务 / Agent / 状态 / 最近活动', '继续对话与停止']}
              />
            }
          />
          <Route path="/settings/password" element={<PasswordPage />} />

          {/* ADMIN 专属（`03` §三：管理入口仅 ADMIN 可见） */}
          <Route element={<RequireAdmin />}>
            <Route
              path="/admin/users"
              element={
                <BatchPlaceholderPage
                  serial="S-07 · 用户管理"
                  title="用户管理"
                  batch="P0-1-36"
                  blockedBy="B 包用户接口已就绪（P0-1-9 已 ✓）"
                  bullets={[
                    '建号：初始密码一次性展示（后端只在创建时下发一次）',
                    '启停账号、改角色、重置密码',
                    '被停用的账号下个请求就会 401（后端快照缓存会失效）',
                  ]}
                />
              }
            />
            <Route
              path="/admin/models"
              element={
                <BatchPlaceholderPage
                  serial="S-07b · 模型池"
                  title="模型池管理"
                  batch="P0-1-36"
                  blockedBy="C 包模型接口已就绪（P0-1-11 已 ✓）"
                  bullets={[
                    'provider 维护：名称 / 类型 / Base URL / API Key（Key 有进无出，保存后不回显）',
                    '模型维护：模型名 / 类型 / 上下文长度 / 是否支持图片 / 启停',
                    '停用的模型不会出现在「可用模型」下拉里（含管理员自己建 Agent 时）',
                  ]}
                />
              }
            />
            <Route
              path="/admin/usage"
              element={
                <BatchPlaceholderPage
                  serial="S-07c · 用量"
                  title="用量统计"
                  batch="P1"
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
