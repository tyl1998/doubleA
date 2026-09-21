# 问题记录 · P0-1-15 知识库 CRUD + 检索配置

> 批次：**P0-1-15 知识库 CRUD + 检索配置**（包 D 第 2 步）
> 日期：2026-09-21
> 产出：`shared/src/knowledgeBase.ts`（+ `shared/src/index.ts` 导出）、
> `backend/src/services/kb.service.ts`、`backend/src/routes/knowledgeBases.ts`、
> `backend/src/app.ts`（注册路由）、`backend/scripts/verify-knowledge-bases.mjs`、
> `backend/scripts/verify-app.mjs`（+「17. 知识库契约」段）、根/子包 `verify:knowledge-bases`
> 一句话：**本批唯一一个真 bug 是纯函数的参数方向写反**（`normalizeRetrievalConfig(raw, patch)` 里 `raw` 压住了
> `patch`）—— 症状是"接口 200、响应看着正常、**用户改的值被静默丢弃**"，`typecheck`/`build`/`lint` 全绿，
> 只有那条纯函数断言抓得到。同时本批首次出现与模型池**相反**的权限口径（知识库是"登录即可"）。

---

## 汇总（4 个坑 + 9 条结论）

| # | 坑 / 结论 | 一句话 |
|---|-----------|--------|
| 1 | **⚠️ `normalizeRetrievalConfig` 的参数方向写反了**（本批唯一的真 bug） | 内部 `fallback = {...DEFAULT, ...patch}` 而 `source = raw` ⇒ **raw 赢**，与"patch 优先"的语义相反；建库与改库**两处**都静默丢弃用户输入 |
| 2 | **这个 bug `typecheck`/`build`/`lint` 都抓不到** | 类型完全正确（两边都是 `Record<string, unknown>`），只有**跑起来比对返回值**的断言能发现 ⇒ 纯函数契约必须有无依赖断言 |
| 3 | **权限口径与模型池相反：知识库是「登录即可」** | `03` §25 权限列（`/knowledge` = 登录；`/admin/models` = ADMIN）+ `02` §三 `knowledge_bases` **无 owner 列** ⇒ 它不是"管理员配置"而是全员共享资源 |
| 4 | **字段级错误断言查错了地方**（本批连踩两次） | 顶层 `msg` 恒为「请求参数校验失败」，真正的字段/refine 文案在 `data.fields[].message` ⇒ 断言 `msg` 含 "128" 是**假失败** |
| 5 | **`description` 的三态在 PATCH 上必须区分「不带」与「null」** | 不带 = 不动；`null` = 清空；字符串 = 设置。`.nullable().optional()` **不加 `.default()`**，否则"改名"会顺手把描述清掉 |
| 6 | **跨字段守卫必须按「生效值」算，不是按请求体里给的值** | 只改 `chunkSize` 时 `chunkOverlap` 没给 ⇒ 拿库里的现值比；只改 `chunkOverlap` 同理。按请求体比会让"一半的越界组合"漏过 |
| 7 | **`agent_components.ref_id` 是多态引用、没有 DB 外键** | 数据库不会替你拦 ⇒ 删库前必须**自己查绑定**并 409；"先删了才发现要拦"是常见写法错误 |
| 8 | **`removeObjects` 在 `Quiet: true` 下只返回失败列表** | 所以"删了几个"= `keys.length - failures.length`，把返回数组当"已删的"会报出 0 |
| 9 | **S3 清理失败只 warn 不抛** | DB 行已经删了，此时抛错会让用户以为"没删成功"而重试 |
| 10 | **embedding 未就绪时「写」与「读」的行为刻意不同** | 写（建库）→ 500 且不留半成品；读 → 照常可用，`embeddingModelChanged` 降级为 `null`（无法判定）。读接口不该因环境缺配置整体不可用 |
| 11 | **`embedding_model` 不在「改」契约里** | 它是建库快照、是"需重建"的判据；可改等于允许伪造"已跟进新模型" |
| 12 | **DB 默认值与 shared 的规范默认值是两处手写** | 必然漂移 ⇒ 验收里要有一条**跨包一致性**断言比对它们 |
| 13 | **"建库快照环境默认值"要靠注入特征值证明** | 注入 256/32 + topK 8 / score 0.42 / rrfK 77，写死 5/0.3/60 的实现必红 |

