# 问题记录 · P0-1-10 模型池 Provider 管理

> 批次：P0-1-10（包 C 第一步）｜日期：2026-09-21
> 产出：`shared/src/modelProvider.ts`、`backend/src/services/model.service.ts`、`backend/src/routes/modelProviders.ts`
> 验收：`pnpm verify:app`（38 项 / CI 39 项）、`pnpm verify:model-providers`（**18 项**，需真实 PG+Redis）
> 契约回写：`docs/02` §4.3（契约增量 12 条）+ **§10.2 Provider Key 存储口径**；`docs/06` P0-1-10 落地要点 12 条

---

## 汇总（10 个坑 / 结论）

| # | 结论 | 类型 |
|---|------|------|
| 1 | **AAD 绑定到 `id` ⇒ 加密依赖 `id` ⇒ 建记录必须用事务** | 设计约束（新） |
| 2 | **解密失败不能掀桌**：掩码降到 `****` 而不是让列表 500 | 可用性（新） |
| 3 | **三态的落点是 `.nullable().optional()` 且绝不能加 `.default()`** | 契约（新） |
| 4 | 最强的那条验收是「**密文逐字不变**」，不是「hasKey 仍为 true」 | 验收方法（新） |
| 5 | `agents.model_id` 是 `ON DELETE RESTRICT` ⇒ 删 Provider 必须前置检查 | 数据库语义（新） |
| 6 | **软删的 Agent 仍占外键** ⇒ 计数不能按 `deletedAt` 过滤 | 数据库语义（新） |
| 7 | `baseUrl` 去尾斜杠 + 只允许 http(s)（SSRF 面） | 契约（新） |
| 8 | 改 `type` 的两种做法都不好 → 选**显式 409**，不要静默级联 | 取舍（新） |
| 9 | **掩码的断言别拿"字符集不相交"去写**（分隔符会误报，自己写了个假失败） | 验收脚本（新） |
| 10 | macOS 的 `grep` 不支持 BRE 的 `\|` 交替且**静默返回空** → 会把"有"读成"没有" | 环境（新） |

---

## 坑 1 · AAD 绑定到 `id`，于是"加密"和"拿到 id"互为前提

**现象**：设计上想让密文绑定到记录（把 A 的密文粘到 B 上就解不开），AAD 取
`model-providers:{id}.api_key_enc`。但 `id` 是 Prisma 在 `create` 时按 `uuid(7)` 生成的 ——
**加密时还不知道 id**。

**为什么不能"先加密、再 create"**：那就只能把 AAD 写成常量（放弃绑定），或者自己生成 id
（本仓没有 uuid v7 生成器，`crypto.randomUUID()` 给的是 v4，会让"时间有序"这条性质在
Provider 上不一致）。

**为什么不能"先 create、再 update"两条独立语句**：中间失败（进程被杀、约束冲突）会留下
**"Provider 建好了但 Key 没写进去"** 的行 —— 而调用方看到的是"请求失败"，于是重试又建一个。
最后库里躺着两个同名 Provider、一个有 Key 一个没有，没人知道哪个是"那次失败的"。

**对策**：`prisma.$transaction(async (tx) => { create → 用 row.id 加密 → update })`。
要么全成要么全无。**PATCH 路径不需要事务**（`id` 已知）。

**顺带记住**：这条使"改 `id`"变成破坏性操作（旧密文全废）。本系统不改 id，所以可接受 ——
但如果将来真要做"记录迁移/合并"，必须连带重新加密。

---

## 坑 2 · 主密钥一换，列表接口整页 500

**现象**：`apiKeyPreview` 是"解密后取首尾"算出来的（这样顺带证明密文解得开）。那么当
`CREDENTIAL_MASTER_KEY` 换过、或某条密文被改坏了，解密会抛 `SecretDecryptionError` ——
如果任它冒到路由层，**整个列表接口 500**，管理员连"哪个 Provider 的 Key 坏了"都看不到，
只能去翻日志。

**对策**：`buildPreview` 内 catch，降级成 `'****'` 并打 warn，`hasKey` 仍为 `true`。
语义上也更准确：**Key 还在，只是这个进程解不开**（与"没配 Key"必须区分开）。

