/**
 * AntD 5 主题注入（P0-1-30）
 *
 * 依据：`design/README.md` §三「原型令牌 → AntD 5 token **一一映射**（P0-1-30 落地时按此注入）」
 *      与 `docs/03-前端设计.md` §一（AntD 5 是 UI 库）。
 *
 * ## 为什么是"读 CSS 变量"而不是在 TS 里再抄一份色值
 *
 * `design/README.md` §三 给的是一张**映射表**，最直白的写法是把 `#1D3FA8` 在 `theme.ts` 里
 * 再写一遍。但那会造出**两个真相来源**：改 `tokens.css` 的人不会知道这里还有一份，
 * 于是"按钮主色改了、AntD 的 focus 环没改"这类漂移会在很久以后才被发现
 * （`docs/06` §六 那类"同一口径在两处各写一遍，必有一处先腐烂"）。
 *
 * 所以这里**从 `:root` 的 CSS 变量读**：
 * - 单一来源：`tokens.css` 是唯一改动点；
 * - **暗色免费**：`[data-theme="dark"]` 换了变量，重算一次就是暗色主题，不需要第二张映射表。
 *
 * 代价：本模块依赖"样式表已注入 DOM"。前端是纯静态产物、样式随入口一起加载，
 * 不满足这个前提时整站本来就没有样式（不是本模块能兜的了的事），故**刻意不做兜底默认值**
 * —— 静默兜底只会把"样式没加载"伪装成"配色不一样"。
 */

import { theme, type ThemeConfig } from 'antd'

/** 主题模式。与 `[data-theme]` 属性取值一一对应（`styles/tokens.css` 的暗色覆盖块） */
export type ThemeMode = 'light' | 'dark'

/** 读一个 CSS 变量的当前值（随 `[data-theme]` 变化，故每次都要重新读） */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 读一个长度类令牌并转成数字（AntD 的 `borderRadius` / `controlHeight` 要 number） */
function tokenNumber(name: string): number {
  return Number.parseFloat(token(name))
}