---

## 坑 1：`normalizeRetrievalConfig` 的参数方向写反（本批唯一的真 bug）

**怎么发现的**：这条不是"跑接口跑挂了"，而是 `verify:app` 里一条**纯函数断言**红的：

```
❌ 接口级验收未通过：1 项失败 / 45 项通过
   patch 应压过 base
     期望: 7
     实际: 99
```

对应的断言（`verify-app.mjs`）：

```js
// `patch` 的优先级必须**高于** `base`（建库时把请求体叠到环境默认值上、改库时叠到当前值上）——
// 反了的话症状很隐蔽：接口 200、响应看着正常，但**用户改的值被静默丢弃**（这条断言就是盯它）
assertEqual(normalizeRetrievalConfig({ topK: 99 }, { topK: 7 }).topK, 7, 'patch 应压过 base')
```

**错在哪**：原实现的形态是

```js
// ❌ 原实现（方向反了）
const base = isRecord(raw) ? raw : {}
const fallback = { ...DEFAULT_RETRIEVAL_CONFIG, ...patch }   // 把 patch 当成了"兜底"
const source = base                                        // 把 raw 当成了"真相"
// ⇒ source 里有的键永远赢；patch 只在 raw 缺键时才生效
```

语义读起来像"用 patch 兜底 raw"，但**调用方的意图是相反的**：建库时 `raw` = 环境默认值（底）、
`patch` = 请求体（用户给的、优先级更高）；改库时 `raw` = 当前值（底）、`patch` = 本次改动（优先级更高）。
两种场景下 `patch` 都必须赢。方向反了 ⇒ **建库与改库两处都静默丢弃用户输入**。

**为什么没人发现**：类型是对的（两边都是 `Record<string, unknown>`），`lint` / `typecheck` / `build` 全绿；
接口返回 200、`retrievalConfig` 是完整合法形状，肉眼扫一眼完全正常。**只有把返回值逐字段比对的断言能抓**。

**订正**（`shared/src/knowledgeBase.ts`）：

```ts
export function normalizeRetrievalConfig(
  raw: unknown,
  patch: Partial<RetrievalConfig> = {},
): RetrievalConfig {
  const base = isRecord(raw) ? raw : {}
  const weights: Record<string, unknown> = isRecord(patch.weights) ? patch.weights : {}
  const baseWeights: Record<string, unknown> = isRecord(base.weights) ? base.weights : {}
  // `{...base, ...patch}` 是安全的：patch 里只可能"键不存在"或"值是合法数字"
  // （zod 的 `.optional()` 会剥掉未给的键，非法的挡在 400），不会出现"显式的 undefined 覆盖 base"
  const merged: Record<string, unknown> = { ...base, ...patch }
  return {
    topK: numberOr(merged.topK, DEFAULT_RETRIEVAL_CONFIG.topK, 1, 100),
    // …
    weights: {
      vector: numberOr(weights.vector ?? baseWeights.vector, DEFAULT_RETRIEVAL_CONFIG.weights.vector, 0, 100),
      fulltext: numberOr(weights.fulltext ?? baseWeights.fulltext, DEFAULT_RETRIEVAL_CONFIG.weights.fulltext, 0, 100),
    },
  }
}
```

注意 `weights` **不能**跟着外层一起展开：它是嵌套对象，`{...base.weights, ...patch.weights}` 要**逐键**合并，
否则"只调 `weights.vector`"会把 `weights.fulltext` 打回默认值（同一个坑的嵌套版本）。

**订正后取证**（`node --input-type=module`，2026-09-21）：

```
patch 优先（当前实现）: {"topK":7,"score":0.3,"mode":"HYBRID","splitStrategy":"hybrid","rrfK":60,"weights":{"vector":1,"fulltext":1}}
raw 兜底缺键        : {"topK":7,"score":0.9,"mode":"HYBRID","splitStrategy":"hybrid","rrfK":60,"weights":{"vector":1,"fulltext":1}}
整体兜底            : {"topK":5,"score":0.3,"mode":"HYBRID","splitStrategy":"hybrid","rrfK":60,"weights":{"vector":1,"fulltext":1}}
weights 逐键合并    : {"vector":3,"fulltext":2}
```

