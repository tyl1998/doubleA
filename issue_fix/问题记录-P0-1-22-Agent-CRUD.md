# P0-1-22 Agent CRUD（软删三件套 / 绑定校验 / 创建者+ADMIN 权限）

> 对应 `docs/06-实施计划.md` 的 P0-1-22（**包 E 第 1 步**，E 包 1/3）。按批次工作流的约定记录
> **现象 / 根因 / 对策**与**原始输出**；`docs/06` 只留一行指针。

## 概况

| 项 | 内容 |
|----|------|
| 批次 | P0-1-22 Agent CRUD（`[✓]` 2026-09-22，包 E 起步） |
| 新增文件 | `shared/src/agent.ts`、`backend/src/services/agent.service.ts`、`backend/src/routes/agents.ts`、`backend/scripts/verify-agents.mjs` |
| 改动文件 | `shared/src/index.ts`（导出）、`backend/src/app.ts`（装配）、`backend/src/index.ts`（启动信封 `step`）、`backend/scripts/verify-app.mjs`（+第 24 节，79→85 项）、两个 `package.json` |
| 新增依赖 / 环境变量 | **零** |
| 验收 | `pnpm verify:agents` **26 项全通过**；`verify:app` **85 项**（CI 86 项）；**既有 17 档全部未回归** |
| 真问题 | 3 个（下面坑 1/2/3）；另有 2 处"口径写反会静默出错"的地方（坑 4/5） |

---

## 坑 1 ⚠️ `USER_ROLES[0]` 这种写法：读的人要数索引，改的人一重排就**静默**把管理员判成别人

**问题**：`canEditAgent` 的第一版是

```ts
if (viewer.role === USER_ROLES[0]) return true   // ← 谁是第一个？
```

它对运行时**完全正确**（当前 `USER_ROLES` 是 `['ADMIN','MEMBER']`）。错的是它的**脆弱性**：
判据的语义（"是不是管理员"）被藏在了数组顺序里 —— 哪天有人为了"界面上先列 MEMBER"而重排
`USER_ROLES`，**没有任何编译错误、没有任何测试会红**（本批的断言只验"ADMIN 为真"，
重排后 `USER_ROLES[0]` 变成 `'MEMBER'`，那么"谁都改不了"，恰好也会让某几条断言红 ——
但如果重排成 `['MEMBER','ADMIN']` 后又有人把断言里的 `'ADMIN'` 跟着改成 `USER_ROLES[1]`，
整条链就一起漂走了）。

**对策**：写成**带类型标注的字面量**：

```ts
const ADMIN_ROLE: UserRole = 'ADMIN'
```

好处两头都占：① 一眼看得出判的是哪个角色；② `USER_ROLES` 里删掉 `'ADMIN'` 时**编译报错**
（`'ADMIN'` 不再是 `UserRole`）—— 而 `USER_ROLES[0]` 在任何情况下都不报错。

> 通用教训：**凡是"用下标取枚举含义"的地方，都是把语义藏在顺序里**。本仓另一处同类是
> `AGENT_TYPES[0]` 之类的写法 —— 建 body 的 `type` 因此**刻意不给 `.default()`**，
> 逼调用方显式说明要哪种（见坑 5）。

## 坑 2 ⚠️ `.refine()` 的校验失败 **path 是空串** —— 前端拿不到"挂到哪个字段上"

**问题**：`updateAgentBodySchema` 用 `.refine()` 表达"至少要提供一个要修改的字段"：

```ts
.refine((body) => /* 至少一个字段 !== undefined */, { message: '至少要提供一个要修改的字段' })
```

验收里断言"空 body → 400 且文案可读"时才发现：**顶层 `msg` 恒为「请求参数校验失败」**
（本仓的既定契约，不允许被逐条文案覆盖），真正的文案在 `data.fields[].message` 里；
而 `.refine()` 产生的 issue **`path` 是空数组** ⇒ `data.fields[].path` 是**空串**。

