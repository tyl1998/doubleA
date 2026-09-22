# P0-1-27 ChatBot 编排循环（包 F 3/5）

> 对应 `docs/06-实施计划.md` 的 P0-1-27（**包 F 第 3 步**，F 包 3/5）。
> 按批次工作流的约定记录 **现象 / 根因 / 对策**与**原始输出**；`docs/06` 只留一行指针。
> 验证脚本：`backend/scripts/verify-chatbot.mjs`（`pnpm verify:chatbot`）；夹具 `backend/scripts/fixtures/chat-upstream.mjs`。
> 契约落点：`docs/02` §六（编排循环）+ §4.5（契约增量 · 消息）+ §十四。

## 概况

| 项 | 内容 |
|----|------|
| 批次 | P0-1-27 ChatBot 编排循环（`[✓]` 2026-09-22，包 F **3/5**） |
| 改动文件 | `backend/src/index.ts`（启动信封 `step`）、`backend/src/orchestrator/index.ts`（**接回点兑现**，删占位）、`backend/src/orchestrator/sse.ts`（`StreamChatReplyInput` 加 `content`）、`backend/src/routes/conversations.ts`（转交 `content`）、`shared/src/conversation.ts`（**新增引用卡与 `content` 契约**）、`shared/src/sse.ts`（`citations.items` 改为复用同一份 schema）、两个 `package.json`（加 `verify:chatbot`）、`backend/scripts/verify-app.mjs`（**第 26 节 17 条**）、`docs/06`、`docs/02`、`README.md` |
| 新增文件 | `backend/src/orchestrator/chatBot.ts`、`backend/src/orchestrator/chatContext.ts`、`backend/src/orchestrator/semaphore.ts`、`backend/scripts/verify-chatbot.mjs`、`backend/scripts/fixtures/chat-upstream.mjs` |
| 新增依赖 / 环境变量 | **零 / 零**（复用 `CHATBOT_CONCURRENCY` 与 `CONTEXT_ROUNDS`，P0-1-3 已建） |
| 验收 | `pnpm verify:chatbot` **21 项全通过**（A7/B3/C3/D4/E2/F2，**真进程 + 真 TCP + 两个假上游**）；`verify:app` **92 → 109 项**（+17 条纯函数断言）；**全量回归 22 档全部退出码 0** |
| 真问题 | **1 个实现 bug**（坑 8.2，**只有全量回归能抓到**）+ **1 条过期守门断言**（坑 8.1，同上）+ **3 条实现期定型决定**（坑 1~3）+ **1 条接口增量**（坑 4）+ **3 条脚本自身的伤**（坑 5~7） |

> 本批的 3 个"脚本自身的伤"（坑 5~7）都落在**新写的验收脚本**上；**唯一一个被测代码的缺陷**
> （坑 8.2）是被**别的批次的验收档**抓出来的 —— 这正是"收尾必跑全量回归"的价值所在。
> 坑 8.1 则是"临时边界被写成断言"的第三次复发（前两次：P0-1-25 翻转 `verify-agents`、
> P0-1-26 改正 `POST /:id/confirm` 的归属）。

---

## 坑 1 ⚠️ 中断（停止 / 断线）**也要落库** —— 唯一的例外是"锁丢了"

**现象**：`01` 决策 15 是「停止即中断，**已生成内容保留**」。但"保留"这句话在实现里可以落在很多地方，
最自然的一种是**只保留在内存里**（`assistantText` 攒着，最后 `return` 出去给出口层拼 `done`）。

**根因**：`done` 事件只服务**当前这条连接的当下**。而这半条回答消失的路径有两条，都很常见：
① 用户刷新页面 ⇒ 历史里只有他的问题、没有回答（"我明明看到了半截答案"）；
② 客户端断开（`02` §5.2 的断线恢复）⇒ 恢复协议就是"查 `/active` 拿进度 + **拉历史补齐**"，
而历史里没有这半条，"补齐"什么都补不出来。

