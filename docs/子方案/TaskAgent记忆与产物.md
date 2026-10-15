# TaskAgent 记忆与产物跨会话（2026-09-30 立项）

> 本方案解决 TaskAgent 三个已知问题，是 P0-3 收尾后的**第一批修复**。
> 日志证据取自 `.dev-logs/backend.log`（2026-09-29 当天实录），代码行号以当日 `main` 为准。

---

## 一、三个问题（按用户报告原文整理）

### 问题 1：容器回收后 agent 失忆

**现象**：TaskAgent 聊天后容器被回收（空闲 30 分钟 / 用户停止），`/work` 下文件被清空；重新与 agent 聊天，agent 不知道自己之前生成过什么。

**日志证据**（`.dev-logs/backend.log`）：
- 三次 `沙箱已回收`，`reason: "idle"`，`idleTtlMin: 30`（13:37 / 15:27 / 16:39），每次带 `沙箱代理令牌已撤销`。
- 回收链路：`reaper.ts#reapIdleSandboxes` → `manager.ts#recycleSandbox`（删容器 + 具名卷 + 账本 + 名额）。

**根因**（代码）：
- `manager.ts:487-531` `recycleSandbox` 删容器与具名卷 ⇒ `/work` 文件没了。
- `taskAgent.ts:410` `bridge.runTurn(content)` 派活时**只发当前用户消息**，后端**从不重放** `messages` 历史 —— pi 靠容器内 session 文件（`/tmp/pi-agent`，tmpfs）自己记忆，容器没了记忆就没了。
- 产物本体在 S3 + `artifacts` 表 + 消息 `content.artifacts` 里**都在**，但**不回馈给引擎**。

### 问题 2：新建会话后产物面板残留旧会话产物

**现象**：会话级别的产物，新建会话后仍出现在产物列表里。

**根因**（前端 bug）：
- `frontend/src/api/artifacts.ts:89` `useConversationArtifacts` 用了 `placeholderData: keepPreviousData`。
- 新建会话时 `conversationId === undefined` → 查询被 `enabled: false` 禁用、永不 resolve → `keepPreviousData` 把**上一个会话**的产物一直顶在面板里。
- 日志佐证：13:43 切到新会话 `01a0e604...` 时发了 `/artifacts` 请求（200 空列表），但面板仍显示旧会话 `01a0eb76...` 的产物。

### 问题 3：MCP 工具增加后新建会话 agent 识别不到工具

**现象**：新增 MCP 工具后新建会话聊天，agent 识别不到工具。

**根因**（镜像版本过期）：
- `infra/.env`：`SANDBOX_IMAGE=doubulea/sandbox-toolkit:2`、`SANDBOX_IMAGE_BASE=doubulea/sandbox-base:2`。
- `infra/sandbox/versions.mjs`：`BASE_LAYER_VERSION = '3'`、`TOOLKIT_LAYER_VERSION = '3'`，注释明写"MCP 桥真实现是 `:3`，`:2` 里是老的空壳扩展"。
- 日志证据：引擎退出 stderr 为 `[mcp-bridge] extension loaded (MCP tool registration lands in P0-3-9b)` —— 该字符串在**当前源码中已不存在**（`git log -S` 确认 3097f9a 移除），说明跑的是旧镜像烘焙的旧扩展，它**不注册任何工具**。
- 后端侧 17:58 有 `已为沙箱下发 MCP 工具清单` ⇒ 后端清单正常，是容器侧没接住。
- **修复动作**：`pnpm sandbox:build` 重建镜像（打出 `:3` 两行），把 `infra/.env` 改 `:3`。这是环境修复，不在本方案的代码改动里，但验收前置条件。

---

## 二、方案决策（2026-09-30 已与用户确认）

用户明确否决"全量恢复产物到 /work"（会延迟容器重建），改为 **记忆文档 + 产物映射 + 按需下载**：

1. **记忆文档（memory doc）**：每次派活前，后端从 DB 组装一份会话记忆（最近 N 轮对话文本 + 产物清单），写入容器 `/work/.doubulea/memory.md`。
   - ⚠️ **关键修正**：不能在"回收时"生成 —— 回收会把容器和 /work 卷一起删掉，放容器里等于白生成。正确做法是**每次派活前从 DB 现组装**（记忆内容随时可从 messages + artifacts 推导），容器重建后照样写入。
   - 写入路径以 `.` 开头 ⇒ `artifacts.ts#filterChangedFiles` 的"隐藏文件跳过"规则天然排除，不会被当产物上传。
