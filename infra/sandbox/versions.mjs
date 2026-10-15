/**
 * 沙箱镜像的**版本唯一事实来源**（P0-3-1；依据 `docs/子方案/沙箱与引擎集成.md` §五）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────
 * 三层镜像里有两层是**构建期预烘焙**的（base / toolkit，workspace 不是镜像、是每会话的卷）：
 *   · base   = Node + **pin 版本 pi** + 桥扩展 + 非 root 用户 + 只读层里的 pi 配置
 *   · toolkit = 验收与常见任务所需的**全部**依赖（python3/pandas/openpyxl/jq/git/rg…）
 * 而 `子方案③` §五 2 把「运行期零安装」定成了硬约束（egress 白名单只放行模型池 ⇒ 容器内
 * `pip install` / `npm i` **必然失败**）。⇒ 版本与标签必须有一个能被机器读到的单一来源，
 * 否则镜像标签会散落在 Dockerfile 的 ARG 默认值、`.env` 的 `SANDBOX_IMAGE*`、脚本的 `-t`
 * 三处，改一处漏两处的症状是「构建成功了，运行时起的还是上一版镜像」——不报错、只是行为不对。
 *
 * 消费方：
 *   ① `infra/scripts/sandbox-build.mjs`（唯一构建入口，负责把这些值变成 `--build-arg` 与 `-t`）
 *   ② `backend/src/config.ts` 的 `SANDBOX_IMAGE` / `SANDBOX_IMAGE_BASE` 由 `infra/.env` 提供
 *      （脚本跑完会把「该写哪两行」直接打印出来，照抄即可）
 *
 * ⚠️ **改内容就要改版本号**（§五 2：`新增依赖 = 重建 toolkit 层 + 改版本号，不是运行时补`）。
 *    两条版本线刻意分开：动 pi 版本只重建 base，加一个 python 库只重建 toolkit。
 */

/**
 * base 层的 Node 基线。
 *
 * 为什么是 22 而不是 24：pi 的 `engines` 是 `>=22.19.0`，而本仓后端也跑在 Node 22 线
 * ⇒ 沙箱与后端同一个大版本，排障时不必在两套 Node 语义之间切换。
 * （上游 `containerization.md` 的示例用 `node:24-bookworm-slim`，那是它的默认，不是我们的约束。）
 *
 * ⚠️ 这是**「大版本线」而非「摘要级」pin** —— 想做到逐字节可复现，把这里换成
 *    `node:22-bookworm-slim@sha256:<digest>`；当前刻意不做，因为那会让每次安全基线更新
 *    都变成一次手改（收益与维护成本见 §五 1 的取舍）。
 */
export const NODE_IMAGE = 'node:22-bookworm-slim'

/** pi 的 npm 包名（上游 `bin` = `pi`，`license` = MIT，见 `子方案③` §三 1） */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent'

/**
 * **pin 的 pi 版本**。这是整个 base 层里最要紧的一个数字：
 * 上游 `RPC 协议` 是官方文档化的（`docs/rpc.md`），但**没有兼容性承诺** ⇒ 版本漂移的表现会是
 * 「桥收到的事件名变了」这类**静默**故障（例如 `agent_settled` 缺席 ⇒ 这一轮永远不落库）。
 */
export const PI_VERSION = '0.87.1'