**对策**：落库的判据**不是"成功了才写"**，而是"**这一轮真的发生过**" —— 见 `chatBot.ts` 收尾的三分支
（顺序即优先级）：锁丢了 → 一字不写；故障 → **已生成的内容照样落库**后抛错；中断 → 落库 + `STOPPED`。
**唯一的例外是 `lock-lost`**：那时这个会话可能已经有**另一个流**在写历史，我们再写一次就是两边往同一份
历史里插消息（`sse.ts` 文件头 ③ 的最后一条）。

📌 这条"例外"没有测试覆盖不了的风险：D 组的最后一条正是"客户端断开 ⇒ 名额与锁一起释放，
占位流以 `done{STOPPED}` 收口"，它在真断开路径上验证了"非 lock-lost 的中断确实落了库"。

---

## 坑 2 ⚠️ "前置失败"与"这一轮失败"是两件事 —— 前者**一个字都不该落库**

**现象**：如果按"只要流开过就写一条消息"实现，智能体被软删（或检索不可用）的那一轮会留下
**一条只有问题、永远没有答案**的记录。

**根因**：落库的单位是"**一轮问答**"，不是"一个请求"。而这一轮**根本没发生**：一个字的回答都没有，
用户在界面上看到的是流内错误卡。留一条孤儿提问的后果很具体 —— 下次刷新时用户以为自己问过但被丢了。

**对策**：`chatBot.ts` 里**刻意没有**"是否落库"的标志位 —— 前置失败直接 `throw`，能走到收尾分支的
就是"这一轮真的发生了"的行。**判据是控制流本身**，不是标志位（标志位容易与"到底哪条路走到了哪里"对不上）。
这与"检索失败要整轮失败"是同一判断的两面：检索层把"搜不了"报成 409/500 而不是空结果
（P0-1-20 定案："空结果会被读成'库里没有相关内容'，是一句假话"），本层**不吞这个错**。

**取证**：D 组"被拒的那一轮**一个字都没落库**"；F 组"故障轮：用户消息落库、**没有**助手消息"。
注意 F 组两者不矛盾：上游故障发生在**用户消息已经产生之后**（那一轮确实开始了），
而 D 组的 BUSY 发生在**开流之前**（那一轮没开始）。

---

## 坑 3 帧的**串行队列** —— `emit` 是异步的，而 LLM 回调是同步的

**现象**：`chatStream` 的回调签名是 `onDelta: (text) => void`（同步），而出口层的 `emit` 是异步的
（要过 schema 校验，还要在背压时等 `drain`）。最顺手的写法 `void input.emit(...)` 有两个真实后果：

1. **帧的顺序不再有保证** —— 前一个 emit 还在等 drain，后一个已经写出去了；
2. emit 抛错（schema 不合法）会变成**没人接的 promise rejection**，而它本该让这一轮以 `error` 收尾。

**对策**：`enqueue` 把帧串成一条 promise 链（`emitChain`），并把**首个错误**记在 `emitFailure` 上；
收尾时 `await emitChain` 再判 `emitFailure`（先于 `fatal` 判 —— 传输层坏了就不必再报上游的事）。
两件事一起解决：**顺序**与**错误不丢**。

---

## 坑 4 接口增量：`ChatProducerInput` 需要 `content`

**现象**：P0-1-26 定的 `ChatProducerInput` 只有 `{conversationId, agentId, target, startedAt, emit, signal, updateSnapshot}` ——
占位 producer 只发 ping，**确实不需要**正文。而编排循环需要它两次：**检索 query** 与**落库正文**。

**对策**：给 `ChatProducerInput` 加 `content: string`，由出口层从 `request.body.content` 转交
（`sse.ts#StreamChatReplyInput` 也同步加一字段）。评分点是**接回点只有一个**：路由那层**零改动**
（P0-1-26 承诺的"单点替换"兑现了）。

### 附带：引用卡形状**只定义一次**

