# 问题记录 — P0-2-2 MCP server 注册 CRUD + 连通测试（`mcp_servers` 表 / 六条路由 / 工具缓存读侧）

> 批次：P0-2-2（**P0-2 工具闭环的第 2 步**；`docs/06` §四 的 `[✓]` 到此为止，进度 2/12）
> 日期：2026-09-24
> 来源：**后端** 新增档 `pnpm verify:mcp-servers`（**31 项全通过**：A 权限 6 / B 连通与缓存 8 / C 删除守卫 / D 注册不强制连通 / E 端点与模板 / F slug 与缓存的纯函数 7，起一个**假 MCP server** 当上游）；另有 `verify:app` **128 项** / `verify:agents` **35 项** / `verify:agent-package` **13 项** / `verify:model-providers` **18 项** 全通过 + `pnpm lint` / `pnpm -r build` 三包 Done + `pnpm check:batch` 一致
> 🎯 **本批是 P0-2 的第一个命令行端测里程碑**：`文档` 里的 curl 跑法见 `README`「手工端测 · 命令行」**⑳**（注册 server → `POST /:id/test` 拿 `tools/list` → `GET /:id/tools` 看工具清单）
> ⚠️ **本批不做智能体侧端测**（用户 2026-09-23 定案）：证据只到「契约与配置接对了」这一层，**不等于**"连真 MCP server 一定对"（上游是本仓夹具）

---

## 0. 一句话结论

**本批把"一个 server 怎么进来、怎么被证明通、它的工具清单从哪来"这三件事钉成了可断言的契约。**

> `shared/src/mcp.ts` 是**契约唯一落点**（四段投影 + 三段请求 + slug 纯函数）；
> `backend/src/mcp/toolCache.ts` 是**工具缓存的编解码**（**不 import 任何运行期模块** ⇒ 能被无依赖档断言）；
> `backend/src/services/mcpServer.service.ts` 是**唯一判据中心**（权限、探测、缓存失效、删除守卫）；
> `backend/src/routes/mcpServers.ts` 只是**六条路由 + 挂 `requireAuth`**，一个 `requireAdmin` 都没有。

**四条坑里最值钱的一条是"连通测试恒 200"** —— 它把"一个可用结论"和"一个错误"在结构上分开了；
**最容易被忽略的一条是"缓存失效判据必须是'真的变了'"** —— 用 `JSON.stringify` 直比会产生**假阳**，
每次保存都白清一次缓存，而**没有任何症状**。

---

## 1. 交付物与它落在哪一层

| 文件 | 职责 | 一句话 |
|------|------|--------|
| `shared/src/mcp.ts` | **契约** | `MCP_AUTH_TYPES`(`NONE`/`OAUTH`) / `MCP_SERVER_STATUSES`(`UNKNOWN`/`OK`/`ERROR`) + slug 纯函数 `slugifyServerName`/`uniqueSlug` + `mcpToolDescriptorSchema` + `normalizeCredentialSchema` + 投影四段（item/列表/create 结果/test 结果/tools 结果） + 请求侧三段 |
| `backend/src/mcp/toolCache.ts` | **编解码** | `McpToolCache` 形状 + `parseToolCache`（**读不出来一律 `null`、整体作废**）+ `buildToolCache` + `toolCountOf`。**不 import 任何运行期模块** |
| `backend/src/services/mcpServer.service.ts` | **判据中心** | 列表 / 建 / 改 / 删 / **测试连通** / 工具列表读侧，六个导出函数 + 一组内部助手 |
| `backend/src/routes/mcpServers.ts` | **路由** | 六条，**全部 `{ preHandler: app.requireAuth }`** |
| `backend/scripts/verify-mcp-servers.mjs` | **验收** | 31 项，真 PG + Redis + 假 MCP server |

**六条路由与它们的信封（第五族形态）**：

| 方法 | 路径 | 信封 |
|------|------|------|
| `GET` | `/api/mcp/servers` | `{items,total,offset,limit}`（同 `/api/users`、`/api/knowledge-bases`） |
| `POST` | `/api/mcp/servers` | **`{server,test}`**（裸 item + 一次 best-effort 探测结论，**不是 201**） |
| `PATCH` | `/api/mcp/servers/:id` | 裸 `McpServerItem` |
| `DELETE` | `/api/mcp/servers/:id` | `{id,name}`（同"删 Provider"口径） |
| `POST` | `/api/mcp/servers/:id/test` | **恒 HTTP 200** + `{ok:true,tools}` / `{ok:false,error}` |
| `GET` | `/api/mcp/servers/:id/tools` | **裸** `{tools,fetchedAt,cached}`（本批纯读缓存、**绝不联网**） |

