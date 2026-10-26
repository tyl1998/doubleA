/**
 * 节点**自检 + 自举**（P1-14 部署优化；2026-10-19 用户定案）。
 *
 * 依据：用户反馈"部署要起太多东西" ⇒ 每台节点应只需**一个后端容器**；做沙箱宿主的节点
 *      由后端自己检测缺什么、并按平台补齐（egress / relay / 沙箱网 / 运行时镜像）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 设计约束
 * ─────────────────────────────────────────────────────────────────────
 *   · **放在后端进程内**（用户定案），不引入第 N 个容器；自举走挂进来的 `/var/run/docker.sock`
 *     驱动**宿主** daemon（与沙箱同一条 DooD 通道）。
 *   · `chatbot` 档位的节点**不做任何自举**（它不需要 docker/egress/relay），自检直接给出"不适用"。
 *   · **探测只读、自举幂等**：`inspectNode()` 只 inspect；`bootstrapNode()` 每一步都先查再动，
 *     重复调用不会重复建容器。
 *   · **不假装成功**：每一步都有 `{ step, ok, detail }`，整份报告据此汇聚；页面按"就绪 / 未就绪"展示，
 *     **未就绪的实例不进会话的实例选择列表**（`GET /api/sandbox/runtimes` 侧过滤，见 `routes/sandbox.ts`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 平台差异（为什么需要 relay）
 * ─────────────────────────────────────────────────────────────────────
 *   macOS / Windows 的 Docker 跑在 VM 里：沙箱容器的 `172.31.240.1` 是 **VM** 的网关，不是宿主的
 *   127.0.0.1 ⇒ 需要 `doubulea-sandbox-relay`（宿主腿走 `host.docker.internal`）。
 *   Linux 上后端与 Docker 同宿主，出口② listener 直接绑沙箱网桥网关，**不需要 relay**。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname as pathDirname, join as pathJoin } from 'node:path'
import { promisify } from 'node:util'

import type { NodeBootstrapResult, NodeBootstrapStep, NodeCheckItem, NodeReport, NodeRoleName } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { config, findWorkspaceRoot } from '../config.js'
import { getDocker, listRuntimeImages, resolveDockerBin, withDockerEnv } from './docker.js'
import { ensureSandboxNetwork } from './network.js'
import { canBuildSandboxRuntime } from './runtimeBuild.js'

const execFileAsync = promisify(execFile)

// 报告结构与会话契约同源（`shared/src/node.ts`）：前端 `/admin/sandbox-instances` 直接消费
export type { NodeBootstrapResult, NodeBootstrapStep, NodeCheckItem, NodeReport, NodeRoleName } from '@doubulea/shared'

// ───────────────────── 两种运行布局（容器 / 宿主直跑）─────────────────────
//
// 一键初始化编排的三样东西（运维脚本、docker CLI、内置脚本中转卷）都是按**容器**形态设计的：
// 脚本打进镜像的 `/app/infra/scripts`、CLI 由 `docker-cli` 侧车挂进命名卷、脚本再写进中转卷给
// 兄弟容器用。而 `pnpm dev` 形态下后端是**宿主上的 `tsx watch`**：`/app` 不存在、脚本在仓库
// `/infra/scripts`、CLI 就在宿主 PATH 上 —— 若不做兼容，同一套判据在这两个形态下结论相反
// （页面点「一键初始化」必然失败，报「找不到 /app/infra/scripts/egress-up.sh」）。
// 下面三个小函数把"当前是哪一种布局"收在一处，供每一步共用。

/**
 * 后端跑在**容器**里，还是直接跑在**宿主**上。
 *
 * 判据取"容器身份标记"，不看某个目录存不存在：`DOUBULEA_CONTAINER_NAME` 由 compose /
 * `deploy/scripts/up.sh` 显式注入（自举要靠它 `docker exec` 定位"自己这个容器"），
 * `/.dockerenv` 是 Docker 给每个容器铺的标记文件。宿主上两者都没有 ⇒ 走"本机直跑"分支
 * （CLI 自带、脚本在真实路径上、不需要侧车与中转卷）。
 */
function isContainerMode(): boolean {
  return (process.env.DOUBULEA_CONTAINER_NAME ?? '').trim() !== '' || existsSync('/.dockerenv')
}

/**
 * 自举脚本路径：`envKey` 显式指定 > `/app/infra/scripts/<name>`（容器）> `<仓库根>/infra/scripts/<name>`（宿主 dev）。
 *
 * 先看 `/app`（它存在就说明是在镜像布局里），再按**上面找到的工作区根**拼仓库路径；两个都没有时
 * 回落容器路径 —— 错误文案里带上它比"某个临时路径"更好定位（调用方的报错都会回显这个值）。
 */
function bootstrapScript(name: string, envKey: string): string {
  const override = (process.env[envKey] ?? '').trim()
  if (override !== '') return override
  const inImage = `/app/infra/scripts/${name}`
  if (existsSync(inImage)) return inImage
  const root = findWorkspaceRoot()
  if (root !== undefined) {
    const inRepo = pathJoin(root, 'infra', 'scripts', name)
    if (existsSync(inRepo)) return inRepo
  }
  return inImage
}

/**
 * 跑脚本时的子进程工作目录。
 *
 * ⚠️ `cwd` 不存在时 `execFile` 直接以 `ENOENT spawn bash` 失败（**不是**脚本自己报错），所以本机
 * dev 形态下不能传写死的 `/app`。三个脚本内部都 `cd "$REPO_ROOT"`（按自身位置推导）⇒ 这里给
 * 仓库根只是为了"能 spawn 出来"，不影响脚本的路径解析。
 */
