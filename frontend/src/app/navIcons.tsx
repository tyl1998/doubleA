/**
 * 导航项 → 图标（P1-15 从 `AppLayout` 提出）
 *
 * 依据：`docs/03-前端设计.md` §三（左侧栏每项 = 图标 + 文字）。原住在旧外壳 `AppLayout`，
 * P1-15 起 `ConvRail` 的「管理」popover 要用**同一份**图标口径 ⇒ 提出成公共模块，
 * 免得两处各写一张 `code → 图标` 映射（`nav.ts` 自身刻意不认识 antd，见其文件头）。
 */

import {
  ApiOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  BookOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  KeyOutlined,
  RobotOutlined,
  ScheduleOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'

/** 每个导航项一个图标（按 `NavItem.code` 认领） */
export const ICON_BY_CODE: Record<string, ReactNode> = {
  AG: <RobotOutlined />,
  KB: <BookOutlined />,
  MC: <ApiOutlined />,
  AH: <HistoryOutlined />,
  TK: <ScheduleOutlined />,
  CR: <KeyOutlined />,
  US: <TeamOutlined />,
  ML: <DatabaseOutlined />,
  UT: <BarChartOutlined />,
}

/** 认领不到 `code` 时的兜底图标 */
export const NAV_FALLBACK_ICON = <AppstoreOutlined />