`citations` 事件的 `items[]` 原本内联在 `shared/src/sse.ts` 里。本批把它抽成
`shared/src/conversation.ts#citationItemSchema`，因为同一个引用卡要由**两个出口**画出：
① SSE 的 `citations` 事件（本轮现算现发）；② `messages.content.citations`（jsonb，刷新后由历史接口读出来重绘）。
两处各写一份的后果**没有编译期错误**，只有肉眼能发现：**流里看到的卡与刷新后恢复出来的卡长得不一样**
（`03` §五 要求"单一渲染路径"）。`verify:app` 第 26 节有一条断言钉住这条（"契约同源"）。

---

## 坑 5 ⚠️ 验收脚本：`startServer()` **写好了但没被调用**（真跑抓到的第一个 bug）

**现象**：第一次真跑，脚本在**第一句 HTTP 请求**（`login`）就炸，而且报的是
**"脚本异常（不是断言失败）"** —— 整档 0 项通过：

```
✖ 脚本异常（不是断言失败，是脚本本身出错）
TypeError: fetch failed
    at async request (.../verify-chatbot.mjs:211:20)
    at async login (.../verify-chatbot.mjs:236:20)
    at async .../verify-chatbot.mjs:555:14
```

**根因**：`startServer()` 函数写得完整（含"端口已被占用"的探测与 20s 就绪轮询），
但主流程里**漏了 `server = await startServer()` 这一行** ⇒ 后端进程从没被拉起来，
而第一句 `fetch` 打的是空气。同族的 `verify-chat-stream.mjs` 第 477 行正是 `server = await startServer()`。

**对策**：在 try 块首行补上。**教训**：这类"函数写好了没用上"的错**没有任何静态检查能拦**
（函数有副作用、不报未使用），而它的症状被包装成"脚本异常" ⇒ 归因容易跑偏到"环境没起好"。
📌 判据：**真跑的第一个请求就 `fetch failed` = 先怀疑"服务有没有被拉起来"，而不是先怀疑端口/PG/Redis。**

---

## 坑 6 验收脚本：`redis.mGet` 不存在 —— 复核残留那一半直接失效

**现象**：清阶段打印 `复核残留失败：redis.mGet is not a function` ——
于是**残留复核整块被跳过**（`try/catch` 吞了），报告里看不出"清理到底干净没有"。

**根因**：复核残留最初写成 `redis.mGet(ids.map(...))`，而本仓 `getRedis()` 返回的 node-redis 客户端上
**没有 `mGet`**（同族的 `verify-chat-stream.mjs` 用的是逐个 `redis.del(key)` / `redis.get(key)`）。

**对策**：抽 `countPresentKeys(keys)` 逐个 `get`。**顺带守住了另一条**：复核**只查脚本自己创建的键**
（`chat.active:{本脚本的会话 id}`），**不**用 `keys('chat.active:*')` —— 后者会把本机 dev server
正在跑的会话算进来 ⇒ **假红**（P0-1-7 的老教训）。
📌 更值得记的是**它暴露的模式**：复核残留被包在 `try/catch` 里只为"不让清理的失败盖住验收结论"，
代价是**它自己坏了也静默**。所以"清理段跑完必须打印一行显式的 `✔ 复核残留：临时数据已删净`"是必须的
—— 那一行是"这段真的跑成功了"的唯一证据（本批第一次真跑时它**没有出现**，就是信号）。

---

## 坑 7 ⚠️ 验收脚本：jsonb 的**键序**让 `JSON.stringify` 直比出假红（本仓第一次遭遇）

**现象**：唯一一条失败断言，报告里期望值与实际值**看着一模一样**：

```
[FAIL] 落库：用户消息 + 助手消息各一条，`lastMessageAt` 前进（同一事务）
       落库的引用与事件里的引用是同一条（刷新后重绘的引用卡不会变样）：
         期望 "[{\"docName\":\"报销制度-cq97as.txt\",\"snippet\":\"第 1 号文档…\",\"score\":0.03278688524590164}]"，
         实际 "[{\"score\":0.03278688524590164,\"docName\":\"报销制度-cq97as.txt\",\"snippet\":\"第 1 号文档…\"}]"
```