function bootstrapCwd(): string {
  if (existsSync('/app')) return '/app'
  return findWorkspaceRoot() ?? process.cwd()
}

/**
 * 补齐 toolkit（空环境）镜像：**先拉取、后构建**。
 *
 *   · 拉取：`SANDBOX_TOOLKIT_PULL_FROM`（如 `registry.local/doubulea/sandbox-toolkit:8`）存在时
 *     `docker pull` 并按本地 tag 重新打标签（不给来源就跳过，不联网碰运气）；
 *   · 构建：构建上下文可见时调 `scripts/sandbox-build.mjs` 的 toolkit 目标（与 CLI 同一份逻辑）；
 *   · 两条都不成 ⇒ 如实失败（沙箱连空环境都起不来）。
 */
async function ensureToolkitImage(note?: (event: string) => void): Promise<{ ok: boolean; detail: string }> {
  const image = config.sandbox.image
  if (image === undefined) return { ok: false, detail: '未配置 SANDBOX_IMAGE（toolkit 镜像名）' }
  note?.(`检查组沙箱镜像 ${image}`)
  try {
    await getDocker().getImage(image).inspect()
    return { ok: true, detail: `已就绪：${image}` }
  } catch {
    // 继续尝试拉取 / 构建
  }
  const pullFrom = (process.env.SANDBOX_TOOLKIT_PULL_FROM ?? '').trim()
  if (pullFrom !== '') {
    try {
      note?.(`本地没有 ${image}，开始 docker pull ${pullFrom}（可能较久）`)
      await execFileAsync(resolveDockerBin(), ['pull', pullFrom], { timeout: 20 * 60_000 })
      if (pullFrom !== image) {
        note?.(`拉取完成，标记为 ${image}`)
        await execFileAsync(resolveDockerBin(), ['tag', pullFrom, image], { timeout: 60_000 })
      }
      return { ok: true, detail: `已从 ${pullFrom} 拉取并标记为 ${image}` }
    } catch (error) {
      // 拉取失败继续尝试构建
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
      return await buildToolkit(image, `拉取 ${pullFrom} 失败（${message}）；`, note)
    }
  }
  return await buildToolkit(image, '', note)
}