/** 令牌名 → AntD 全局 token 的完整映射。**这张表就是 `design/README.md` §三 的落地形态。** */
export function buildAntdTheme(mode: ThemeMode): ThemeConfig {
  return {
    algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      // --- 表面（暖纸）-------------------------------------------------------------
      colorBgLayout: token('--paper'),
      colorBgContainer: token('--surface'),
      colorBgElevated: token('--surface'),
      colorFillTertiary: token('--surface-2'),
      colorBgMask: 'rgba(23, 24, 28, 0.34)',

      // --- 墨（文字与线）-----------------------------------------------------------
      colorText: token('--ink'),
      colorTextHeading: token('--ink'),
      colorTextSecondary: token('--muted'),
      colorTextTertiary: token('--muted-2'),
      colorTextQuaternary: token('--muted-2'),
      colorSplit: token('--rule'),
      colorBorder: token('--rule-control'),
      colorBorderSecondary: token('--rule-strong'),

      // --- 强调与状态色：全站单一强调色（原型的中心决定）--------------------------
      colorPrimary: token('--accent'),
      colorPrimaryHover: token('--accent-ink'),
      colorPrimaryActive: token('--accent-ink'),
      colorLink: token('--accent'),
      colorLinkHover: token('--accent-ink'),
      colorSuccess: token('--ok'),
      colorWarning: token('--warn'),
      colorError: token('--danger'),
      /** `03` §4.1 把"运行中 / 排队 / 需要凭据"都归到信息态，配色沿用强调色 */
      colorInfo: token('--accent'),

      // --- 控件几何：与原型同尺寸（几乎不圆的工业感）------------------------------
      borderRadius: tokenNumber('--r-sm'),
      borderRadiusSM: tokenNumber('--r-xs'),
      borderRadiusXS: tokenNumber('--r-xs'),
      borderRadiusLG: tokenNumber('--r-md'),
      controlHeight: 34,
      controlHeightSM: 28,
      controlHeightLG: 40,
      controlOutline: token('--accent-wash'),
      controlOutlineWidth: 3,

      // --- 字体：AntD 默认字体必须被覆盖（`design/README.md` §三 末条提醒）---------
      fontFamily: token('--font-body'),
      fontFamilyCode: token('--font-mono'),
      fontSize: 14,
      /** 中文正文行高 ≥1.7（原型的 `--lh-body`） */
      lineHeight: 1.75,

      // --- 动效：与原型同拍 --------------------------------------------------------
      motionEaseOut: token('--ease-out'),
      motionDurationFast: '0.17s',
      motionDurationMid: '0.32s',
      motionDurationSlow: '0.64s',

      // --- 阴影：三档都带墨色环境调（不用 AntD 默认的纯黑 + 大扩散）----------------
      boxShadow: token('--sh-2'),
      boxShadowSecondary: token('--sh-2'),
      boxShadowTertiary: token('--sh-1'),
    },
    components: {
      // AntD 默认观感的三个来源：`#1677ff`、8px 圆角、白底 + 默认阴影。前两个由 token 解决，
      // 这里把**按钮的默认投影关掉** —— 原型里按钮是"边框 + 底色"，没有发光。
      Button: {
        fontWeight: 500,
        contentFontSize: 13,
        paddingInline: 16,
        defaultBg: token('--surface'),
        defaultColor: token('--ink'),
        defaultBorderColor: token('--rule-control'),
        defaultHoverBg: token('--surface-2'),
        defaultHoverColor: token('--ink'),
        defaultHoverBorderColor: token('--ink-2'),
        defaultActiveBg: token('--surface-2'),
        defaultActiveBorderColor: token('--ink-2'),
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Input: {
        /** 原型 `.input` 的内边距是 sp-2 / sp-3 */
        paddingBlock: tokenNumber('--sp-2'),
        paddingInline: tokenNumber('--sp-3'),
        inputFontSize: 13,
        colorTextPlaceholder: token('--muted-2'),
        hoverBorderColor: token('--ink-2'),
        activeBorderColor: token('--accent'),
        /** 原型的聚焦环：`0 0 0 3px var(--accent-wash)`，不是 AntD 默认的描边变粗 */
        activeShadow: `0 0 0 3px ${token('--accent-wash')}`,
        errorActiveShadow: `0 0 0 3px ${token('--danger-wash')}`,
      },
      Form: {
        labelColor: token('--ink'),
        labelFontSize: 13,
        labelHeight: 22,
        itemMarginBottom: 16,
        verticalLabelPadding: `0 0 ${tokenNumber('--sp-2')}px`,
      },
      Alert: {
        colorInfoBg: token('--accent-wash'),
        colorWarningBg: token('--warn-wash'),
        colorErrorBg: token('--danger-wash'),
        colorSuccessBg: token('--ok-wash'),
        defaultPadding: `${tokenNumber('--sp-3')}px ${tokenNumber('--sp-4')}px`,
        fontSize: 13,
      },
      Tag: {
        defaultBg: token('--surface-2'),
        defaultColor: token('--ink-2'),
        borderRadiusSM: tokenNumber('--r-xs'),
        fontSizeSM: 11,
        // ⚠️ **边框色在这里设不了**：Tag 的 `ComponentToken` 只有 `defaultBg` / `defaultColor`
        //    （`antd/es/tag/style/index.d.ts`），边框固定取 `token.colorBorder`，而 `colorBorder`
        //    按 `design/README.md` §三 必须映射到 `--rule-control`（0.5 墨，给交互控件用的 3:1 边界）。
        //    原型 `.tag` 要的是更浅的 `--rule`（0.13 发丝线）⇒ 一旦有页面真正渲染 Tag（P0-1-31 起的列表），
        //    在 `styles/app.css` 里补一条 `.ant-tag { border-color: var(--rule) }` 对齐，
        //    **不要**为此把全局 `colorBorder` 调浅 —— 那会让所有输入框边界掉到 3:1 以下。
      },
      Card: {
        headerBg: 'transparent',
        bodyPadding: tokenNumber('--sp-5'),
      },
      Message: { contentBg: token('--surface') },
      Notification: { colorBgElevated: token('--surface'), paddingMD: 16 },
      Dropdown: {
        controlItemBgHover: token('--surface-2'),
        paddingBlock: tokenNumber('--sp-2'),
      },
    },
  }
}
