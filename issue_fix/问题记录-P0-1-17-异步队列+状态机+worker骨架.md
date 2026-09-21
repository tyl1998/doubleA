# P0-1-17 异步队列 + 状态机 + worker 骨架

> 批次：**P0-1-17**（包 D 第 4 步）｜日期：2026-09-21｜前置：P0-1-16
> 依据：`docs/06` P0-1-17、`docs/02` §二、`docs/子方案/知识库流水线.md` §三/§十
> 验收：**`pnpm verify:pipeline` 24 项全通过**（需 PG + Redis + MinIO）；`verify:documents` 30 → **32 项**；`verify:app` 49 → **50 项**

## 概况

| 项 | 内容 |
|----|------|
| 新增依赖 | **无**（队列复用既有 `ioredis`；本批**零新增依赖、`allowBuilds` 无需改动**） |
| 新增文件 | `backend/src/pipeline/queue.ts`、`backend/src/pipeline/stages.ts`、`backend/src/pipeline/worker.ts`、`backend/scripts/verify-pipeline.mjs`、`backend/scripts/probe-upload-once.mjs` |
| 改动文件 | `shared/src/document.ts`（状态机契约）、`backend/src/config.ts`（`PIPELINE_QUEUE_KEY`）、`backend/src/infra/redis.ts`（`createRedisConnection`）、`backend/src/services/document.service.ts`（入队 + 回滚）、`backend/src/index.ts`（worker 生命周期 + `step`）、`backend/scripts/{verify-app,verify-documents,verify-e2e}.mjs`、`infra/.env.example`、`infra/.env`、两处 `package.json`、`docs/02`/`docs/06`/`子方案①`/`README.md` |
| 本轮**真 bug** | ① 状态机转换集合的断言按**书写顺序**写死了期望值 ⇒ 换一下 `DOCUMENT_STATUSES` 的顺序就假失败（见坑 8）；② `verify-documents` 的 E 组把 `upload()` 的返回值当成了 `fetch` 响应（见坑 9）。两个都是**跑验收才抓出来**的 |
| 口径增量 | ① 幂等从"一道"做成**四道**（`子方案①` §三 只写了第 ④ 道）；② job 形状在 §三 三字段之外多带 `contentHash`；③ 状态机写进 `shared` 成为**跨包契约** |
| 坑预判订正 | `06` 的预判（"List 无 ack ⇒ worker 崩了会丢 job，故必须有重试入口，不能假设队列必达"）**成立**，且本批把补救做成**协议层成立**的事 —— 见文末「坑预判取证」 |

---

## 坑 1 ⚠️ `BRPOP` 会独占整条 Redis 连接（只在**队列空闲**时才显形）

**现象**

设计上最容易被忽略、症状又最容易被误判的一处：把阻塞读接到会话单例（`getRedis()`）上之后，**只要队列是空的**，
`BRPOP` 就会把整条连接占住（它不返回、连接也不能发别的命令）。于是 `/health` 的 Redis 探活、
`/api/auth` 的会话读写**全部挂起**。而队列**有 job 时一切正常**（`BRPOP` 立刻返回并让出）——
所以本地一测"队列有任务"就看不到问题，到了线上队列空闲的时段才炸。

**根因**

`BRPOP` 是**连接级**阻塞命令：ioredis 在它返回之前不会从这条连接上发任何其它命令（包括 pipeline 里的）。

**对策**

1. `infra/redis.ts` 抽出 `createRedisConnection(role: string)`，与单例共用 `buildClient()` 但各建一条连接；
   队列的阻塞读走专用连接（`createRedisConnection('pipeline-queue')`），`llen` 这类非阻塞命令仍可用共享连接。
2. `ensureRedisConnected(connection = getRedis())` 改成可接收非单例连接。
3. 验收里有一条**专门盯它**：故意留一个挂起的 `BRPOP`，同时用**共享连接**发 `PING`，必须 < 500ms 返回。
   （只断言"队列能取到 job"是实现无关的，抓不到这个错误连接的选择。）
4. 收尾用 `disconnect()` 而**不是** `quit()`：调用它的时机恰恰是 `BRPOP` 还挂着的时候，`quit` 要等命令返回，
   会一路等满优雅退出的宽限期（`stopPipelineWorker(graceMs)` 白等 5s）。

```ts
// backend/src/pipeline/queue.ts（要点）
let blocking: Redis | undefined
function blockingConnection(): Redis {
  blocking ??= createRedisConnection('pipeline-queue') // 专用连接，绝不复用会话单例
  return blocking
}
export async function closePipelineQueue(): Promise<void> {
  blocking?.disconnect() // 不是 quit()：此刻 BRPOP 还挂着，quit 会一直等
  blocking = undefined
}
```