**根因**：`messages.content` 是 **jsonb**，Postgres 会把对象键**重排**（先按键长、再按字节序）
⇒ 写进去时的 `{docName, snippet, score}` 读出来变成 `{score, docName, snippet}`。
`JSON.stringify` 直比把**键的书写顺序**也当成了契约 —— 而**对象键序本来就不是契约**
（本仓从 P0-1-17 起一律"按集合/排序后比较"，只是这一处漏了）。

**对策**：加 `canonicalJson(value)`（**递归按键名排序**后序列化）再比。**这条要推广到后续所有
"比较经 jsonb / JSON 往返过的值"的断言**，尤其是 P0-1-28（消息历史分页）—— 那一档整篇都在比
读回来的 `content`。📌 症状识别口诀：**"期望值与实际值在报告里长得一样"⇒ 先查键序。**

---

## 坑 8 ⚠️ 全量回归抓到两条：一条**过期的守门断言**、一条**实现层的真缺陷**

> 这是本批**最值钱**的一部分 —— 两条都**不在本批新写的验收脚本里**，只有"收尾必跑全量回归"能撞见。
> 第一次全量回归的结果是 **21 档通过 / 1 档失败**：`verify:chat-stream`（P0-1-26 的那一档）**13 项失败**。

### 8.1 旧档的守门断言有保质期：它靠"producer 是占位实现"当前提

**现象**：`pnpm verify:chat-stream` 报 13 项失败，且失败得很"发散"（A/B/C/D/E 五组同时红）：

```
[FAIL] 空流：只发 `ping`，没有任何内容事件（P0-1-27 之前这是**预期**行为）
       事件集合（本批只允许出现 ping）：期望集合 ["ping"]，实际 ["error"]
[FAIL] 同会话并发发送 → `error{code:CONFLICT}` 事件
       错误码：期望 "CONFLICT"，实际 "UPSTREAM_ERROR"
[FAIL] 5s 内收到 `done{finishReason:STOPPED}`，且它**是最后一个事件**
       停止是**正常收尾**，必须是 done（不是 error）：期望 "done"，实际 "error"
[FAIL] 锁被人清掉 → 2~3s 内收到 `error`（INTERNAL）…：期望 "INTERNAL"，实际 "UPSTREAM_ERROR"
```

**根因**：那一档的**上下文变了**，不是它写错了。P0-1-26 时 `resolveChatProducer()` 返回的是**占位
producer**（只发 ping、不调上游），所以：
· 它的 Provider `base_url` 随便填了个 `https://api.example.com/v1`（"反正不会有人调"）；
· "**本批不该有答案**"被做成一条守门断言（把 `06` 的临时边界钉在脚本里）。

P0-1-27 兑现接回点之后，编排循环**真的会去调上游** ⇒ 那个假 URL 立刻失败 ⇒ 每条流都以
`error{UPSTREAM_ERROR}` 收口 ⇒ **所有"流还活着时"的断言（互斥 / 停止 / 断线 / 锁丢）一起塌**。
"13 项失败"看着吓人，**根因只有一个**：上游不可达。

**对策（两处，缺一不可）**：

1. **把上游换成真在跑的夹具**：`fixtures/chat-upstream.mjs` 以 **`stall` 模式**起
   （收下请求、只发 SSE 注释行、**不回内容**），并把它写进 Provider 的 `base_url`。
   ⇒ 流里**仍然只有 `ping`**，"通道"这一层的每条断言（时间轴 / 句柄 / 互斥 / 停止 / 断线）**原样成立**；
   "回答本身"交给 `verify:chatbot` 那一档。**守的东西没变，变的是怎么把上游按住**。
