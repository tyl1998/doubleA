# MCP 客户端迁移:单体 SDK 1.x → 官方 v2(`@modelcontextprotocol/client`),启用 2026-07-28 与无状态 input_required

> 本文自包含,供新会话独立实施。**不考虑历史数据兼容/迁移**(见 §2)。
> 所有结论均已在本机核实过(npm registry + 已安装产物 + 拆包 v2 client dist + 后端日志 + DB)。

---

## 1. 目标

让本平台 MCP 客户端能与**现代协议(2026-07-28)**的 MCP server 正确协商,并支持**无状态 `input_required` 二次确认**——即工具返回 `resultType:"input_required"` 结果、客户端带 `inputResponses` 发一次全新请求完成确认,**无需会话、无需服务端→客户端反向通道**。

直接动因:`apitest` 的 `delete_*` 工具用二次确认(`inputRequired.elicit`)。当前我们用旧单体 SDK `@modelcontextprotocol/sdk@1.30.1`,协商到 `2025-11-25`,只能靠 `elicitation/create`(反向请求)桥接;而 `apitest` 跑 `legacy:"stateless"`(无会话、每请求单响应),物理上收不到反向请求,于是删除工具直接返回错误、二次确认失效。

**证据(删除失败的工具结果,原样存于 DB `messages.content.tool_calls[].output`):**
```
Cannot request input 'confirm' (elicitation/create): the client on this 2025-era
connection did not declare the required capability (... per-request legacy serving
cannot receive server-to-client requests)
```
握手日志:`hasSession:false`、`negotiatedProtocolVersion:"2025-11-25"`、server `apitest 0.1.0`、endpoint `http://localhost:3000/mcp`。

现代协议下同一份 `inputRequired` 是**无状态**的,不再需要反向通道 → 升级客户端到 v2 即可根治,且保住 `scanUsage/force` 之类的后果清单。

---

## 2. 非目标(明确不做)

- **不做历史数据兼容/迁移**:不迁移/兼容已持久化的 MCP 会话缓存、`tool_cache`、旧协议版本留痕等。需要就直接清库/重新拉取(`tool_cache` 本就是可重建的投影)。
- 不改前端、不改会话/确认卡的对外契约(见 §5 复用清单)。
- 不动沙箱侧(`backend/src/sandbox/*`)——它刻意不传 `onElicit`(`sandbox/proxy.ts:445`),迁移后维持不传即可。

---

## 3. 已核实的事实(可复核)

**v2 是官方线、公开可装(非 fork):**
```
npm view @modelcontextprotocol/client version dist-tags  → 2.1.0, { latest: '2.1.0' }
npm view @modelcontextprotocol/server version dist-tags  → 2.1.0, { latest: '2.1.0' }
npm view @modelcontextprotocol/core   version            → 2.1.0
npm view @modelcontextprotocol/node   version            → 2.1.0
```
v2 把旧单体 `@modelcontextprotocol/sdk` 拆成 scoped 包族(core/client/server/node/express/fastify/hono);**客户端侧用 `@modelcontextprotocol/client`**。旧 `@modelcontextprotocol/sdk` 的 `npm view` 只会看到 `1.30.1`(那是旧单体线的 latest),这是我们之前误判"公共 SDK 只到 2025-11-25"的原因。

**`@modelcontextprotocol/client@2.1.0` dist 里确认存在(拆包 grep 得到):**
- `FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28"`(另有 2026-07-15/07-17 常量);modern-era 与 legacy `SUPPORTED_PROTOCOL_VERSIONS` **分两套**版本处理(自动按对端能力选新/旧腿)。
- 无状态 input_required 全套类型/工具:
  - `InputRequiredResult { resultType:'input_required'; inputRequests: InputRequest[]; requestState?: string }`
  - `InputRequest = CreateMessageRequest | ListRootsRequest | ElicitRequest`
  - `InputResponse = CreateMessageResult | ListRootsResult | ElicitResult`;`InputResponses`(按 key 索引)
  - `isInputRequiredResult(...)`、`InputRequiredOptions`(含 `inputRequired.maxRounds` 的自动多轮)、`RequestStateAccessor`
  - 错误码 `UNSUPPORTED_RESULT_TYPE`、`INPUT_REQUIRED_ROUNDS_EXCEEDED`
- **关键利好**:input_required 的载荷 shape 与 elicitation **完全相同**(`ElicitRequest`/`ElicitResult`)。所以确认的"问/答"数据形状不变,我们现有的确认逻辑可直接复用(见 §5)。
- v2 client **同时支持 legacy 与 modern**:对仍是 1.x/2025 的其它 MCP server 会自动降级、继续走 elicitation 反向通道。迁移不会打挂老 server。

**对端:** `apitest-server` 依赖 `@modelcontextprotocol/server@2.0.0` + `@modelcontextprotocol/node@2.0.0`(声明见其 `package.json:22-23`,锁定见其 `pnpm-lock.yaml`),支持 2026-07-28。我们客户端升到 v2 后,双方协商即可落到 2026-07-28。