---

## 坑 2 幂等是**四道**，不是一道；"四道全跳过"必须**一个字节都不写**

**现象**

`子方案①` §三 只写了第 ④ 道（"若已是 READY 且 `content_hash` 未变 → 跳过"）。但 List 队列**没有 ack**，
必然出现重复投递；只做第 ④ 道会在这些情况下出错：同一文档的两个 job 被连着取走（第二个该跳过）、
文档已被删（不该再把状态写回去）、job 里带的是**旧内容的 hash**（该跳过而不是照着重跑）。

**对策**：四道闸依次把守 ——

| 道 | 判据 | 为什么必要 |
|----|------|-----------|
| ① | **同进程在飞去重**（`inFlightDocIds`） | 本进程只有一个阻塞消费者，"取走 → 登记"之间没有 `await` 窗口 ⇒ 这条是**确定性**的，不靠运气 |
| ② | 文档行不存在 | 上传后又被删了 |
| ③ | job 的 `contentHash` ≠ 行的 `content_hash` | 陈旧 job（内容已换过）—— 这正是 job 要多带 `contentHash` 的原因 |
| ④ | 行已是 `READY` | 重复投递一个已成功的任务 |

**取证方式值得记一笔**：断言"四道全跳过时**零写入**"不能只看返回的 `skipped` 计数（那是实现的自述），
要看**库**：`updated_at` **逐字不变**（"没写"看得见，而"写了但值相同"会被漏掉），
再加上"阶段执行次数仍为 1"。反过来，`PARSING`/`FAILED` 且 hash 相符的 job **会真的处理** ——
这正是"重投能把文档救回来"的机制。

---

## 坑 3 写状态一律走 CAS；`READY → FAILED` **刻意非法**，且它没有 HTTP 路径能验

**现象 / 根因**

worker 是 `documents.status` 的**唯一写者**，所以状态机的不变式没有任何 HTTP 端点能观测到。
最危险的一条是 `READY → FAILED`：那是"**过期的 job 把一份已成功的文档打回失败**"的唯一形态。
用户看到的是"内容明明能用却报失败"，而且**无法自愈** —— 重投会被第 ④ 道幂等规则跳过。

**对策**

1. 状态机的**唯一定义**放 `shared/src/document.ts`：
   `PARSING → {PARSING, READY, FAILED}`、`READY → PARSING`、`FAILED → PARSING`。
   也**刻意不允许** `FAILED → READY`：重试必须经过**可见的** `PARSING` 中间态，否则列表里看不出"正在重试"。
2. 写状态走 **CAS**：`updateMany({ where: { id, status: from } })`，`from` 取**当前**状态而不是硬写 `'PARSING'`。
   `count === 0` ⇒ 状态已被别的写者改过，本进程**不覆盖**、只 `warn`。
   （"先查再写"在两个消费者都读到旧态时会把非法迁移写进去；CAS 把判断与写入合成一个原子操作。）
3. 在 **`verify:app`** 里用**纯函数矩阵**守这条不变式（不需要 Redis/PG，可进 CI）：5 条合法迁移逐条断言，
   再钉死 `READY→FAILED`、`READY→READY`、`FAILED→READY` 三条非法。

---

## 坑 4 上传与入队是**同一件事的两半**：入队失败必须整次回滚

**现象**

只做到"建 `PARSING` 行"而不保证入队成功，后果是**最坏**的一种：那行永远是 `PARSING`、没有任何人会消费它，
而用户**重传还会被判重命中跳过**（连新行都不建）⇒ 界面上出现"上传成功、永远转圈、重传也没用"的文档。

**对策**

`document.service.ts` 的 `rollbackRegistration(docId, bucket, fileKey)`：入队失败时删行 + 删 S3 对象，
再抛 `AppError.internal('任务入队失败…')`。顺序仍是 **S3 → DB → 入队**，任一步失败都往回收拾。

**取证靠子进程 A/B 对照**（不是把父进程的连接打断）：

| 组 | 环境 | 期望 |
|----|------|------|
| 对照组 | 子进程 + **真 Redis** | 上传成功、登记 1 行、落 1 个对象、投 1 条任务 |
| 实验组 | 子进程注入 `REDIS_URL=redis://127.0.0.1:1` | 入队失败 ⇒ **整次上传回滚**（行与对象都不留）、库里没有痕迹、队列为空 |