**后果与对策**：这条错误在界面上**无法挂到某个输入框**（它是"表单级"而不是"字段级"错误）。
三条选择，本批选了第一条：

1. **接受它是表单级错误**（`path: ''`）—— 验收断言改成**遍历 `message` 找那句话**，
   而不是 `fields.some(f => f.path === 'body.xxx')`。这条断言现在明确写着原因注释，
   免得下一个人"顺手"把 `path` 断言补上然后红一天。
2. 改用 `superRefine` 并显式 `ctx.addIssue({ path: [...], ... })` —— 但那会**编造一个字段**，
   而"哪个字段漏了"本来就是不确定的。
3. 把"至少一个字段"交给服务层判（`if (Object.keys(body).length === 0) throw AppError.validation(...)`）
   —— 但那会把校验从契约层挪到服务层，前端拿不到同一份判据。

> 通用教训：**`.refine()` 适合"对象级"约束，但它的错误天然没有 `path`**。
> 凡是前端要**逐字段高亮**的错误，都得用 `superRefine` + `addIssue({ path })`。

## 坑 3 ⚠️ Fastify 的 schema 校验跑在 `preHandler` **之前** —— 验"未登录 401"必须给**语法合法**的载荷

**问题**：验收"五条路由未登录一律 401"的第一版，`POST` / `PATCH` 用了**空 body**：

```js
['POST', '/api/agents', {}]        // ← 拿了 400，不是 401
```

因为 Fastify 的**路由级 schema 校验**在 `preHandler` 之前执行 ⇒ 空 body 先撞上
`createAgentBodySchema` 的必填项，**根本没走到 `requireAuth`**。这一条如果只是"断言写成 400"
就过去了，但它会把"鉴权是否真的挂上了"这件事**验成一个假的**（400 和 401 都说明"没进去"，
可原因完全不同：前者是参数问题，后者才是权限）。

**对策**：给**语法合法**的 body/params（用一个不存在的合法 UUID 作 `:id`）：

```js
['POST', '/api/agents', { name: '未登录', type: 'CHATBOT', modelId: MISSING_UUID }],
['PATCH', `/api/agents/${MISSING_UUID}`, { name: '未登录' }],
```

这样才真的走到鉴权分支。**顺序本身是有意设计的**（校验先于鉴权能让未登录的畸形请求不碰数据库），
所以要"适应它"而不是"改掉它"。

> 同族的既有记录：P0-1-7 的"未登录出口"与 P0-1-16 的"四道前置校验"都吃过这个顺序。

## 坑 4 ⚠️ 软删**只打标记**会让绑过的知识库**永远删不掉** —— 且界面看不出来

**问题**：`02` §4.4 写的是「删除（**软删**：会话转只读保留、**组件绑定解除**）」。
"组件绑定解除"这半句极容易被当成"反正 Agent 都删了，绑定自然作废"而省掉 —— 但
`kb.service.ts` 的删库守卫数的是 `agent_components` 的行数（那是唯一能知道"这个库被谁用着"的地方）：

```ts
const refs = await db.agentComponent.count({ where: { componentType: 'KNOWLEDGE', refId: id } })
if (refs > 0) throw AppError.conflict(`该知识库正被 ${refs} 个智能体绑定…`)
```

于是**只打标记**的实现会造出这个状态：**界面上那个 Agent 已经"没了"，而它绑的知识库删不掉**，
提示还写着"正被 1 个智能体绑定" —— 用户点遍所有页面也找不到那个"幽灵"。

**对策**：软删做成**一个事务里的三件事**，并且**用一条链取证**（这是本批最想钉死的东西）：

```
建库 → 建 Agent 并绑定它 → 删库 → **409**（前置条件成立）
     → DELETE /api/agents/:id（软删）→ 再删库 → **200**（解绑真的发生了）
```

顺着这条链还钉了另外两件容易漏的：**`deleted_at` 真的被写入**、**行还在**（会话要挂在它上面，
`conversations.agentId` 是 FK，"物理删"会连会话一起带走或直接报错）。

