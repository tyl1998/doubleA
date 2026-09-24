# 问题记录 — P0-2-1 MCP client 底座（官方 TS SDK / Streamable HTTP）

> 批次：P0-2-1（**P0-2 工具闭环的第 1 步**；`docs/06` §四 的 `[✓]` 到此为止）
> 日期：2026-09-24
> 来源：**后端** 新增档 `pnpm verify:mcp-client`（**34 项全通过**：A 握手/会话/版本 6 / B 投影 3 / C `tools/call` 三分法 6 / D 失败分类 9 / E elicitation 3 / F 优雅关闭 4 / G 入口校验与配置 3，起一个**假 MCP server** + 直接 `import` 构建产物）；另有 `pnpm lint` / `pnpm -r typecheck` / `pnpm -r build` 三连全绿 + `pnpm check:batch` 一致
> ⚠️ **本批不做智能体侧端测**（用户 2026-09-23 定案）：本批**无界面、无路由**，`docs/06` §4.4 的第一个端测点在 **P0-2-2 之后**的命令行档；本批只有「契约与配置接对了」这一层证据，**不等于**"连真 MCP server 一定对"

---

## 0. 一句话结论

**本批的价值一半在新代码，一半在"把 SDK 的行为真相钉在注释里"。**

> `backend/src/mcp/client.ts` 是一层**薄的壳**：连接 / 握手 / `tools/list` / `tools/call` / 优雅关闭，
> 出口**只吐本仓自己的类型**（`McpToolDescriptor` / `McpToolResult`），camelCase 之外**零 SDK 对象外泄**；
> `backend/src/mcp/errors.ts` 把 SDK 抛出的**各种东西**（`McpError` / `StreamableHTTPError` / `TypeError` /
> `SyntaxError` / zod 校验错 / 裸 `Error`）翻译成**本仓错误码 + 可读中文 + 脱敏**，职责与 `llm/upstream.ts` 同层。

而**六条坑里没有一条是"猜"的** —— 全部来自读 SDK 源码（`client/index.js`、`client/streamableHttp.js`、
`shared/protocol.js`）再拿夹具**实测确认**：

| # | 事实 | 症状为什么难发现 |
|---|------|-----------------|
| 1 | SDK 把请求版本**写死** `2025-11-25`（无 setter） | 设计文档写的是 `2025-06-18`；以为"能配"，其实不能 |
| 2 | SDK 把**任意**中断原因包装成 `McpError(RequestTimeout)` | "用户点停止"被显示/断言成"上游超时" |
| 3 | 会话无效时服务端回 **404**（与"路径写错"**同码**） | 排查被引向 `endpoint_url`，真因是 `mcp-session-id` 丢了 |
| 4 | `Client.close()` **不终止会话**（只 `transport.close()`） | 服务端累积僵尸会话，我们**零症状** |
| 5 | `registerCapabilities()` 在 connect **之后**调用**直接抛** | 想在 `connect()` 里顺手声明能力 ⇒ 启动即失败 |
| 6 | `StreamableHTTPError` **不设 `name`**（是 `'Error'`） | `err.name === 'StreamableHTTPError'` 永假 ⇒ 分类整条走空 |

---

## 1. 架构决定：**一条壳 + 显式投影**

`McpClient` 对外只暴露四个动作，**没有任何一个把 SDK 的类型签名透出去**：

| 动作 | 出口类型 | 说明 |
|------|---------|------|
| `connect()` | `void` | 握手 + 记录协商结果；可带 `sessionId` 跳过握手（恢复会话） |
| `listTools()` | `McpToolDescriptor[]` | 四键恒存在（`name`/`description`/`inputSchema`/`annotations`），缺失落 `null` |
| `callTool(name, args, opts)` | `McpToolResult` | `{ content, structuredContent, isError, raw }` |
| `close()` | `void` | **先 `DELETE` 终止会话、后 `close`**（见 §5） |

**为什么出口要"显式投影"而不是把 SDK 对象直接返回**：SDK 的 `Tool` / `CallToolResult` 类型会随版本漂移，
一旦调用点持有它，**SDK 升级 = 我们的调用点跟着改**。投影层是唯一能容纳这种漂移的地方。