**为什么不做"预览缓存"**：解密耗时毫秒级，而缓存会带来两个坏处 —— 读路径产生副作用
（密文被写操作牵连）、换主密钥后状态不能立刻反映。

---

## 坑 3 · 三态的落点：`.nullable().optional()`，绝不能加 `.default()`

`apiKey` 的三态（缺省不动 / `null` 清空 / 有值写入）在 zod 里的正确写法是：

```ts
apiKey: providerApiKeySchema.nullable().optional(),   // → string | null | undefined
```

**为什么不能写 `.optional().default(null)` 或 `.nullish().default(null)`**：
那样 `undefined` 会被填成 `null`，服务层再也分不清"没给"和"要清空" ——
于是"改个名字"会**顺手把 Key 抹掉**，而且是静默的（响应里只有 `hasKey: false`），
要等到真正调用模型时才发现。

**空串的处理**：契约里直接拒掉（`min(1)`），文案写清"要清空请传 null，不动则不传该字段"。
理由：空串在"没配"与"配了个空值"之间摇摆，而"清空"这件事已经有 `null` 这条路了 ——
留两条明确的路，比留三条含混的路好。

**服务层的落点**（一一对应，不要自作聪明合并）：

```ts
input.apiKey === undefined ? {}                                        // 不动
: input.apiKey === null    ? { apiKeyEnc: null }                       // 清空
                           : { apiKeyEnc: encryptSecret(v, aad(id)) }  // 写入
```

---

## 坑 4 · "PATCH 不传 Key 时原 Key 保持不变"要怎么验才算真验过

门槛原文是「PATCH 不传 Key 时原 Key 保持不变」。最容易写成的断言是
**"PATCH 之后 `hasKey` 仍为 true"** —— 但这条**测不出**最要命的实现错误：
如果实现里"每次 PATCH 都重新加密一遍"（顺手把它写进 `data`），`hasKey` 照样是 true，
Key 也确实"没变"（明文相同），可是：

- 密文被无谓改写（换主密钥的窗口里会留下一批解读不了的旧密文）；
- 一旦"重新加密"的取值为 `undefined` 而不是原值，就会变成静默清空。

**对策**：断言**密文逐字相同**。

```js
const before = await readCipher(provider.id)
await api('PATCH', `/api/model-providers/${provider.id}`, { payload: { name: '改名' } })
assertEqual(await readCipher(provider.id), before, '密文必须逐字不变')
```

因为 IV 是随机的，"重新加密"必然产出不同的密文 —— 这条断言能一次抓住那一类实现。

---

## 坑 5 · `models.provider_id` 是 CASCADE，但 `agents.model_id` 是 RESTRICT

`02` §三 定的删除语义：删 Provider → 级联删其下 `models`；但 `agents.model_id` 是
`ON DELETE RESTRICT`。所以**只要 Provider 下有一个模型被 Agent 引用着**，
`DELETE /api/model-providers/:id` 就会在 DB 层抛外键错误。

不做前置检查的话，Prisma 会把它包成 `P2003` → 统一 500，前端只能显示"服务器错误"，
管理员完全不知道为什么删不掉、该怎么办。

**对策**：删之前先数一遍

```ts
const referencedModels = await db.model.count({ where: { providerId: id, agents: { some: {} } } })
if (referencedModels > 0) throw AppError.conflict(`该 Provider 下有 ${referencedModels} 个模型正被 Agent 使用…`)
```

并**保留 `P2003` 的兜底分支**（并发下仍可能撞上，此时给可读的 409 而不是 500）。

---

## 坑 6 · 软删的 Agent 仍然占着外键

`agents` 是**软删**（`deleted_at`）。直觉上"删掉的 Agent 不算数"，但在**外键**这件事上它完全算数 ——
行还在，`model_id` 这个引用就还在。

**如果计数时按 `deletedAt: null` 过滤**，就会出现最难查的一类体验：提示说"这个可以删"，
点下去 500。

**对策**：计数刻意**不按 `deletedAt` 过滤**（`agents: { some: {} }` 数全部）。
文案也据此写"请先删除或改绑这些 Agent"。

**验收脚本对应**：先用 `prisma.agent.create` 造一个真实引用 → 断言 409；再**硬删** Agent → 断言可以删。
脚本的 `finally` 清理顺序同样是硬约束：**Agent 先于 Model**（RESTRICT），否则清理自己都会失败。

