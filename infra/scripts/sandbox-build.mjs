#!/usr/bin/env node
/**
 * sandbox-build.mjs —— 沙箱镜像的**唯一构建入口**（P0-3-1）
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §五（三层镜像 + toolkit 构建期预烘焙）
 *
 * ── 它解决的是什么问题 ────────────────────────────────────────────────
 * 镜像有两个（base / toolkit）、版本值有三个（Node 基线、pi 版本、两条层版本号），
 * 若让 `docker build` 的 `-t`、`--build-arg`、`infra/.env` 的 `SANDBOX_IMAGE*` 各写各的，
 * 必然出现"改一处漏两处"——而症状是**静默**的：构建成功了，运行时起的还是上一版镜像。
 * ⇒ 所有版本值只从 `infra/sandbox/versions.mjs` 读（唯一事实来源，`06` §六 第 4 条同款纪律），
 *   Dockerfile 里刻意**不给**这些 ARG 有意义的默认值：手敲 `docker build` 会在第一道断言上
 *   大声失败，而不是默默烤出一个"参数为空"的镜像。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   pnpm sandbox:build                 构建 base → toolkit，末尾打印要写进 infra/.env 的两行
 *   pnpm sandbox:build -- --no-cache   不用 layer cache（改了 apt 源/想彻底重来时）
 *   pnpm sandbox:build -- --base-only  只构建 base（改 pi 版本时最快的一圈）
 *   pnpm sandbox:build -- --toolkit-only  只重建 toolkit（加了一个 python 库时）
 *   pnpm sandbox:build -- --registry https://registry.npmmirror.com
 *   pnpm sandbox:build -- --dry-run    只打印将要执行的 docker 命令
 *   pnpm sandbox:build -- --prune      构建后清掉**旧的** sandbox 镜像 tag / 悬空镜像 /
 *                                       已停的 sandbox 容器与无主卷，并回收 24h 前的构建缓存
 *                                       （保护：本次构建的两个 tag + `infra/.env` 正在用的 tag）
 *
 * ── 两个本机实况（都不是猜的）─────────────────────────────────────────
 *  ① **`docker` 可能不在非交互 shell 的 PATH 里**（本机是 OrbStack 托管）⇒ 本脚本自己找
 *     可执行文件，并把它所在目录加进子进程 PATH。可用 `DOCKER_BIN=/path/to/docker` 覆写。
 *  ② **光找到 `docker` 还不够**：拉取私有镜像/查凭据时 CLI 会去 PATH 里找
 *     `docker-credential-osxkeychain`。实测（P0-3-1）：只用 `/usr/local/bin/docker` 而 PATH 里
 *     没有 `~/.orbstack/bin` 时，报的是 `error getting credentials - err: exec:
 *     "docker-credential-osxkeychain": executable file not found in $PATH` —— 一个与"构建失败"
 *     毫不相干的报错。⇒ 这里把常见凭据助手目录一并补进子进程 PATH。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BASE_IMAGE_NAME,
  DEFAULT_NPM_REGISTRY,
  NODE_IMAGE,
  PI_PACKAGE,
  PI_VERSION,
  RUNTIME_IMAGE_NAME,
  SANDBOX_RUNTIMES,
  TOOLKIT_IMAGE_NAME,
  baseImageRef,
  runtimeImageRef,
  toolkitImageRef,
  variantToComponentsArg,
} from '../sandbox/versions.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const INFRA_DIR = resolve(SCRIPT_DIR, '..')
const REPO_ROOT = resolve(INFRA_DIR, '..')
const SANDBOX_DIR = join(INFRA_DIR, 'sandbox')

// ── 参数解析 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const registryIndex = argv.indexOf('--registry')
// registry 优先级：`--registry` > `SANDBOX_NPM_REGISTRY` 环境变量 > `versions.mjs` 的默认值。
// 为什么给一个环境变量：本机（内网）**容器直连 registry.npmjs.org 不通**（见 versions.mjs 的注释），
// 而"每次都记得加 --registry"是靠不住的 —— 环境变量可以直接写在 shell profile 里。
const npmRegistry =
  registryIndex >= 0 ? argv[registryIndex + 1] : (process.env.SANDBOX_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY)

const aptMirrorIndex = argv.indexOf('--apt-mirror')
// Debian 源主机名优先级：`--apt-mirror` > `SANDBOX_APT_MIRROR` > 自动（换了 npmmirror 就用清华源）> ''。
// ⚠️ 本机实测：`deb.debian.org` 只 ~0.4MB/s，`mirrors.tuna.tsinghua.edu.cn` ~6MB/s（十几倍）
//    —— 两个 Dockerfile 的 apt 步骤占了沙箱构建的大头，这条是本机提速最有效的一处。
// ⚠️ 默认值仍**不写死**国内源（CI / 海外环境用官方是对的）；"本机内网"这个事实由调用方给。
// ⚠️ 显式传空串（`--apt-mirror ''` 或 `SANDBOX_APT_MIRROR=`）**就是**用官方源（`??` 不会把空串当缺省）。
const explicitAptMirror = aptMirrorIndex >= 0 ? argv[aptMirrorIndex + 1] : process.env.SANDBOX_APT_MIRROR
const aptMirror =
  explicitAptMirror ?? (npmRegistry.includes('npmmirror') ? 'mirrors.tuna.tsinghua.edu.cn' : '')

// Node 发行站（装 node 18/20 时用；见 `runtime/install-node-version.sh`）。
// 优先级：`SANDBOX_NODE_DIST_MIRROR` 环境变量 > 按 npm 源推断 > 官方。
// 换源的理由同 apt/npm：本机内网直连 nodejs.org 可能慢/不通，而 npmmirror 有 node 二进制镜像。
const nodeDistMirror =
  process.env.SANDBOX_NODE_DIST_MIRROR ??
  (npmRegistry.includes('npmmirror')
    ? 'https://registry.npmmirror.com/-/binary/node'
    : 'https://nodejs.org/dist')

// Rust 发行站（装 rust 时用；见 `runtime/install-rust-version.sh`）。
// ⚠️ 官方 `static.rust-lang.org` 在本机实测被限速到 **几十 KB/s**（rust 包 ~345MB ⇒ 会挂很久），
//    而 USTC 镜像 ~2.3MB/s ⇒ 内网构建务必换镜像。优先级：`SANDBOX_RUST_DIST_MIRROR` > 按 npm 源推断 > 官方。
const rustDistMirror =
  process.env.SANDBOX_RUST_DIST_MIRROR ??
  (npmRegistry.includes('npmmirror')
    ? 'https://mirrors.ustc.edu.cn/rust-static/dist'
    : 'https://static.rust-lang.org/dist')

if (flags.has('--help') || flags.has('-h')) {
  console.log(
    '用法: pnpm sandbox:build [-- --no-cache|--base-only|--toolkit-only|--runtime <name[,name]>|--registry <url>|--apt-mirror <host>|--dry-run|--prune]\n' +
      '环境变量: SANDBOX_NPM_REGISTRY=<url>   （等价于 --registry；本机需要换源，见 README）\n' +
      '          SANDBOX_APT_MIRROR=<host>    （等价于 --apt-mirror；只换 Debian 源主机名，留空 = 官方）',
  )
  process.exit(0)
}
if (registryIndex >= 0 && (npmRegistry === undefined || npmRegistry.startsWith('--'))) {
  console.error('--registry 后面要跟一个 URL')
  process.exit(2)
}
if (aptMirrorIndex >= 0 && (explicitAptMirror === undefined || explicitAptMirror.startsWith('--'))) {
  console.error('--apt-mirror 后面要跟一个主机名（如 mirrors.tuna.tsinghua.edu.cn），或用空串走官方源')
  process.exit(2)
}

const noCache = flags.has('--no-cache')
const dryRun = flags.has('--dry-run')
const baseOnly = flags.has('--base-only')
const toolkitOnly = flags.has('--toolkit-only')
const doPrune = flags.has('--prune')
// P1-17a：`--runtime` **可多选**（重复给、或逗号分隔，如 `--runtime python --runtime node` /
// `--runtime python,node`）；不给则**全建**。常用于"只重建改过的那几栈"（最短的一圈）。
const requestedRuntimes = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--runtime') continue
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error('--runtime 后面要跟变体名（语言+版本，可逗号分隔 / 重复给）：如 node20-python3.12')
    process.exit(2)
  }
  for (const piece of value.split(',')) {
    const name = piece.trim()
    if (name !== '') requestedRuntimes.push(name)
  }
  i += 1
}
// `--runtime` 接受**任意可解析的变体 id**（2026-10-15 起不再枚举版本）—— 用构建侧的解析器试一下即可。
for (const name of requestedRuntimes) {
  try {
    variantToComponentsArg(name)
  } catch (error) {
    console.error(`未知的 --runtime ${name}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
// 去重 + 保持传入顺序；空 = 全部
const selectedRuntimes = [...new Set(requestedRuntimes)]
if (selectedRuntimes.length > 0 && baseOnly) {
  console.error('--base-only 时不构建运行时镜像（运行时 FROM toolkit）⇒ 去掉 --runtime 或 --base-only')
  process.exit(2)
}
if (baseOnly && toolkitOnly) {
  console.error('--base-only 与 --toolkit-only 不能同时给（那就是"都构建"，去掉参数即可）')
  process.exit(2)
}

// ── docker 可执行文件定位（见文件头「两个本机实况」）─────────────────────
function resolveDockerBin() {
  const override = process.env.DOCKER_BIN
  if (override) {
    if (!existsSync(override)) {
      console.error(`DOCKER_BIN 指向的文件不存在：${override}`)
      process.exit(2)
    }
    return override
  }
  const fromPath = spawnSync('docker', ['--version'], { stdio: 'ignore' })
  if (!fromPath.error && fromPath.status === 0) return 'docker'
  const candidates = [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    join(homedir(), '.orbstack/bin/docker'),
    '/Applications/OrbStack.app/Contents/MacOS/xbin/docker',
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error(
      '找不到 docker 可执行文件。请启动 Docker Desktop / OrbStack，或用 DOCKER_BIN=/path/to/docker 指定。',
    )
    process.exit(2)
  }
  return found
}

const dockerBin = resolveDockerBin()

/** 子进程 PATH：补上 docker 所在目录与常见凭据助手目录（含 OrbStack 的） */
const childEnv = {
  ...process.env,
  PATH: [dirname(dockerBin), join(homedir(), '.orbstack/bin'), process.env.PATH ?? ''].join(':'),
}

