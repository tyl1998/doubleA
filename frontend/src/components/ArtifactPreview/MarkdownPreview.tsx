/**
 * MD 预览（`子方案④` §五 2）
 *
 * ★ **复用 `features/chat/AssistantMarkdown`**（`03` §4.6：`06` §六 第 6 条的"单一渲染路径"）
 * —— 与助手正文同一套组件，不另写一个 Markdown 渲染器。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件存在的唯一理由：给 MD 一路**唯一**的残留风险打补丁
 * ─────────────────────────────────────────────────────────────────────
 * `react-markdown@10.1.0` 的**实测**行为（`子方案④` §五 2，一次性探针跑出来的，非照抄文档）：
 *   · `<script>` ⇒ **转义成字面文本**（没装 `rehype-raw` 就不进 DOM）⇒ 无 XSS 面；
 *   · `javascript:` 链接 ⇒ `defaultUrlTransform` 把协议**清成空串** ⇒ 不可点；
 *   · 外链图片 `![](http://evil.example/x.png)` ⇒ **原样保留** ⇒ 浏览器会真的去请求那个地址。
 * 前两条不用管，**第三条必须管**：那是追踪像素 / 访问者 IP 泄露，而且它发生在
 * "用户什么都没点"的情况下。
 *
 * ⇒ 对策就是下面这个 `components.img` 覆盖：白名单只有 `data:image/` 与同源的 `/api/…`，
 * 其余一律**不自动加载**，改成"一个可点击的链接 + 一句说明"（用户想看可以自己点 ——
 * 那是一次**有意识**的行为，而不是静默发生的请求）。
 * ⚠️ **这是预期行为**，不是 bug：引擎产出的 MD 里带外链图时，预览里看到的是链接而不是图。
 */

import { useMemo } from 'react'
import { AssistantMarkdown } from '../../features/chat/AssistantMarkdown.js'
import { useT, type Translate } from '../../app/i18n.js'
import type { Components } from 'react-markdown'

/**
 * 图片 `src` 能不能直接渲染。
 *
 * 白名单刻意只有两项：`data:image/`（内嵌图，无网络请求）与 `/api/…`（同源的我们的端点）。
 * ⚠️ **不放行任何跨源地址** —— 那正是要挡的东西；也不放行相对地址（HTML/MD 产物里的相对路径
 * 会以 `/api/artifacts/:id/content` 为 base 解析 ⇒ 打到一个 404 上，挡掉反而更诚实）。
 */
function isRenderableImageSrc(src: string): boolean {
  const value = src.trim()
  if (value === '') return false
  if (value.startsWith('data:image/')) return true
  return value.startsWith('/api/')
}

/**
 * 图片覆盖组件工厂：`t` 从组件里传进来（模块级常量拿不到 locale）。
 * `t` 在同一语言下引用稳定（见 `app/i18n.tsx`）⇒ 用 `useMemo` 包一层即可。
 */
function previewImageComponents(t: Translate): Components {
  return {
    img: ({ src, alt, title }) => {
      const source = typeof src === 'string' ? src : ''
      if (isRenderableImageSrc(source)) {
        return <img src={source} alt={alt ?? ''} title={title} />
      }
      // 跨源图：给链接 + 说明，**不自动加载**
      return (
        <span className="preview__extimg">
          <a href={source} target="_blank" rel="noreferrer noopener">
            {alt === undefined || alt === '' ? source : alt}
          </a>
          <span className="ratio">{t('artifact.preview.mdExternalNote')}</span>
        </span>
      )
    },
  }
}

export interface MarkdownPreviewProps {
  text: string
}

export function MarkdownPreview({ text }: MarkdownPreviewProps) {
  const { t } = useT()
  const components = useMemo(() => previewImageComponents(t), [t])
  return (
    <div className="preview preview--text">
      <AssistantMarkdown text={text} components={components} />
    </div>
  )
}