/**
 * npm registry。
 *
 * ⚠️ **本机实测（P0-3-1）：容器直连 `registry.npmjs.org` 不通** —— 症状很有欺骗性：
 *   容器能通 HTTPS（`https://deb.debian.org`、`https://www.baidu.com` 都是 200），**只有 npmjs 被拦**
 *   （`Client network socket disconnected before secure TLS connection was established`）。
 *   而 `apt-get update` 走的是**明文 HTTP**、照样成功 ⇒ 只看"apt 能装包"会得出"网络没问题"的结论，
 *   然后看着 `npm install` **挂十几分钟没有一行输出**（npm 默认 `fetch-timeout` 是 5 分钟/次、
 *   还会重试），很容易误判成"容器坏了"或"pi 包很大"。
 *
 * ⇒ 本机构建要显式换源（二选一）：
 *     pnpm sandbox:build -- --registry https://registry.npmmirror.com
 *     SANDBOX_NPM_REGISTRY=https://registry.npmmirror.com pnpm sandbox:build
 *
 * 默认值**仍然写官方的 npmjs**（它是唯一"在任何环境都正确"的默认，CI / 海外环境直接用）；
 * 这属于**本机网络实况**，不该被烤进镜像的默认值里。base/Dockerfile 里另配了
 * `--fetch-timeout` / `--fetch-retries`，好让"源不通"在 1~3 分钟内**失败**而不是挂着。
 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

export const BASE_IMAGE_NAME = 'doubulea/sandbox-base'
export const TOOLKIT_IMAGE_NAME = 'doubulea/sandbox-toolkit'
/**
 * **运行时层**镜像名（P1-17a；`docs/子方案/Code模式工作区.md` §五之二 2 · 方案 B）。
 *
 * 一层一栈：`doubulea/sandbox-runtime:<runtime>-<ver>`，全部 `FROM toolkit`。做法与理由：
 *   · **运行时是有限集合 ⇒ 预烘焙**（可白名单）；**依赖是无限集合 ⇒ 运行期拉**（P1-17b）；
 *   · 每栈一份（而不是把所有语言塞进一个层）⇒ 按会话的 `runtime` 选镜像，镜像体积不随栈爆炸
 *     （`子方案` §五之二 2 定案取 B）；
 *   · 都是 FROM toolkit ⇒ 拿到同一套 pi / 工具链 / git helper，只多一个语言运行时。
 *
 * ⚠️ **`node` = toolkit 本身**（node 由 base 的 `node:22` 提供，npm 随 node 一起来了）——
 *    刻意**不**用 apt 的 `nodejs` 覆盖它（那是 Debian 的 v18，会把镜像里的 v22 顶掉）。
 * ⚠️ 这批镜像**只装运行时、不装任何依赖**；依赖由 P1-17b 在运行期经注册表出网拉。
 */
export const RUNTIME_IMAGE_NAME = 'doubulea/sandbox-runtime'

/**
 * base 层内容版本（改 Node 基线 / pi 版本 / 桥扩展 / pi 配置 时 +1）
 *
 * ⚠️ **P0-3-4 起为 `2`**：本批新增了运行期的 `models.json` 生成器（`base/gen-models.mjs`）并在
 * `entrypoint.sh` 里加了一步调用 ⇒ 只读层内容变了。**必须改这个数**，否则宿主上会同时留着
 * `base:1` 与 `base:2`，"上次构建的"与"这次跑的"就此分叉（而症状只是"新代码没生效"）。
 *
 * ⚠️ **P0-3-9b 起为 `3`**：桥扩展不再是空壳（`base/pi-agent/extensions/mcp-bridge/index.ts`
 * 真的会去拉清单并 `registerTool`）⇒ 只读层内容又变了。不 +1 的症状最隐蔽：
 * 宿主上还留着 `toolkit:2`（里面是老的空壳扩展），于是"任务里 MCP 工具一个都不出现"，
 * 而后端日志里一条错都没有（扩展只是没注册任何工具）。
 *
 * ⚠️ **P0-3-14 起为 `4`**：桥扩展又要多注册一族**内置工具**（`knowledge_search` /
 * `list_knowledge`，经 `/api/sandbox/builtin/call`）⇒ 只读层内容再次变了。同一条纪律：
 * 不 +1 ⇒ 宿主上的 toolkit 里还是"只注册 MCP 工具"的旧扩展，于是"绑了知识库但模型不会去检索"，
 * 而后端日志里一条错都没有。
 *
 * ⚠️ **P0-3-14 后续为 `5`**：同批给 base/toolkit 的 `apt` / `npm` 步骤加了 **BuildKit 缓存挂载**
 * （`--mount=type=cache`，见两个 Dockerfile 的注释）。它改的是**构建**行为、也轻微改了只读层内容
 * （apt 的 lists 不再落镜像）⇒ 按"改内容就 +1"的纪律升到 `5`，免得宿主上留着同 tag 的旧层。
 *
 * ⚠️ **P1-9 R8 起为 `6`**：只读层里多了 `extensions/workspace/index.ts`（P1-9 · P2 加的文件）。
 * **这正是这条纪律的活标本**：P2 加了扩展与 `Dockerfile` 断言，却漏了 +1 ⇒ 宿主上的
 * `doubulea/sandbox-toolkit:5` 里**根本没有这个扩展**（`exec pi` 只加载 mcp-bridge），
 * 症状是"开了 Code 模式，agent 的文件读写完全没走中介"，而后端一条错都没有。R8 的最小原型
 * 复核在真实 `:5` 镜像里当场撞见（该文件缺失）⇒ 本批 +1 并重建，让扩展真的进镜像。
 */