两条刻意的"不做"（各属后续批次，写在这里防误改）：

- `inputSchema` **原样透传**：剥 `$schema` / 补 `type:'object'` / 非 object 根包一层 —— **全属 P0-2-6**（`toolSchema.ts`）。
- 不认识的 content 块**不丢**：推成 `{ type: 'unknown', raw }` 而不是静默丢弃。

---

## 2. ⚠️ 坑一：协议版本**不是我们可控的东西**

### 事实（读源码 + 实测）

SDK 1.30.1 在 `client/index.js#connect` 里用**写死**的常量发首包：

```js
// @modelcontextprotocol/sdk/dist/esm/shared/protocol.js
export const LATEST_PROTOCOL_VERSION = '2025-11-25'   // ← 请求版本，无 setter
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
```

而 `mcp-protocol-version` 这个头**只在 `_protocolVersion` 有值时**才发 —— 首包 `initialize` **不带**（正确），
此后每条都带**服务端回的那个版本**。

### 定案：**"请求最新、接受降级、协商结果留痕"**

设计文档 `docs/06` §4.0 原本写"协议 `2025-06-18`"。**不能改 SDK 的请求版本**，于是正确落法是：

1. 请求最新（`2025-11-25`，SDK 决定）；
2. 服务端回 `2025-06-18`（= 设计目标）时 **SDK 接受**，此后每条都带 `mcp-protocol-version: 2025-06-18` —— **行为与设计一致**；
3. 服务端回一个**不在支持集内**的版本 ⇒ SDK 抛裸 `Error`（消息含 `protocol version is not supported`）⇒ 我们翻成 **502** 并列出支持集。

`connect()` 成功后打一条 info 日志，把三件事一起留痕：`requestedProtocolVersion` / `negotiatedProtocolVersion` /
`matchesDesignTarget`（外加 `hasSession` / `serverInfo`）。**恢复会话时**（传了 `sessionId`、跳过握手）改为打
「MCP 会话已恢复（未重新握手）」，**并接受调用方传入的 `protocolVersion`**（见 §7）。

`docs/06` §4.0 第 1 条**已按实测订正**。

---

## 3. ⚠️ 坑二：中断与超时**不能靠错误码分开**

### 事实

SDK 在 `shared/protocol.js#cancel` 里把**任意**中断原因都包成同一个错误码：

```js
// reason instanceof McpError ? reason : new McpError(ErrorCode.RequestTimeout, String(reason))
```

⇒ 用户点"停止"传进来的 `AbortSignal` 触发时，调用方看到的是一个 **`McpError(RequestTimeout)`**，
与"真的等超时了"**逐字无法区分**。

### 定案：**顺序即正确性**

`toMcpFailure(error, context)` 的判定顺序是**刻意排的**，`context.aborted` 必须排在 `isMcpError` **之前**：

| 序 | 判定 | 结果 |
|---|------|------|
| ① | `isAppError(error)` | 原样放行（已经是本仓错误码） |
| ② | **`context.aborted`** | ⇒ `McpAbortError`（用户停止 / 调用方主动取消） |
| ③ | `isMcpError(error)` | `-32001` ⇒ `upstreamTimeout`；其余 ⇒ `upstreamError` + 码表提示 |
| ④ | `isStreamableHttpError(error)` | 按 §6 的形状识别 |
| ⑤ | `rawMessage.includes('protocol version is not supported')` | ⇒ 502 + 支持集 |
| ⑤' | `SyntaxError` | ⇒ 响应不是 JSON（多半不是 MCP 端点） |
| ⑤'' | `isSchemaError(error)` | ⇒ 响应 JSON 但不符契约 |
| ⑥ | `describeCauseChain(error)` 命中 `NETWORK_CODES` | 按 `ENOTFOUND`/`ECONNREFUSED`/… 给可执行文案 |
| ⑦ | 兜底 | `upstreamError` |

**取证**：D2 —— 注入一个 `stall` 模式的上游、点"停止"，中断在 **151ms** 内返回且抛的是 `McpAbortError`
（不是 `UPSTREAM_TIMEOUT`）；D1 —— 注入 500ms 超时，错误码是 `UPSTREAM_TIMEOUT`、2s 内返回。

