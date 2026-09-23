/**
 * 「还没有内容」的统一页面（P0-1-30）
 *
 * 三种情况长得一样、只是文案不同（`docs/03` §七「列表三态」的同一套语言）：
 * 1. **未开工的页面**（{@link BatchPlaceholderPage}）—— 导航里已经指向真实路由，
 *    点进来必须得到一句"它属哪一批、会做什么"，而不是 404 或白屏。
 * 2. **没有权限**（{@link ForbiddenPage}）—— 会员访问 `/admin/*`（`03` §三 的管理入口仅 ADMIN 可见，
 *    但手敲 URL 依然要落到一个有解释的页面上）。
 * 3. **路由不存在**（{@link NotFoundPage}）。
 *
 * 这三种都是"页面级空态"，不是"列表空了" —— 后者由各列表页自己的 `.empty` 承担
 * （`03` §七：空态要带引导按钮）。
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { HOME_PATH, LOGIN_PATH } from '../app/paths.js'

export type NoticeTone = 'accent' | 'warn' | 'danger'

export interface NoticePageProps {
  /** 仪器读数式的屏号（与仪表轨底部同一口径） */
  serial: string
  title: string
  lead: ReactNode
  tag?: { text: string; tone?: NoticeTone }
  /** 该页面的要点（占位页用它说明"这一页将来有什么"，避免读成"坏了"） */
  bullets?: readonly string[]
  actions?: ReactNode
}

function toneClass(tone: NoticeTone | undefined): string {
  return tone === undefined || tone === 'accent' ? 'tag tag--accent' : `tag tag--${tone}`
}

export function NoticePage({ serial, title, lead, tag, bullets, actions }: NoticePageProps) {
  // ⚠️ 这里**不套 `.page`**：页面级留白与 `<main>` 地标由 AppLayout 统一提供
  // （登录页不走 AppLayout，它自带 `.auth` 两栏，故不在此约定内）。
  return (
    <>
      <nav className="crumb" aria-label="面包屑">
        <Link to={HOME_PATH}>工作台</Link>
        <span className="crumb__sep" aria-hidden="true">
          /
        </span>
        <span className="crumb__here">{title}</span>
      </nav>

      <div className="page__head">
        <div>
          <p className="kicker">{serial}</p>
          <h1>{title}</h1>
          <p className="page__lead">{lead}</p>
        </div>
        {tag !== undefined && (
          <div className="page__head-actions">
            <span className={toneClass(tag.tone)}>{tag.text}</span>
          </div>
        )}
      </div>

      <div className="card bracket card--pad stack">
        {bullets !== undefined && bullets.length > 0 && (
          <div>
            <p className="kicker">这一页会包含</p>
            <ul style={{ marginTop: 'var(--sp-3)' }}>
              {bullets.map((item) => (
                <li key={item} style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="row row--wrap">{actions}</div>
      </div>
    </>
  )
}

export interface BatchPlaceholderPageProps {
  serial: string
  title: string
  /** 属哪个批次（`docs/06` 的批次号）。**必须写清**，否则读起来就是"这页坏了" */
  batch: string
  /** 前置依赖一句话（为什么要等） */
  blockedBy?: string
  bullets?: readonly string[]
}

/**
 * 未开工页面的占位。
 *
 * 为什么导航里保留这些入口、而不是先隐藏：`03` §二 的路由表是产品结构的一部分，
 * 隐藏它会让"导航项在 ADMIN 与非 ADMIN 之间的差异"这类验收无从验起，
 * 也会让用户在 P0-1-31 之后发现"入口是突然冒出来的"。给占位页并写明批次，
 * 比"点不动"和"什么都没有"都诚实。
 */
export function BatchPlaceholderPage({ serial, title, batch, blockedBy, bullets }: BatchPlaceholderPageProps) {
  return (
    <NoticePage
      serial={serial}
      title={title}
      tag={{ text: batch, tone: 'warn' }}
      lead={
        <>
          本页尚未开工，属 <span className="num">{batch}</span>
          {blockedBy === undefined ? '。' : `，前置：${blockedBy}。`}
          {' 当前可用的功能是登录 / 首登强制改密 / 修改密码 —— '}
          <Link to={HOME_PATH}>回到首页</Link>。
        </>
      }
      bullets={bullets}
      actions={
        <Link to={HOME_PATH}>
          ← 回到首页
        </Link>
      }
    />
  )
}

export function ForbiddenPage() {
  return (
    <NoticePage
      serial="S-00 · 权限"
      title="没有权限"
      tag={{ text: '403 FORBIDDEN', tone: 'danger' }}
      lead="这一页仅管理员可见。当前账号是普通成员；如果确实需要，请联系管理员调整角色。"
      actions={
        <Link to={HOME_PATH}>
          ← 回到首页
        </Link>
      }
    />
  )
}

export function NotFoundPage() {
  return (
    <NoticePage
      serial="S-00 · 未找到"
      title="页面不存在"
      tag={{ text: '404 NOT_FOUND', tone: 'danger' }}
      lead="地址可能写错了，或者这个页面已经改名。左侧仪表轨上的字母缩写是全部目的地。"
      actions={
        <Link to={LOGIN_PATH}>
          ← 回到登录页
        </Link>
      }
    />
  )
}
