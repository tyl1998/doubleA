# 问题记录 — macOS 环境适配（Windows → macOS 迁移）

> 批次：非计划内（环境适配，不占用 P0-1-3 编号）
> 日期：2026-09-21
> 关联：`README.md` §一 快速开始 / `infra/scripts/` / `docs/06` §六 施工纪律
> 定位：仓库原按 Windows + Git Bash 搭建，本机换成 **macOS (arm64)** 后暴露的差异与结论。

---

## 汇总（6 个坑）

| # | 问题 | 严重度 | 状态 |
|---|------|--------|------|
| 1 | 启停脚本只有 `.ps1`，macOS 无 `powershell` → `pnpm infra:up` 直接不可用 | 高 | ✅ 已解决：补 `.sh` + 跨平台入口 `infra.mjs` |
| 2 | 宿主 5432/6379/9000/9001 **被另一项目容器占用** | 高 | ✅ 已解决：改 `.env` 端口避让，不动别人容器 |
| 3 | **bash 3.2：中文全角字符紧跟 `$VAR` 被并入变量名** → `unbound variable` | 中 | ✅ 已解决：一律写 `${VAR}` |
| 4 | pnpm 未安装（Windows 是 corepack 的 Node 路径直调） | 低 | ✅ 已解决：`corepack enable pnpm` |
| 5 | `nodeLinker: hoisted` 的原始动机（Windows 符号链接静默失败）在 macOS 上不存在 | 低 | ℹ️ 保持现状，不动配置 |
| 6 | **dev 侧端口 5173 与 3000 同样被别的项目占用**（当前不阻塞） | 低 | 📌 已记录，待 P0-1-3 处理 |

**核心结论**：macOS 上 `pnpm install` / `pnpm -r build` / 三个依赖服务 / `pg-verify.mjs`
**12 项验收全部通过**，与 Windows 侧结论一致（`bigm_similarity` 同样 0.4）。
迁移成本集中在「脚本与端口」，**代码与配置零改动**。

---

## 坑 1 — 启停脚本只有 PowerShell 版

**现象**：`pnpm infra:up` 在 macOS 上报找不到 `powershell`；根 `package.json` 里
两个脚本是硬编码的 `powershell -ExecutionPolicy Bypass -File ...`。

**对策**（两份实现 + 一个平台无关入口）：

```
infra/scripts/
├── dev-up.ps1 / dev-down.ps1     ← Windows 原实现，**保持不动**
├── dev-up.sh  / dev-down.sh      ← 新增，与 .ps1 行为等价
└── infra.mjs                     ← 新增：按 process.platform 选脚本 + 透传参数/退出码
```

根 `package.json`：

```jsonc
"infra:up":   "node infra/scripts/infra.mjs up",     // 原：powershell ... dev-up.ps1
"infra:down": "node infra/scripts/infra.mjs down",
```

**为什么不让 `.sh` 顶替 `.ps1`**：Windows 侧（`docs/06` 记录的施工机）仍要用原脚本，
`infra.mjs` 只做「选哪个」，不含业务逻辑，两边都能随时直接调自己的脚本。

**坑中坑**：`pnpm infra:up` 传参要写 `pnpm infra:up -- --purge`，
npm 会先把 `--` 原样带进 argv，故 `infra.mjs` 里要 `.filter(a => a !== '--')` 丢掉它。

---

## 坑 2 — 宿主机端口被另一项目占用

**现象**：

```
$ lsof -nP -iTCP:5432 -sTCP:LISTEN
OrbStack  30519 <user>  206u  IPv4 ... TCP *:5432 (LISTEN)
```

四个端口全被 `OrbStack` 代理监听 —— 实为**另一个项目**（`apitest-server`）的
`postgres / redis / minio` 容器，已 `Up 2 days (healthy)`。

**处置原则**：**不动别人的容器**。compose 文件本就写明「端口一律『宿主端口 ← 环境变量』，
冲突时改 `.env` 即可，不必动本文件」，照此执行：

| 服务 | 原 | 现 |
|------|----|----|
| PostgreSQL | 5432 | **15432** |
| Redis | 6379 | **16379** |
| MinIO API | 9000 | **19000** |
| MinIO Console | 9001 | **19001** |

同步改了 `.env` 里的 `DATABASE_URL` / `REDIS_URL` / `S3_ENDPOINT` 三处连接串
（宿主进程连容器走 `127.0.0.1`，端口必须跟着走，否则 P0-1-3 起后端连不上）。

**注意**：`pg-verify.mjs` 走 `docker compose exec`（容器内 5432），
**不受宿主端口影响**，故换端口后验收照旧全绿。

**反向提醒**：`docker ps` 里 `apitest-server-*` 不是本项目的容器，
`dev-down.sh --purge` 只作用于本项目 compose（`name: doubulea`），不会误伤。

---

## 坑 3 — bash 3.2 把中文并进变量名（**最新鲜的坑**）

**现象**：

```bash
$ bash infra/scripts/dev-up.sh --no-build
=== Preflight ===
  [OK] Docker engine 可达
infra/scripts/dev-up.sh: line 72: ENV_FILE�: unbound variable
```

**根因**：出问题那行是

```bash
ok "env 文件: $ENV_FILE（CREDENTIAL_MASTER_KEY 已设置）"
#                        ↑ 紧跟着中文全角左括号
```

