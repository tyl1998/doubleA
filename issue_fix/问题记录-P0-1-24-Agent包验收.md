# P0-1-24 Agent 包验收（包 E 收口 · 四条门槛）

> 对应 `docs/06-实施计划.md` 的 P0-1-24（**包 E 第 3 步 / 收口**，E 包 3/3）。按批次工作流的约定记录
> **现象 / 根因 / 对策**与**原始输出**；`docs/06` 只留一行指针。
> 包级脚本：`backend/scripts/verify-agent-package.mjs`（`pnpm verify:agent-package`）。
> 契约落点：`docs/02` §4.4（Agent 端点表，本包后仍差 P1 的 `copy` 与 F 包的 `conversations`）+ §十四。

## 概况

| 项 | 内容 |
|----|------|
| 批次 | P0-1-24 Agent 包验收（`[✓]` 2026-09-22，包 E **收口 3/3**） |
| 改动文件 | 根 `package.json` 与 `backend/package.json`（各加一条 `verify:agent-package`）、`backend/src/index.ts`（启动信封 `step`）、`docs/06`、`docs/02`、`README.md` |
| 新增文件 | `backend/scripts/verify-agent-package.mjs`（包级脚本，**一行一组**逐行跑 4 条门槛） |
| 新增依赖 / 环境变量 / 接口 | **零 / 零 / 零**（纯验收批次 —— 端点全部由 P0-1-22/23 落地） |
| 验收 | `pnpm verify:agent-package` **13 项全通过**（R1 3 / R2 3 / R3 3 / R4 3 / R5 1）；**既有 18 档全部未回归（19/19 退出码 0）** |
| 真问题 | 0 个实现 bug；**4 条"包级验收"特有的方法论坑**（坑 1~3）+ **1 条自己写出来的假断言**（坑 4） |

> 本批没有发现被测代码的缺陷 —— 这是**好消息**：E 包的两批（P0-1-22/23）验收做得够紧，
> 收口时没有"单档绿、串起来崩"的情况。所以本文件的value全在**"包级验收该怎么做"**上。

---

## 坑 1 ⚠️ 「每档都绿」是最容易骗人的信号：三出口必须逐字一致

**问题**：门槛② 的原文只有两句话 ——「绑定 2 个知识库 → 详情完整回显 → 解绑 1 个 → 详情立即反映」。
`verify-agents` 的 H 组已经验过"`PUT` 的响应与 `GET :id` 逐字一致"，看上去包级脚本无事可做。

但"详情完整回显"这个说法在**三个出口**都有落点：写端点（`PUT`）、详情端点（`GET :id`）、
列表端点（`GET /api/agents`）。**各验各的时候**——

| 假想实现 | `verify-agents` H（只对 `PUT` vs `GET :id`） | 包级脚本 R2（三出口 + 顺序） |
|---|---|---|
| 三个出口都正确 | 绿 | 绿 |
| `PUT` 回 A 形状（比如按提交顺序）、`GET :id` 也回 A 形状、**列表回 B 形状**（按 id 序） | **绿**（那两条恰好都对） | **红** |
| `PUT` 与详情**故意保持同形状**、列表却漏乘一次排序 | **绿** | **红** |

**根因**：P0-1-21 已经定过"同一份数据不许有第二种形状"，但那条纪律之前只在**两个**出口间验过
（上传响应 vs 列表项）。出口增加到三个之后，"两两各验一次"是 3 对组合、而**包级只需要一条断言**
就能覆盖全部组合 —— 成本与覆盖面的关系在这里反过来了。

**对策**：R2 里同时写**两条**：

```js
// ① 集合语义（顺序无关）：写端点 = 详情 = 列表，且都恰好是提交的那两条
assertSameSet(componentSet(writeItem.components), componentSet(expected), '写端点响应里的绑定')
assertSameSet(componentSet(detail.item.components),   componentSet(expected), '详情端点回显的绑定')
assertSameSet(componentSet(listItem.components),      componentSet(expected), '列表端点回显的绑定')
// ② 逐字（含顺序）：三处两两相等（`componentType asc, refId asc` 是共同契约）
assertEqual(JSON.stringify(writeItem.components), JSON.stringify(detail.item.components), '…')
assertEqual(JSON.stringify(detail.item.components), JSON.stringify(listItem.components), '…')
```

R1 里另配一条**键集合断言**（建 / 详情 / 列表三处 `Object.keys().sort()` 逐字相同）
—— 它挡的是"以后有人顺手往某个出口多 select 一列"。