**三件事的顺序**也刻意：**先 CAS 打软删标记**（`updateMany({where:{id, deletedAt:null}})`），
再解绑、再转只读。好处有两个：① 并发双击删除时第二条拿到 `count === 0` → 直接 404，
此时**还没改任何别的东西**，抛错回滚等于什么都没发生；② 之后的动作都作用在"已经删除的"那份数据上，
不存在"删到一半"的可见中间态。

## 坑 5 三处"写反了会静默出错"的口径（都没有编译错误、都不会 400）

### 5.1 绑定模型**不能**复用 `resolveChatTarget()` —— 那是"调用上游"的前置，不是"配置"的前置

`model.service.ts#resolveChatTarget()` 已经有一整套"这个模型能不能用"的校验，看起来正好能复用。
但它多一条：**Provider 没配 Key 就抛 424 `NEED_CREDENTIAL`**（因为它的调用方是 `chat()`，真要发请求）。

把它拿来校"绑定"会造成：**管理员必须先给 Provider 配 Key、才能建智能体** ——
而"配好 Key 再点连通性测试"才是正常顺序；结果是"我只想先把智能体建出来"被一个 424 挡住，
而修它的动作（配 Key）跟用户想做的事没关系。

**对策**：绑定校验**只三条**，与 `GET /api/models/available?type=CHAT` 的过滤条件**逐条对应**
（存在 + `type=CHAT` + 模型与所属 Provider 都启用），**不看 Key**。并且加一条
**一致性断言**：`available` 列表里出现过的 CHAT 模型必须都建得成、不在列表里的一律被拒 ——
两处口径各自漂移是本批最容易发生的事（"选的时候可选、提交时被拒"）。

### 5.2 **换绑才校验**：`modelId` 传同值必须放行（幂等）

若写成"body 里有 `modelId` 就校验"，那么当绑定的模型**事后被管理员停用**时：
用户打开编辑页 → 只改个名字 → 保存 → **409**。每次提交都撞，而他能想到的出路（换模型）
恰恰是他没打算做的事 —— 症状是"**这个智能体改不动了**"，且他不知道为什么（名字跟模型没关系）。

**对策**：`input.modelId !== undefined && input.modelId !== target.modelId` 才校验。
验收里有一条专守它：**模型事后被停用 → 改名仍必须 200，且 `modelAvailable` 变 `false`**
（后者是新加的字段，让界面能显示"绑的模型不能用了"而不是等用户发消息才炸）。

### 5.3 `type` **可传但不可改**：放进 schema 是为了把**静默 no-op 变成显式报错**

`03` §4.2 写明"类型创建后不可改"。若干脆把 `type` 从 `PATCH` 的 schema 里删掉，
zod 会把多余键**静默剥掉** ⇒ 调用方以为自己改成功了，实际什么都没发生（**能改回 409 的只有 409**）。

**对策**：schema 里保留 `type`，值不同 → **409**「智能体类型创建后不可修改。请新建一个智能体」；
值相同 → **200**（前端是整表单提交，"没改"不该失败）。

> 5.1~5.3 的共同点：**三条都不会让 lint/tsc/build 报错，也不会让"happy path"失败** ——
> 只在特定顺序下静默做错事。这也是为什么它们全部落进了 `verify-agents` 而不是只写在注释里。

---

## 两条**跨批次口径**的一致性（本批新引入、且必须与既有两个批次对齐）

### ① `canEditAgent` 的 `deletedAt` 收宽到 `Date | string | null`

服务端从 Prisma 拿到的是 `Date`，验收脚本从 JSON 里拿到的是 `string`（或 `null`）。
若把判据写成 `agent.deletedAt === null`，服务端与脚本都能用；但一旦有人写成
`!agent.deletedAt` 或 `deletedAt instanceof Date`，**就必然出现第二份实现**
（"服务端判"与"脚本判"分家）—— 而权限判据有两份实现，等于迟早有一份是错的。