> 复核 API 细节的方法:`npm pack @modelcontextprotocol/client@2.1.0 @modelcontextprotocol/core@2.1.0`,解包后读 `dist/index.d.mts` 与 `dist/index-*.d.mts`(input_required / callTool 选项 / transport 都在类型里)。

---

## 4. 现状代码盘点(迁移面)

**1.x SDK 的 import 在整个后端只有一处** —— `backend/src/mcp/client.ts`:
```
:55  import { Client } from '@modelcontextprotocol/sdk/client/index.js'
:56  import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
:57  import { ElicitRequestSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
:58  import type { ElicitRequestParams } from '@modelcontextprotocol/sdk/types.js'
```
其余模块全部经**我们自己的抽象**与 client 交互,不碰 SDK 类型:
- `McpClientOptions` / `McpCallOptions` / `McpToolResult` / `McpElicitRequest` / `McpElicitReply`(都定义在 `client.ts`)。
- `services/mcpCall.service.ts`:透传 `onElicit`(`:157`、`:241`、`:398`、`:441`)。
- `orchestrator/chatBot.ts`:把 `onElicit` 接到 `awaitConfirm`(`:548-572`);PLATFORM 危险确认在 `:484`。
- `orchestrator/sse.ts`:`awaitConfirm`(`:820`)+ 应答端点 `answerConfirm`;`confirm` SSE 事件。
- `mcp/inject.ts`:`createCredentialFetch(...)` —— 生成注入凭据的 `fetch`,经 `McpClientOptions.fetch` 交给 transport(**判据 6 的落点**)。
- `mcp/errors.ts`:`toMcpFailure(...)` 把 SDK 抛出的错误分类成 `UPSTREAM_ERROR/UPSTREAM_TIMEOUT/McpAbortError`。
- `mcp/risk.ts`:`isDangerousTool()`(基于 annotations 的 PLATFORM 危险判定)——**与本迁移无关,不动**。

**`client.ts` 文件头有 6 条实测判据(全部针对 1.x),迁移时逐条对 v2 重验并改写注释:**
1. 请求协议版本由 SDK 写死(`params.protocolVersion = LATEST_PROTOCOL_VERSION`,无 setter)。→ v2 里版本协商是 modern/legacy 分套,确认 v2 客户端默认会 offer 2026-07-28 且能与 legacy server 降级。
2. `mcp-protocol-version` 头仅在协商后发,首包 initialize 不带。
3. 保留头合并顺序:我们设的头会覆盖 SDK 的三个头 ⇒ 绝不能塞 `mcp-session-id`/`mcp-protocol-version`/`Authorization`(落成 `shared` 的 `MCP_RESERVED_HEADER_NAMES`)。
4. `close()` 不终止会话 ⇒ 固定"先 DELETE(terminateSession)后 close"。
5. `registerCapabilities()` 只能在 connect 前、且只在真有应答方时声明。
6. **(最高风险)** transport 的 `fetch` 选项是所有网络请求的唯一出口 ⇒ 凭据注入(HEADER/QUERY/BODY)全挂这一个口子。**v2 transport 的自定义 fetch/注入点接口要先探明**。

---

## 5. 复用 / 不动清单(减少改动面)

以下**保持不变**,迁移只需把 v2 的 input_required(与 legacy 的 elicitation)都接到它们上:
- `SseChannel.awaitConfirm`(`orchestrator/sse.ts:820`)、`answerConfirm`、`confirm` SSE 事件、`POST /:id/confirm` 端点、`/active` 的 `pendingConfirmId`。
- `chatBot.ts` 的 PLATFORM 危险确认(`:484`)与 `onElicit→awaitConfirm` 接线(`:548-572`)。
- 前端确认卡与第三方接入契约(见 `docs/07-第三方接入-会话确认(confirm)协议.md`)。
- `McpElicitRequest`/`McpElicitReply` 的形状(`accept`/`decline`/`cancel` + 可选 content)——因为 input_required 里装的就是 `ElicitRequest`/`ElicitResult`,同一套。

---

## 6. 实施步骤(建议分阶段,便于回退)

### 阶段 0 — 环境
- Node **≥22**(v2 与本仓都要求;本机默认 `node` 是 v20 会崩 prisma,用 `nvm use 22`,仓库已带 `.nvmrc`)。
- 包管理 pnpm。开发环境:`bash infra/scripts/dev-run.sh`(会拉 pg/redis/minio + 迁移 + 起前后端);停:`dev-stop.sh`。
- 对端 `apitest` 在 `http://localhost:3000/mcp`,需 Bearer 凭据(平台里该 server 已注册、凭据已存,注入位置 HEADER `Authorization`)。