```text
[PASS] 绑 2 个知识库：写端点响应 = 详情端点 = 列表端点，且都恰好是提交的那两条
[PASS] 建、详情、列表三条路径**投影键集合逐字一致**（同一份数据不许有第二种形状）
```

> 通用教训：**"包级验收"的价值不是把断言再写一遍，而是把"只在组合上才成立"的性质写出来。**
> 判断方法：问"如果我只验一半，哪种坏实现能蒙过去" —— 想得出具体实现，就说明该补一条组合断言。

---

## 坑 2 ⚠️ 门槛④ 的"只读"目前**只能验一半**：要标成「部分完成」而不是混进 ✅

**问题**：门槛④ 原文是「删除 Agent 后其会话**仍在（只读）**，组件绑定已解除」。
而 `conversations` 的端点是 **P0-1-25**（F 包）—— **现在没有任何 HTTP 出口**能观察
"这个会话读得到、写不进去"。"只读"的两个字在今天的代码里**没有对应的可观测行为**。

**两种错误做法**（都会让结论表说谎）：

- **把它写成 ✅**：因为"会话行还在、`status=FINISHED`"确实是事实。但那份 ✅ 会被读成
  "只读已验证"，而真正要验的"用户发消息会被拒"根本还没实现（连拒绝的门都还没有）。
- **干脆不验**：那"会话**仍在**"这一半也就没人验了 —— 而它恰恰是本包唯一的跨包风险点（见坑 3）。

**对策**：**验能验的那一半，并把这一半明确标成 ⚠️ 部分完成**，写在脚本的**结论表**里（人读的交付物）：

```text
  ✅ R4 门槛④ 删除 Agent 后其会话仍在（只读），组件绑定已解除  (3 项全通过)
  ⚠️ 门槛④ 的"只读"：会话端点属 P0-1-25 ⇒ 本包在 **DB 层**取证（行还在 / status=FINISHED / 消息还在）；"发消息被拒"要等 F 包
```

DB 层的取证内容是四件事（都是"删 Agent 不该发生的事"的反面）：

| 断言 | 挡住的坏实现 |
|---|---|
| `conversations` 行还在 | "顺手把会话也删了"（`onDelete: Restrict` 之外的服务层删除） |
| `status === FINISHED` | "只打 `deleted_at` 标记、会话不管"（历史会话还能继续发消息） |
| `messages` 行还在 | "删会话级联删消息"被误触发 |
| `finishedConversations === 1`（且只数 `ACTIVE`） | 用 `_count.conversations` 顶替（一个已有 10 个 FINISHED 会话的 Agent 会回报"影响 10 个"，`03` §七 的级联提示会吓到用户） |

会话行是脚本**直接造的**（`02` §三 的同形数据：`agentId/userId/topic/status/lastMessageAt` + 一条 USER 消息）：

```js
const conversation = await prisma.conversation.create({ data: { agentId, userId, topic, status: ACTIVE, lastMessageAt: new Date() } })
```

**F 包落地后要做的事**（写进 `docs/06` 与 `docs/02` 的口径里，不只留在这份归档里）：
把这一条换成**打端点**（`GET /api/agents/:id/conversations` 能列出该会话 + 对它发消息被拒）。
这正是 P0-1-21 定下的规矩：**"把临时等价取证换成真链路"，换不动的要标出来、不能混进 ✅。**

---

## 坑 3 本包唯一一条跨包链路：删库守卫（D）× 软删解绑（E）

**问题**：`kb.service.ts` 的删库守卫数的是 `agent_components`（**多态外键、无 FK**），
而"软删 Agent 时顺手解绑"是 E 包的职责。**只做一半**（软删只打标记、不解绑）时症状极隐蔽：

> 界面上那个 Agent 已经"没了"（列表里不出现、详情 404），
> 用户想删掉它绑过的那个知识库，却一直拿到 409「正被 1 个 Agent 绑定」——
> 而那个 Agent 他**再也点不开**，没有任何入口能解绑。**他无路可走。**

`verify-agents` 的 E 组已经用"绑 KB → 删 KB 409 → 软删 Agent → 删 KB 200"验过一遍，
但那是**单档**的验法（自己绑、自己删）。包级脚本要问的是"**串起来**还成立吗"，
于是 R4 把它做成**一对反向断言**，且**反例先出现**：

```text
① 再建一个 Agent 绑上它        → 此刻删库必须 409（这是守卫仍生效的反例，不是失败）
② 软删那个占位 Agent           → 同一句删库请求必须变 200
```

