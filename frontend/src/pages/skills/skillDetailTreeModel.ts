/**
 * 详情页文件树编辑的**纯数据层**（P1-24a-7，2026-11-19 用户定案：就在详情页编辑，不再跳草稿页）。
 *
 * 交互照 Code 模式（`features/chat/WorkspacePanel.tsx`）：树行**右键**出菜单
 * （文件：重命名 / 删除；目录：新建文件 / 新建文件夹 / 上传到此目录 / 重命名 / 删除目录）。
 *
 * 为什么要有这一层：详情页的编辑**先在本地累积**（新建的文本 / 待上传的二进制 / 重命名 / 删除），
 * 点「保存」时才由 `usePublishSkillEdits` 一次回放成 vN+1。累积与"最终树长什么样"必须是纯函数 ——
 * 否则"删掉 A 又新建 A"这种序列在界面上会自相矛盾，而保存时又是另一个结果。
 */

import { SKILL_ENTRY_PATH, isPreviewableSkillMime, type SkillFileEntry } from '@doubulea/shared'

/** 一次重命名（`to` 可能与别的改动冲突 —— 保存时由服务端 400，界面不做合并语义） */
export interface TreeRename {
  from: string
  to: string
  kind: 'FILE' | 'DIR'
}

/** 待写入的文本文件（新建 / 在线编辑；`path` 是**最终**路径） */
export interface TreeTextWrite {
  path: string
  text: string
  /** 显示用（树行读数 / 更新后的树大小） */
  size: number
  mime: string
}

/** 待上传的二进制 / 文件（新建上传，或整文件替换同路径） */
export interface TreeUpload {
  path: string
  file: File | undefined
  /** 文本文件也用上传通道时的正文（二进制 `undefined`） */
  text: string | undefined
  /** 显示用大小（新建文本 = UTF-8 字节数；上传 = `file.size`），仅用于树行读数 */
  size: number
  mime: string
}

/**
 * 树编辑的累积状态（**不可变**：每次操作返回新实例，React 才能正确重渲染）。
 *
 * 关键不变量：`textWrites` / `uploads` 的 `path` 已经在 `renames` 的**目标**之后、`removals` 之前 ——
 * 也就是"先落文件，再改名，最后删"，与保存时的回放顺序一致。
 */
export class TreeEdits {
  readonly textWrites: ReadonlyMap<string, TreeTextWrite> = new Map()
  readonly uploads: ReadonlyMap<string, TreeUpload> = new Map()
  readonly renames: readonly TreeRename[] = []
  readonly removals: ReadonlySet<string> = new Set()
  /** 新建的目录（保存时自动补一个 `dir/.keep` 占位文件 —— 目录不是存储对象，见 `withDir`） */
  readonly dirs: ReadonlySet<string> = new Set()
  /** `SKILL.md` 正文的本地改动（`null` = 没改，沿用当前版本） */
  readonly markdown: string | null = null
  /** 已知的基准文件路径（由页面传 `detail.files`；删除基准文件时据此加墓碑） */
  readonly basePaths: readonly string[] = []

  /**
   * 带着"这一版基准文件清单"的编辑状态。
   *
   * ⚠️ 所有 `with*` 都从 `clone()` 派生，而 `clone()` 读的是 `this.basePaths` —— 页面必须**先**
   * 用它播种（`new EmptyTreeEdits().forBase(detail.files)`），否则第一次 `withRemoval` 就会
   * 在 `for...of undefined` 上抛错，整个详情页白屏（2026-11-19 用户反馈的实际症状）。
   * 传 `SkillFileEntry[]` 或 `string[]` 都行，内部统一成路径。
   */
  forBase(base: readonly (SkillFileEntry | string)[]): TreeEdits {
    const next = this.clone()
    return Object.assign(next, { basePaths: base.map((item) => (typeof item === 'string' ? item : item.path)) }) as TreeEdits
  }