2. **翻转那条守门断言并留痕**：标题从"本批不该有内容事件"改成
   "上游挂着不回 ⇒ 只发 ping"（注释写明"P0-1-26 时靠 producer 是占位，P0-1-27 起靠 stall 上游"）；
   文件头那段前提说明、`baseUrl` 那行注释、`openStream` 的注释、收尾横幅**四处**同步改掉。

📌 **这条与 P0-1-25 翻转 `verify-agents`、P0-1-26 改正 `POST /:id/confirm` 的归属是同一类事**：
**"临时边界"一旦被写成断言，就必须在接回点那一批回来改它。** 而唯一能发现的方式就是
**收尾跑全量回归**（那一档不属于本批，本批自测永远绿）。
📌 顺带一个可复用的判据：**一档里"大面积同时红"且分布在不同分组 ⇒ 先找共同前置（这里是上游不可达），
不要逐条去改断言**。

### 8.2 锁丢时**抛错对象选错** ⇒ 用户看到的是"服务内部错误"而不是可行动的建议

**现象**：修完 8.1 后剩下的**唯一**一条失败 —— 错误码已经对了（`INTERNAL`），**文案**不对：

```
[FAIL] 锁被人清掉 → 2~3s 内收到 `error`（INTERNAL），而不是 `done{STOPPED}`
       文案应给出可行动的建议（用户看到的是这句）：应含 "重新发送"，实际 "服务内部错误"
```

**根因**：`chatBot.ts` 的 lock-lost 分支写的是 `throw failure ?? (signal.reason as Error)`。
而锁丢时，出口层的 `abort('lock-lost', …)` **会掐断在飞的那次上游 `fetch`** ⇒
`failure` 很可能是一个 **`LlmAbortError`**（技术异常、**没有用户文案**）⇒ 它盖住了
`signal.reason` 里那个带着文案的 `ChatStoppedError` ⇒ `fail()` 走"其余错误"那支，
出口是通用文案「服务内部错误」（`02` §十：非 `AppError` 的 message 一律不出）。

**对策**：lock-lost 分支**优先抛 `signal.reason`**（它才是"为什么中断"的权威记录）：

```ts
throw signal.reason instanceof ChatStoppedError ? signal.reason : (failure ?? (signal.reason as Error))
```

**为什么它值得单独记一条**：这是本批**唯一一个被测代码的缺陷**，而它的可见形态是
**"状态码对了、文案错了"** —— 只断言状态码的档会全绿（`verify:chatbot` 的 D 组断言的是
`error{code:BUSY}` 的码；这条只有 `verify:chat-stream` 的 E 组在断言**文案**）。
📌 教训：**"错误码 + 文案"要成对断言**。码对了只说明"分流对了"，文案才是用户唯一看到的东西；
`02` §4.4/§4.5 里那几处"文案指向的动作"正是这条的成文形式。

---

## 定型决定（实现期定的口径，不是坑）

1. **并发闸的 `BUSY` 是流内 `error` 事件，不是 429 JSON 信封** —— 与 P0-1-26 给 `CONFLICT` 的判断同源：
   分界线是**主语**。`BUSY`/`CONFLICT` 的主语是"**这一轮生成**"（客户端已经发起了对话 ⇒ 按单一渲染路径
   在对话区收口），而 401/400/404/只读 409/424 的主语是"**这个请求/目标**"（换任何客户端都该先被拦下 ⇒ 信封）。
   ⇒ `assertConversationSendable` **刻意不含**并发闸（它是进程级信号量的产物）。
2. **逐库各调一次 `searchKnowledgeBase` ⇒ 同一句 query 会被 embed 多次**。这是**刻意的**：
   那条函数是"一次检索"的完整语义（读库配置 → 双路 → RRF），为省一次 embedding 绕过它
   （自己拼 SQL）会让"检索口径"出现**第二个实现**。库的数量是个位数，代价可接受；
   要优化应当把它改成接受多库的函数（属后续批次）。
3. **TTFT 在第一个 `delta` 上打点**（`02` §十三：阶段一"首字 < 3s"的**唯一**测量依据，不能事后补）。
   实测 **53ms**，日志字段含 `ttftMs` / `historyMessages` / `citations`。