第二行是关键：`raw={score:0.9}` + `patch={topK:7}` ⇒ `topK=7`（patch 赢）、`score=0.9`（raw 没被冲掉）
—— **两个方向同时成立**才是"合并"，只验一个方向会漏掉"整体覆盖"的实现。

**教训**：凡是"`A` 叠 `B`"这类**方向敏感**的纯函数，断言必须**两个方向各来一条**（上面的键谁赢、
只有一边有的键谁留）。这是 P0-1-10/11 那条"三态字段要逐态验"的同族纪律。

---

## 坑 2：字段级错误断言查错了地方（本批连踩两次）

本批在 `verify-knowledge-bases.mjs` 里写了两条字段级断言，**两条都先写错、都被同一次运行打红**：

```
[FAIL] 参数校验与 404：空改动 / 超长名 / chunkSize 越界 / 非法 UUID / 不存在的 id 都给出可读错误
        超长名文案应给出上限：应含 "128"，实际 "请求参数校验失败"
```

**原因**（`backend/src/plugins/errorHandler.ts` 定的口径）：校验失败 → 顶层 `msg` **恒为**
「请求参数校验失败」，真正的详情在 `data.fields[{ path, message }]`：

```ts
// backend/src/plugins/errorHandler.ts
/** 请求参数校验失败 —— 唯一一个由本插件（而非业务层）抛出的 `AppError` 子类 */
class ValidationError extends AppError {
  constructor(fields: FieldIssue[], message = '请求参数校验失败') { /* … */ }
}
```

两个容易踩的细节：

- `path` 带 **location 前缀**（`body.name` / `querystring.limit` / `params.id`）—— 写 `path === 'id'` 会失配。
- **`.refine()` 的文案也落在 `data.fields` 里，且 `path` 是空字符串**（它不属于任何单个字段）——
  所以"至少要提供一个要修改的字段"这条只能靠**遍历 `data.fields` 找 message**，不能按 path 定位。

**订正后的写法**：

```js
// ✔ 字段级文案查 data.fields，别查顶层 msg
assert(
  (longName.json().data?.fields ?? []).some(
    (field) => field.path === 'body.name' && String(field.message).includes('128'),
  ),
  `超长名应给出带上限的字段级文案，实际 ${JSON.stringify(longName.json().data?.fields)}`,
)
```

顺带把原来的 `assertIncludes(longName.json().msg, '128', …)` 换掉了 —— 它**永远不可能通过**，
是个典型的"断言写错了却看起来像实现有问题"的假失败。

---

## 坑 3：权限口径与模型池相反 —— 知识库是「登录即可」

这是本批**最该钉死**的一条，因为它是"直觉会写反"的地方：`/api/model-providers` 是 ADMIN
（"配置类接口都该是管理员吧"），于是很容易顺手给 `/api/knowledge-bases` 也挂上 `requireAdmin`。

**依据**（文档先于代码）：

- `03` §25 路由权限表：`/knowledge` = **登录**；`/admin/models`、`/admin/users` = **ADMIN**。
- `02` §三：`knowledge_bases` **没有 `owner` 列** ⇒ 它不是"某个人的私有物"，而是全员共享的资源
  （与 `mcp_servers` 同族，与 `agents` 那类有归属列的相反）。

**实现**：`backend/src/routes/knowledgeBases.ts` 的五个路由一律只挂 `app.requireAuth`，
并在 `app.ts` 的注册处留下注释说明"这里的登录即可权限是刻意的"。

**守门断言**（`verify-knowledge-bases.mjs`）：

```js
await it('⚠️ 权限是「登录即可」：**MEMBER** 能建 / 能改 / 能删（与模型池的 ADMIN 相反）', async () => {
  // 这条是本批最该钉死的断言：若有人给这些路由加上 `requireAdmin`（"配置类接口都该是管理员吧"），
  // 它会立刻红。…
```

用 **MEMBER 账号**跑"建 / 改 / 删"三连 —— 比"ADMIN 能建"强得多：后者在加了 `requireAdmin` 后**依然通过**。

---

## 坑 4：删库是三道闸，顺序不能换