  protected clone(): TreeEdits {
    const next = new TreeEdits()
    return Object.assign(next, {
      textWrites: new Map(this.textWrites),
      uploads: new Map(this.uploads),
      renames: [...this.renames],
      removals: new Set(this.removals),
      dirs: new Set(this.dirs),
      markdown: this.markdown,
      basePaths: [...this.basePaths],
    }) as TreeEdits
  }

  /** 写 / 覆盖一个文本文件（`keepBase=true` 且内容等于基线时 = 撤销这次编辑） */
  withTextWrite(path: string, text: string, keepBase = false): TreeEdits {
    const next = this.clone()
    const writes = new Map(next.textWrites)
    if (keepBase) writes.delete(path)
    else writes.set(path, { path, text, size: new TextEncoder().encode(text).length, mime: mimeOfPath(path) })
    const uploads = new Map(next.uploads)
    uploads.delete(path)
    const dirs = new Set(next.dirs)
    // 这个路径所在（及更上层）的"新建空目录"已经不再空了 ⇒ 从待建目录里摘掉
    for (const dir of [...dirs]) if (underPath(path, dir)) dirs.delete(dir)
    return Object.assign(next, { textWrites: writes, uploads, dirs }) as TreeEdits
  }

  /** 上传一个文件（新建或整文件替换）；同路径的文本改动让位 */
  withUpload(path: string, file: File): TreeEdits {
    const next = this.clone()
    const uploads = new Map(next.uploads)
    uploads.set(path, { path, file, text: undefined, size: file.size, mime: file.type === '' ? mimeOfPath(path) : file.type })
    const writes = new Map(next.textWrites)
    writes.delete(path)
    const removals = new Set(next.removals)
    removals.delete(path)
    const dirs = new Set(next.dirs)
    for (const dir of [...dirs]) if (underPath(path, dir)) dirs.delete(dir)
    return Object.assign(next, { uploads, textWrites: writes, removals, dirs }) as TreeEdits
  }

  /** 记一次重命名 / 移动（目标处已有的改动保留；源处若是新建文件则跟着改路径） */
  withRename(item: TreeRename): TreeEdits {
    const next = this.clone()
    const writes = new Map(next.textWrites)
    const moved = writes.get(item.from)
    if (moved !== undefined) {
      writes.delete(item.from)
      writes.set(item.to, { path: item.to, text: moved.text, size: moved.size, mime: mimeOfPath(item.to) })
    }
    const uploads = new Map(next.uploads)
    const movedUpload = uploads.get(item.from)
    if (movedUpload !== undefined) {
      uploads.delete(item.from)
      uploads.set(item.to, { ...movedUpload, path: item.to })
    }
    return Object.assign(next, {
      renames: [...next.renames.filter((existing) => existing.from !== item.from), item],
      textWrites: writes,
      uploads,
    }) as TreeEdits
  }

  /** 删除一个路径（文件或目录前缀；`SKILL.md` 永不删） */
  withRemoval(path: string): TreeEdits {
    return this.removedBy((candidate) => candidate === path)
  }

  /**
   * 递归删除一个目录前缀（基准文件走墓碑、本次新建的直接丢弃；见 `removedBy`）。
   */
  withRemovalOfDir(dir: string): TreeEdits {
    return this.removedBy((candidate) => underPath(candidate, dir))
  }

  private removedBy(match: (path: string) => boolean): TreeEdits {
    const next = this.clone()
    const removals = new Set(next.removals)
    const writes = new Map(next.textWrites)
    const uploads = new Map(next.uploads)
    if (match(SKILL_ENTRY_PATH)) return this
    // 基准文件才需要墓碑；本次新建的（文本 / 上传）直接丢弃即可 ——
    // 丢弃后它不再出现在 `textWrites` / `uploads`，也就不会被 `planTreeSave` 写进 vN+1。
    for (const path of [...writes.keys(), ...uploads.keys()]) {
      if (!match(path)) continue
      writes.delete(path)
      uploads.delete(path)
    }
    for (const path of this.basePaths) {
      if (match(path)) removals.add(path)
    }
    // 本次重命名的目标路径同样是"草稿文件"，被删时一并记墓碑（源路径的墓碑由改名本身负责）。
    for (const rename of next.renames) if (match(rename.to)) removals.add(rename.to)
    const dirs = new Set(next.dirs)
    for (const dir of dirs) if (match(dir)) dirs.delete(dir)
    // ⚠️ 这里必须把**删过的** `writes` / `uploads` 写回：漏写时"新建又删掉"的文件仍留在待发布清单里
    //    （2026-11-19 修正；树上看不见它，保存却会写进 vN+1）。
    return Object.assign(next, { removals, textWrites: writes, uploads, dirs }) as TreeEdits
  }