/** 用仓库里的构建脚本建 toolkit（`scripts/sandbox-build.mjs`；脚本内部自己决定层版本） */
async function buildToolkit(image: string, prefix: string, note?: (event: string) => void): Promise<{ ok: boolean; detail: string }> {
  const script = bootstrapScript('sandbox-build.mjs', 'DOUBULEA_SANDBOX_BUILD_SCRIPT')
  if (!existsSync(script)) {
    return { ok: false, detail: `${prefix}且找不到 ${script}（无法构建 toolkit；请在宿主导入镜像或挂 infra/scripts）` }
  }
  try {
    // 只建 toolkit（base 是它的 FROM，脚本自己会先确保 base 存在）
    note?.(`通过 ${script} 构建 ${image}（镜像构建可能要几分钟）`)
    // 脚本内部自己定位 docker（`DOCKER_BIN` / `SANDBOX_DOCKER_BIN` / PATH）；宿主 dev 下后端 PATH
    // 里没有 `/usr/local/bin` ⇒ 把已解析出来的那个二进制传给它，别让它再猜一遍。
    await execFileAsync(process.execPath, [script, '--toolkit-only'], {
      timeout: 60 * 60_000,
      cwd: bootstrapCwd(),
      env: withDockerEnv(),
    })
    return { ok: true, detail: `${prefix}已通过 ${script} 构建 ${image}` }
  } catch (error) {
    return { ok: false, detail: `${prefix}构建失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 让脚本里 `docker run -v <src>:...` 的 `src` 成为**宿主可见**的路径。
 *
 * 镜像内置脚本时，脚本在容器里的 `/app/infra/scripts`，而 `-v` 的源由**宿主** docker 解析 ——
 * 那个路径在宿主上不存在（Docker 会建成空的**目录**挂进去 ⇒ 兄弟容器启动失败）。
 * 做法：把要用的脚本 `docker cp` 到一个**共享可见**的临时目录（默认宿主 `/tmp`，容器内 `/tmp` 同名），
 * 再让脚本用它。
 *
 * 前提：宿主 `/tmp` 与容器 `/tmp` 可见性一致（同机 Docker 默认成立；macOS 的 OrbStack 也成立）。
 * 若运维已经用覆盖文件挂了真实脚本（`DOUBULEA_HOST_INFRA_DIR` 指向宿主路径），则**不拷贝**。
 */
/**
 * 把**镜像内置**的运维脚本放到一个**兄弟容器也能看到**的位置。
 *
 * 难点：脚本里是 `docker run -v <src>:<dst>`，`src` 由**宿主** docker 解析；而脚本在容器里时，
 * 容器内 `/tmp` **不是**宿主 `/tmp`（OrbStack 实测：兄弟容器挂不到）。`docker cp` 也只能写到容器自己的层。
 *
 * 解法：用一个**命名卷** `doubulea-node-infra` 做中转 —— 本容器把它挂到 `/opt/node-infra`（读写），
 * 把内置脚本拷进去；兄弟容器用**同一个卷**挂到 `/app`（脚本就是 `/app/<file>`）即可。卷的生命周期由
 * Docker 管，天然"宿主可见"，不依赖任何宿主路径。
 *
 * 返回 `hostDir`（= 容器内的卷挂载点），由调用方作为 `DOUBULEA_HOST_INFRA_DIR` 传给脚本。
 * ⚠️ 卷必须已挂载（compose 里加了 `doubulea-node-infra:/opt/node-infra`）；没挂就返回 `undefined`，
 *    自举退化为"使用脚本所在目录"（仅当它本身就在宿主可见路径上时可用，即覆盖挂载模式）。
 */
const INFRA_VOLUME = 'doubulea-node-infra'
const INFRA_VOLUME_MOUNT = '/opt/node-infra'
let infraMaterialized: string | undefined

export async function materializeInfraDir(scriptPath: string): Promise<{ hostDir: string } | undefined> {
  const explicitHostDir = (process.env.DOUBULEA_HOST_INFRA_DIR ?? '').trim()
  if (explicitHostDir !== '') return undefined // 覆盖文件已把脚本挂到宿主路径上
  if (infraMaterialized !== undefined) return { hostDir: infraMaterialized }
  // ★ 本机直跑（`pnpm dev`）：脚本本来就在**宿主文件系统**上（`<仓库根>/infra/scripts`），`-v` 的源
  //   直接就是它 ⇒ 不需要中转卷。若不在这里早退，会走下面的 `DOUBULEA_CONTAINER_NAME` 缺失分支，
  //   在每次初始化时打一条"写入中转卷失败"的 warn（看着像配置错误，其实是正常路径）。
  if (!isContainerMode()) return undefined
  const container = (process.env.DOUBULEA_CONTAINER_NAME ?? '').trim()

  const sourceDir = pathDirname(scriptPath)
  const files = (await readdir(sourceDir).catch(() => [] as string[])).filter((file) => /\.(mjs|sh)$/u.test(file))
  const exec = promisify(execFile)
  try {
    if (container === '') throw new Error('未设置 DOUBULEA_CONTAINER_NAME')
    // ① 确保卷存在（compose 已建过则 no-op）
    await exec(resolveDockerBin(), ['volume', 'create', INFRA_VOLUME], { timeout: 30_000 })
    // ② 把本容器的脚本写进卷（`docker cp` 从本进程文件系统读，写到本容器的卷挂载点）
    await exec(resolveDockerBin(), ['exec', container, 'mkdir', '-p', INFRA_VOLUME_MOUNT], { timeout: 30_000 })
    for (const file of files) {
      await exec(resolveDockerBin(), ['cp', pathJoin(sourceDir, file), `${container}:${INFRA_VOLUME_MOUNT}/${file}`], {
        timeout: 60_000,
      })
    }
    // ③ 校验：卷里确实有脚本（避免"看起来成功、兄弟容器挂了空目录"）
    const listing = await exec(resolveDockerBin(), ['exec', container, 'ls', INFRA_VOLUME_MOUNT], { timeout: 30_000 })
    if (!String(listing.stdout).includes('sandbox-relay.mjs')) throw new Error('卷里没有脚本')
    infraMaterialized = INFRA_VOLUME_MOUNT
    getLogger().info({ volume: INFRA_VOLUME, files: files.length }, '内置运维脚本已写入中转卷')
    return { hostDir: INFRA_VOLUME_MOUNT }
  } catch (error) {
    getLogger().warn({ err: error, container }, '内置脚本写入中转卷失败 ⇒ 自举回退为脚本所在目录')
    return undefined
  }
}

/**
 * 补齐**基础设施镜像**（egress / relay 用的 node 镜像；docker-cli 侧车用的 CLI 镜像）。
 *
 * 为什么不在脚本里拉：`egress-up.sh` / `relay-up.sh` 刻意"离线可跑"（不联网、不给你猜镜像源）。
 * 而**初始化**是运维动作，允许联网 ⇒ 由这里先 `docker pull`，再交给脚本起容器。
 *
 * 来源可配（内网没有外网时）：
 *   · `EGRESS_IMAGE` / `RELAY_IMAGE`（默认 `node:22-bookworm-slim`）
 *   · `DOCKER_CLI_IMAGE`（默认 `docker:27-cli`）
 * 拉取失败**不阻断**：脚本会用自己的报错说明"本地没有镜像"，页面能看懂。
 */
async function ensureInfraImages(needed: readonly string[]): Promise<Array<{ image: string; ok: boolean; detail: string }>> {
  const results: Array<{ image: string; ok: boolean; detail: string }> = []
  const docker = getDocker()
  for (const image of new Set(needed)) {
    try {
      await docker.getImage(image).inspect()
      results.push({ image, ok: true, detail: `已存在：${image}` })
      continue
    } catch {
      // 继续拉
    }
    try {
      await execFileAsync(resolveDockerBin(), ['pull', image], { timeout: 15 * 60_000 })
      results.push({ image, ok: true, detail: `已拉取：${image}` })
    } catch (error) {
      results.push({
        image,
        ok: false,
        detail: `拉取 ${image} 失败（${error instanceof Error ? error.message.split('\n')[0] : String(error)}）—— 请离线导入该镜像，或配置内网镜像源`,
      })
    }
  }
  return results
}

/** 名称常量（与 `infra/scripts/*.sh` 保持一致） */
const EGRESS_NAME = 'doubulea-egress'
const RELAY_NAME = 'doubulea-sandbox-relay'
const DOCKER_HOST_NAME = 'doubulea-docker-cli'
const EGRESS_PORT = 3128
const RELAY_PORT = 13001

/** 从 Docker 版本信息推断**宿主**平台（容器内 `platform()` 恒为容器自己的平台） */
async function detectHostPlatform(): Promise<string> {
  const fromEnv = process.env.DOUBULEA_HOST_PLATFORM?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  try {
    const info = await getDocker().info()
    const name = String((info as { OperatingSystem?: unknown }).OperatingSystem ?? '')
    if (/docker desktop|orbstack|rancher|colima|podman machine/iu.test(name)) return 'darwin-or-windows-vm'
  } catch {
    // 拿不到就按进程平台（Linux 原生 / 本机 pnpm dev）
  }
  return platform()
}

/** 平台是否"需要 relay"（Docker 跑在 VM 里 ⇒ 沙箱够不到宿主 127.0.0.1） */
function needsRelayFor(hostPlatform: string): boolean {
  return /^(darwin|win32|.*vm.*)$/u.test(hostPlatform)
}

/** 查容器是否在运行（不存在/未运行 ⇒ false；Docker 不可达 ⇒ 抛） */
async function containerRunning(name: string): Promise<boolean> {
  try {
    const info = await getDocker().getContainer(name).inspect()
    return info.State.Running === true
  } catch {
    return false
  }
}

/**
 * 只读自检：这台节点现在能不能当沙箱实例。
 *
 * ⚠️ 不写任何东西（不建网、不起容器）：它会被**每次心跳**与页面轮询调用。
 */
/**
 * 让两个**共享卷**的挂载点对本进程可写（幂等，慢路径）。
 *
 * 为什么需要：Docker 新建命名卷的根目录是 `root:root 755`，而本容器以 uid 10001 运行 ⇒
 * 自举时"脚本往卷里写文件"会 `Permission denied`，症状是**看起来成功、卷里却是空的**
 * （egress 代理随后每 5s 报 `ENOENT /egress-allow/policy.json`）。挂载点目录属主改不了
 * （卷由 root 建），所以这里 `chmod 0777`：两个卷只装脚本与策略，不含敏感数据。
 *
 * ⚠️ 只在"写失败"时才调用（正常路径一次也不跑）—— 它要起一个一次性容器。
 */
export async function ensureSharedVolumesWritable(volumes: readonly string[]): Promise<string[]> {
  const fixed: string[] = []
  for (const volume of volumes) {
    const container = (process.env.DOUBULEA_CONTAINER_NAME ?? '').trim()
    if (container === '') break
    try {
      await execFileAsync(
        resolveDockerBin(),
        ['exec', '-u', '0', container, 'sh', '-lc', `chmod 0777 /opt/${volume.replace(/^doubulea-/u, '')}`],
        { timeout: 30_000 },
      )
      fixed.push(volume)
    } catch {
      // 忽略：下一次自举会再试
    }
  }
  return fixed
}

export async function inspectNode(options: { role: NodeRoleName; instanceId: string }): Promise<NodeReport> {
  const hostPlatform = await detectHostPlatform()
  const needsRelay = needsRelayFor(hostPlatform)
  const items: NodeCheckItem[] = []
  const now = Date.now()

  if (options.role === 'chatbot') {
    return {
      instanceId: options.instanceId,
      role: 'chatbot',
      platform: platform(),
      hostPlatform,
      needsRelay: false,
      // 只做对话的节点：没有必需项 ⇒ 恒"就绪"（它本就不进实例列表，这个字段只是给页面看）
      ready: true,
      items: [],
      checkedAt: now,
    }
  }

  // ① Docker 可达
  let dockerOk = false
  let dockerDetail: string
  try {
    const version = await getDocker().version()
    dockerOk = true
    dockerDetail = `daemon ${version.Version}`
  } catch (error) {
    dockerDetail = `连不上 Docker（${error instanceof Error ? error.message : String(error)}）— 容器里需要挂 /var/run/docker.sock 与 gid`
  }
  items.push({ key: 'docker', label: 'Docker daemon', required: true, ok: dockerOk, detail: dockerDetail })

  // ② 沙箱网（自举时创建；这里只看在不在）
  let networkOk = false
  let networkDetail = '不存在（点「一键初始化」会创建）'
  if (dockerOk) {
    try {
      const net = await getDocker().getNetwork('doubulea-sandbox').inspect()
      networkOk = true
      networkDetail = `gateway ${net.IPAM?.Config?.[0]?.Gateway ?? '?'}`
    } catch {
      // 保持"不存在"
    }
  }
  items.push({ key: 'sandboxNetwork', label: '沙箱网 doubulea-sandbox', required: true, ok: networkOk, detail: networkDetail })

  // ③ egress（沙箱必挂的出口①）
  const egressOk = dockerOk ? await containerRunning(EGRESS_NAME) : false
  items.push({
    key: 'egress',
    label: `出口代理 ${EGRESS_NAME}`,
    required: true,
    ok: egressOk,
    detail: egressOk ? `运行中（:${String(EGRESS_PORT)}）` : '未运行 —— 沙箱没有它调不到模型池；点「一键初始化」会拉起',
  })

  // ④ egress 是否已接上沙箱腿（沙箱容器里要能解析到它）
  let egressReachable = false
  let egressNetworks: string[] = []
  if (egressOk) {
    try {
      const info = await getDocker().getContainer(EGRESS_NAME).inspect()
      egressNetworks = Object.keys(info.NetworkSettings?.Networks ?? {})
      egressReachable = egressNetworks.includes('doubulea-sandbox')
    } catch {
      egressReachable = false
    }
  }
  items.push({
    key: 'egressReachable',
    label: 'egress 已接入沙箱网',
    required: true,
    ok: egressReachable,
    detail: egressReachable
      ? `已接入（网络：${egressNetworks.join(' + ')}）`
      : egressOk
        ? `未接入沙箱网（当前：${egressNetworks.join(' + ') || '无'}；自举时会 network connect）`
        : 'egress 未运行（先起 egress）',
  })

  // ⑤ relay（仅 macOS/Windows 需要）
  const relayOk = needsRelay && dockerOk ? await containerRunning(RELAY_NAME) : !needsRelay
  items.push({
    key: 'relay',
    label: `出口② 中转 ${RELAY_NAME}`,
    required: needsRelay,
    ok: relayOk,
    detail: needsRelay
      ? relayOk
        ? `运行中（:${String(RELAY_PORT)} → host.docker.internal）`
        : '未运行 —— macOS/Windows 上 Docker 在 VM 里，沙箱够不到后端；点「一键初始化」会拉起'
      : '不需要（Linux 后端直接绑沙箱网桥网关）',
  })

  // ⑥ 构建上下文（可选：没有也能跑，只是不能按需构建环境）
  const buildOk = await canBuildSandboxRuntime()
  items.push({
    key: 'buildContext',
    label: '运行时构建上下文',
    required: false,
    ok: buildOk,
    detail: buildOk ? '可见（可按需构建环境）' : '不可见 —— 不能按需构建环境（不影响已有镜像）',
  })

  // ⑦ toolkit 镜像（沙箱默认镜像；缺了连空环境都起不来）
  let toolkitOk = false
  if (dockerOk) {
    const image = config.sandbox.image
    if (image === undefined) toolkitOk = false
    else {
      try {
        await getDocker().getImage(image).inspect()
        toolkitOk = true
      } catch {
        toolkitOk = false
      }
    }
  }
  items.push({
    key: 'toolkitImage',
    label: `沙箱镜像 ${config.sandbox.image ?? '（未配置 SANDBOX_IMAGE）'}`,
    required: true,
    ok: toolkitOk,
    detail: toolkitOk ? '已就绪（空环境可用）' : '缺失 —— 需要导入或构建 toolkit 镜像',
  })

  // ⑧ 运行时镜像（可选：没有就用 toolkit 回退，只是少了语言层）
  let runtimeIds: string[] = []
  if (dockerOk) {
    // `listRuntimeImages` 回的是**完整 ref**（`repo:tag`）⇒ 这里只取 tag（= 变体 id + 层版本）
    runtimeIds = (await listRuntimeImages(config.sandbox.runtimeRepo).catch(() => [])).map(
      (ref) => ref.slice(ref.indexOf(':') + 1),
    )
  }
  items.push({
    key: 'runtimeImages',
    label: '语言运行时镜像',
    required: false,
    ok: runtimeIds.length > 0,
    detail:
      runtimeIds.length > 0
        ? `已就绪：${runtimeIds.join('、')}`
        : '没有额外运行时（空环境照样可用；可在实例上按需构建）',
  })

  // ⑨ 工作区根目录（宿主机路径必须在容器里可见且可写）
  const workspaceOk = existsSync(config.workspace.root)
  items.push({
    key: 'workspaceRoot',
    label: '工作区根目录',
    required: true,
    ok: workspaceOk,
    detail: workspaceOk ? config.workspace.root : `${config.workspace.root} 不存在（检查 WORKSPACE_ROOT 与 bind mount）`,
  })

  const ready = items.every((item) => !item.required || item.ok)
  return {
    instanceId: options.instanceId,
    role: 'taskAgent',
    platform: platform(),
    hostPlatform,
    needsRelay,
    ready,
    items,
    checkedAt: now,
  }
}

/**
 * 心跳用的**就绪采样**（带缓存）：`undefined` = 不该上报（chatbot 档位 / 沙箱未启用）。
 *
 * ⚠️ 缓存 60s：自检会 inspect 容器/镜像/网络（多个 Docker 往返），每 30s 心跳都跑一遍太贵；
 *    就绪状态变化不要求秒级（用户点了「初始化」后页面会主动刷新）。
 */
const READY_CACHE_MS = 60_000
let readyCache:
  | { at: number; value: { ready: boolean; missing: string[]; hostPlatform: string; needsRelay: boolean } }
  | undefined

export async function maybeInspectNodeReadiness(
  now: number = Date.now(),
): Promise<{ ready: boolean; missing: string[]; hostPlatform: string; needsRelay: boolean } | undefined> {
  if (!config.sandbox.enabled) return undefined
  if (readyCache !== undefined && now - readyCache.at < READY_CACHE_MS) return readyCache.value
  const report = await inspectNode({ role: 'taskAgent', instanceId: config.sandbox.instanceId })
  const value = {
    ready: report.ready,
    missing: report.items.filter((item) => item.required && !item.ok).map((item) => item.key),
    hostPlatform: report.hostPlatform,
    needsRelay: report.needsRelay,
  }
  readyCache = { at: now, value }
  return value
}

/** 自举成功后清缓存（让下一次心跳立刻带上新结论） */
export function invalidateNodeReadiness(): void {
  readyCache = undefined
}

/**
 * 一键自举：把自检里"必需但没就绪"的项补齐。**幂等**，可在页面重复点。
 *
 * 步骤（能跳过的都跳过）：
 *   ① 建沙箱网（`ensureSandboxNetwork`，与沙箱同一条判据）
 *   ② 起 `docker-cli` 侧车（后端按需构建要用它的 CLI；compose 已拉起时这一步是 no-op）
 *   ③ 起 egress 并接上沙箱腿（**复用 `infra/scripts/egress-up.sh`**：策略解析/健康检查都在那里）
 *   ④ macOS/Windows：起 relay（**复用 `infra/scripts/relay-up.sh`**）
 */
/** 收尾：清就绪缓存 + 重新自检（自举的最后一步，两处调用点共用） */
/** 复检失败时的空骨架（chatbot 档位没有"执行前自检"可借用，只能给这个） */
function emptyReportFor(instanceId: string, role: NodeRoleName): NodeReport {
  return {
    instanceId,
    role,
    platform: platform(),
    hostPlatform: '',
    needsRelay: false,
    ready: false,
    items: [],
    checkedAt: Date.now(),
  }
}

async function finishBootstrap(
  options: {
    role: NodeRoleName
    instanceId: string
    progress?: NodeBootstrapProgress
    /** 执行**前**那份自检（复检失败时借用它的骨架；chatbot 档位不传） */
    inspectedBefore?: NodeReport
  },
  steps: NodeBootstrapStep[],
): Promise<NodeBootstrapResult> {
  invalidateNodeReadiness()
  options.progress?.begin('recheck', '正在跑完整自检（结论会回填到这里）')
  options.progress?.stage?.('recheck')
  let report: NodeReport
  try {
    report = await inspectNode(options)
  } catch (error) {
    // 自检本身炸了也要**收尾**：否则任务快照停在"重新自检 = 待执行"，页面永远看着像卡住。
    // 报告用**执行前**那份自检的骨架（`before` 一定存在：`bootstrapNode` 第一步就是它），并把
    // 每一项都标成未就绪 —— 与其编一份"看起来就绪"的，不如如实说"复检失败"。
    const detail = `自检失败：${error instanceof Error ? error.message : String(error)}`
    options.progress?.end('recheck', { ok: false, detail })
    const skeleton = options.inspectedBefore ?? emptyReportFor(options.instanceId, options.role)
    const fallback: NodeReport = {
      ...skeleton,
      ready: false,
      items: skeleton.items.map((item) => (item.required ? { ...item, ok: false, detail: '复检失败，结论未知' } : item)),
      checkedAt: Date.now(),
    }
    return { instanceId: options.instanceId, ok: false, steps: [...steps, { step: 'recheck', ok: false, detail }], report: fallback }
  }
  const ok = steps.every((step) => step.ok) && report.ready
  options.progress?.end('recheck', {
    ok: report.ready,
    detail: report.ready
      ? '全部必需项就绪'
      : `仍有未就绪项：${report.items
          .filter((item) => item.required && !item.ok)
          .map((item) => item.label)
          .join('、')}`,
  })
  return { instanceId: options.instanceId, ok, steps, report }
}

/**
 * 进度回调（2026-10-20：管理页要能看到**步骤**，而不只是一根假进度条）。
 *
 * 刻意做成**同步 void 回调**：`nodeBootstrap` 是纯执行单元，不认识 Redis / HTTP；
 * 谁订阅谁负责节流（见 `services/nodeBootstrapJob.service.ts`）。
 */
export interface NodeBootstrapProgress {
  /** 开始一个步骤（`key` 与 `NodeCheckKey` / 新增的 `dockerCli` / `recheck` 对齐）；`detail` 是"正在做什么" */
  begin(key: string, detail: string): void
  /** 步骤内的一条进展（拉镜像 / 起容器…） */
  note(key: string, event: string): void
  /** 结束一个步骤 */
  end(key: string, outcome: { ok: boolean; detail: string; skipped?: boolean }): void
  /** 整个流程的阶段切换（仅用于任务快照的 `stage` 文案，可选） */
  stage?(stage: string): void
}

export async function bootstrapNode(options: {
  role: NodeRoleName
  instanceId: string
  progress?: NodeBootstrapProgress
  /** 内部用：第一次自检的结论（复检失败时借用骨架），调用方不用传 */
  inspectedBefore?: NodeReport
}): Promise<NodeBootstrapResult> {
  const steps: NodeBootstrapStep[] = []
  const progress = options.progress
  const push = (step: string, ok: boolean, detail: string, skipped = false): void => {
    steps.push({ step, ok, detail, skipped })
  }

  if (options.role === 'chatbot') {
    progress?.begin('nodeRole', 'chatbot 档位：只需要后端，无需自举')
    progress?.end('nodeRole', { ok: true, detail: 'chatbot 档位：只需要后端，无需自举', skipped: true })
    push('nodeRole', true, 'chatbot 档位：只需要后端，无需自举', true)
    progress?.begin('recheck', '正在跑完整自检')
    progress?.stage?.('recheck')
    const report = await inspectNode(options)
    progress?.end('recheck', { ok: report.ready, detail: report.ready ? '全部必需项就绪' : '仍有未就绪项' })
    return { instanceId: options.instanceId, ok: true, steps, report }
  }

  // ★ **只修未就绪的项**（2026-10-19 用户反馈）：健康的项一律跳过 —— 不重建 egress / relay 容器，
  //   不重复拉镜像。判据来自**本次**自检（与页面看到的是同一份结论）。
  progress?.stage?.('inspect')
  const before = await inspectNode(options)
  options.inspectedBefore = before
  const failing = new Set(before.items.filter((item) => item.required && !item.ok).map((item) => item.key))

  if (failing.has('docker')) {
    progress?.begin('docker', '正在连接 Docker daemon')
    try {
      await getDocker().version()
      progress?.end('docker', { ok: true, detail: '可连接（自检时不可达，本次已恢复）' })
      push('docker', true, '可连接（自检时不可达，本次已恢复）')
    } catch (error) {
      const detail = `连不上 Docker：${error instanceof Error ? error.message : String(error)}`
      progress?.end('docker', { ok: false, detail })
      push('docker', false, detail)
    }
  } else {
    progress?.end('docker', { ok: true, detail: '跳过（已就绪）', skipped: true })
    push('docker', true, '跳过（已就绪）', true)
  }

  // ① 沙箱网
  if (failing.has('sandboxNetwork')) {
    if (!failing.has('docker') || steps.some((step) => step.step === 'docker' && step.ok)) {
      progress?.begin('sandboxNetwork', '正在创建 / 校验沙箱网 doubulea-sandbox')
      try {
        const net = await ensureSandboxNetwork()
        const detail = `${net.name}（gateway ${net.gateway}${net.created ? '，本次创建' : '，已存在'}）`
        progress?.end('sandboxNetwork', { ok: true, detail })
        push('sandboxNetwork', true, detail)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        progress?.end('sandboxNetwork', { ok: false, detail })
        push('sandboxNetwork', false, detail)
      }
    } else {
      progress?.end('sandboxNetwork', { ok: false, detail: 'Docker 不可达 ⇒ 跳过' })
      push('sandboxNetwork', false, 'Docker 不可达 ⇒ 跳过')
    }
  } else {
    progress?.end('sandboxNetwork', { ok: true, detail: '跳过（已就绪）', skipped: true })
    push('sandboxNetwork', true, '跳过（已就绪）', true)
  }

  // ② docker-cli 侧车（镜像缺了就拉；容器本身仍由 compose 负责 —— 它带命名卷，就地起易与 compose 定义分叉）
  //
  // ⚠️ **本机直跑（`pnpm dev`）不需要侧车**：那是"容器里没有 docker CLI，靠一个 CLI 容器把二进制
  //   挂进命名卷"的替身方案。宿主上 CLI 本来就在 PATH（或 `SANDBOX_DOCKER_BIN`）⇒ 这一项直接判 ok，
  //   否则页面会在一个健康的 dev 环境里一直显示"侧车未运行"的红项。
  const dockerUsable = !failing.has('docker') || steps.some((step) => step.step === 'docker' && step.ok)
  if (!dockerUsable) {
    // Docker 都连不上 ⇒ 这一项**什么都没查**：标"失败"会让人以为侧车本身有问题（实际是连不上 Docker）
    const detail = 'Docker 不可达 ⇒ 无法检查（先修 Docker）'
    progress?.end('dockerCli', { ok: false, detail })
    push('dockerCli', false, detail)
  } else if (!isContainerMode()) {
    const detail = '不需要（后端直接跑在宿主上，docker CLI 就在 PATH）'
    progress?.end('dockerCli', { ok: true, detail, skipped: true })
    push('dockerCli', true, detail, true)
  } else {
    progress?.begin('dockerCli', '正在检查 docker-cli 侧车')
    const cliOk = await containerRunning(DOCKER_HOST_NAME)
    const needsCli = await canBuildSandboxRuntime()
    if (needsCli && !cliOk) {
      const cliImage = (process.env.DOCKER_CLI_IMAGE ?? 'docker:27-cli').trim()
      progress?.note('dockerCli', `本地镜像里没有 ${cliImage}，开始拉取`)
      const pulled = await ensureInfraImages([cliImage])
      for (const item of pulled) progress?.note('dockerCli', item.detail)
      if (pulled.some((item) => !item.ok)) {
        const detail = pulled.map((item) => item.detail).join('；')
        progress?.end('dockerCli', { ok: false, detail })
        push('dockerCli', false, detail)
      } else {
        const detail = `镜像 ${cliImage} 已就绪，但侧车未运行 —— 请用 compose 起 backend（会自动带出）`
        progress?.end('dockerCli', { ok: false, detail })
        push('dockerCli', false, detail)
      }
    } else {
      const okCli = cliOk || !needsCli
      const detail = cliOk ? (needsCli ? '运行中（可按需构建环境）' : '运行中') : '未运行'
      progress?.end('dockerCli', { ok: okCli, detail, skipped: cliOk })
      push('dockerCli', okCli, detail, cliOk)
    }
  }

  // ③ toolkit：只有缺了才动（先拉取、拉不到再构建）
  if (failing.has('toolkitImage')) {
    if (!dockerUsable) {
      // Docker 不可达时拉/建镜像必然失败，且报错会是长串 docker 输出 —— 如实说"没法做"，别制造噪音。
      // relay 由下面统一处理（它只看平台与运行状态，不需要 Docker 健康）。
      const detail = 'Docker 不可达 ⇒ 无法准备镜像（先修 Docker）'
      progress?.end('toolkitImage', { ok: false, detail })
      push('toolkitImage', false, detail)
    } else {
      progress?.begin('toolkitImage', '正在准备沙箱镜像（先拉取，失败再构建 —— 构建可能较久）')
      const toolkitStep = await ensureToolkitImage((event) => progress?.note('toolkitImage', event))
      progress?.end('toolkitImage', toolkitStep)
      push('toolkitImage', toolkitStep.ok, toolkitStep.detail)
    }
  } else {
    progress?.end('toolkitImage', { ok: true, detail: '跳过（已就绪）', skipped: true })
    push('toolkitImage', true, '跳过（已就绪）', true)
  }

  // ④ egress：只有未运行 / 没接上沙箱网才重建（镜像缺了先拉 —— 初始化允许联网）
  if (!dockerUsable) {
    progress?.end('egress', { ok: false, detail: 'Docker 不可达 ⇒ 跳过' })
    push('egress', false, 'Docker 不可达 ⇒ 跳过')
  } else if (failing.has('egress') || failing.has('egressReachable')) {
    const why = failing.has('egress') ? '未运行' : '未接入沙箱网'
    progress?.begin('egress', `出口代理${why}，正在准备镜像与脚本`)
    const egressImage = (process.env.EGRESS_IMAGE ?? 'node:22-bookworm-slim').trim()
    progress?.note('egress', `检查镜像 ${egressImage}`)
    const pulled = await ensureInfraImages([egressImage])
    for (const item of pulled) progress?.note('egress', item.detail)
    const script = bootstrapScript('egress-up.sh', 'DOUBULEA_EGRESS_SCRIPT')
    if (pulled.some((item) => !item.ok)) {
      const detail = pulled.map((item) => item.detail).join('；')
      progress?.end('egress', { ok: false, detail })
      push('egress', false, detail)
    } else if (!existsSync(script)) {
      const detail = `找不到 ${script}（容器里没有 infra/scripts，本机也没有仓库源码）—— 请在宿主执行 bash infra/scripts/egress-up.sh --allow-all`
      progress?.end('egress', { ok: false, detail })
      push('egress', false, detail)
    } else {
      const infra = await materializeInfraDir(script)
      progress?.note('egress', `执行 ${script} --allow-all`)
      // ⚠️ `bootstrapCwd()` / `withDockerEnv()` 是**本机 dev 兼容**的两处：前者避免 `cwd=/app`
      //   不存在导致的 `ENOENT spawn bash`，后者把 docker 二进制目录补进子进程 PATH（脚本里
      //   `command -v docker` 才找得到）。容器形态下两者都退化成原来的行为。
      const scriptEnv =
        infra === undefined
          ? {}
          : { DOUBULEA_HOST_INFRA_DIR: infra.hostDir, DOUBULEA_MOUNT_VOLUME: INFRA_VOLUME }
      const runEgress = (): Promise<unknown> =>
        execFileAsync('bash', [script, '--allow-all'], {
          timeout: 300_000,
          cwd: bootstrapCwd(),
          env: withDockerEnv({ ...process.env, ...scriptEnv }),
        })
      try {
        await runEgress()
        const detail = `（${why}）已按 ${script} 拉起并接网`
        progress?.end('egress', { ok: true, detail })
        push('egress', true, detail)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 已知症状：卷挂载点 `root:root 755` ⇒ 脚本写策略 `Permission denied`。放权后重试一次。
        if (/Permission denied|策略文件写不进去/u.test(message)) {
          progress?.note('egress', '策略文件写入被拒 —— 修正策略卷权限后重试')
          const fixed = await ensureSharedVolumesWritable(['doubulea-egress-policy'])
          if (fixed.length > 0) {
            try {
              await runEgress()
              const detail = `（${why}）已按 ${script} 拉起并接网（先修正了策略卷权限）`
              progress?.end('egress', { ok: true, detail })
              push('egress', true, detail)
              return finishBootstrap(options, steps)
            } catch (retryError) {
              const detail = `egress-up.sh 重试仍失败：${retryError instanceof Error ? retryError.message : String(retryError)}`
              progress?.end('egress', { ok: false, detail })
              push('egress', false, detail)
              return finishBootstrap(options, steps)
            }
          }
        }
        const detail = `egress-up.sh 失败：${message}`
        progress?.end('egress', { ok: false, detail })
        push('egress', false, detail)
      }
    }
  } else {
    progress?.end('egress', { ok: true, detail: '跳过（运行中且已接网）', skipped: true })
    push('egress', true, '跳过（运行中且已接网）', true)
  }

  // ⑤ relay（仅 VM 平台；且只有未运行才起）
  const hostPlatform = await detectHostPlatform()
  if (!needsRelayFor(hostPlatform)) {
    progress?.end('relay', { ok: true, detail: '跳过（本平台不需要）', skipped: true })
    push('relay', true, '跳过（本平台不需要）', true)
  } else if (!failing.has('relay')) {
    progress?.end('relay', { ok: true, detail: '跳过（运行中）', skipped: true })
    push('relay', true, '跳过（运行中）', true)
  } else {
    progress?.begin('relay', '正在拉起出口② 中转容器')
    const relayImage = (process.env.RELAY_IMAGE ?? 'node:22-bookworm-slim').trim()
    progress?.note('relay', `检查镜像 ${relayImage}`)
    const pulled = await ensureInfraImages([relayImage])
    for (const item of pulled) progress?.note('relay', item.detail)
    const relayScript = bootstrapScript('relay-up.sh', 'DOUBULEA_RELAY_SCRIPT')
    if (pulled.some((item) => !item.ok)) {
      const detail = pulled.map((item) => item.detail).join('；')
      progress?.end('relay', { ok: false, detail })
      push('relay', false, detail)
    } else if (existsSync(relayScript)) {
      try {
        const infra = await materializeInfraDir(relayScript)
        progress?.note('relay', `执行 ${relayScript}`)
        await execFileAsync('bash', [relayScript], {
          timeout: 120_000,
          cwd: bootstrapCwd(),
          env: withDockerEnv(
            infra === undefined
              ? process.env
              : { ...process.env, DOUBULEA_HOST_INFRA_DIR: infra.hostDir, DOUBULEA_MOUNT_VOLUME: INFRA_VOLUME },
          ),
        })
        const detail = `已按 ${relayScript} 拉起`
        progress?.end('relay', { ok: true, detail })
        push('relay', true, detail)
      } catch (error) {
        const detail = `relay-up.sh 失败：${error instanceof Error ? error.message : String(error)}`
        progress?.end('relay', { ok: false, detail })
        push('relay', false, detail)
      }
    } else {
      const detail = `找不到 ${relayScript} —— 请在宿主执行 bash infra/scripts/relay-up.sh`
      progress?.end('relay', { ok: false, detail })
      push('relay', false, detail)
    }
  }

  return finishBootstrap(options, steps)
}