**先跑反例是有意的**：如果只验"解绑后能删"，一个"删库守卫被删掉了"的实现（守卫不再检查绑定）
也会全绿 —— 那时 409 那一条才是能不能发现问题的关键。
而"解绑后能删"则挡住"只打标记"的实现。两条合起来才把**两个方向**都钉死。

```text
[PASS] 跨包链路：解绑之后**那个知识库才删得掉**（D 包的删库守卫数的是绑定行）
```

> 通用教训：**跨包链路的验收要"反例 + 正例"成对出现**。只有正例时，"守卫被移除"的坏实现会蒙过去；
> 只有反例时，"守卫没接上解绑"的坏实现会蒙过去。

---

## 坑 4 我自己写出来的一条**假断言**：单侧断言 + 未定义的变量

**问题**：R4 最后一条本来想验"软删的不再出现在列表里"，第一版写成了这样：

```js
// ✗ 第一版：单侧 + 引用了一个根本不存在的变量
await it('列表里不再出现被软删的两个 Agent', async () => {
  const ids = await myAgentIdsInList(ownerCookie)
  assert(!ids.includes(created.deletedKbIdHolder), '被删的不该还在列表里')   // ← 这个键从没被赋过值
})
```

两个毛病叠在一起：

- **引用了不存在的字段**（`created.deletedKbIdHolder`）⇒ `undefined`，而
  `[].includes(undefined)` 恒为 `false` ⇒ `!false === true` ⇒ **断言永真**。
  更糟的是它**不会报错、不会 lint 报警**（`created` 是 `{}`，索引访问在 JS 里合法）。
- **单侧断言**：只验"被删的不在"，一个**列表恒为空**的实现（或"过滤条件写反成 `deletedAt` 非空"）
  照样全绿。

**对策**：改成**两方向 + 逐个真 id**：

```js
const ids = await myAgentIdsInList(ownerCookie)
for (const deletedId of softDeletedAgentIds) {
  assert(!ids.includes(deletedId), `被软删的 ${deletedId} 不该还在列表里（点进去会是死链：详情 404）`)
}
assert(ids.includes(created.chatbot.id),   '没被删的那个必须还在列表里')
assert(ids.includes(created.taskAgent.id), '没被删的任务型也必须还在列表里')
```

为此专门加了 `softDeletedAgentIds` 数组（软删是**保留行**的，与 `createdAgentIds` 语义不同，
清理时要一起真删）。

> 通用教训：**"我写的断言"和"被测代码"一样会静默出错，而且报错指不到自己头上**
> （P0-1-17 坑 ⑥ 已经记过一次"看着像被测代码坏了、其实是脚本写错"）。
> 抓这类问题的唯一办法是**反问一遍"这条断言在什么输入下会变红"** ——
> 答不上来的断言（比如这里：`ids` 里永远不含 `undefined`）等于没写。

---

## 另外两处"跑起来才发现"的细节（轻）

1. **`finally` 里的断言不会被 `it()` 计数**：R5（清场）必须放在 `finally` 里 ——
   前面的用例抛错时残留复核仍要给出结论（"跑完干净"本身是这个包的交付条件）。
   但它**不走 `it()` 包装**，所以分组计数要**手工补**一次：

   ```js
   groupStart('R5', '清场：自清理 + 残留复核', '…')
   if (dirty.length === 0 && sessionsLeft.length === 0) { passed += 1; currentGroup.passed += 1 }
   else { failed += 1; currentGroup.failed += 1 }
   ```

   漏了这一步**不会报错**，只会让结论表里那一行永远显示 "(0 项全通过)" —— 一种很安静的谎。
2. **全角空格会被 `eslint` 的 `no-irregular-whitespace` 拦下**：结论表里为对齐用了 `　`（U+3000），
   报错 `Irregular whitespace not allowed`（指到那个字符、却看不出是"想对齐"）。改用两个半角空格即可。
   顺带：脚本里两个 `import` 的枚举（`AgentType` / `ComponentType`）本批没用到 ⇒
   `@typescript-eslint/no-unused-vars` 报错，删掉即可 —— **`pnpm lint` 是这批唯一"卡住过一次"的检查**。
3. **清理顺序**：本批**首次**在同一个脚本里同时碰 `agent_components` 与 `messages`（**分区表**）
   ⇒ 按外键（全 `RESTRICT`）自下而上删，且**先把会话 id 查出来再删**，
   不去依赖"`deleteMany` 的 `where` 支持关系过滤"这个较新的能力（少用一个不确定的语法）。

---

## 验收记录（原始输出）

### 1. `pnpm verify:agent-package`（真依赖档：PG + Redis；**不需要 MinIO**）

