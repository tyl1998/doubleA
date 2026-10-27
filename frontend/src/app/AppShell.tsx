/**
 * 应用外壳（P0-1-30 立；**P1-15 修订 R2 改为"单一外壳、会话栏常驻"**）
 *
 * 依据：`docs/03-前端设计.md` §三（全局布局）、`子方案/聊天主页与信息架构改造.md` §三
 *      （**修订**：管理跟会话走，但不再"进管理页才出现 rail"—— 见下）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么只有一个外壳（设计修订）
 * ─────────────────────────────────────────────────────────────────────
 * P1-15 首版把应用拆成**两种外壳**：聊天主页自带 `ConvRail`、管理页走 `.shell + .rail`。
 * 症状是"进站即聊天、点『管理』里的任一功能又跳回旧版 rail 页"，两套左侧栏来回切换，
 * 入口与观感被切成两半。本次修订按**通用 Web 应用（ChatGPT / 飞书一类）**把外壳收敛成一个：
 *
 * ```
 * ┌──────────────┬─────────────────────────────────────────────┐
 * │ ConvRail     │ [聊天] 消息流 / 欢迎态（自带标题栏，无顶栏）  │
 * │ （会话栏，   │                                             │
 * │  常驻）       │ [管理] 顶栏面包屑 + `.page`（各管理页内容）  │
 * │              │                                             │
 * │ 新对话        │                                             │
 * │ 历史会话      │                                             │
 * │ 管理 popover  │                                             │
 * │ 用户菜单      │                                             │
 * └──────────────┴─────────────────────────────────────────────┘
 * ```
 *
 * **左列永远是会话栏**（`ConvRail`），只有右列主区随路由换形态：
 * - **聊天视图**（{@link isChatHomePath}：`/`、`/c/:id`、`/new/:agentId`、老深链 `/chat/...`）
 *   ⇒ 直接铺 `ChatHomePage`（消息流自带 `chat__head`，不再叠全局顶栏）；
 * - **页面视图**（智能体 / 知识库 / MCP / 任务 / 产物 / 凭据 / 用量 / ADMIN 两页）
 *   ⇒ 顶栏面包屑 + `.page`，内容仍是各页自己的 `.page__head`。
 *
 * ⚠️ **R3（2026-10-13）**：会话栏的收起/展开按钮从会话栏内部搬到**主区左上角的一枚浮层按钮**
 * （`.app-shell__toggle`），点击即在"显示 / 完全隐藏会话栏"之间切换（`.app-shell--rail-hidden`，
 * 不再收成图标条）。会话栏内部那枚旧按钮已删（见 `ConvRail`）。
 *
 * 三件事只在这里做，别的页面不要重复：
 * 1. **`<main>` 地标与页面级留白**（`.page`）—— 页面组件只渲染自己的内容；
 * 2. **导航的权限过滤与当前项高亮** —— 判据来自 `nav.ts`（会话栏底部的管理 popover 复用同一份）；
 * 3. **全局服务状态灯 / 用户菜单** —— 住在 `ConvRail` 底部（`ServiceLed` / `UserMenu`），单处口径。
 */

import { Fragment, useState } from 'react'
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import { Link, Outlet, useLocation } from 'react-router-dom'

import { useCurrentUser } from '../api/auth.js'
import { ConvRail } from '../features/chat/ConvRail.js'
import { PageCrumbContext } from './crumbContext.js'
import { useT } from './i18n.js'
import { crumbBaseForPath, matchNavItem } from './nav.js'
import { conversationIdFromPath, isChatHomePath } from './paths.js'

/**
 * 顶栏的「快捷页面导航」（面包屑）。
 *
 * 静态前缀来自 `crumbBaseForPath(pathname)`（`工作台 / 模块`），`detail` 非空时追加为当前段
 * （二级页用 `usePageCrumb` 上报）。有 `detail` 时前缀各段渲染成链接，否则末段即当前页。
 */