---

## 坑 7 · `baseUrl` 的归一化与 scheme 白名单

**尾斜杠**：这个值将来会被拼成 `${baseUrl}/chat/completions`（P0-1-12）。管理员从浏览器
地址栏复制的地址十有八九带尾斜杠 → 拼出来 `https://x/v1//chat/completions`，有的网关当 404，
排查起来很费时间。契约层做一次 `transform` 去掉尾部所有斜杠，前后端对"存下来的到底是什么"
就没有分歧。

**scheme 白名单**：只允许 `http://` / `https://`。这个值最终会被后端拿去发 HTTP 请求，
允许 `file://` / 任意 scheme 等于把"协议选择"交给配置者（SSRF 面变大）。同时用 `new URL()`
做严格校验（正则挡不住 `http://`、`http://x:abc` 这类）。

**验收脚本的意外收获**：因为归一化只存在于契约层，`verify:app` 里有一条**纯函数**断言
（`https://api.openai.com/v1///` → `https://api.openai.com/v1`），不需要数据库就能守住这条契约。

---

## 坑 8 · 改 `type`：三种做法里没有"好"的，选了最不坏的

`model_providers.type` 与 `models.type` 是**冗余**的（`02` §三）。Provider 已有模型时改 type，
三种做法：

| 做法 | 问题 |
|------|------|
| 静默放行 | 留下"CHAT 的 Provider 挂着 EMBEDDING 的模型"，数据自相矛盾，后面查起来是谜案 |
| 级联改所有模型的 type | 更糟：**静默改变"已绑定 Agent 用的是哪类模型"**，而 Agent 无法自动适配 |
| **有模型时拒绝（409）** | 管理员要"先处理模型"，多一步 —— 但**显式报错比静默改数据强** |

选第三种，并**放行同值 PATCH**（`type: 'CHAT'` 打给本来就是 CHAT 的 Provider 不算改类型）——
否则前端"整表保存"表单每次都会莫名 409。

---

## 坑 9 · 掩码的断言：别拿"字符集不相交"去写

第一版断言是"掩码里不得出现中间段的**任何字符**"：

```js
const middle = key.slice(3, key.length - 4)
assert([...middle].every((ch) => !masked.includes(ch)))
```

跑出来**失败**，但实现是对的 —— 因为 key 里的分隔符 `-`（`sk-proj-…`）同时出现在
首段和中间段，被算成了"泄露"。

**对策**：只比对**字母数字**（`replace(/[^A-Za-z0-9]/g, '')`），并额外断言"中间段的连续片段
不出现在掩码里"。**教训**：断言"两个集合不相交"时，先想清楚集合里有没有**本来就该重复的
非载荷字符**（分隔符、前缀、填充）。

---

## 坑 10 · macOS 的 `grep` 不支持 BRE 的 `\|` 交替，而且**静默返回空**

排查过程中用 `grep -n "A\|B" file` 找两个关键词，**输出为空、退出码非 0**，
看起来就是"文件里没有"。实际上 macOS 自带的是 BSD grep，对 BRE 里的 `\|` 不支持 ——
于是它把 `\|` 当字面量匹配，永远匹配不上。

**危害**：把"有"读成"没有"（例如"这个环境变量没被任何地方引用"这种结论可能完全是假的）。
这一批真的差点因此下错结论。

**对策**：交替一律用 `grep -E "A|B"`，或者直接用工具侧的 Grep（ripgrep）。
**判断"某处不存在"时，必须用一个已知存在的反例校验一次**（拿一个肯定出现的词试同一个命令，
看它是否也返回空）。

---

## 验收记录（原始输出摘要）

### `pnpm verify:app`（本机，38 项）

```
[PASS] maskApiKey：长 key 给「前3+****+后4」、短 key 只露尾巴、极短直接全遮
[PASS] Provider 路由已注册且仅 ADMIN：未登录 401；非法参数 400（校验先于鉴权，故匿名下可断言）
[PASS] shared Provider 契约：baseUrl 归一化 / 空 apiKey 被拒 / PATCH 三态保住 undefined 与 null
[PASS] Provider Key 的密文绑定到记录（AAD）：换个 providerId 就解不开，不能跨记录搬运
[PASS] shared Provider 输出形态：只含掩码与 hasKey，无任何 apiKey 字段；列表分页同构
✅ 接口级验收通过：38 项全通过
```