**对策**：签名收宽到 `Date | string | null`，注释写明原因。判据仍是**唯一一份**
（`shared` 的 `canEditAgent`），服务端与验收脚本都 import 它。

### ② 软删的 Agent **仍占**模型的引用计数（与 P0-1-11 的删除守卫同口径）

`ModelItem.agentCount` 与"删被引用的模型 → 409"的守卫，数的是 **`agents` 表的行数**，
`where` 里**刻意不带 `deletedAt: null`**。理由是 `agents.model_id` 是 `ON DELETE RESTRICT`：
软删不解除这个引用，数据库层面确实删不掉（"软删 = 不再使用"是**业务**语义，不是**外键**语义）。

本批加了一条断言把这个口径钉在明处（"软删的 Agent 仍占模型的引用计数"）——
否则很容易有人觉得这是 bug 然后"顺手"给守卫加个 `deletedAt: null`，
改完 `psql` 里照样 `RESTRICT` 报错，症状变成"接口说能删、数据库删不掉"。

> 这条与 P0-1-15 的"删库先查 Agent 绑定"、P0-1-19 的"删文档先删 DB 再删 S3"是同一族：
> **连带关系不在一张表里时，一定要把口径显式写下来并跨批次对齐。**

---

## 验收原始输出（节选）

### `node scripts/verify-agents.mjs`（26 项，本批新增）

```
══ P0-1-22 智能体 CRUD 验收：软删三件套 / 绑定校验 / 创建者+ADMIN 权限 ══
  临时数据：verify-agent-admin-exn40t（ADMIN）+ verify-agent-owner-exn40t（MEMBER·创建者）+ verify-agent-other-exn40t（MEMBER·第三方）
  模型：可用 1 / 停用 1 / 向量 1 / Provider 停用 1；注入 embedding 快照 api:verify-embed-model

── A 组 · 投影 / 两种类型 / 列表排序（HTTP）──
  [PASS] 枚举同源：契约的 AGENT_TYPES / COMPONENT_TYPES 与数据库枚举**逐字一致**
  [PASS] 两种类型都能建（`03` §4.2 第 1 条）：ChatBot 与 TaskAgent 各建一个，字段全覆盖
  [PASS] `type` 必填、`modelId` 必填且必须是 UUID（缺参数给的是**字段级**明细）
  [PASS] 列表是**全员**的，且 `canEdit` 三个方向都对（自己真 / 他人假 / ADMIN 真）
  [PASS] 列表排序是 `updatedAt desc`：刚改过的排最前（不是"最近创建"）
  [PASS] 详情：非法 uuid → 400（`params.id` 明细）；不存在的 uuid → 404

── B 组 · 绑定模型：与"可选列表"同口径（停用 / 类型 / Provider 停用 / 不存在）──
  [PASS] 绑定 **disabled** 模型被拒（验收门槛）：409 + 文案指出"停用"与去哪儿修
  [PASS] 绑定向量模型 / Provider 停用的模型 / 不存在的模型：分别 409 / 409 / 404
  [PASS] **一致性断言**：可选列表里的 CHAT 模型必须建得成，不在列表里的一律被拒（防两处口径漂移）
  [PASS] 换绑只在 `modelId` **变了**时校验：模型事后被停用 → 仍能改名，且 `modelAvailable=false`

── C 组 · 权限：创建者 + ADMIN 可编删，其余 403 ──
  [PASS] 第三方**普通用户** PATCH / DELETE 他人的 Agent → 403（本批验收门槛）
  [PASS] 创建者本人能改能删（反向守卫：防"只有 ADMIN 能改"的实现）
  [PASS] ADMIN 能改**别人**的 Agent（反向守卫：防"仅创建者"的实现）
  [PASS] 五条路由未登录一律 401（且不碰会话存储）

── D 组 · 三态与字段覆盖（响应对 + 库里也对）──
  [PASS] 四个文本字段是**三态**：不带=不动 / `null`=清空 / 值=设置（库里逐字段核对）
  [PASS] `guideQuestions`：`[]` 清空 / 不带不动 / 真写进 jsonb / 四条边界各 400
  [PASS] `type` **不可改**：传不同值 → 409（显式报错而不是静默忽略）；传同值 → 200（幂等）
  [PASS] 空 body → 400，且**文案在字段明细里**（`.refine()` 的 path 是空串，只能遍历 message）

── E 组 · 软删：打标记 + 解绑组件 + 会话转只读（三件事一个事务）──
  [PASS] 软删三件套：详情 404 但**行还在**；组件解除；会话转只读且**保留**
  [PASS] 已软删的一律 404：再删一次 404、PATCH 404（**不是** 403，也不是能改回来）
  [PASS] 口径一致性（跨批次）：软删的 Agent **仍占**模型的引用计数（与删除守卫同口径）

── F 组 · 路由表：五条已注册，P0-1-23 / P1 的刻意不存在 ──
  [PASS] 五条路由都在，且"尚未做"的三条一律 404（不提前注册）

── G 组 · 纯函数：canEditAgent / normalizeGuideQuestions / schema ──
  [PASS] `canEditAgent` 矩阵：创建者真 / ADMIN 真 / 其余假 / 软删一律假
  [PASS] `normalizeGuideQuestions` 永不抛错：非数组→[]、丢非字符串、trim、丢空串、**不截断**
  [PASS] 输出的键集合里**没有** `deletedAt` 之类的内部列（防"以后有人顺手 select 出去"）

── 清理（自清理 + 复核残留）──
  [PASS] 残留复核：7 张表全部为 0，3 个会话键全部清空

✅ P0-1-22 智能体 CRUD 验收通过：26 项全通过
```