export const BASE_LAYER_VERSION = '6'

/**
 * toolkit 层内容版本（加一个 python 包 / CLI 时 +1）
 *
 * ⚠️ **P0-3-4 起为 `2`**：toolkit 本身一行没改，但它 `FROM` 的是 base 层 ——
 * base 内容变了就必须重建一份新的 toolkit tag，否则 `doubulea/sandbox-toolkit:1`
 * 仍然指向**旧 base 里的那套入口**（= 没有 models.json 生成那一步）。
 *
 * ⚠️ **P0-3-9b 起为 `3`**：同一条理由 —— 真正被 `.env` 的 `SANDBOX_IMAGE` 引用的是
 * **toolkit 层**，base 换了而它不换 ⇒ 沙箱跑的仍是旧 base（扩展还是空壳）。
 *
 * ⚠️ **P0-3-14 起为 `4`**：同一条理由 —— base 层换了（扩展多了内置工具注册），
 * toolkit 的 tag 不换 ⇒ `.env` 的 `SANDBOX_IMAGE` 仍指向旧 base。
 *
 * ⚠️ **P0-3-14 后续为 `5`**：同一条理由 —— 本层自己与 base 的 Dockerfile 都加了缓存挂载。
 *
 * ⚠️ **P1-9 R8 起为 `6`**：同一条理由 —— base 层换了（多了 workspace 扩展），
 * toolkit 的 tag 不换 ⇒ `.env` 的 `SANDBOX_IMAGE` 仍指向旧 base（扩展根本没进镜像）。
 *
 * ⚠️ **P1-9 R11 复补起为 `7`**：本层**自己的包清单**变了 —— 装了 `openssh-client`
 * （`SSH_KEY` 型 git 凭据要在容器里跑 `ssh`；缺它 `git clone git@…` 报 `ssh: not found`）。
 * 不 +1 的症状：宿主上留着没有 ssh 的旧 toolkit，agent 用 SSH 凭据 clone 必失败。
 *
 * ⚠️ **P1-9 R11 修订起为 `8`**：本层多了两个 git 凭据 helper（`/opt/sandbox-git/*.mjs`，
 * "按需拉取"的两个脚本）⇒ 只读层内容又变了。不 +1 的症状：宿主上的 toolkit 没有 helper，
 * 而容器 env 里的 `credential.helper` / `GIT_SSH_COMMAND` 指向不存在的脚本
 * ⇒ `git clone` 认证静默失败（git 对缺失的 helper 只在 stderr 提一句，很容易看漏）。
 */
export const TOOLKIT_LAYER_VERSION = '8'

/**
 * 运行时层内容版本（P1-17a；加/换一个语言运行时、或改 runtime Dockerfile 时 +1）
 *
 * 同 base/toolkit 的那条纪律：不 +1 ⇒ 宿主上留着旧 tag 的运行时镜像，会话选的运行时
 * **静默地**还是上一版（例如 python 运行时里没有 pip）。tag 形态 `<变体>-v<ver>`。
 */
export const RUNTIME_LAYER_VERSION = '2'

