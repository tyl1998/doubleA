/**
 * Webfont 注入（P0-1-30）
 *
 * 为什么用脚本注入而不是 `<link rel="stylesheet">` 写死在 `index.html`：
 * 外部字体 CSS **是渲染阻塞资源** —— 网络受限（公司网络 / 无外网）时首屏会一直白屏，
 * 直到连接超时。设计原型刻意保留了「Archivo → IBM Plex → 思源黑体 → PingFang SC / 微软雅黑」
 * 的回退链（`design/README.md` §八），**中文本来就由系统字体承接**，所以字体只应该是"锦上添花"：
 * 先用系统栈把界面画出来，字体到了再升级 —— 而不是让首屏等它。
 *
 * 落地形态：React 挂载后再插 `<link>`。脚本插入的样式表**不参与首屏阻塞**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ **不再拉 Noto Sans SC**（内存优化 P6，`docs/子方案/前端长会话内存优化.md`）
 * ─────────────────────────────────────────────────────────────────────
 * 它是**全量中文字体**（Google 的 css2 会按 `unicode-range` 拆成上百个分片，实际下载量
 * 在几 MB 量级），而且中文本来就由系统字体承接（见上段与 `design/README.md` §八 的回退链）。
 * 拉它的唯一收益是"少数没装中文系统字体的环境字形更统一"，代价是每个 tab 都要为它付出
 * 字体解码 / 缓存的常驻内存 —— 长会话场景下这笔交换不成立。中文栈原样保留在 `tokens.css`
 * （`PingFang SC` / `Microsoft YaHei` …），观感不受影响。
 */

/** 字形来源与 `design/*.html` 的 `<link>` 完全一致（改这里就等于改全部页面的字体口径） */
const WEBFONT_HREF =
  'https://fonts.googleapis.com/css2?family=Archivo:wght@700;800' +
  '&family=IBM+Plex+Mono:wght@400;500;600' +
  '&family=IBM+Plex+Sans:wght@400;500;600' +
  '&display=swap'

/**
 * 幂等：重复调用只插一次（React StrictMode 下 effect 会跑两遍）。
 * 刻意**不**监听 load/error 做重试 —— 字体加载失败是**可接受降级**，不是错误。
 */
export function loadWebfonts(): void {
  if (document.getElementById('doubulea-webfonts') !== null) return

  for (const host of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
    const preconnect = document.createElement('link')
    preconnect.rel = 'preconnect'
    preconnect.href = host
    // gstatic 才需要 CORS；不加 crossorigin 时字体文件会被拒绝
    if (host.includes('gstatic')) preconnect.crossOrigin = 'anonymous'
    preconnect.id = `doubulea-preconnect-${host.includes('gstatic') ? 'fonts' : 'css'}`
    if (document.getElementById(preconnect.id) === null) document.head.append(preconnect)
  }

  const link = document.createElement('link')
  link.id = 'doubulea-webfonts'
  link.rel = 'stylesheet'
  link.href = WEBFONT_HREF
  document.head.append(link)
}