**从这段输出里能直接读出来的事**：
① 三足鼎立的权限**三个方向都验了**（自己真 / 他人假 / ADMIN 真）——
只验"他人假"的话，一个"仅创建者"的实现会全绿；
② 绑定校验是**四条失败**而不是一条（门槛要求"绑 disabled 模型被拒"，另三条是顺手补齐的）；
③ 软删**三件套**三件都有断言，其中"组件解除"那条是用**知识库能否删掉**取的证（见坑 4）；
④ 收尾残留 `7 张表全部为 0`。

### `node scripts/verify-app.mjs` 的第 24 节（85 项，本批 +6）

```
── 智能体契约与路由（权限判据 / 三态 / 引导问题 / 一套投影）──
  [PASS] 五条路由已注册；P0-1-23 与 P1 的三条**刻意不存在**（不提前做下一批的活）
  [PASS] 权限判据 `canEditAgent`：四个方向（创建者 / ADMIN / 第三方 / 已软删）
  [PASS] `guideQuestions` 契约：上限 / 元素类型 / 空白项都给**字段级文案**
  [PASS] `normalizeGuideQuestions`（读取端唯一入口）：永不抛错、只做类型收敛、**不截断**
  [PASS] 建/改 body 的三态与"不可改的 type"：`undefined`（不动）与 `null`（清空）必须分得开
  [PASS] 输出投影的键集合固定：没有 `deletedAt` 之类的内部列（防"以后有人顺手 select 出去"）

✅ 接口级验收通过：85 项全通过
```

### 静态检查

```
$ pnpm lint                                                   # 通过（无输出）
$ pnpm --filter @doubulea/shared exec tsc -p tsconfig.json     # 通过
$ pnpm --filter @doubulea/backend exec tsc -p tsconfig.json    # 通过
```

### 未回归（既有 17 档逐项仍通过）

```
db 17 ｜ session 13 ｜ auth 21 ｜ users 17 ｜ model-providers 18 ｜ models 17 ｜ llm 22
embedding 27 ｜ knowledge 23 ｜ documents 44 ｜ pipeline 29 ｜ ingest 23 ｜ knowledge-bases 19
retrieval 27 ｜ kb-package 11 ｜ e2e 17 ｜ app 85（本批 +6）
```