4. **`usage_records` 表在本版本不写**：该表属 **P1**（`01` 决策 20、`02` §七 待决事项 4 已定案"首版只打日志"），
   `schema.prisma` 里没有它。本批做的是"计量**透传**"（`done.usage` + 结束日志的 `tokensIn/tokensOut`）。
   **接回点**：P1 建表后在落库那个事务里加一条 `usageRecord.create`。
5. **本版本刻意不做 token 级上下文裁剪**：`model.maxContext` 在库里但**没有可用的 tokenizer**
   （embedding 用的是另一套模型）⇒ 按字符估算再裁会得到"看起来在保护上下文、实际按一个错误的折算率乱切"
   的**假保护**，比"明确只按轮数裁"更坏（`02` §六 也只写了轮数）。留在待回补清单。

---

## 原始输出（节选）

### `pnpm verify:chatbot`（最终，21/21）

```
══ P0-1-27 验收：ChatBot 编排循环（检索块 / 流式透传 / 引用 / 停止 / 并发闸 / 历史）══
  目标：http://127.0.0.1:13098（脚本自己起进程 + 两个假上游，跑完删净）
  注入：CHATBOT_CONCURRENCY=1｜CONTEXT_ROUNDS=3｜SSE_PING_INTERVAL_SEC=1
  知识库 01a0c841-… / 文档 01a0c841-…（1 块，89 字）

── A｜命中知识库：引用卡 + 流式透传 + 落库（`06` 验收原文第 ① 条）
  [PASS] 发起对话：HTTP 200 + `text/event-stream`（**不是** JSON 信封）
  [PASS] 流以 `done{COMPLETE}` 收尾，带 `messageId` 与 usage（usage 来自上游最后一帧）
  [PASS] `citations` 事件：片段与库里的那块正文**逐字相同**，且出现在增量之前
  [PASS] 增量按上游原样透传：拼接后的正文与夹具脚本一致（证明"检索块真的进了 prompt"）
  [PASS] 落库：用户消息 + 助手消息各一条，`lastMessageAt` 前进（同一事务）
  [PASS] 发给上游的报文：system 含检索块与人格、末条是 user、`stream:true`、不带 `stream_options`
         实测 TTFT = 53ms（阶段一门槛 < 3000ms）
  [PASS] TTFT 打点：服务端日志里有首字延迟（`02` §十三 是阶段一"首字 < 3s"的唯一测量依据）

── B｜未命中：不产生引用卡、prompt 明确禁止编造（`01` 决策 12）        —— 3 项全通过
── C｜停止：已生成部分保留 + 可直接追问（`01` 决策 15；`06` 验收原文第 ② 条） —— 3 项全通过
── D｜并发闸（CHATBOT_CONCURRENCY=1）：满则 **流内** `error{BUSY}`      —— 4 项全通过
── E｜超长会话（注入 CONTEXT_ROUNDS=3，历史 25 轮）不报错且按轮数截断    —— 2 项全通过
── F｜上游故障：流内 `error` 收尾（`02` §5.2 的两类失败两个出口）        —— 2 项全通过

── 清理（自清理 + 复核残留）──
  ✔ 复核残留：临时数据已删净
✅ P0-1-27 ChatBot 编排循环验收通过：21 项全通过
```

### `pnpm verify:app`（第 26 节，节选）