对照组不是多余的：**没有它，实验组的"失败"可能只是探针自己坏了**（假通过）。

---

## 坑 5 worker 的生命周期归**进程入口**，不进 `buildApp()`

`verify:app` 用 `app.inject` 打请求，**不连 Redis**。若把 `startPipelineWorker()` 写进 `buildApp()`，
那套契约验收会被迫连 Redis，还会莫名开始消费（并可能抢掉别人投的任务）。

⇒ `index.ts` 在 `listen` **成功之后**才 `startPipelineWorker()`（绑定失败就没必要开始消费）；
`shutdown()` 里**先** `stopPipelineWorker()` 再 `app.close()` + 关 PG/Redis（否则 worker 会拿着
已关闭的连接继续处理，日志里出现一堆假故障）。

---

## 坑 6 队列键必须可配：`REDIS_URL` 是共享的，队列是"被消费"的资源

**现象**

跑着的 dev server 与验收脚本用同一条队列时，"谁取走 job"是**随机的**。症状**不是报错**，
而是"验收**时好时坏**"：脚本投的任务被 dev server 的 worker 抢走处理了，脚本自己等不到结果。

**对策**：新增 **`PIPELINE_QUEUE_KEY`**（默认 `pipeline:jobs`）。`verify:pipeline` / `verify:documents`
一律注入 `verify:*` 前缀的随机键，`verify:e2e` 起的一次性进程也换键 —— 于是脚本之间、脚本与开发队列之间**互不干扰**，
且收尾能干净地 `del` 掉自己那个键（H 组专门断言"队列键在收尾后不存在"）。

> 这条与"共享 Redis"是同一类问题（P0-1-6 的会话键同理），只是队列这侧更隐蔽：**任务是被消费掉的，
> 出了事没有痕迹可查**。

---

## 坑 7 失败要区分"**文档**的问题"与"**基础设施**的问题"

- 阶段抛错（文件读不到、解析失败、内容与扩展名不符）⇒ `FAILED` + `error_msg`（**给人看**的文案）。
- **读行 / 写状态本身就失败**（PG 挂了）⇒ **不写状态**，只记日志。

理由：把"我们查不了"写成"这个文档坏了"，会让用户去重传一个其实没问题的文件。代价是文档停在 `PARSING` ——
而 `PARSING` + hash 相符的 job **会被重新处理**，正是重试入口覆盖的场景（坑 2 的反面用法）。

`error_msg` 文案纪律：按"用户能不能照着做点什么"写（例：「原文件读取失败：对象存储里找不到《重试.pdf》，
请重新上传该文档」）；bucket / S3 键 / 堆栈**只进日志**。阶段抛出的 `AppError.message` 原样采用，
非 `AppError`（编程错误）加「内部错误：」前缀并截断 300 字（`describeFailure()`）。

---

## 坑 8 ⚠️ 状态机断言按**书写顺序**写死期望值 ⇒ 假失败（跑验收才抓出来）

**现象**

`verify:pipeline` A 组第一次跑就红：

```
[FAIL] 状态机矩阵：合法转换恰好 4 条 ...
       合法转换集合：
       期望 ["PARSING->PARSING","PARSING->READY","PARSING->FAILED","READY->PARSING","FAILED->PARSING"]
       实际 ["PARSING->PARSING","PARSING->READY","PARSING->FAILED","READY->PARSING","FAILED->PARSING"]
```

两边**逐字看着一样**，实际顺序不同：实现是"按 `DOCUMENT_STATUSES` 双层循环"产出的
（`PARSING→…`、`READY→…`、`FAILED→…`），而期望值是手写的另一个顺序。

**根因**：转换集合是**集合语义**，却用了 `JSON.stringify` 直接比 —— 等于把"书写顺序"也当成了契约的一部分。

**对策**：**两边都排序再比**（`JSON.stringify([...legal].sort())` vs `[…].sort()`）。教训与 P0-1-15 那条同源：
**集合/多值的纯函数断言，比较前先归一化**；不然换个枚举顺序就假失败，而假失败会消磨对验收的信任。

> 顺带订正一处文案：该用例的标题原本写"恰好 4 条"，而断言实际是 **5 条**（3 个状态 × 3 个状态里的合法者）。
> 标题与断言不一致会误导后来人，已在收尾时改成"恰好 5 条"。

---

## 坑 9 `upload()` 的返回值不是 `fetch` 响应（脚本自身的 bug）