删除路径上三个风险叠加，实现顺序是有讲究的：

1. **先查 `agent_components` 的绑定 → 409**。`agent_components.ref_id` 是**多态引用**（可能指向
   provider / model / knowledge_base），**没有 DB 外键** ⇒ 数据库不会替你拦，删了就是 Agent 指向不存在的库。
   验收里专门有一条断言"**409 时库与内容一个都没被删**"——"先删 DB 再检查引用"是常见写法错误，
   冲突时已经删了一半。
2. **删 DB 行**：`documents` / `chunks` 走 FK `ON DELETE CASCADE`，服务层不用手写删除。
3. **最后删 S3 对象**（`documents.file_key`）。

**两个 S3 口径**：

- **失败只 warn 不抛**：DB 行已经删了，此时抛错会让用户以为"没删成功"而重试（重试必然 404，更困惑）。
- **回报真实删除数**：`removeObjects(bucket, keys)` 传的是 `Quiet: true`，**只返回失败列表** ⇒
  删除数 = `keys.length - failures.length`。把返回数组的长度当"已删的"会恒定报 0。
- 顺带一条：**从没上传过文档的库**（S3 无对象）也要能干净删掉 —— 清理逻辑不能因为"没有对象"而报错，
  验收里单列了一条。

---

## 坑 5：embedding 未就绪时「写」与「读」的行为刻意不同

`knowledge_bases.embedding_model` 是 NOT NULL 且取值 = `EmbeddingProvider.name()`（P0-1-14 定案），
所以环境缺 embedding 配置时：

- **写（建库）→ 500**，文案点明"embedding 未就绪"，且**不留半成品**（先取名字再落库，
  取不到就根本不开事务 —— 验收断言"行数不变"）。
- **读 → 照常可用**，只是 `embeddingModelChanged` **降级为 `null`**（= 无法判定，不是 false）。
  实现上分成两个函数：`requireEmbeddingModelName()`（写路径，取不到抛 500）与
  `currentEmbeddingNameOrNull()`（读路径，用 `embeddingReadiness().name`，永远不抛）。

**验证方式**：D 组用**子进程注入环境变量**（`EMBEDDING_MODE=api` + 三项清空），
因为 `config.ts` 是模块加载期读环境且进程内只算一次 —— 同一进程里改 `process.env` 无效。
这与 P0-1-13 的"第五档"模式一致（`verify:*` 脚本里起子进程验配置相关行为）。

---

## 验收记录（原始输出，2026-09-21）

### 依赖型：`pnpm verify:knowledge-bases`（需 `pnpm infra:up`，PG + Redis + MinIO）