/**
 * **组件目录的构建侧镜像**（必须与 `shared/src/runtime.ts#SANDBOX_RUNTIME_COMPONENTS` **逐条一致**）。
 *
 * ⚠️ 这是本仓第二处"同一份词汇写两遍"（第一处是 `shared` 与 Prisma 的枚举）—— 因为构建侧是 JS、
 *    后端/前端是 TS，无法直接共享。**两处不一致的症状**：后端算出的变体 id 与构建出的 tag 对不上
 *    ⇒"明明建了却说没有、反复重建"。加组件时**两处一起改**。
 *
 * 组件 id：`node22` / `python311` / `python310` / `python38` / `go` / `java17` / `rust`。
 * 变体 id = 组件 id 按 `LANGUAGE_ORDER` 排序后用 `-` 连接（空集合 = `none`）。
 */
const RUNTIME_LANGUAGE_ORDER = ['node', 'python', 'go', 'java', 'rust']
export const RUNTIME_COMPONENTS = [
  { language: 'node', version: '22', id: 'node22' },
  { language: 'python', version: '3.11', id: 'python311' },
  { language: 'python', version: '3.10', id: 'python310' },
  { language: 'python', version: '3.8', id: 'python38' },
  { language: 'go', version: 'default', id: 'go' },
  { language: 'java', version: '17', id: 'java17' },
  { language: 'rust', version: 'default', id: 'rust' },
]

/**
 * `pnpm sandbox:build` **默认预构建**的变体（常用组合；不是"白名单"，按需构建仍可建任意组合）。
 * 顺序即构建顺序。`none` = 空集合（只有 toolkit）。
 */
export const SANDBOX_RUNTIMES = [
  'none',
  'node22',
  'python311',
  'go',
  'java17',
  'rust',
  'python310',
  'python38',
  'node22-python310',
  'node22-python38',
]

/** 组件 id → 目录项（构建侧解析变体用） */
const COMPONENT_BY_ID = new Map(RUNTIME_COMPONENTS.map((component) => [component.id, component]))

/**
 * 变体 id → 给 `runtime/Dockerfile` 的 `COMPONENTS` 串（`lang=ver,…`，按语言顺序）。
 * `none` / 空 ⇒ `''`（不装语言运行时）。含未知 id ⇒ 抛（构建侧宁可红，也别烤出一个空壳）。
 */
export function variantToComponentsArg(variant) {
  if (variant === '' || variant === 'none') return ''
  const ids = variant.split('-').filter((piece) => piece !== '')
  const components = ids.map((id) => {
    const component = COMPONENT_BY_ID.get(id)
    if (component === undefined) throw new Error(`未知的运行时组件 id：${id}（变体 ${variant}）`)
    return component
  })
  components.sort((a, b) => RUNTIME_LANGUAGE_ORDER.indexOf(a.language) - RUNTIME_LANGUAGE_ORDER.indexOf(b.language))
  return components.map((component) => `${component.language}=${component.version}`).join(',')
}

/** `doubulea/sandbox-base:<ver>` —— toolkit 的 `FROM` 与 `.env` 的 `SANDBOX_IMAGE_BASE` 都用它 */
export const baseImageRef = () => `${BASE_IMAGE_NAME}:${BASE_LAYER_VERSION}`

/** `doubulea/sandbox-toolkit:<ver>` —— `.env` 的 `SANDBOX_IMAGE`，即**默认/回退镜像**（§五 1） */
export const toolkitImageRef = () => `${TOOLKIT_IMAGE_NAME}:${TOOLKIT_LAYER_VERSION}`

/**
 * `doubulea/sandbox-runtime:<变体>-v<层版本>` —— 一变体一份（P1-17a）。
 *
 * ⚠️ `-v` 分隔符与后端 `backend/src/sandbox/runtimeImages.ts` 的解析**必须一致**：
 *    变体名自己可以含 `-`（组合名 `node22-python38`），故用**最后一个 `-v<数字>`** 切变体名。
 */
export const runtimeImageRef = (runtime) => `${RUNTIME_IMAGE_NAME}:${runtime}-v${RUNTIME_LAYER_VERSION}`