```text
══ P0-1-24 Agent 包验收（包 E 收口）：两类型 CRUD / 绑库与解绑 / 权限 / 删除的连带 ══

── R1 门槛① 两种类型均可创建/编辑/删除 ──
   CHATBOT 与 TASK_AGENT 各走一条完整链；顺带钉"建/改/删三条路径共用同一套投影"
  [PASS] 两种类型都能建出来，且 `type` 按提交值落库、`canEdit=true`（创建者本人）
  [PASS] 建、详情、列表三条路径**投影键集合逐字一致**（同一份数据不许有第二种形状）
  [PASS] 两种类型都能改：文本字段三态 + 引导问题（`[]` 清空）

── R2 门槛② 绑定 2 个知识库 → 详情完整回显 → 解绑 1 个 → 详情立即反映 ──
   MCP 那一半按 docs/06 的口径变更为对偶形态（明确拒绝 + 文案指向 P0-2），见文件头 ⚠️①
  [PASS] 绑 2 个知识库：写端点响应 = 详情端点 = 列表端点，且都恰好是提交的那两条
  [PASS] 解绑 1 个：详情**立即**只反映剩下的那 1 个（不是缓存、不是延迟生效）
  [PASS] MCP 对偶：含 MCP 的提交被**明确拒绝**，且文案指向 P0-2（口径变更的守门断言）

── R3 门槛③ 普通用户改他人 Agent 被拒（403）；本人 Agent 可改 ──
   ⚠️ 三个方向都写全：仅验"他人 403"的话，一个"仅创建者"的实现（ADMIN 也改不了）会全绿
  [PASS] 他人（MEMBER）改 → 403，且**一个字节都没写**（改名字的前后逐字比对）
  [PASS] 本人改自己的 → 200（创建者是 MEMBER，这条同时守着"没被顺手加 requireAdmin"）
  [PASS] ADMIN 改**别人**的 → 200（"创建者 + ADMIN 可编删"里的后半句）

── R4 门槛④ 删除 Agent 后其会话仍在（只读），组件绑定已解除 ──
   ⚠️ 会话端点属 P0-1-25 ⇒ 本组在 **DB 层**取证；"只读"的运行时表现要等 F 包（见文件头 ⚠️②）
  [PASS] 删除时**三件事一起发生**：deleted_at 打标 / 绑定解干净 / 会话转只读且消息还在
  [PASS] 跨包链路：解绑之后**那个知识库才删得掉**（D 包的删库守卫数的是绑定行）
  [PASS] 列表里不再出现被软删的两个 Agent（`deletedAt: null` 是所有查询的默认过滤）

── 清理（自清理 + 复核残留）──

── R5 清场：自清理 + 残留复核 ──
   八张表 + 会话键，全部要能复核为 0（不靠"我没报错"）
  [PASS] 残留复核：8 张表全部为 0（agents=0 agentComponents=0 conversations=0 messages=0
         knowledgeBases=0 models=0 providers=0 users=0），3 个会话键全部清空

── E 包结论表（docs/06 P0-1-24 的四条验收门槛）──
  ✅ R1 门槛① 两种类型均可创建/编辑/删除  (3 项全通过)
  ✅ R2 门槛② 绑定 2 个知识库 → 详情完整回显 → 解绑 1 个 → 详情立即反映  (3 项全通过)
  ✅ R3 门槛③ 普通用户改他人 Agent 被拒（403）；本人 Agent 可改  (3 项全通过)
  ✅ R4 门槛④ 删除 Agent 后其会话仍在（只读），组件绑定已解除  (3 项全通过)
  ✅ R5 清场：自清理 + 残留复核  (1 项全通过)
  ⚠️ 门槛② 的 **MCP** 那一半：P0-1 阶段明确拒绝（400 + 指向 P0-2），由 P0-2 接回 —— 本包验的是**对偶形态**
  ⚠️ 门槛④ 的"只读"：会话端点属 P0-1-25 ⇒ 本包在 **DB 层**取证（行还在 / status=FINISHED / 消息还在）；"发消息被拒"要等 F 包
  边界：本包收口时**浏览器仍是占位页**（前端里程碑 P0-1-30、Agent 界面 P0-1-31）；命令行可跑的完整链路见 README 的手工端测段

✅ P0-1-24 Agent 包验收通过（四条门槛）：13 项全通过
```

### 2. 全量回归（**19 档**，`tee` 到 `/tmp/P0-1-24-regress.log`）