`verify-documents` 新增的 E 组里写了 `second.response.json()`，但脚本的 `upload()` 助手返回的是
`{ response, data, docId }` —— 取 body 要用 `second.json().data`。症状是 `TypeError: second.response is undefined`，
**看着像被测代码坏了，其实是脚本写错了**。

⇒ 教训：验收脚本里的**助手函数返回值形状**要有唯一写法；新增断言时照抄同一组里的既有写法，
不要凭手感写。

---

## 其它值得记一笔的

### ① 阶段数组 + 可注入 = "骨架"的具体含义

`stages.ts` 里本批只有 `load-source` 与 `parse`（④ 空文本检测与 ⑤ 分块属 P0-1-18，
⑥ embedding 与 ⑦ 入库属 P0-1-19）。`startPipelineWorker({ stages, concurrency })` 让验收能塞**一组慢速假阶段**，
从而**确定性**地观测并发闸与幂等（E 组：8 个 200ms 任务，峰值并发恰为 2，总耗时 ≥ 4 轮）。
意思是：后两批各插一个阶段，worker 的并发/幂等/失败处理**一行都不用改**。

### ② `parse` 阶段**再跑一次** `detectFormat`

上传时校验的是**客户端发来的字节**，worker 读到的是**存储里的字节** —— 两者可能不同（对象被换掉）。
验收里"对象被换成文本 ⇒ `FAILED` 且原因是「文件内容与扩展名不符」"正是这条，
顺带证明阶段跑的是**真逻辑**而不是桩。

### ③ **并发闸门要同时测峰值与总耗时**

只断言"`peakInFlight` ≤ 2"的实现，把闸门写成**串行**（一次只跑一个）也能过。
所以 E 组同时测下界：8 个 200ms 的任务，总耗时必须 ≥ 4 轮 × 200ms。

### ④ 验收脚本的日志噪音

F 组（S3 对象丢失）与 G 组（死 Redis）**故意制造失败**，会把错误堆栈打进日志、把真结论冲没。
⇒ 脚本顶部设 `LOG_LEVEL=fatal`（`error` 还不够 —— 失败任务的 `error` 级日志正是要静音的那批）。

### ⑤ 回归时 `pnpm -r build` 被"环境批量删除防护"挡住

`pnpm -r build` 会触发 `prisma generate`，而它会**重新删除并生成** `backend/generated/prisma`
（114 个文件 > 阈值 50）⇒ 环境防护报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 并中止。
本批**没有动 schema、客户端已是最新**，故回归这三项时直接跑 `tsc`/`vite build`（不经 generate 那一步）：
`pnpm --filter @doubulea/shared exec tsc -p tsconfig.json`、`pnpm --filter @doubulea/backend exec tsc -p tsconfig.json`、
frontend 的 build。**注意**：动了 `schema.prisma` 时必须正常走 `pnpm db:generate`（或按提示确认），
不能拿这条当惯例。

---

## 验收原始输出（节选）

### `node scripts/verify-pipeline.mjs`（24 项）

```
══ P0-1-17 异步队列 + 状态机 + worker 骨架 ══
  [PASS] 注入的队列键真的生效（`verify:` 前缀 ⇒ 与 dev server 的默认队列互不干扰）
  [PASS] job 编解码往返：字段逐字相等，且队列里存的是 JSON 字符串
  [PASS] 非法 payload 一律被丢弃（返回 undefined，不抛）—— 队列是"外部输入"
  [PASS] 状态机矩阵：合法转换恰好 5 条（3 个状态 × 3 个状态里的合法者），且 READY 不可能被打回 FAILED
  [PASS] 入队返回新的队列长度；取件拿到的就是投进去的那条，取完队列归零
  [PASS] 空队列：等满 5s 后返回 undefined（不是永久阻塞）
  [PASS] 垃圾 payload 被丢弃（取件不抛、且它确实被移出队列）
  [PASS] 阻塞读**不占用共享连接**：BRPOP 挂起期间 /api 侧的 Redis 命令仍立刻返回
  [PASS] 上传四格式 → 响应 status 恒为 PARSING，且每篇都入队一条（队列长度 = 4）
  [PASS] 启动 worker → 四篇全部 READY，error_msg 为空，chunk_count=0（本批的预期中间态）
  [PASS] 同一文档被**并发**投递 3 次：只处理一次（幂等第 ① 道：在飞去重）
  [PASS] 已 READY 再投同一 job：**一个字节都不写**（updated_at 逐字不变）
  [PASS] 过期 job（contentHash 不符）：跳过，不动状态也不动时间戳
  [PASS] 文档已删的 job：跳过并告警，不抛错、不影响后续消费
  [PASS] 8 个慢任务（各 200ms）：峰值并发恰为 2，全部只处理一次
  [PASS] 原文件在 S3 里丢了 → FAILED，error_msg 是可展示的中文原因、chunk_count 归 0
  [PASS] 补回原文件 + **重投同一个 job** → 回到 READY，error_msg 被清空（这就是"重试入口"）
  [PASS] S3 对象被换成别的内容 → FAILED 且原因是「文件内容与扩展名不符」（证明 parse 阶段跑的是真逻辑）
  [PASS] 对照组（子进程 + 真 Redis）：上传成功、登记 1 行、落 1 个对象、投 1 条任务
  [PASS] 死 Redis（子进程注入）：入队失败 ⇒ **整次上传回滚**（文档行与 S3 对象都不留）
  [PASS] 死 Redis 那条路没在任何地方留下痕迹（库里只有对照组那一条，队列为空）
  [PASS] 删库（API）→ 该库 documents 行与 S3 对象全部清空（包括 worker 处理过的那些）
  [PASS] 队列键在收尾后不存在（不把任务留给共用这份 Redis 的别的进程）
  [PASS] 第二处独立取证：删探针库 → 同样是双清（避免"第一条过了只是碰巧"）
✅ P0-1-17 异步队列 + 状态机 + worker 骨架验收通过：24 项全通过
```