```
  [PASS] 检索块：标题 + 连续序号 + 「来源：文档名」前缀，片段**原样**（不二次截断）
  [PASS] 检索块：零命中时写出「没有检索到」的明文（留白等于让模型自己决定有没有）
  [PASS] system prompt：三段顺序固定 = 人格 → 检索规则 → 检索块
  [PASS] ⚠️ 检索规则**每一轮都注入**（无论有没有命中）—— 这是「不编造来源」在 prompt 层的那一半
  [PASS] system prompt：空白 systemPrompt 回落兜底文案；有值时**逐字保留**（不 trim）
  [PASS] 多库命中合并：`rrfScore desc` + 同分按 `chunkId asc`（确定性 tie-break）
  [PASS] 多库命中合并：**刻意不设条数上限**（每个库的 topK 是它自己的配置）
  [PASS] 引用卡：`score` 取**融合分** `rrfScore`（不是任何一路原始分），且只带三列
  [PASS] `textOfHistoryRow`：跨版本读 jsonb 的唯一兜底点，脏值一律 `""` 且永不抛错
  [PASS] 历史截断：取 `rounds × 2` 条（一轮 = 一问一答）且截断后**从 user 开始**
  [PASS] 历史截断：丢掉空文本的助手行与 SYSTEM 行
  [PASS] 落库形态：`text` 恒写（可以是空串）；空的 `thinking`/`citations` **不加键**
  [PASS] 落库形态：返回的 `citations` 是**副本**（改返回值不得回写调用方的数组）
  [PASS] 并发闸：满则 `tryAcquire()` 返回 `null`（**不是 Promise**）—— 不排队
  [PASS] 并发闸：`release` **幂等**（否则计数减负 ⇒ 上限被悄悄放到无穷）
  [PASS] 并发闸：`limit < 1` 抬到 1、小数向下取整（0 会让所有请求都被拒）
  [PASS] 契约同源：引用卡形状只定义一次，SSE 事件与落库共用同一份

✅ 接口级验收通过：109 项全通过
```

### `pnpm verify:chat-stream`（P0-1-26 的档；本批**改过**它，最终 28/28）

```
── P0-1-26 结论表（docs/06 的验收原文逐条）──
  ✅ A 流形态与心跳（`02` §五：帧格式 + 响应头禁缓冲 + 空闲期 ping）  (6 项全通过)
  ✅ B 会话互斥（`02` §5.2：持锁期间同一会话再次发送 → 流内 `error{code:CONFLICT}`）  (4 项全通过)
  ✅ C 停止（`02` §5.2：`chat.stop:{id}` TTL 60s，编排循环在可中断点检查）  (5 项全通过)
  ✅ D 断线释放锁（`02` §5.2：断线重连先查 `/active`；这里验"断开即解锁"这一半）  (2 项全通过)
  ✅ E 锁被清掉时**必须用 error 收口**（而不是假装"已停止"）  (2 项全通过)
  ✅ F 发消息的前置（`02` §4.5 的 400/401/404/409/424）  (6 项全通过)
  ✅ G 契约自检与残留复核  (3 项全通过)
✅ P0-1-26 SSE 验收通过：28 项全通过
```

**第一次全量回归时它是这样红的**（13 项失败 / 15 项通过，根因只有一个：Provider 的 `base_url`
指向一个不存在的上游 —— 而 P0-1-26 时"不会有人去调它"）：

```
  ❌ A 流形态与心跳（1 项 / 5 项失败）
  ❌ B 会话互斥（2 项 / 2 项失败）
  ❌ C 停止（2 项 / 3 项失败）
  ❌ D 断线释放锁（0 项 / 2 项失败）
  ❌ E 锁被清掉时**必须用 error 收口**（1 项 / 1 项失败）
❌ P0-1-26 SSE 验收未通过：13 项失败 / 15 项通过
```

### 全量回归

```
verify:app => PASS          verify:kb-package => PASS
verify:db => PASS           verify:agents => PASS
verify:session => PASS      verify:agent-package => PASS
verify:auth => PASS         verify:conversations => PASS
verify:users => PASS        verify:chat-stream => PASS   ← 第一次是 FAIL（见坑 8.1）
verify:model-providers => PASS   verify:chatbot => PASS
verify:models => PASS       verify:e2e => PASS
verify:llm => PASS
verify:embedding => PASS
verify:knowledge => PASS
verify:documents => PASS
verify:pipeline => PASS
verify:ingest => PASS
verify:knowledge-bases => PASS
verify:retrieval => PASS
```
