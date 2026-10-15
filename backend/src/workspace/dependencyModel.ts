/**
 * 工作区**依赖目录**判据（P1-17b）—— 纯函数：哪些路径属于"运行期拉下来的依赖/构建产物"。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 3（依赖目录按 `.gitignore` 风格排除：
 *      ① 不进产物、② 不进冷备、③ 配额区分源码字节 vs 依赖字节）+ §十三 已决 10。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件（同 `quotaModel.ts` / `artifactChanges.ts` 的切分纪律）
 * ─────────────────────────────────────────────────────────────────────
 * 本文件**零 `config` / 零 DB / 零 FS**：判据能在自证脚本里逐条核对。三个消费方共用**同一份名单**：
 *   · `workspace/store.ts#scanWorkspaceFiles`（**不进索引** ⇒ 不进文件树 / 配额 / 冷备）；
 *   · `sandbox/artifactChanges.ts`（**不进产物**）；
 *   · `workspace/service.ts`（**写闸门**：中介写拒绝落进依赖目录）。
 *
 * ★ **一个名单、三处生效**：名单写在别处就会分叉，而分叉的症状是"产物里没有 node_modules，
 *   但冷备/配额里却有"——没有一层会报错。
 *
 * ⚠️ **为什么依赖目录要整体排除（而不是"算小一点"）**：`node_modules` 动辄几百 MB、上万个小文件，
 *    它会**顶爆** `WORKSPACE_MAX_FILES`(2000) 与 `WORKSPACE_MAX_TOTAL_MB`(512) 两条源码配额，
 *    且**不该进 S3 冷备**（可再生、巨大 ⇒ 换机重建白备几百 MB）。
 *    排除后：源码字节走源码配额、依赖字节单独计量（`scanWorkspaceTree.dependencyBytes`）。
 */

/**
 * 依赖 / 构建产物目录名（**显式名单、一处定义**）。
 *
 * 匹配口径 = **路径里任一段**命中名单即算（含嵌套：monorepo 的子包 `pkg/node_modules` 同罪）。
 * ⚠️ 这是**较严**的口径：`src/dist/foo` 这类"路径里恰好有 dist 段"的文件也会被排除。
 *    取舍：`node_modules` 在 monorepo 里几乎必然嵌套，而"漏排一个嵌套依赖目录"会直接顶爆配额；
 *    "偶尔多排一个叫 dist 的源目录"只是少了一次产物交付，可解释、且能靠改名规避。
 */
export const WORKSPACE_DEPENDENCY_DIRS: readonly string[] = [
  // ── 包管理器下载的依赖 ──
  'node_modules',
  'bower_components',
  'venv',
  '.venv',
  '.tox',
  '.nox',
  '.gradle',
  '.cargo',
  // ── 语言/工具缓存 ──
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.cache',
  '.parcel-cache',
  '.next',
  '.nuxt',
  '.turbo',
  // ── 构建产物（只列**设计点名**的 target / dist；`build` / `out` 之类太容易撞上用户源码目录，
  //    故意不收 —— 见文件头"较严口径"的取舍：宁可少排一个构建目录，也别把用户的 src/out 藏起来）──
  'target',
  'dist',
  '.output',
]

/** 名单的 `Set` 形态（`isWorkspaceDependencyPath` 在最热路径上，别每次 `includes` 线性扫） */
const DEPENDENCY_DIR_SET: ReadonlySet<string> = new Set(WORKSPACE_DEPENDENCY_DIRS)

/**
 * 一个**工作区相对路径**是不是落在依赖目录里（**唯一判据**，三个消费方共用）。
 *
 * `relative` 一律是 `a/b/c` 形态的相对路径（`normalizeWorkspacePath` 的产物）；
 * 空串 / 只有文件名（无目录段）⇒ `false`（根目录下的文件不是依赖）。
 */
export function isWorkspaceDependencyPath(relative: string): boolean {
  return relative.split('/').some((segment) => DEPENDENCY_DIR_SET.has(segment))
}

/**
 * 一个**目录名**是不是依赖目录（`scanWorkspaceTree` 的 walk 用它决定"要不要下钻/计入依赖字节"）。
 * 与 {@link isWorkspaceDependencyPath} 同源（同一个 `Set`）。
 */
export function isWorkspaceDependencyDirName(name: string): boolean {
  return DEPENDENCY_DIR_SET.has(name)
}