### `node scripts/verify-documents.mjs`（32 项，本批 +2）

```
  [PASS] 新建一条文档就多一条任务（`子方案①` §三 ① 登记 → ② 入队）
  [PASS] 判重命中**不入队**：没有新文档要处理，多投一条只会让 worker 白跑一次跳过
  [PASS] 删库（走 API）→ 该库的 documents 行与 S3 对象全部消失
  [PASS] 删第二个库（API）→ 同样干净；随后复核临时数据归零
✅ P0-1-16 文档上传 + 四格式解析验收通过：32 项全通过
```

### `node scripts/verify-app.mjs`（50 项，本批 +1 段）

本批新增第 19 段：状态机契约（5 条合法迁移 + `READY→FAILED` / `READY→READY` / `FAILED→READY` 三条非法）。

```
✅ 接口级验收通过：50 项全通过
```

### 静态检查

```
pnpm lint                                → eslint . 无告警
pnpm --filter @doubulea/shared  exec tsc -p tsconfig.json   → OK
pnpm --filter @doubulea/backend exec tsc -p tsconfig.json   → OK
```

### 未回归（既有各档逐项仍通过）

`db 17 / session 13 / auth 21 / users 17 / model-providers 18 / models 17 / llm 22 / embedding 27 /
knowledge 23 / knowledge-bases 19 / e2e 17`。

---

## 坑预判取证

`06` 的预判 **成立**："List 无 ack 语义 —— worker 崩溃会丢 job，故必须有「重试」入口（P0-1-19），
不能假设队列必达。"

`BRPOP` **取走即出队**，worker 在 `finally` 之外崩溃时那个 job 就没了。本批把补救做成**协议层成立**的事：
`PARSING`/`FAILED` 且 `contentHash` 相符的 job **会被真的重新处理** —— 于是"**重投同一个 job**"就是一个
可用的重试手段（F 组：对象丢失 → `FAILED` → 补回对象 + 重投 → `READY`，`error_msg` 被清空）。
P0-1-19 的 `POST .../retry` 只是给这件事**加一个端点与权限**，机制已就位。

---

## 遗留 / 下批提醒

1. **`READY` ≠ "可检索"**：解析成功即置 `READY`，而 `chunk_count` 仍是 0、chunk 一行也没有
   ⇒ 这个中间态下"扫描件"（解析出 0 字）**同样会变 `READY`**。空文本检测是 **P0-1-18**。
   验收已把 `chunkCount === 0` 写在明处，别下一个人把它当 bug。
2. **没有列表端点**（P0-1-21）⇒ 进度只能查库；**重试没有 HTTP 入口**（P0-1-19 加端点）。
3. **worker 是进程内的**（`PIPELINE_CONCURRENCY=2`），不是独立进程 —— worker 崩了后端一起崩。
   List 队列无 ack 的代价由此而来（坑 2/文末）。
4. `getPipelineWorkerStats()` **刻意未接进 `/health`**（不是本批范围），但它是运维面板/健康项的雏形。
5. 本批**不是可端测里程碑**：用户能在浏览器里亲手走通的完整链路要等 **P0-1-20**（检索可用）与
   **P0-1-21**（列表页面/端点）。当前命令行级的验收入口是 `pnpm verify:pipeline`。