2. **产物映射表（artifact manifest）**：`artifacts` 表本身就是产物 → S3 的映射（`conversationId, fileKey, fileName, size, mime`），S3 对象回收后仍在。缺的是容器侧下载通道。
3. **按需下载（agent 自己下载）**：新增沙箱产物下载端点，agent 需要时经 `SANDBOX_BACKEND_URL` + per-container token 自己拉回。
4. **会话产物**：删除会话时产物行**不删**（改 schema 可空 + `SetNull`），归入"会话产物"，按用户可查（且可在该页主动删除）。

实现范围：**后端 + 前端全做**（用户已确认）。

---

## 三、实现方案（分块）

### 块 1：记忆文档生成 + 写入 work（问题 1 的核心）

**新文件** `backend/src/orchestrator/memoryDoc.ts`（或并入 `taskAgent.ts`，看体积定）：

```
buildMemoryDoc(conversationId) → string
  · 查最近 N 轮 messages（USER/ASSISTANT 文本，复用 textOfHistoryRow 口径）
  · 查 artifacts 表该会话产物清单（fileName + artifactId + size + mime）
  · 拼 Markdown：对话摘要 + 产物清单（含"如何下载"说明，见块 2）

writeMemoryDoc(containerId, doc) → void
  · execInSandbox 写入 /work/.doubulea/memory.md（含子目录 mkdir -p）
  · 失败只 warn（记忆是本轮的赠品，不落轮）
```

**改动点** `backend/src/orchestrator/taskAgent.ts`：
- 在 ③.5 `snapshotWorkFiles`（拍产物基线）**之前**调 `writeMemoryDoc` —— 记忆文件写完后才拍基线，于是记忆文件算进基线、本轮不会被当新产物收集。
- ⚠️ 记忆文件每次派活都会变化 ⇒ 若基线在写记忆文件**之后**拍，它永远在基线里 ⇒ 永远不会被收集。顺序必须：写记忆 → 拍基线 → 派活 → 收集。

**产物映射里"如何下载"的说明**（给引擎看的文本）：
- 容器有 `SANDBOX_BACKEND_URL` 与 `SANDBOX_TOKEN` 环境变量；
- toolkit 镜像刻意**没有 curl/wget**（`infra/sandbox/toolkit/Dockerfile:24`），但有 node ⇒ 下载命令用 `node -e 'fetch(...)'`。

### 块 2：沙箱产物下载端点（问题 1 的"按需下载"通道）

**改动点** `backend/src/sandbox/proxy.ts` + `backend/src/services/artifact.service.ts`：

- 在沙箱 listener（出口②，`listener.ts`）上挂 `GET /api/sandbox/artifacts/:artifactId`。
- 认证：复用 `proxy.ts#authenticate`（`tokenFromHeader` + `resolveSandboxToken`）。
- 归属：产物 → `conversationId` 必须等于 token 解析出的 `conversationId`（与 `openArtifactSource` 同一条判据，只是主语从 `userId` 换成 `conversationId`）。
- 响应：字节流 + 与公网下载同款的响应头（`Content-Disposition` / `Content-Type` / `nosniff` / `no-store`），可复用 `routes/artifacts.ts#buildContentDisposition`。
- 服务层加一个 `openArtifactSourceForConversation({ artifactId, conversationId })`，与现有 `openArtifactSource` 共用取流逻辑，避免两份 S3 判据。

### 块 3：删除会话保留产物行（会话产物）

**改动点** `backend/prisma/schema.prisma` + `backend/src/services/conversation.service.ts`：

- `Artifact.conversationId` 改可空（`String?`），`onDelete: Cascade` → `SetNull`。
- 补 `Artifact.userId`（产物归属用户，删除会话后仍可查"我的会话产物"）—— 建行时从 `conversation.userId` 写入（`artifacts.ts#collectRoundArtifacts` 现在没有 userId，需要从会话查一次，或由编排层传进来）。
- `removeConversation`：删会话行后产物行 `conversationId` 自动置空，**不再删产物行**；S3 对象本来就没删（`collectConversationObjectKeys` 返回 `[]`，见下）。
- ⚠️ 顺带修一个**隐藏 bug**：`conversation.service.ts:389-392` `collectConversationObjectKeys` 至今返回 `[]`，注释写"P0-3 加一句"但没加 —— 删除会话时产物 S3 对象从未删除。本次既然改删除语义（产物保留为会话产物），这个函数改为**不再收集产物键**（或干脆删除 S3 清理那段，避免误删会话产物）。

### 块 4：会话产物后端端点

> ⚠️ **2026-10-01 修订**：原「历史产物」只列 `conversationId = null` 的产物，语义太窄 ⇒ 改为
> **「会话产物」= 跨会话汇总本人全部产物**（不加 `conversationId` 过滤），并补一个**删除**端点。