  /** 撤销删除（只对墓碑生效，且会被"再写 / 再上传"自动收起） */
  withoutRemoval(path: string): TreeEdits {
    const next = this.clone()
    const removals = new Set(next.removals)
    removals.delete(path)
    return Object.assign(next, { removals }) as TreeEdits
  }

  /**
   * 新建一个目录。
   *
   * ⚠️ 目录**不是存储对象**（`skill_files` / S3 只有文件，树里的目录由路径前缀推出来），
   * 所以"只记一个目录名"在保存后必然消失 —— 2026-11-19 用户反馈的实际 bug：
   * 新建文件夹 → 保存 → 刷新，文件夹没了（它既没进 vN+1，也**不算改动**，保存按钮本来就不会亮）。
   *
   * 现在与审核页同口径：新建目录 = 在它下面落一个 `.keep` 占位文件（`planTreeSave` 里补），
   * 于是目录会出现在 vN+1 里；用户往目录里放文件的，`.keep` 自动收起。
   */
  withDir(dir: string): TreeEdits {
    const next = this.clone()
    const dirs = new Set(next.dirs)
    dirs.add(dir)
    return Object.assign(next, { dirs }) as TreeEdits
  }

  /** `SKILL.md` 正文改动（`null` = 回到当前版本的正文） */
  withMarkdown(markdown: string | null): TreeEdits {
    const next = this.clone()
    return Object.assign(next, { markdown }) as TreeEdits
  }

}

/** 由路径猜 mime（与后端 `skillDraft.service#mimeOfDraftPath` 的最小表同口径） */
function mimeOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
  const table: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    csv: 'text/csv',
    py: 'text/x-python',
    sh: 'text/x-shellscript',
    js: 'text/javascript',
    ts: 'text/typescript',
    sql: 'application/sql',
    html: 'text/html',
    xml: 'application/xml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
  return table[ext] ?? 'application/octet-stream'
}

/** `a/b/c.md` 的父目录（根文件 = `''`） */
export function parentDirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '' : path.slice(0, index)
}

export function underPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * 把当前版本的清单按本地改动**变形**（重命名 / 已上传文件的新体积）。
 *
 * ⚠️ 本地已标记删除的文件**不在这里过滤**（2026-11-19 修正）：详情页的树要像 Code 模式 /
 * 审核页那样把删除行**留着**（置灰 + 可撤销），删掉后树里"凭空少一行"、也没有任何入口能撤销。
 * 之前这里把 `removals` 的条目直接丢掉，同时 `detailStatusOf` 对同一个路径返回 `REMOVED`，
 * 两个视图对"这一行在不在"各说一套 => 删除后文件从树里消失、右栏还停在它上面。
 * 现在统一由调用方把 `removals` 作为树行状态传下去（`removedPaths`），清单本身保持完整。
 *
 * @param markdown 本地改过的正文（没改 = 传当前版本的正文）
 */