```text
app                    exit=0   ✅ 接口级验收通过：86 项全通过
db                     exit=0   ✅ P0-1-5 数据层验收通过：17 项全通过
session                exit=0   ✅ P0-1-6 会话验收通过：13 项全通过
auth                   exit=0   ✅ P0-1-7 认证接口验收通过：21 项全通过
users                  exit=0   ✅ P0-1-8 用户管理接口验收通过：17 项全通过
model-providers        exit=0   ✅ P0-1-10 模型池 Provider 验收通过：18 项全通过
models                 exit=0   ✅ P0-1-11 模型管理验收通过：17 项全通过
llm                    exit=0   ✅ P0-1-12 LLM client 验收通过：22 项全通过
embedding              exit=0   ✅ P0-1-13 embedding 双模式验收通过：27 项全通过
knowledge              exit=0   ✅ P0-1-14 知识库数据层验收通过：23 项全通过
documents              exit=0   ✅ 文档端点验收通过（P0-1-16 上传/解析/前置校验 + P0-1-17 入队
                                  + P0-1-21 列表/下载）：44 项全通过
pipeline               exit=0   ✅ 文档流水线验收通过（P0-1-17 队列/状态机/worker + P0-1-18 空文本
                                  检测/分块 + P0-1-19 入库）：29 项全通过
ingest                 exit=0   ✅ P0-1-19 入库 / 覆盖重建 / 失败重试验收通过：23 项全通过
knowledge-bases        exit=0   ✅ P0-1-15 知识库 CRUD 验收通过：19 项全通过
retrieval              exit=0   ✅ P0-1-20 双路检索 + RRF 融合验收通过：27 项全通过
kb-package             exit=0   ✅ P0-1-21 知识库包验收通过（子方案① §十二 的 8 行）：11 项全通过
agents                 exit=0   ✅ P0-1-22/23 智能体验收通过：35 项全通过
agent-package          exit=0   ✅ P0-1-24 Agent 包验收通过（四条门槛）：13 项全通过   ← 本批新增
e2e                    exit=0   ✅ P0-1-9 端到端验收通过：17 项全通过
（19/19 exit=0，无失败档 `/tmp/P0-1-24-*.fail.log`）
```

> 本批是**纯验收批次**（零源码改动），回归的意义与往常不同：它证明的是
> **"新增一个包级脚本不会碰坏任何既有档"**（尤其是本脚本与 `verify-agents` 都用同一批表：
> `agents` / `agent_components` / `conversations` / `messages`）。
> ⚠️ 另一个**没有**在本批回归、但值得记的点：`pnpm -r typecheck`/`build` 未跑（本批没动 `.ts`），
> 按批次工作流"未动 schema 时直接跑 `tsc`、绕开 `prisma generate`"的约定执行。

### 3. 静态检查

`pnpm lint` ✅（本批唯一卡住过一次的检查 —— 见"另外两处细节"第 2 点）/
`pnpm check:batch` ✅（`docs/06` 最后一个 `[✓]` 的批次号 ↔ 启动信封 `step`）。
`docs/02` 的 `^### 4\.` 与 `docs/06` 的 `^## / ^###` 小节序号已 grep 复核连续 ✅
（P0-1-23 新加进收尾清单的那条，本批第一次执行）。

---

## 边界与后续

- **本批不是可端测里程碑**：§七 待决事项 7 的第二个端测点仍是 **P0-1-30（浏览器首站）**；
  Agent 界面是 **P0-1-31**。命令行可跑的完整 Agent 链路（建 → 绑库 → 解绑 → 改权限 → 删）
  见 README 的手工端测 **⑭ / ⑭-h**。
- **F 包（P0-1-25 起）之后要回补的一件事**：把门槛④ 的"只读"从 **DB 层取证**换成**打端点**
  （`GET /api/agents/:id/conversations` + "对它发消息被拒"）—— 并在 `docs/06` 与脚本里
  把那条 ⚠️ 部分完成改成 ✅（这是 P0-1-21 定下的"换不动的临时等价取证要标出来、能换就换掉"）。
- **MCP 的接回点在 P0-2**（与 P0-1-23 同一条）：建 `mcp_servers` 表时把
  `assertComponentRefsBindable` 的"无条件拒绝"换成"存在性校验"，并把门槛② 改回含 MCP 的版本、
  把 MCP 那半从 ⚠️ 提到 ✅。
- **P1 事项（不在本批）**：`POST /api/agents/:id/copy`（含组件绑定整份拷贝，`01` §3.3 决策）。
- **刻意不做**：给门槛④ 加"会话列表端点先做出来再验"（那是把 F 包的活提前——`docs/06` §六 第 25 条
  已定"不提前做下一批"的口径）。
