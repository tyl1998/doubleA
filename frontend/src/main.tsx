/**
 * 前端入口（P0-1-30 落地）
 *
 * 顺序上只有两件事必须发生在 `render` 之前，且都有明确理由：
 *
 * 1. **`initThemeMode()`** —— 把 `data-theme` 写到 `<html>`。晚一步就会"浅色闪一下再变暗"，
 *    而且 `app/theme.ts` 是**读 CSS 变量**生成 AntD 主题的，属性没写好就会读到上一态的变量。
 *    **`initLocale()`** 同理（P1-23）：把 `lang` 写到 `<html>`，晚一步会让界面文案闪一下中文再变英文。
 * 2. **CSS 三件套 import** —— ES module 的 import 会被提升并按书写顺序求值，
 *    故 `tokens.css`（变量）一定先于 `base.css`（用变量的重置）生效。
 *    这三行**只在这里出现**：其他地方不许再 import 一次，否则暗色覆盖块会被重复打进产物。
 *
 * `loadWebfonts()` 刻意放在 `render` **之后**：脚本插入的样式表不参与首屏阻塞，
 * 网络受限时先出界面、字体到了再升级（详见 `styles/webfonts.ts` 顶部说明）。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'

import { App } from './app/App.js'
import { AppProviders } from './app/AppProviders.js'
import { initLocale } from './stores/locale.js'
import { initThemeMode } from './stores/ui.js'
import { loadWebfonts } from './styles/webfonts.js'

initThemeMode()
initLocale()

const container = document.getElementById('root')

if (container) {
  createRoot(container).render(
    <StrictMode>
      <AppProviders>
        <App />
      </AppProviders>
    </StrictMode>,
  )

  // 挂载已排队后才插字体：首屏不等它
  loadWebfonts()
}