export function effectiveDetailFiles(
  base: readonly SkillFileEntry[],
  edits: TreeEdits,
  markdown: string | null,
): SkillFileEntry[] {
  const renamed = new Map(edits.renames.map((item) => [item.from, item.to]))
  const out: SkillFileEntry[] = []
  for (const entry of base) {
    if (entry.path === SKILL_ENTRY_PATH) {
      // ⚠️ `markdown` 为 `null` = 正文**没改**、还是服务端那一份 ⇒ **不能用 `''` 算大小**，
      //    否则树里 `SKILL.md` 会显示 0 B（2026-11-19 实际踩到）。
      out.push({
        ...entry,
        size: markdown === null ? entry.size : new TextEncoder().encode(markdown).length,
        sha256: markdown === null ? entry.sha256 : '',
      })
      continue
    }
    const to = renamed.get(entry.path) ?? entry.path
    out.push({ ...entry, path: to, size: edits.uploads.get(entry.path)?.size ?? entry.size })
  }
  // 目录重命名：把前缀下的路径整体换掉（从目录根往下一层替换；足够覆盖"改名一个目录"）
  const prefixRenamed = out.map((entry) => {
    const path = dirRewriteOf(edits, entry.path)
    return path === entry.path ? entry : { ...entry, path }
  })
  const seen = new Set(prefixRenamed.map((entry) => entry.path))
  for (const item of [...edits.textWrites.values(), ...edits.uploads.values()]) {
    const path = dirRewriteOf(edits, item.path)
    if (path === SKILL_ENTRY_PATH || seen.has(path)) continue
    seen.add(path)
    prefixRenamed.push({
      path,
      size: item.size,
      mime: item.mime,
      sha256: '',
      previewable: isPreviewableSkillMime(item.mime),
      purged: false,
    })
  }
  return prefixRenamed.sort((a, b) => (a.path === SKILL_ENTRY_PATH ? -1 : b.path === SKILL_ENTRY_PATH ? 1 : a.path.localeCompare(b.path)))
}

/**
 * 新建的（还没放文件的）目录路径 —— 纯粹为了"新建后、保存前"就能在树上看到它。
 *
 * 目录不是存储对象（`skill_files` / S3 只存文件）⇒ 它不在 `effectiveDetailFiles` 的清单里，
 * 由树组件单独渲染成"空文件夹"。保存时会自动补一个 `dir/.keep`（见 `planTreeSave`），
 * 所以这个目录在 vN+1 与刷新之后依然存在。已经带上文件的目录会自然出现在清单里，这里去重掉。
 */
export function pendingDirsOf(
  edits: TreeEdits,
  files: readonly SkillFileEntry[],
): string[] {
  const existing = new Set<string>()
  for (const file of files) {
    const segments = file.path.split('/')
    for (let index = 1; index < segments.length; index += 1) existing.add(segments.slice(0, index).join('/'))
  }
  return [...edits.dirs].map((dir) => dirRewriteOf(edits, dir)).filter((dir) => !existing.has(dir) && !edits.removals.has(dir))
}

export type DetailFileStatus = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED' | null

/** 树行上的改动标记（新建 / 修改 / 改名 / 删除；未改动 = `null`） */
export function detailStatusOf(path: string, base: readonly SkillFileEntry[], edits: TreeEdits): DetailFileStatus {
  if (path === SKILL_ENTRY_PATH) return null
  if (edits.removals.has(path)) return 'REMOVED'
  const renamed = edits.renames.some((item) => item.to === path || (item.kind === 'DIR' && underPath(path, item.to)))
  if (renamed) return 'RENAMED'
  if (edits.textWrites.has(path) || edits.uploads.has(path)) {
    return base.some((entry) => entry.path === path) ? 'MODIFIED' : 'ADDED'
  }
  return null
}

/** 新建目录的占位文件名（空目录要进版本只能靠它；与审核页 `SkillDraftReview` 同一约定） */
export const KEEP_FILE_NAME = '.keep'

/** `docs` → `docs/.keep` */
export function keepPathOfDir(dir: string): string {
  return `${dir}/${KEEP_FILE_NAME}`
}

/** 保存时真正要回放的序列（顺序：文本 → 上传 → 重命名 → 删除） */
export interface TreeEditPlan {
  markdown: string
  textWrites: { path: string; text: string }[]
  uploads: TreeUpload[]
  renames: TreeRename[]
  removals: string[]
}

/**
 * 目录重命名后的路径（`rewriteDirOf` 的唯一入口；`''` = 没有改名）
 *
 * 目录改名只改前缀，且取"最外层的那个改名"（`a → b` 之后再 `a/x → y` 这种嵌套不在界面里出现）。
 */