const C = {
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  dim: '\u001b[90m',
  red: '\u001b[31m',
  x: '\u001b[0m',
}
const step = (text) => console.log(`\n${C.cyan}== ${text} ==${C.x}`)
const ok = (text) => console.log(`  ${C.green}[ok]${C.x} ${text}`)
const info = (text) => console.log(`  ${C.dim}${text}${C.x}`)

function run(args, label) {
  console.log(`  ${C.dim}$ ${dockerBin} ${args.join(' ')}${C.x}`)
  if (dryRun) return 0
  const result = spawnSync(dockerBin, args, { stdio: 'inherit', env: childEnv })
  if (result.error) {
    console.error(`${C.red}[fail]${C.x} ${label}：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`${C.red}[fail]${C.x} ${label}（退出码 ${result.status}）`)
    process.exit(result.status ?? 1)
  }
  return 0
}

/** 跑一条 docker 命令并**收回 stdout**（用于"列出要删的东西"）；失败回 `[]`，不抛 */
function capture(args) {
  const result = spawnSync(dockerBin, args, { encoding: 'utf8', env: childEnv })
  if (result.error || result.status !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 跑一条 docker 命令但**忽略失败**（回收路径：删不掉只该 warn，不该让整批失败） */
function runBestEffort(args, label) {
  console.log(`  ${C.dim}$ ${dockerBin} ${args.join(' ')}${C.x}`)
  if (dryRun) return
  const result = spawnSync(dockerBin, args, { stdio: 'inherit', env: childEnv })
  if (result.error || result.status !== 0) {
    console.log(`  ${C.yellow}[warn]${C.x} ${label}（不影响构建）`)
  }
}

// ── 0. 前置检查 ──────────────────────────────────────────────────────────
step('Preflight')
const serverVersion = spawnSync(dockerBin, ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8',
  env: childEnv,
})
if (serverVersion.status !== 0) {
  console.error(`${C.red}[fail]${C.x} Docker engine 不可达。请先启动 Docker Desktop / OrbStack。`)
  console.error(serverVersion.stderr ?? '')
  process.exit(1)
}
ok(`Docker engine 可达（server ${serverVersion.stdout.trim()}）`)
info(`docker：${dockerBin}`)
info(`Node 基线：${NODE_IMAGE} ｜ pi：${PI_PACKAGE}@${PI_VERSION}`)
info(`npm 源：${npmRegistry}`)
if (npmRegistry !== DEFAULT_NPM_REGISTRY) {
  info('（已换源：本机容器直连 registry.npmjs.org 不通，见 versions.mjs 的注释）')
}
info(`Debian 源：${aptMirror === '' ? '官方 deb.debian.org' : aptMirror}`)
if (aptMirror !== '') {
  info('（换源：本机实测官方源只 ~0.4MB/s，清华源 ~6MB/s —— 两个 Dockerfile 的 apt 步骤是大头）')
}
info(`Node 发行站：${nodeDistMirror}`)
info(`Rust 发行站：${rustDistMirror}`)
info(`base 标签：${baseImageRef()} ｜ toolkit 标签：${toolkitImageRef()}`)
info(`运行时标签：${SANDBOX_RUNTIMES.map((r) => runtimeImageRef(r)).join('、')}`)

// ── 1. base 层 ───────────────────────────────────────────────────────────
if (!toolkitOnly) {
  step('构建 base 层（Node + pin 版 pi + 桥扩展 + 非 root 用户 + 只读层里的 pi 配置）')
  const args = [
    'build',
    '-f',
    join(SANDBOX_DIR, 'base', 'Dockerfile'),
    '-t',
    baseImageRef(),
    '--build-arg',
    `NODE_IMAGE=${NODE_IMAGE}`,
    '--build-arg',
    `PI_PACKAGE=${PI_PACKAGE}`,
    '--build-arg',
    `PI_VERSION=${PI_VERSION}`,
    '--build-arg',
    `NPM_REGISTRY=${npmRegistry}`,
    '--build-arg',
    `APT_MIRROR=${aptMirror}`,
  ]
  if (noCache) args.push('--no-cache')
  args.push(join(SANDBOX_DIR, 'base'))
  run(args, 'base 层构建')
  ok(`base 层完成 → ${baseImageRef()}`)
} else {
  step('构建 base 层')
  info('已跳过（--toolkit-only）')
}

// ── 2. toolkit 层 ────────────────────────────────────────────────────────
if (!baseOnly) {
  step('构建 toolkit 层（python3 + pandas/numpy/openpyxl + jq/git/ripgrep；末步跑依赖自检）')
  const args = [
    'build',
    '-f',
    join(SANDBOX_DIR, 'toolkit', 'Dockerfile'),
    '-t',
    toolkitImageRef(),
    '--build-arg',
    `BASE_IMAGE=${baseImageRef()}`,
    '--build-arg',
    `APT_MIRROR=${aptMirror}`,
  ]
  if (noCache) args.push('--no-cache')
  args.push(join(SANDBOX_DIR, 'toolkit'))
  run(args, 'toolkit 层构建')
  ok(`toolkit 层完成 → ${toolkitImageRef()}`)
} else {
  step('构建 toolkit 层')
  info('已跳过（--base-only）')
}

// ── 2.4 运行时层（P1-17a）─────────────────────────────────────────────────
// 一变体一份镜像（`FROM toolkit`），只装语言运行时、不装依赖。运行时**不写进 .env** —— 后端扫
// 本机镜像（`SANDBOX_RUNTIME_REPO` 前缀 + tag 约定 `<repo>:<id>-v<层版本>`）得到可选运行时。
if (!baseOnly) {
  const runtimesToBuild = selectedRuntimes.length > 0 ? selectedRuntimes : SANDBOX_RUNTIMES
  step(`构建运行时层（${runtimesToBuild.join('/')}；只装运行时、不装依赖）`)
  for (const runtime of runtimesToBuild) {
    const args = [
      'build',
      '-f',
      join(SANDBOX_DIR, 'runtime', 'Dockerfile'),
      '-t',
      runtimeImageRef(runtime),
      '--build-arg',
      `BASE_IMAGE=${toolkitImageRef()}`,
      '--build-arg',
      `COMPONENTS=${variantToComponentsArg(runtime)}`,
      '--build-arg',
      `APT_MIRROR=${aptMirror}`,
      '--build-arg',
      `NODE_DIST_MIRROR=${nodeDistMirror}`,
      '--build-arg',
      `RUST_DIST_MIRROR=${rustDistMirror}`,
    ]
    if (noCache) args.push('--no-cache')
    args.push(join(SANDBOX_DIR, 'runtime'))
    run(args, `运行时层构建（${runtime}）`)
    ok(`运行时层完成（${runtime}）→ ${runtimeImageRef(runtime)}`)
  }
} else {
  step('构建运行时层')
  info('已跳过（--base-only）')
}

// ── 2.5 回收（--prune）────────────────────────────────────────────────────
// Docker **从不自动清理**：新 tag 建好后，旧 tag 的镜像、悬空镜像、已停容器、无主卷、以及
// **构建缓存**（本机曾累积到 ~30GB）都只会越来越多。这里把"旧 sandbox 版本"收一遍。
//
// ★ 三条安全约束（都不许省）：
//   ① **保护正在用的 tag** —— 本次构建的两个 + `infra/.env` 里 `SANDBOX_IMAGE*` 指向的；
//      ⚠️ 若 `.env` 还停在上一版（用户还没改），那一版**不会**被删。
//   ② **只碰 `doubulea/sandbox-*` 与带我们 label 的东西** —— 本机通常还跑着别的项目，
//      `docker image prune -a` / 无过滤的 `container prune` 会误伤它们（本机实测有别的仓库镜像）。
//   ③ 回收路径**一律 best-effort**（`runBestEffort`）：正在被运行容器占用的 tag 删不掉是正常的，
//      不该让整批构建失败。
if (doPrune && !dryRun) {
  step('回收（--prune）：旧 sandbox 镜像 tag / 悬空镜像 / 已停容器 / 旧构建缓存')

  const keep = new Set()
  if (!toolkitOnly) keep.add(baseImageRef())
  if (!baseOnly) keep.add(toolkitImageRef())
  if (!baseOnly) for (const runtime of SANDBOX_RUNTIMES) keep.add(runtimeImageRef(runtime))
  const envFile = join(INFRA_DIR, '.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*(SANDBOX_IMAGE|SANDBOX_IMAGE_BASE)\s*=\s*(.+?)\s*$/.exec(line)
      if (m) keep.add(m[2])
    }
  }
  info(`保护中的 tag：${[...keep].join('、') || '（无）'}`)

  // ① 删掉 `doubulea/sandbox-base:*` / `doubulea/sandbox-toolkit:*` / `doubulea/sandbox-runtime:*`
  //    里**不在保护名单**的 tag
  for (const repo of [BASE_IMAGE_NAME, TOOLKIT_IMAGE_NAME, RUNTIME_IMAGE_NAME]) {
    for (const ref of capture(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repo])) {
      if (keep.has(ref)) {
        info(`保留 ${ref}（正在用 / 本次构建）`)
        continue
      }
      runBestEffort(['image', 'rm', ref], `删除旧 tag ${ref}`)
    }
  }

  // ② 悬空镜像（被顶掉、没有 tag 的层）
  runBestEffort(['image', 'prune', '-f'], '清悬空镜像')

  // ③ 已停的 **sandbox** 容器（按 label 过滤 —— 绝不碰别的项目）
  const stopped = capture(['ps', '-a', '--filter', 'label=doubulea.role=sandbox', '--filter', 'status=exited', '-q'])
  if (stopped.length > 0) runBestEffort(['rm', ...stopped], '清已停 sandbox 容器')
  else info('没有已停的 sandbox 容器')

  // ④ 无主的 **sandbox** 工作卷（同样按 label 过滤；活会话的卷是"在用"，不会被动）
  runBestEffort(['volume', 'prune', '-f', '--filter', 'label=doubulea.role=sandbox'], '清无主 sandbox 卷')

  // ⑤ 构建缓存：只回收 **24h 之前**的（刚构建出来的层留着，下次改一行仍能命中缓存）
  runBestEffort(['builder', 'prune', '-f', '--filter', 'until=24h'], '回收 24h 前的构建缓存')
}

// ── 3. 汇总：把"该写进 infra/.env 的两行"直接给出来 ────────────────────
step('Done')
if (!dryRun) {
  const sizes = spawnSync(
    dockerBin,
    ['images', '--format', '{{.Repository}}:{{.Tag}}  {{.Size}}', baseImageRef(), toolkitImageRef()],
    { encoding: 'utf8', env: childEnv },
  )
  if (sizes.status === 0) {
    for (const line of sizes.stdout.trim().split('\n')) {
      if (line.length > 0) info(line)
    }
  }
}
// 本次构建的运行时变体（`--runtime` 子集时只列这几栈；否则全部）
const builtRuntimes = baseOnly ? [] : selectedRuntimes.length > 0 ? selectedRuntimes : SANDBOX_RUNTIMES
console.log(`
  把下面两行写进 infra/.env（.env 已被 gitignore，模板见 infra/.env.example）：
${C.yellow}    SANDBOX_IMAGE_BASE=${baseImageRef()}${C.x}
${C.yellow}    SANDBOX_IMAGE=${toolkitImageRef()}${C.x}
${C.yellow}    SANDBOX_RUNTIME_REPO=${RUNTIME_IMAGE_NAME}${C.x}

  ⚠️ SANDBOX_IMAGE 是**回退镜像**（toolkit 层）：会话的 \`runtime\` 找不到对应运行时镜像时用它。
  ⚠️ **运行时不再写进 .env**：后端启动后**扫本机镜像**（\`SANDBOX_RUNTIME_REPO\` 前缀 + tag 约定
     \`<repo>:<变体>-v<层版本>\`）得到"有哪些运行时"，前端据它渲染 —— **有就提供、没有就不提供**。
     ⇒ 本次构建的镜像会**自动**出现在会话设置里，无需改配置。
${builtRuntimes.length > 0 ? `  ⚠️ 本次构建的运行时：${builtRuntimes.map((r) => runtimeImageRef(r)).join('、')}\n` : ''}
  ⚠️ 改了镜像内容就要同时改 infra/sandbox/versions.mjs 里的层版本号并重建
     —— 否则宿主上会同时留着新旧两个 tag，"上次构建的"与"这次跑的"就此分叉。
     ⚠️ 层版本号一升，**已在跑的容器仍用旧镜像**，要等它被回收（空闲 TTL / 引擎退出）
        或下次派活时按 \`doubulea.image\` 标签比对不符而重建 —— 见 \`sandbox/manager.ts\` 的复用判据。

  手 run 一个能说话的容器（当前 CMD 默认就是 --mode rpc；P0-3-2 起由 dockerode 接管）：
${C.dim}    ${dockerBin} run --rm -i -v doubulea-sandbox-smoke:/work ${toolkitImageRef()} --help${C.x}
  在活容器里重跑依赖自检：
${C.dim}    ${dockerBin} run --rm --entrypoint /opt/sandbox-selfcheck.sh ${toolkitImageRef()}${C.x}
`)

// 明确提醒"还不是可端测里程碑"，免得有人以为这就能派活了（`06` §五 的里程碑说明）。
info('本步只是**镜像预构建**：容器生命周期、两条网络出口、Key 注入分别属 P0-3-2/3/4；')
info('能端测的点仍是 P0-3-11（在此之前派活没有链路可走）。')
console.log(`\n${C.dim}cwd 提示：本脚本与当前工作目录无关（所有路径都从自身位置推导）；仓库根 = ${REPO_ROOT}${C.x}`)