> 判据来源：这是 **P0-1-23（校验必须排在删除之前）** 与 **P0-1-26（收尾清必须在释放锁之前）** 的**同一条原则**
> —— **顺序即正确性**。凡是"两个东西共用一个信号，只能靠顺序分开"的地方，顺序就是契约。

---

## 4. ⚠️ 坑三："会话丢了"会**伪装成**"端点不存在"

### 事实

MCP 的 Streamable HTTP 规范要求：服务端在**会话无效**时回 **404**。而"路径写错 / 这个地址根本没有 MCP 端点"
**也是 404** —— **同码** ⇒ 默认提示会把排查方向引向 `endpoint_url`，而真因是 `mcp-session-id` 丢了或过期。

### 定案：加一条**内容判据**

`describeHttpFailure` 里 `code === 404` 分支**多看一步**：若响应体匹配 `/session/i` ⇒ 改口说
"多半是会话丢了：Streamable HTTP 用 404 表示『这个会话不存在』（与『路径不存在』同码）"。

**这条能写出来，是因为夹具回显了自己拒掉的那个 session id** —— 假 server 的 `setSessionRequired(true)` 在
缺 `mcp-session-id` 时回 404，**body 里带上被拒的 session id**（D9 断言）。

---

## 5. ⚠️ 坑四：`Client.close()` **不终止会话**

### 事实

SDK 的 `Client.close()` 只做 `transport.close()`（关掉本地连接），**不发 `DELETE`** ⇒ 服务端那侧的会话
**一直留着**，累积成僵尸会话，而客户端**零症状**（不报错、日志干净）。

### 定案：`McpClient.close()` 固定「**先 `DELETE`、后 close**」

```
hadSession = (protocolVersion !== null)   // 真握过手才需要终止
if (hadSession) await terminateSession()  // 失败只 warn，不抛
await inner.close()                       // 失败只 warn，不抛
```

`closed` 标志保证**幂等**，且 `close()` **永不抛**（收尾路径上抛错会掩盖真因）。

**取证**：F1/F2 —— 夹具的 `terminated[]` 记下收到的 `DELETE`；断言"关过之后，服务端侧恰好多了一条终止记录"。

---

## 6. ⚠️ 坑五：`registerCapabilities()` 的**时序**

### 事实

SDK 的 `registerCapabilities()` 在 **connect 之后**调用会**直接抛**：

```
Cannot register capabilities after connecting to transport
```

⇒ 想在 `connect()` 里"顺手声明 elicitation 能力"会让启动当场失败。

### 定案

- 能力声明**只在构造函数里**做，且**只在真的传了 `onElicit` 时**才声明（`registerCapabilities({ elicitation: {} })`）。
- **声明了却答不出来，比不声明更难查** —— 服务端会照发 `elicitation/create` 请求，而我们静默失败。
  所以"能力声明必须与实际相符"。

**E 组**把「服务端反向发 `elicitation/create` → 客户端应答 → 服务端收到」这条**完整往返**验了（需求 27 的那一半）。
**在 P0-2-1 就验它，比等到 P0-2-10 才发现接不上便宜得多。**

---

## 7. 三条"读源码才知道"的细节

### 7.1 `StreamableHTTPError` **不设 `name`**

它是个普通 `class extends Error`，**没有** `this.name = 'StreamableHTTPError'` ⇒ `err.name === 'StreamableHTTPError'`
**永假**。只能按**形状**认：有 `code: number` 且 `message` 以 `'Streamable HTTP error: '` 开头。

`describeHttpFailure` 里最值钱的一条是 `code === -1`：SDK 明说"不认识的 content-type" ⇒ 我们写
"大概率这个地址**不是** MCP 端点（常见：网关回了一个 HTML 页面或登录页）"。

### 7.2 `fetch` 连不通抛 `TypeError: fetch failed`，**真因在 `.cause` 链上**

```js
// Undici 的形态：TypeError('fetch failed') → .cause = Error('getaddrinfo ENOTFOUND …') { code: 'ENOTFOUND' }
```

⇒ `describeCauseChain()` 顺着 `.cause` 往下走，命中 `NETWORK_CODES`
（`ENOTFOUND`/`EAI_AGAIN`/`ECONNREFUSED`/`ECONNRESET`/`EPIPE`/`ETIMEDOUT`/`UND_ERR_*` …）才给可执行文案。
**只看最外层 `TypeError` 的 message 是什么都读不出来的。**

