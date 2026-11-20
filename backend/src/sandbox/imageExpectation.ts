/**
 * 沙箱镜像**版本期望**的纯判据（一键初始化的"识别到升级"）。
 *
 * 背景：`infra/sandbox/versions.mjs` 是层版本的唯一事实来源；而 `SANDBOX_IMAGE` 是**启动期**
 * 从 `infra/.env` 读的。平台升级后如果只改代码、不改 env，一键初始化会看到旧 tag 在本地存在，
 * 误报"已就绪"并跳过 —— 新扩展（例如 `request_skill_from_workspace`）就不会进容器。
 *
 * 本模块只做两件事：
 *   · 从 ref 取 **tag**（支持 `registry:5000/repo:tag`，不允许把端口当 tag）；
 *   · 比较"配置的 tag"与"当前代码期望的 tag"，给出一句可执行的升级提示。
 *
 * 其余（动态 import `versions.mjs`、实际构建 / 拉取）留在 `nodeBootstrap.ts`。
 */

/** 当前代码期望的沙箱镜像（由 `versions.mjs` 的 `baseImageRef()` / `toolkitImageRef()` 提供） */
export interface SandboxImageExpectation {
  base: string
  toolkit: string
}

/**
 * `registry.local:5000/doubulea/sandbox-toolkit:14` → `14`；
 * 没写 tag（`repo` / `registry:5000/repo`）⇒ 空串（= `latest`，与期望的显式版本不等）。
 */
export function imageTagOf(ref: string): string {
  const trimmed = ref.trim()
  const slash = trimmed.lastIndexOf('/')
  const colon = trimmed.lastIndexOf(':')
  return colon > slash ? trimmed.slice(colon + 1) : ''
}

/**
 * 配置是否落后于当前代码的期望版本。
 *
 * `expected === null`（读不到 `versions.mjs`，如极简定制镜像）⇒ **不判漂移**，退回旧行为：
 * 只看配置的镜像在不在，避免把"无法判断"误报成"需要升级"。
 */
export function sandboxImageDriftOf(configured: string | undefined, expected: SandboxImageExpectation | null): boolean {
  if (expected === null) return false
  if (configured === undefined) return false
  return imageTagOf(configured) !== imageTagOf(expected.toolkit)
}

/**
 * 升级提示（写进自检项 detail / 自举步骤）。
 *
 * 必须包含**可直接照抄的两行 env**：一键初始化无法替运维改宿主上的 `infra/.env`
 * （容器里通常没有这个文件，而 env 是启动期快照），所以这里给的是"改完再点一次"的闭环。
 */
export function sandboxImageUpgradeHint(configured: string | undefined, expected: SandboxImageExpectation): string {
  const current = configured === undefined ? '（未配置 SANDBOX_IMAGE）' : configured
  return `配置为 ${current}，但当前代码要求 ${expected.toolkit}（层版本升级）。请把 infra/.env 改为 SANDBOX_IMAGE_BASE=${expected.base} / SANDBOX_IMAGE=${expected.toolkit}，重启后端后再点一键初始化`
}