> `verify:pipeline` 与 `verify:knowledge-bases` 都**会碰 `agent_components`**（前者验"被 Agent 绑定
> → 409"、后者验级联删），而本批的软删逻辑动了这张表 —— 所以这两档是本次回归里最该看的两档，
> 两边都仍是原计数。

---

## 坑预判取证

| `06` 的坑预判 | 结论 | 落地形态 |
|---------------|------|----------|
| 删除是**软删**（会话转只读保留、组件绑定解除）→ schema 需 `deleted_at`，所有查询默认过滤 | ✅ **成立且比预判更严** | `deleted_at` 列 P0-1-5 就已落；本批把"解除绑定 + 会话转只读"也做成**同一事务里的三件事**，取证链见坑 4。所有读路径（列表 / 详情 / PATCH / DELETE）一律 `where { deletedAt: null }` —— 漏了这条会让软删的 Agent 重新出现在首页上，而它的详情是 404（点进去就是死链），验收里有一条"软删后不该出现在列表里"专守 |

**本批自己发现、并写进文档的边界**（5 条）：

1. **`.refine()` 的错误没有 `path`** ⇒ 是"表单级"而非"字段级"（坑 2）；
2. **Fastify 的 schema 校验先于 `preHandler`** ⇒ 验 401 要给合法载荷（坑 3）；
3. **绑定的模型事后被停用不影响改名**（只有换绑才校验），此时靠 `modelAvailable` 提示（坑 5.2）；
4. **`systemPrompt` / `openingRemarks` 刻意不 `trim()`**（多行排版是提示词的一部分，
   与 name/description 相反）—— 验收里连前导 `\n\n` 一起逐字断言；
5. **组件绑定只给 `{componentType, refId}`、不带目标名**（`mcp_servers` 要到 P0-2 才建；
   "只有知识库有名字"的不对称投影比"都没有名字"更难用）—— 名字由前端从各自的列表端点映射。

---

## 遗留 / 下批提醒

1. **组件绑定的"写侧"是 P0-1-23**（`PUT /api/agents/:id/components` 整体替换）。
   本批已把**读侧**全部做好（`COMPONENT_TYPES` 枚举、`{componentType, refId}` 投影、
   列表/详情的 `components` 回显），下一批只需补写侧 —— 但 ⚠️ **整体替换只许写
   `agent_components`、不要顺手更新 `agents.updated_at`**：本批已把列表排序定为 `updatedAt desc`，
   动了它就会让"解绑一个知识库"把这个智能体弹到列表顶部（用户会看到"列表自己跳了一下"）。
   这条已回写进 `docs/06` P0-1-23 的坑预判。
2. **`POST /api/agents/:id/copy` 是 P1**，验收里有一条"它必须 404"守着 —— 谁实现它之前先改那条断言。
3. **名称不查重**是刻意的（`agents` 上没有 `name` 唯一约束）：需要唯一性时应当**先加约束再改代码**，
   而不是在服务层造一条"看起来唯一、并发下不唯一"的规则（与 `createModelProvider` 同款结论）。
4. **组件绑定的 `refId` 是刻意无 FK 的多态外键**（`02` §3.1）：`KNOWLEDGE → knowledge_bases.id`、
   `MCP → mcp_servers.id`。因此**引用完整性完全靠服务层**——P0-1-22 的软删要手工删这些行，
   P0-1-23 的整体替换要手工校验每个 `ref_id` 归属有效（引用不存在的 KB 必须**拒绝**而非静默丢弃）。
5. **`agents` 的 `@@index([deletedAt, updatedAt(sort: Desc)])`** 是本批列表排序的支撑；
   将来若要加类型筛选（`?type=`），注意 `03` §二 的首页**没有**这个筛选器，不要自己发明。
6. **软删的 Agent 的会话会挂在已删的 Agent 上**（`conversations.agentId` 指向一行 `deleted_at != null`）。
   P0-1-25 做会话列表时要靠 **join 出来的 `agentName` 快照**显示名字，**不要**去 `agents` 表按
   `deletedAt: null` 过滤（否则历史会话会显示"未知智能体"）。