### 7.3 我们的头**合并在最后**

`_commonHeaders()` 是 `{ ...auth, ...sessionId, ...protocolVersion, ...extraHeaders }` ⇒ **我们传的 `extraHeaders`
排在最后、优先级最高**。所以：

- 不许把三个保留头（`authorization` / `mcp-session-id` / `mcp-protocol-version`）塞进 `requestInit.headers` —— 会被 SDK 内部逻辑覆盖或冲突；
- 凭据（P0-2-7 的 `Authorization`）**恰恰应该**经 `extraHeaders` 注入（P0-2-7 的接回点）。

---

## 8. ⚠️ 已**证伪**的坑预判：`allowBuilds` 不需要登记

P0-1-1 留下的坑预判说"新增 native-ish 依赖要登记 `pnpm-workspace.yaml` 的 `allowBuilds`"。
本批 `pnpm --filter @doubulea/backend add @modelcontextprotocol/sdk@^1.30.1` 输出 `Packages: +75 -72`，
**未报** `ERR_PNPM_IGNORED_BUILDS` —— SDK **没有 install 脚本**（纯 TS/JS，无 postinstall 编译）。

> ⚠️ 这一条要写下来，否则下一个人会"预防性地"往 `allowBuilds` 里登记一个不需要的包。

---

## 9. 错误翻译层**刻意不 import SDK 的运行时导出**

`SUPPORTED_PROTOCOL_VERSIONS` 与 `MCP_ERROR_CODE_REQUEST_TIMEOUT` 在 `errors.ts` 里**各写死一份**，
不 `import` 自 SDK。理由写在注释里：

> 否则 **SDK 升级 ⇒ 我们的文案跟着变** —— 一个"支持集"的展示文案，不该由第三方包的导出决定。

代价：支持集漂移时要手动跟（当前 SDK 1.30.1 的五个版本已核对一致）。

---

## 10. 本批的取证方式与边界（诚实标出）

| 事项 | 证据 | 边界 |
|------|------|------|
| 代码正确性 | `pnpm verify:mcp-client` **34 项全通过**（真起假 MCP server + 直接 import 构建产物） | 上游是**本仓夹具** ⇒ 只证"契约与配置接对了" |
| 静态质量 | `lint` + 三包 `typecheck`/`build` 全绿 | `typecheck`/`build` 退出码可能是沙箱拦 pnpm 临时目录清理的**假失败** ⇒ 看输出 `Done` / `✓ built` |
| 批次一致性 | `pnpm check:batch` 一致（`docs/06` 最后一个 `[✓]` = P0-2-1 = `index.ts` 的 `step`） | — |
| 真 MCP server | **没有验** | 连真 server 属 P0-2-2 之后的命令行档 |
| 端测 | **本批不是端测里程碑**（无界面、无路由） | `docs/06` §4.4 的第一个端测点在 P0-2-2 之后 |

⚠️ **本档不需要 PG / Redis**：`mcp/client.ts` 只依赖 `config` + `infra/logger.js` —— 客户端层"不认识数据库"
是设计上的硬约束，于是 `verify:mcp-client` 成了本仓**第一档"只要 dist + `infra/.env`"**的第四档验收。
**这是把"分层是否真的分层"变成可执行断言的一个副产品。**

---

## 11. 一句话给下一个动这一块的人

> **SDK 的行为真相必须读源码 + 拿夹具实测确认，别信"文档说能配"。**
> 本批六条坑全部来自"读源码发现问题 → 写夹具确认 → 把判据写进注释与断言"这个循环；
> 而 `toMcpFailure` 的**判定顺序**与 `close()` 的**两步顺序**是这一层唯二"写反了会静默出错"的地方 ——
> **顺序即正确性**（P0-1-23 / P0-1-26 的同一条原则，第三次应用）。
>
> **接下来**：P0-2-2 建 `mcp_servers` 表 + CRUD（`docs/06` §四，前置 = P0-2-1）；
> `assertComponentRefsBindable` 的 MCP 那一半（P0-1-23 留的接回点）在那里兑现。