### 阶段 1 — v2 client 底座(spike,先不接线到现有链路)
1. 加依赖:`@modelcontextprotocol/client@^2.1.0`(按需 `@modelcontextprotocol/core@^2.1.0`);移除 `@modelcontextprotocol/sdk`(`backend/package.json:30`)。
2. 按 v2 API **重写 `backend/src/mcp/client.ts`**,保持对外导出的类型/方法签名不变(`McpClient`、`connectMcpClient`、`listTools`、`callTool`、`McpClientOptions`、`McpToolResult`、`McpElicitRequest`、`McpElicitReply`、`close`、`sessionId`/`protocolVersion`/`serverInfo` getters)——这样上层零改动。
3. **判据 6 优先打通**:确认 v2 transport 如何注入自定义 `fetch`(凭据注入),把 `mcp/inject.ts#createCredentialFetch` 接上;验证 HEADER/QUERY/BODY 三种注入仍在同一个口子生效,且未覆盖保留头(判据 3)。
4. **input_required 接线**:v2 client 的 `callTool` 支持 `inputRequired` 选项(带 `maxRounds` 的自动多轮 + 一个提供 `inputResponses` 的 resolver)。把该 resolver 指向**现有 `onElicit` 语义**:收到 input_required 里的 `ElicitRequest` → 归一化成 `McpElicitRequest` → 交给 `onElicit`(即上层的 `awaitConfirm`)→ 拿到 `McpElicitReply`(accept/decline/cancel)→ 转成 `ElicitResult` 放进 `inputResponses` 重调。
   - legacy server 仍保留 `elicitation/create` 反向通道处理(v2 也支持),同样接到 `onElicit`。两条腿汇到同一个 `onElicit`。
5. 写一个**一次性验证脚本**(`node --import tsx`,不进主链路):对 `apitest` 做 `initialize`(断言协商到 `2026-07-28`)+ 一次 `delete_*` 的 input_required 往返(resolver 直接返回 accept),断言删除成功、拿到后果清单。

### 阶段 2 — 灰度切换
- 在 `services/mcpCall.service.ts` 用开关(env 或 config)选择新/旧底座,逐项对齐后再全量:
  - `tools/list` 投影一致;
  - 危险工具(PLATFORM 卡)仍正常;
  - 凭据注入(HEADER/QUERY/BODY)一致;
  - 单次超时 / 用户中断(`McpCallOptions.signal`)行为一致;
  - 会话终止(判据 4)不泄漏;
  - 对**仍是 legacy 的 server**降级正常、elicitation 仍可用。

### 阶段 3 — 收尾
- 删除旧依赖与兼容开关;更新 `client.ts` 文件头 6 条判据为 v2 版本;若 `errors.ts` 的错误识别依赖 1.x 具体错误形状,按 v2 调整。

---

## 7. 验证清单(全部在 Node 22 下)
- [ ] `pnpm --filter @doubulea/backend typecheck` 通过。
- [ ] spike 脚本:对 `apitest` 协商到 `2026-07-28`;`delete_*` input_required 往返成功、删除生效、返回后果清单。
- [ ] 现有链路:发消息调 `apitest` 只读工具(不弹卡直接执行)、危险工具(PLATFORM 卡)、删除(现代协议下二次确认经 `awaitConfirm` 弹一次即可完成)。
- [ ] 凭据注入三态(HEADER/QUERY/BODY)在真实调用中生效且不覆盖保留头。
- [ ] 超时/中断/会话终止行为与旧底座一致。
- [ ] 另找一个 legacy(2025)server 验证降级 + elicitation 反向通道仍工作(回归)。

---

## 8. 风险与注意
- **判据 6(fetch/凭据注入)是最大未知**:v2 transport 的自定义 fetch 接口若与 1.x 不同,`inject.ts` 的接法要相应改;这是最该先探的点。
- **"确认两次"的去重（✅ **2026-09-29 已落地**，见下）：现代协议下删除会经我方 PLATFORM 卡 + 服务端 input_required 各一次。去重口径：**同一次调用已过 PLATFORM 卡且用户确认**（`route.dangerous` 为真且用户点了确认）⇒ 之后同一调用途中的服务端 elicitation / `input_required` **自动 accept**（不再弹第二张卡），落点 `chatBot.ts#onElicit`（`platformConfirmed` 标志），legacy 反向通道与现代 input_required 两条腿共用同一入口、同时生效。非危险工具（没弹过 PLATFORM 卡）不受影响，服务端卡照弹。⚠️ 前提是"同一次调用"——模型在同一轮里**再次**发起同名调用仍会重新弹 PLATFORM 卡。
- v2 是 ESM;确认 `tsx`/构建链对 `.mjs`/`exports` 解析正常(本仓已是 ESM + Node22,通常无碍)。

---

## 9. 复核锚点(命令与坐标)
- 版本核对:`npm view @modelcontextprotocol/client version dist-tags`、`... server ...`(需联网环境)。
- 读 v2 API:`npm pack @modelcontextprotocol/client@2.1.0` → 解包读 `dist/index.d.mts`。
- 唯一 SDK import 点:`backend/src/mcp/client.ts:55-58`。
- 依赖声明:`backend/package.json:30`(`@modelcontextprotocol/sdk`)。
- onElicit 透传:`services/mcpCall.service.ts:157/241/398/441`;接线:`orchestrator/chatBot.ts:548-572`。
- 确认原语:`orchestrator/sse.ts:820`(`awaitConfirm`)。
- 凭据注入:`backend/src/mcp/inject.ts`(`createCredentialFetch`)。
- 删除失败取证:DB `messages.content.tool_calls[].output`(会话 `01a0e6d1-…`、消息 `01a0e74d-…`)。