> ⚠️ **顺手订正一处注释笔误**：`mcpToolDescriptorSchema` 的注释原写「**四个**契约键」却列了五个，
> 而对象里其实有**六个**（`name`/`title`/`description`/`inputSchema`/`annotations`/`hasOutputSchema`）。
> 这个笔误从 P0-2-1 就在（`client.ts` 的本地 interface 与注释同病），本批把类型搬到 `shared` 时把它改成
> 「六个键恒存在」，`client.ts` 的引用注释同步。**纯注释、不改行为**。

---

## 2. 权限第五族：**登录即可、无 owner 列收窄**

`06` §4.2 把这一族定得很清楚：`/api/mcp/**` 一律"登录即可"，**最接近 knowledge-bases** ——
同样是"人人可见的共享资源"。五族的差别：

| 资源 | 路由挂什么 | 判据 |
|------|-----------|------|
| `/api/users`、`/api/model-providers`、`/api/models` | `requireAdmin` | 端点级 |
| `/api/knowledge-bases`、**`/api/mcp/servers`** | **`requireAuth`** | **无 owner 列** |
| `/api/agents` | `requireAuth` + **行级判定** | `01` 决策 18（创建者 + ADMIN） |
| `/api/conversations` | `requireAuth` + **行级判定** | 仅创建者本人（连 ADMIN 无后门） |

⇒ **一个 `requireAdmin` 都没有**，而且**刻意不做**"只有创建者能改/删"的收窄：
`mcp_servers.created_by` 只是**留痕**（界面显示"谁注册的"），**不参与判定**。

**代价是显式承认的**：任何登录用户都能改/删别人注册的 server —— 这是 `01` 决策 22 的直接推论，
**要收紧得先改 `01`/`02`，本批不自行发明权限模型**。P0-2 的收窄落在**凭据**上
（`/api/mcp/credentials` 只能动自己的，属 P0-2-4），**不在 server 上**。

**验收用了两条反向守卫盯着它**（否则"顺手加 `requireAdmin`"照样绿）：

- A2：**B 能改 A 建的** server ⇒ 200；
- A4：**B 能删 A 建的** server ⇒ 200。

两个操作用户**都是 MEMBER**（不是 ADMIN）—— "ADMIN 能建"在加了 `requireAdmin` 后**依然通过**，验不出问题
（P0-1-15 起就记过的老坑）。

---

## 3. ⚠️ 坑一：连通测试**恒 200** + 缓存的两条副作用

### 事实

`POST /api/mcp/servers/:id/test` 的语义是"**探活端点自身是请求成功**"（与 `02` §4.9 的 `/health` 同源口碑）：

- 成功 ⇒ `200` + `{ok:true, tools:[…]}`，**顺手把工具写进 `tool_cache`**（并置 `status='OK'`）；
- 失败 ⇒ **仍然 `200`** + `{ok:false, error:"…可读原因…"}`，且 **`tool_cache` 一个字节都不动**；
- 只有 **id 不存在** ⇒ `404`（那是"**请求本身**的问题"，不是"这个 server 通不通"）。

### 为什么不能映射成 502/504

`ok:false` 是一条**信息**（这个 server 现在通不通），不是一个错误。把它映射成 502 会让界面把
"一个可用的结论"渲染成"一个错误"⇒ 用户看到一个红色的失败态，而**其实只是上游现在连不上**，
正是 test 这个端点存在的意义。

### 两条副作用的方向是**相反**的（这是坑）

- **成功**刷新缓存（否则"通了但工具列表还是空的"）；
- **失败什么都不动**（否则一次网络抖动就把**上一次成功**拿到的工具清单抹掉 —— 用户会以为 server 坏了）。

**验收取证**（B 组 8 项）里最要紧的一条：**先让 test 成功一次**（缓存里有东西），
再用**故障注入**（`upstream.setFailing(true)`）让下一次 test 失败，然后断言 `tool_cache` **逐字不变**。
> ⚠️ 这里**不能**用"把 `endpointUrl` 改坏"来造失败 —— 改 `endpointUrl` 会**先清缓存**
> （§4），断言就落在**空缓存**上了，验不出"失败不动缓存"。

