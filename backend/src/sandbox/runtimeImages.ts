/**
 * 沙箱**运行时镜像**（P1-17a）—— 纯判据：本机镜像里"有哪些运行时、各自最新一份是哪份"。
 *
 * 依据：`docs/子方案/Code模式工作区.md` §五之二 2。**2026-10-14 修订（用户定案）**：
 * 运行时可选项**由后端从本机镜像探测得到** —— "有就提供、没有就不提供"，**不写死枚举**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * tag 约定（`infra/sandbox/versions.mjs` 与这里必须一致）
 * ─────────────────────────────────────────────────────────────────────
 *   `doubulea/sandbox-runtime:<id>-v<层版本>`   —— id 是运行时名（`python310` / `node22-python38`…），
 *   `-v<数字>` 是**层内容版本**（`RUNTIME_LAYER_VERSION`），用来区分"同一 id 的不同构建"。
 *   ⇒ 解析 id 用**最后一个 `-v<数字>`** 切开（id 自己可能含 `-`，见组合名 `node22-python38`）。
 *
 * ⚠️ 本文件**零 `config` / 零 DB / 零 Docker**：`listSandboxRuntimes`（refs → 列表）与
 *    `resolveSandboxRuntimeImage`（id + 列表 + 回退 → 镜像）都能在自证脚本里逐条核对。
 *    取 refs 的动作在 `sandbox/docker.ts#listRuntimeImages`（薄封装）。
 */

import { sandboxVariantLabel } from '@doubulea/shared'

import type { SandboxRuntimeItem } from '@doubulea/shared'

/** 运行时镜像的仓库名（`.env` 的 `SANDBOX_RUNTIME_REPO` 默认值；与 `versions.mjs#RUNTIME_IMAGE_NAME` 同值） */
export const SANDBOX_RUNTIME_REPO_DEFAULT = 'doubulea/sandbox-runtime'

/** tag 里 id 与层版本的分隔符（`<id>-v<层版本>`） */
const TAG_LAYER_SEPARATOR = /-v(\d+)$/u

/**
 * 从一条镜像 ref（`repo:tag`）解析运行时 id。
 * 不是本仓库（前缀不符）/ 不是 `<id>-v<数字>` 形态 ⇒ `undefined`（**不是我们的运行时镜像，跳过**）。
 */
export function runtimeIdFromImageRef(ref: string, repo: string): string | undefined {
  const prefix = `${repo}:`
  if (!ref.startsWith(prefix)) return undefined
  const tag = ref.slice(prefix.length)
  const matched = TAG_LAYER_SEPARATOR.exec(tag)
  if (matched === null) return undefined
  const id = tag.slice(0, matched.index)
  return id === '' ? undefined : id
}

/** 从一条镜像 ref 解析层版本号；解析不出 ⇒ `undefined` */
export function runtimeLayerVersionFromImageRef(ref: string, repo: string): number | undefined {
  const prefix = `${repo}:`
  if (!ref.startsWith(prefix)) return undefined
  const matched = TAG_LAYER_SEPARATOR.exec(ref.slice(prefix.length))
  return matched === null ? undefined : Number(matched[1])
}

/**
 * 从一堆镜像 ref 里收集**可用运行时**：每个 id 取**层版本最大**的那一份。
 *
 * 排序：按 id 字典序（稳定，便于前端与排障逐条比对）。
 * ⚠️ 结果里**不含** `SANDBOX_IMAGE`（那是回退镜像、不是"可选运行时"；由 `fallbackImage` 单独给）。
 */
export function listSandboxRuntimes(refs: readonly string[], repo: string): SandboxRuntimeItem[] {
  const best = new Map<string, { image: string; version: number }>()
  for (const ref of refs) {
    const id = runtimeIdFromImageRef(ref, repo)
    const version = runtimeLayerVersionFromImageRef(ref, repo)
    if (id === undefined || version === undefined) continue
    const current = best.get(id)
    if (current === undefined || version > current.version) best.set(id, { image: ref, version })
  }
  return [...best.entries()]
    .map(([id, entry]) => ({ id, label: sandboxVariantLabel(id), image: entry.image }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 按会话的 `runtime`（id）选镜像；列表里没有该 id ⇒ 回退 `fallback`（通常是 `SANDBOX_IMAGE`）。
 *
 * ⚠️ `fallback` 本身 `undefined`（没配 `SANDBOX_IMAGE`）时返回 `undefined`，由调用方
 * （`ensureSandbox`）走显式失败 —— 本函数不替调用方决定"没配置怎么办"。
 * ⚠️ **找不到 id 不抛错**：老会话的 runtime 可能在本机没有对应镜像（换机/换镜像集），
 *    回退到 toolkit 能让它**继续能跑**（比"起不来"好），并留一条 warn 观测。
 */
export function resolveSandboxRuntimeImage(
  runtimeId: string,
  runtimes: readonly SandboxRuntimeItem[],
  fallback: string | undefined,
): string | undefined {
  return runtimes.find((item) => item.id === runtimeId)?.image ?? fallback
}