function PageCrumb({ pathname, detail }: { pathname: string; detail: string | null }) {
  const { t } = useT()
  const base = crumbBaseForPath(pathname)
  // 静态前缀是 key（要翻译），细节段是运行时数据（原样渲染）⇒ 在这里就地取值，
  // 让下面渲染逻辑保持"已成型字符串"的简单形态。
  const trail: readonly { label: string; to?: string }[] =
    detail === null
      ? base.map((segment) => ({ label: t(segment.labelKey), to: segment.to }))
      : [...base.map((segment) => ({ label: t(segment.labelKey), to: segment.to })), { label: detail }]

  return (
    <nav className="crumb" aria-label={t('shell.crumbAria')}>
      {trail.map((segment, index) => {
        const last = index === trail.length - 1
        return (
          <Fragment key={`${segment.label}-${index}`}>
            {index > 0 ? (
              <span className="crumb__sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {!last && segment.to !== undefined ? (
              <Link to={segment.to}>{segment.label}</Link>
            ) : (
              <span className={last ? 'crumb__here' : undefined}>{segment.label}</span>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}

export function AppShell() {
  const { t } = useT()
  const location = useLocation()
  // 本组件只挂在 RequireAuth 里面 ⇒ 这里 `data` 必然是已登录用户
  const { data: user } = useCurrentUser()
  /**
   * 会话栏是否**整体隐藏**（默认显示）。P1-15 修订 R3：收起/展开按钮从会话栏内部搬到**主区左上角浮层**
   * （见下面的 `.app-shell__toggle`），点击即在"显示 / 完全隐藏"之间切换（不再收成图标条）。
   * 本组件跨路由常驻，故状态天然保持 —— 切聊天/管理页都不复位。
   */
  const [railHidden, setRailHidden] = useState(false)
  /** 二级页上报给顶栏面包屑的**细节段**（见 `crumbContext.ts`） */
  const [crumbDetail, setCrumbDetail] = useState<string | null>(null)
  // 退出登录后 queryClient 被 clear，本组件可能在卸载前再渲染一次 ⇒ 兜一下 undefined
  if (user === undefined || user === null) return null

  const pathname = location.pathname
  const chatView = isChatHomePath(pathname)
  const current = matchNavItem(pathname)

  return (
    <PageCrumbContext.Provider value={setCrumbDetail}>
      <div className={`app-shell${railHidden ? ' app-shell--rail-hidden' : ''}`}>
        <ConvRail conversationId={conversationIdFromPath(pathname)} />

        <div className="app-shell__main">
          {/* 会话栏开关（浮层，不占布局）：低调常驻、悬停/聚焦时显形；点击整体隐藏 / 唤回会话栏。
              它是**唯一**的收起入口（会话栏内部那枚旧按钮已删，见 `ConvRail`）。 */}
          <button
            className="app-shell__toggle"
            type="button"
            onClick={() => {
              setRailHidden((value) => !value)
            }}
            aria-label={railHidden ? t('shell.railExpand') : t('shell.railCollapse')}
            aria-expanded={!railHidden}
            title={railHidden ? t('shell.railExpand') : t('shell.railCollapse')}
          >
            {railHidden ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>

          {chatView ? (
            // 聊天视图：主区整块交给 ChatHomePage（消息流 / 欢迎态），不叠全局顶栏
            <Outlet />
          ) : (
            <>
              <header className="topbar">
                <PageCrumb pathname={pathname} detail={crumbDetail} />
              </header>
              {/* 页面组件不再自带 `.page` 包裹 —— 留白与地标只在这里定义一次 */}
              <main
                className="page"
                aria-label={current === undefined ? t('nav.workspace') : t(current.labelKey)}
              >
                <div className="page__body">
                  <Outlet />
                </div>
              </main>
            </>
          )}
        </div>
      </div>
    </PageCrumbContext.Provider>
  )
}