---

## 4. ⚠️ 坑二：缓存失效判据是"**真的变了**"（jsonb 键序）

### 事实

`endpointUrl` / `credentialSchema` / `authType` **任一变了** ⇒ **必须清 `tool_cache`**
（"改了 endpoint、工具列表还是旧 server 的"就是这么来的）。
但**只改 `name` 不动 slug、也不清缓存**（name 不参与连通，清了只会让用户白等一次重拉）。

### 坑在哪

判"变没变"要拿**提交值**与**库里现值**比。而 `credentialSchema` 是 **jsonb**：
PG 会把对象键**按"长度 + 字节"重排**（实测库里的键序变成
`key,type,label,inject,required,placeholder` —— 与提交时的字面量顺序**不同**）。
于是：

- 用 `JSON.stringify(a) === JSON.stringify(b)` 直比 ⇒ **恒 false**（键序不同）⇒ **每次保存都白清一次缓存**；
- 症状：改个名（或什么都没改）也会让工具列表被清空、下次要重新探测 —— **没有任何报错**。

**定案**：`sameJson(a,b)` 做**键序无关**的深度比较（对象按键排序后比、数组保持顺序）。

### 验收关键手法：先证明"PG 真的重排了键"

F6 用例是"原样提交不清缓存"。如果只是**想当然**地认为 PG 会重排，而实际**没重排**，
这条断言就是**空转**（两种实现都过）。所以验收里**先断言库里的键序确实是重排过的那个顺序**，
再验"原样提交 ⇒ 缓存逐字不变"。**"证明前提真的成立"是这类断言的另一半**。

---

## 5. ⚠️ 坑三：`endpoint_url` 是 **SSRF 面**

任何登录用户都能注册一个 server，让后端去**连任意地址**。P0 的处置是**只校验 scheme**：

- `mcpEndpointUrlSchema` 用**字段级 `superRefine`** 自判 `http:`/`https:`（拒 `file:`/`gopher:` 之类）；
- **不做**内网地址黑名单 / 端口白名单 / DNS 重绑定防护 —— 那属 **P1 安全加固**。

**这是已知且刻意**的边界，已写进 `docs/02` §4.7 的 ⚠️ 与 `README` 的「已知边界」，
⇒ 本阶段"能给后端指哪它就连哪"**不是 bug**。**接回点**：scheme 校验那一处换成安全校验器即可，接口形态不变。

---

## 6. ⚠️ 坑四：P0-1-23 的接回点 = **翻转**而不是删掉

P0-1-23 时 `assertComponentRefsBindable` 对 `MCP` 引用**一律回 400**（那时 `mcp_servers` 表还不存在，
收到的必然是伪造 id）。本批表建好了，接回点兑现 = **同一个函数里把"一律 400"换成"存在性校验"**，
**接口形态一个字不变**。

**危险的是"顺手把旧断言删掉"**：`verify:agents` / `verify:agent-package` 里各有一条
"引用不存在的 MCP server 必须被拒"的对偶断言，必须**翻转**它并**各补一条正面用例**：

- 反面对偶 ⇒ 引一个**不存在**的 MCP id ⇒ **404**（不是 400 了）；
- 正面新增 ⇒ 先 `prisma.mcpServer.create(...)` 造一个真 server ⇒ PUT 绑定 ⇒ **200** + 两种类型都在。

> ⚠️ **只做前半（把 400 改成 404）而不补正面用例**，一个"**一律 404**"的实现也照样全绿。
> 这正是 P0-1-23 那条「翻转要留痕迹」的第二次应用。

---

## 7. 验收脚本**自己**踩的三条

### 7.1 造"连接被拒绝"不能用 `http://127.0.0.1:1/mcp`

端口 **1**（以及 7、9 等）属 **fetch 规范的 bad port** —— `undici` 在**发包之前**就拒掉，
错误原因链是 `fetch failed ← bad port`，**根本走不到 TCP** ⇒ 验不到"连接被拒绝"的翻译层。