macOS 自带的是 **GNU bash 3.2**（2007 年，为 GPLv3 前的最后版本）。
它的标识符扫描在 `$VAR` 后遇到多字节字符时，会把该字符的**部分字节**当作变量名的一部分，
于是去求值一个叫 `ENV_FILE\xEF...` 的变量 → `set -u` 下直接 `unbound variable` 退出。
即便 `LANG=en_US.UTF-8` 也复现（bash 3.2 的多字节处理与 4.x/5.x 不同）。

**对策**：**变量后紧跟非 ASCII 字符时，一律写 `${VAR}`** 显式界定名字边界。

```bash
ok   "env 文件: ${ENV_FILE}（CREDENTIAL_MASTER_KEY 已设置）"      # ✅
warn "env 文件: ${ENV_FILE} —— CREDENTIAL_MASTER_KEY 为空（…）"   # ✅
```

**连带建议**：`.sh` 里变量贴近中文的地方都用 `${}`，代价是零，能免疫整类问题。
（`.ps1` 侧有同类但成因不同的问题，见 `问题记录-P0-1-2` 坑 4/5：`{{}}` 与 BOM。）

---

## 坑 4 — pnpm 的获取方式

Windows 侧是**直调 corepack 的 pnpm.js**（受管 node 下 shim 失效）。
macOS 侧无此限制，按官方路径即可：

```bash
corepack enable pnpm     # 在 node bin 下写 shim
pnpm -v                  # → 12.4.2（由 package.json 的 packageManager 锁定）
```

首次执行会自动下载 `pnpm@12.4.2` 到 corepack 缓存（约 10s）。

**顺带验证**：`pnpm install` 输出
`[link-workspace] 完成：修复 0 个，跳过 2 个有效链接`
—— 说明 `link-workspace.mjs` 在 macOS 上**纯属空转**，两条 workspace 链接都是原生有效的。

---

## 坑 5 — `nodeLinker: hoisted` 还要不要留

**背景**：`pnpm-workspace.yaml` 里设 `nodeLinker: hoisted`，理由是 Windows 上
pnpm 创建目录符号链接会**静默失败**（`问题记录-P0-1-1`）。

**macOS 实测**：符号链接一切正常（见坑 4 的「跳过 2 个有效链接」）。

**结论：保持 `hoisted` 不动**。理由：
- 改动它会让 `pnpm-lock.yaml` 与 `node_modules` 布局在两平台间产生差异，
  而 Windows 侧仍在施工 —— **一致性优先于局部优化**；
- `hoisted` 在 macOS 上同样能跑通（install / build / typecheck 全绿），只是少了
  pnpm 默认的「幽灵依赖防护」，单人小团队可接受（原决策已写明此取舍）；
- 文档里已预留了退出路径：「若将来 CI（Linux）上 isolated 正常，可删掉 `nodeLinker` 一行切回默认，代码无需改动」。
  **但那是 CI 的决策，不是本机迁移该顺手做的改动。**

---

## 坑 6 — dev 侧端口（5173 / 3000）也被占

**现象**：起前端 dev server 时 vite 打印 `Port 5173 is in use, trying another one...` 并落到 5174；
探活 `localhost:3000` 返回 **404**（有服务在听，但不是我们的）。

**占用者**：均为**另一个项目**的 node 进程（`lsof` 可见），与本项目无关。

**为什么暂时不动**（与坑 2 的区别）：

| | 坑 2（5432 等） | 坑 6（5173 / 3000） |
|---|---|---|
| 是否阻塞 | **阻塞** —— 不换端口 `infra:up` 直接起不来 | **不阻塞** —— 现在阶段根本没有后端 HTTP 服务 |
| 处置 | 立刻改 `.env` | 记录，等真正需要时再改 |

前端 dev 的 5173 只是显示端口，vite 未设 `strictPort` 故自动递增到 5174，
**功能无损**，只是看日志时别默认 5173。

后端 3000 则会在 **P0-1-3/P0-1-4** 落地监听时变成 `EADDRINUSE`；
且 vite 的 `/api` 代理默认指向 `localhost:3000`，现在会**打到别人的服务上**。
届时按下面两处一起改（已在 `infra/.env` 的 `BACKEND_PORT` 上方留了同文提示）：

```bash
# infra/.env
BACKEND_PORT=13000

# 起前端 dev 时同步代理目标
VITE_DEV_PROXY_TARGET=http://localhost:13000 pnpm dev:frontend
```

**刻意不改 `vite.config.ts` 的默认值**：`.env` 是**本机**文件（gitignore），
若把源码默认值改成 13000，Windows 侧 `.env` 还写 3000 时两边就不一致了。
跨平台默认值留在源码，本机差异留在 `.env` —— 与坑 2 同一套原则。

---

## 附：本机验收记录（2026-09-21）

```bash
pnpm install        → 71 个包，6.1s，workspace 链接原生有效
pnpm -r build       → shared ✅ / backend ✅(→backend/dist) / frontend ✅(→frontend/dist 142.95 kB)
pnpm typecheck      → 三包全绿
pnpm infra:up       → 镜像构建 4m54s（首编 pg_bigm）→ 三容器 healthy
pnpm infra:verify   → 12/12 PASS（bigm_similarity('中文测试','中文') = 0.4）
宿主连通性           → 15432 / 16379 / 19000 / 19001 四端口均可连
```