function dirRewriteOf(edits: TreeEdits, path: string): string {
  const dir = edits.renames.find((item) => item.kind === 'DIR' && underPath(path, item.from))
  return dir === undefined ? path : `${dir.to}${path.slice(dir.from.length)}`
}

/**
 * 把累积的改动压成保存序列（删除顺序取"路径长的先"，避免目录与文件互相覆盖）。
 *
 * 新建目录 ⇒ 补 `dir/.keep` 文本（目录不是存储对象，空目录只能靠占位文件进版本）；
 * 目录里已经有本次新建 / 上传的文件的，`.keep` 不需要；`SKILL.md` 从不在删除 / 重命名里。
 */
export function planTreeSave(edits: TreeEdits, markdown: string, keepText = ''): TreeEditPlan {
  const held = [
    ...edits.textWrites.keys(),
    ...edits.uploads.keys(),
    ...edits.renames.map((item) => item.to),
  ]
  const writes = new Map(edits.textWrites)
  for (const dir of edits.dirs) {
    const real = dirRewriteOf(edits, dir)
    if (edits.removals.has(real)) continue
    // 目录里已经放了（本次新建 / 上传的）文件 ⇒ 目录会自然出现在版本里，不用占位文件
    if (held.some((path) => underPath(path, `${real}/`))) continue
    const keep = keepPathOfDir(real)
    if (writes.has(keep)) continue
    writes.set(keep, { path: keep, text: keepText, size: new TextEncoder().encode(keepText).length, mime: 'text/plain' })
  }
  return {
    markdown,
    textWrites: [...writes.values()].filter((item) => item.path !== SKILL_ENTRY_PATH),
    uploads: [...edits.uploads.values()].filter((item) => item.path !== SKILL_ENTRY_PATH),
    renames: edits.renames.filter((item) => item.from !== SKILL_ENTRY_PATH && item.to !== SKILL_ENTRY_PATH),
    removals: [...edits.removals]
      .filter((path) => path !== SKILL_ENTRY_PATH)
      .sort((a, b) => b.length - a.length),
  }
}

/** 某个路径在本地已上传 / 已编辑的内容（右栏显示用；`undefined` = 没有本地改动） */
export function localContentOf(edits: TreeEdits, path: string): { text?: string; file?: File } | undefined {
  const write = edits.textWrites.get(path)
  if (write !== undefined) return { text: write.text }
  const upload = edits.uploads.get(path)
  if (upload !== undefined) return { file: upload.file, ...(upload.text === undefined ? {} : { text: upload.text }) }
  return undefined
}

/** 空状态（`new EmptyTreeEdits()`；与 `new TreeEdits()` 等价，单独一个名字只为读起来像意图） */
export class EmptyTreeEdits extends TreeEdits {}

/**
 * 是否有本地改动（不含"已知基准路径"这类上下文；空目录不算 —— 它不落版本）。
 *
 * ⚠️ 判据与 `planTreeSave` 同口径（**待落版本的内容**），否则会出现"新建一个文件又删掉"：
 * 树与保存计划都已回到原样，界面却一直显示"未保存 / 可保存"。
 */
export function treeEditsEmpty(edits: TreeEdits): boolean {
  return treeEditCount(edits) === 0
}

/**
 * 真正会落进 vN+1 的改动条数。
 *
 * ⚠️ 新建目录也算（它落地时是 `dir/.keep`，见 `planTreeSave`）—— 2026-11-19 之前这里把目录排除，
 * 结果"只新建了一个文件夹"时 `dirty` 一直是 `false`，保存按钮不亮，目录也就永远发不出去。
 */
export function treeEditCount(edits: TreeEdits): number {
  const plan = planTreeSave(edits, '')
  const markdownChanged = edits.markdown === null ? 0 : 1
  return (
    plan.textWrites.length + plan.uploads.length + plan.renames.length + plan.removals.length + markdownChanged
  )
}