```
$ pnpm verify:knowledge-bases
══ P0-1-15 知识库 CRUD 验收：快照 / 补默认值 / 级联 + S3 / 全员权限 ══
  临时数据：verify-kb-admin-m0uxwi（ADMIN）+ verify-kb-member-m0uxwi（MEMBER）+ 1 Provider/Model/Agent
  建库快照预期：embeddingModel=api:verify-embed-model｜chunk 256/32｜topK 8 / score 0.42 / rrfK 77
  进程内 embedding 就绪结论：ready=true（注入 api 三项）

── A 组 · CRUD 与"建库快照环境默认值"（HTTP）──
  [PASS] 建库：只给 name → chunk 与 retrieval_config **全部快照自环境默认值**（不是硬编码 5/0.3/60）
  [PASS] 建库：`embedding_model` 是**当前 provider 的快照**，且 `embeddingModelChanged=false`（与当前一致）
  [PASS] 建库：显式 chunk + **局部** retrievalConfig 覆盖生效，未给的键仍取默认值
  [PASS] 列表与详情：投影符合契约、`total` 与分页字段自洽、详情与列表项**逐字一致**
  [PASS] 改库：`retrievalConfig` 是**局部合并** —— 只调 topK 不会把 mode 打回默认值
  [PASS] 改库：`description` 三态 —— 改名不动描述 / `null` 清空 / 字符串设置
  [PASS] 跨字段守卫：chunkOverlap >= chunkSize 一律 400（只改一个也要按**生效值**算）
  [PASS] 参数校验与 404：空改动 / 超长名 / chunkSize 越界 / 非法 UUID / 不存在的 id 都给出可读错误
  [PASS] ⚠️ 权限是「登录即可」：**MEMBER** 能建 / 能改 / 能删（与模型池的 ADMIN 相反）
  [PASS] 删库：回 { id, name, deletedDocuments, deletedObjects }，删完详情 404、列表里消失

── B 组 · 删库级联清 chunks 与 S3 原文件 ──
  [PASS] 删库：`documents` / `chunks` 由外键级联清空，**S3 原文件真的消失**，且回报真实个数
  [PASS] 删库：**被 Agent 绑定 → 409**，且库与内容一个都没被删（多态引用没有外键兜底，必须自己拦）
  [PASS] 删库：从没上传过文档的库（S3 无对象）也能干净删掉 —— 清理逻辑不能因为"没对象"而报错

── C 组 · retrieval_config 的补默认值（老数据不能让读接口炸）──
  [PASS] 老数据：库里存 `{}` / 只剩一半键 / 越界值 → 读接口仍返回**完整且合法**的形状
  [PASS] 补默认值的逻辑在**一处**（`shared` 的 `normalizeRetrievalConfig`）：模块级纯函数逐键兜底
  [PASS] DB 默认值与 shared 的规范默认值是**同一组值**（`schema.prisma` 的手写字符串容易和契约漂移）

── D 组 · embedding 未就绪时的行为（子进程注入环境变量）──
  [PASS] 未就绪时建库 → 500 且文案点明"embedding 未就绪"，**不留半成品**（行数不变）
  [PASS] 未就绪时**读**接口仍可用：`embeddingModelChanged` 变成 `null`（无法判定），不是 500

── 清理与残留复核 ──
  [PASS] 自清理复核：脚本建的知识库 / 文档 / chunk / S3 对象 / 账号全部清干净

✅ P0-1-15 知识库 CRUD 验收通过：19 项全通过
```

### 无依赖：`pnpm verify:app`（含「17. 知识库契约」段）

```
✅ 接口级验收通过：46 项全通过
```

该段钉住的四件事：① 五条路由**确实注册了**、且**没有** `/available`（知识库不像模型那样分两套投影）；
② `normalizeRetrievalConfig` 的 **patch 优先方向**（连同"patch 没给的键保留 base"与"weights 逐键合并"
共三条，就是上面那个真 bug 的守门断言）；③ `description` **三态**；④ `embeddingModelChanged` **三态**。

### 全量回归（12 档，2026-09-21）

```
=== app ===             ✅ 46 项全通过
=== knowledge ===       ✅ 23 项全通过
=== db ===              ✅ 17 项全通过
=== session ===         ✅ 13 项全通过
=== auth ===            ✅ 21 项全通过
=== users ===           ✅ 17 项全通过
=== model-providers === ✅ 18 项全通过
=== models ===          ✅ 17 项全通过
=== llm ===             ✅ 22 项全通过
=== embedding ===       ✅ 27 项全通过
=== knowledge-bases === ✅ 19 项全通过
=== e2e ===             ✅ 17 项全通过
```

合计 **257 项**；`pnpm lint` 无输出（干净）、`pnpm -r typecheck` 三包 Done、`pnpm -r build` 绿。

---

## 待决 / 留给后批的事

1. **`子方案①` §二 与 6 键形状的口径冲突**：§二 第 44 行提到 `empty_text_threshold` /
   `candidatePoolFactor`，但同节的键清单只列了 6 个键。本批取 **6 键**（`topK` / `score` / `mode` /
   `splitStrategy` / `rrfK` / `weights`），另两个**不进 `retrieval_config`**（它们是全局常量而非库级配置）。
   → 待 P0-1-18（空文本检测）落地时回写文档消掉这一处不一致。
2. **`embeddingModelChanged` 的"需重建"路径**（`子方案①` §八）尚未实现 —— 本批只暴露判据，不做迁移。
3. **`excludeSelf` 记录到本批的口径**：`agent_components.ref_id` 无外键，将来 P0-2 加 MCP/工具绑定时
   **同一个多态表会承载更多类型** ⇒ 删库的绑定检查要按 `component_type` 收敛条件，不要写成"表里有就算"。