**改动点** `backend/src/routes/artifacts.ts` + `backend/src/services/artifact.service.ts` + `shared/src/conversation.ts`：

- `GET /api/artifacts?offset&limit`（仅本人）：查 `artifacts` where `userId = me`，返回 `{ items, total, offset, limit }`（`created_at desc`）。
- `DELETE /api/artifacts/:id`（仅本人）：**真删除** —— 先删 S3 对象、成功才删 `artifacts` 行；别人的 / 不存在的 id 一律 404，对象删不掉 ⇒ 500 且不动库。
- shared 增加 `listMyArtifactsQuerySchema`（复用 `listArtifactsQuerySchema`）与响应 schema（复用 `artifactListResultSchema` 即可，字段同）。

### 块 5：前端

- **问题 2 修复**：`frontend/src/api/artifacts.ts:84` `useConversationArtifacts` —— `conversationId === undefined`（新会话态）时返回空清单，不用 `keepPreviousData` 顶旧数据。改法：`enabled` 已为 false，问题在 placeholder；可将 queryFn 在无 id 时返回空结果，或去掉 `placeholderData`。
- **会话产物入口**：前端加"会话产物"页面（`ArtifactCollectionPage`，路由 `/artifacts`），调块 4 的端点，复用现有 `ArtifactCard` 的下载/预览能力（`frontend/src/features/chat/ArtifactCard.tsx`、`frontend/src/api/artifacts.ts` 的 `saveArtifactFile` / `fetchArtifactText`）；并给 `ArtifactCard` 加**可选** `onDelete`（`Popconfirm` ⇒ `DELETE /api/artifacts/:id`），只在该页传入。

---

## 四、验收清单

1. **问题 3 前置**：重建沙箱镜像到 `:3` 并更新 `infra/.env`，容器 stderr 不再出现 `lands in P0-3-9b`；新建会话 agent 能看到 MCP 工具。
2. **问题 2**：TaskAgent 会话产出产物 → 新建会话 → 产物面板为空（不残留旧会话产物）。
3. **问题 1**：
   - 派活后 `docker exec <container> cat /work/.doubulea/memory.md` 能看到对话摘要 + 产物清单；
   - 停止/空闲回收容器后重新聊天，agent 能说出之前生成过哪些文件；
   - 容器内按记忆文档的下载命令能取回产物内容（curl 不行，用 node fetch 验证）。
4. **会话产物**：删除含产物的会话 → `/api/artifacts` 仍能查到该产物并可下载；前端「会话产物」入口可见；在该页删除一条产物 ⇒ 对象与行一并移除、刷新后不再出现。

---

## 五、边界与刻意不做

- **不做全量产物恢复**：容器重建只写记忆文档（几 KB），不把产物下载回 /work —— 延迟与磁盘成本都不可接受。
- **不做历史全文重放给引擎**：记忆文档只给"摘要 + 产物清单"，不是逐字历史；pi 会话活着时它自己记得全部。
- **产物保留期不变**：会话产物仍受 `ARTIFACT_RETENTION_DAYS`（默认 7 天）清理收口，不因"可汇总查看"而变成永久。用户也可在「会话产物」页**主动删除**（对象 + 行一并移除）。
- **撤回最新一轮（recall）的删除语义不变**：`conversation.service.ts#recallLastRound` 仍删该轮产物行 + S3 对象（撤回=撤销那一轮，与"删除会话"是两种操作）。
---

## 修订（2026-10-14）：记忆文档阅读指令必须给**工作区相对路径**

**问题**：agent 每次执行开始读 `/work/.doubulea/memory.md` **都失败**。根因：Code 模式下引擎的 `read` 工具被 `pi-agent/extensions/workspace` **同名覆盖**（版本感知版），参数是**工作区相对路径**；后端 `normalizeWorkspacePath` 直接拒绝以 `/` 开头的绝对路径（`backend/src/workspace/paths.ts:55`）⇒ 绝对路径的阅读指令必然 `ok:false` 校验失败。

**处置**：`backend/src/orchestrator/memoryDoc.ts` 新增 `MEMORY_DOC_RELATIVE_PATH = '.doubulea/memory.md'`，`memoryDocReadInstruction()` 改用它并显式提示"read 只接受工作区相对路径，不要传 `/work/...`"。相对路径在两种形态下都对：中介 `read` 认它；非中介的内置 `read` 以 cwd=`/work` 解析它。`MEMORY_DOC_PATH`（绝对）仍供 `writeMemoryDoc` 写盘与日志用。