CI 无依赖模式（`EXPECT_DEGRADED=1`）：**39 项全通过**。

### `pnpm verify:model-providers`（需真实 PG + Redis，18 项）

```
══ P0-1-10 模型池 Provider 验收：Key 加密 / 读脱敏 / 三态 / 删除与改类型守卫 ══
  [PASS] 无会话 401；MEMBER 403；ADMIN 列表 200 且符合分页形态（验收：仅 ADMIN）
         preview=sk-****WXYZ（明文长度 41）
  [PASS] 建 Provider（带 Key）→ 200，响应里 hasKey/preview 齐备且**逐字搜不到明文 Key**（验收①）
         库中密文：v1.3MOdwHGxOt1OF0Z…（98 字符）
  [PASS] **数据库里是密文**：形态 v1.<iv>.<tag>.<ct>、不等于明文、且能用 AAD 解回原文（验收②）
  [PASS] 密文**绑定到记录**：换个 Provider 的 AAD 解不开（密文不能跨记录搬运）（验收②③）
  [PASS] 列表 / 单条读接口都不含明文与密文（读脱敏，`02` §十 不变式）
  [PASS] PATCH **不传 apiKey** → 原 Key 逐字不变（密文完全相同，不是"重新加密了一遍"）（坑预判）
  [PASS] PATCH `apiKey` 传新值 → 换成新密文，能解出新值且与旧密文不同
  [PASS] PATCH `apiKey: null` → 清空（hasKey=false / preview=null / 库里为 NULL）
  [PASS] PATCH 参数校验：空 body 400、`apiKey: ""` 400（要清空请传 null）
  [PASS] 建/改的其它校验：非法 baseUrl / 非 http(s) / 未知 type / 空 name → 400 + 字段明细
  [PASS] 不存在的 id：PATCH / DELETE → 404 / NOT_FOUND；非法 uuid → 400
  [PASS] 改 type 守卫：Provider 下**有模型**时改 type → 409（防"CHAT 的 Provider 挂 EMBEDDING 模型"）
  [PASS] 列表的 modelCount 反映实际挂载数（前端删 Provider 前的提示依据）
  [PASS] 删 Provider：无模型 → 200 且库里真的没了
  [PASS] 删 Provider：有模型但**无 Agent 引用** → 200 且模型被级联删除（`models.provider_id` CASCADE）
  [PASS] 删 Provider：有模型**被 Agent 引用** → 409（而不是撞外键抛 500，`02` §三 RESTRICT）
  [PASS] 解开 Agent 绑定后即可删除；且删 Provider 会**顺带清掉它的密文**（不残留可解凭据）
  [PASS] 删除后再读列表：被删的 Provider 不再出现，且响应体依旧零钥匙痕迹
✅ P0-1-10 模型池 Provider 验收通过：18 项全通过
```

**残留复核**（跑完立刻查）：

```
users=0 providers=0 models=0 agents=0        （"verify-%" 前缀统计）
Redis 键：空
库内账号：admin / member（两个种子账号，首登态）
```

> ⚠️ 第一轮跑完 Redis 里留了两个 `auth-user:*` 快照键 —— `requireAuth` 每请求会写（TTL 60s），
> 脚本"顺手"创建的。这正是 `06` P0-1-7 坑 5 记下的教训（**枚举脚本创建的全部键，含"顺手创建的"**），
> 已在收尾里补 `invalidateUserSnapshot(userId)`。

### 回归（全绿，未回归）

| 档 | 项数 | 结果 |
|----|------|------|
| `lint` / `-r typecheck` / `-r build` | — | ✅ 三包全绿 |
| `verify:app` | 38（CI 39） | ✅ |
| `verify:model-providers` | 18 | ✅ |
| `verify:db` | 17 | ✅ |
| `verify:session` | 13 | ✅ |
| `verify:auth` | 21 | ✅ |
| `verify:users` | 17 | ✅ |
| `verify:e2e` | 17 | ✅ |

**零新增依赖、零新增环境变量**（`maskApiKey` 放 shared 纯函数，AAD 用现成 `encryptSecret` 的
`context` 参数）。