**处置**：先 `startFakeMcpServer({})` 拿一个**真端口**、`close()` 掉，再把它当 `endpoint_url`
（`UNREACHABLE_URL`）—— 这样才是"端口在、没人听"。
（已写进脚本注释与 `docs/06` 的落地要点。）

### 7.2 中文名会被 `slugify` 整段折掉 ⇒ 多用例**共用同一族 slug**

早先的用例都叫"验证 MCP-01-\<suffix\>"这类中文名，`slugifyServerName` 把它们**整段折成** `mcp-<suffix>`
—— 于是它们**共用同一族 slug**，序号一路涨到 `-9`，把"这个 case 应该拿 `-8`"的断言撞翻。

**处置**：需要独立序号的用例改用**专属 ASCII 名字族**（`verify-dup-${suffix}`）。
> **"中文名靠序号区分"是设计内行为**（slug 要进工具名，可读性交给 `name`），不是 bug。

### 7.3 顺手修掉一条**历史欠账**

`verify:app` 里的 Provider 投影夹具**漏了 P0-1-37 加的必填 `protocol`**，这条断言**一直红着**
而没人看见 —— 因为打真端点的 `verify:model-providers` 全绿，正好把它**遮住**。
本批把它补成**真断言**（必填 + 取值域 + 键集合含 `protocol`）。

> **教训（第三次同族）**：夹具与契约会**各自漂移**；"打真端点的档绿"不代表"无依赖档也在验同一件事"。

---

## 8. 本批的取证方式与边界（诚实标出）

| 事项 | 证据 | 边界 |
|------|------|------|
| 代码正确性 | `pnpm verify:mcp-servers` **31 项全通过**（真 PG + Redis + **假 MCP server**） | 上游是**本仓夹具** ⇒ 只证"契约与配置接对了" |
| 不回归 | `verify:app` 128 / `verify:agents` 35 / `verify:agent-package` 13 / `verify:model-providers` 18 全通过 | — |
| 静态质量 | `lint` + 三包 `typecheck`/`build` 全绿 | 退出码可能是沙箱拦 pnpm 临时目录清理的**假失败** ⇒ 看输出 `Done` / `✓ built` |
| 批次一致性 | `pnpm check:batch` 一致（`docs/06` 最后一个 `[✓]` = P0-2-2 = `index.ts` 的 `step`） | — |
| 命令行端测 | `README`「手工端测 · 命令行」**⑳**（注册 → test → tools） | 由**用户人工**执行（2026-09-23 定案：智能体不代跑） |
| 真 MCP server | **没有验** | 连真 server 不在本批范围；④ 假上游已是本仓惯例 |
| 界面 | **本批无界面**（`/mcp` 管理页属 P0-2 后续） | — |

**不需要 MinIO**（server 元数据只在 PG），但**需要 Redis**（会话/登录态）。

**明确的边界（都不是 bug）**：

- `created_by` **不参与判定** ⇒ 别人建的 server 你能改能删（`01` 决策 22）；
- `POST /:id/test` **不带用户凭据**（"注册者视角"，P0-2-5 定案）⇒ 有些 server 的 `tools/list`
  也要求鉴权，那时会**如实报 `ok:false`**；
- `authType:'OAUTH'` ⇒ **400 + 文案指向 P1**（OAuth 属 P1）；
- 凭据 CRUD（`/api/mcp/credentials`）属 **P0-2-4**、工具名转换（`mcp_{slug}_{toolName}`）属 **P0-2-6**。

---

## 9. 一句话给下一个动这一块的人

> **"连通测试恒 200"不是一个偷懒的取舍，而是"把结论与错误在结构上分开"** ——
> 凡"探活类"端点（`/health`、`/:id/test`）都该这样：**结论进 body，只有"请求本身错了"才给 4xx**。
>
> **"缓存只在真的变了才失效"这一条，"变没变"必须键序无关地比** ——
> jsonb 往返会重排键，直比就是**假阳**；而假阳的代价是**每次保存都白清缓存**、且**零症状**。
> 写这类断言时，**先证明前提（PG 真的重排了键）再验结论**，否则断言在空转。
>
> **接下来**：P0-2-3 是凭据模板的深度校验（`validateCredentialSchema` → `{ok,issues}`），
> 接回点就在 `credentialSchemaEntrySchema` 的注释里 —— 本批只做了**形状**，`key` 的合法性
> 与同一模板内重复 `key` 的字段级报错都留给它。
