/**
 * 工作区**文件夹递归删除**判据（P1-9 · 目录删除）—— **纯函数**，零 `config` / DB / FS
 *
 * 依据：`docs/子方案/Code模式工作区.md` §六 1（工作区 API）+ §九（配额 / 安全）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件（同 `quotaModel.ts` / `dependencyModel.ts` / `dirModel` 的切分纪律）
 * ─────────────────────────────────────────────────────────────────────
 * 文件树里**目录不是一行**：目录由文件路径的 `/` 段派生（`shared#workspaceTreeResultSchema` 的
 * 注释："空目录在工作区模型里不存在"）。于是"删除文件夹"= 挑出**所有以 `dir/` 开头**的活文件路径，
 * 逐个软删。这条判据（`前缀 = dir + '/'`）错一点就会误伤同前缀的兄弟文件（`out2/x` vs `out/x`），
 * 故抽成纯函数、在自证脚本里逐条核对。
 *
 * ⚠️ 尾斜杠是**必有**的：`out` 必须匹配 `out/a`、不匹配 `outsider.txt` / `out2/a`。
 */

/**
 * 目录前缀（`out` → `out/`；`out/` → `out/`）—— 判据的唯一来源。
 *
 * 调方传进来的 `dir` 一律是 `normalizeWorkspacePath` 的产物（无尾斜杠、无 `..`、非空），
 * 这里只做"补一个尾斜杠"这一件事，幂等。
 */
export function workspaceDirPrefix(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`
}

/** `path`（归一化相对路径）是否落在目录 `dir` **之下**（含任意深）。`dir` 自身不是路径，故不算 */
export function isWorkspacePathInDir(path: string, dir: string): boolean {
  return path.startsWith(workspaceDirPrefix(dir))
}

/** 从一批路径里挑出落在 `dir` 之下的那些（保序；目录删除的"要软删哪些行"） */
export function selectWorkspaceDirPaths(dir: string, paths: readonly string[]): string[] {
  const prefix = workspaceDirPrefix(dir)
  return paths.filter((path) => path.startsWith(prefix))
}
