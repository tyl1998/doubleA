# 问题记录 · P0-1-12 LLM client 封装

> 批次：**P0-1-12 LLM client 封装**（包 C 第 3 步）
> 日期：2026-09-21
> 产出：`backend/src/llm/client.ts`、`backend/src/services/model.service.ts`（追加解析与探测）、
> `backend/src/routes/modelProviders.ts`（追加一条路由）、`shared/src/modelProvider.ts`（追加契约）、
> `backend/scripts/verify-llm.mjs`、`backend/scripts/verify-app.mjs`（追加 2 项）
> 一句话：**本批最值钱的两条都是"跑验收才暴露的实现 bug"，而不是设计坑** ——
> 超时守卫的写法错了会**静默失效**（脚本直接挂死），中断的实现错了会**看不见地失效**
> （点停止回答还在往外冒）。两者都只有真跑才抓得到。

---

## 汇总（2 个实现 bug + 10 条结论）

| # | 坑 / 结论 | 一句话 |
|---|-----------|--------|
| 1 | **两级超时不能各建一个 `AbortController`** | 没接到 `fetch` 上的那个照样触发，读流却纹丝不动 → 配了 300ms 超时、脚本挂到被 SIGTERM |
| 2 | **中断不能只靠"abort 让读流失败"** | 响应已在同一个 TCP 包里缓冲好时，`for await` 会继续把缓冲读完 → "点了停止，回答还在往外冒" |
| 3 | `stream_options` 默认不能发 | 坑预判点名的那条，落成"usage 有就收、没有就算了"+ 一条断言（假上游记录请求体） |
| 4 | **末帧可能没有结尾空行** | 不处理残留缓冲就会**凭空少几个字**（最难发现的一类：文本只差结尾） |
| 5 | 不吃 `[DONE]` 哨兵 | 有的实现根本不发；"流结束"就是结束 |
| 6 | SSE 帧会被 TCP 切碎 | 必须按行缓冲，不能假设"一次 read = 一帧"（验收脚本故意拆帧） |
| 7 | **上游 401 的 body 会回显 `Authorization`** | 不脱敏就等于借错误消息把 Key 漏出去 → 所有进日志/错误消息的响应片段都要先过 `redactSecret` |
| 8 | `200` 里藏 `{error}` / 回非 JSON | 不显式判就会表现为"模型答了个空"，问题被推迟到很久以后 |
| 9 | `rawFinishReason` **不在传输层**归一化 | 归一化成 `COMPLETE\|STOPPED\|ERROR` 是 SSE 层的事，且会丢掉 `length`（被截断）的决策价值 |
| 10 | "真实 provider" 用**本地真 HTTP 假上游**代替 | 验收不该依赖外部厂商；好处是"Key 有没有注入"能在**上游侧取证** |
| 11 | 拉模型列表的两种"不"是刻意的 | 不要求 Provider 启用（诊断用）、不要求配 Key（自建实现免鉴权）；与 `resolveChatTarget` 的 424 相反 |
| 12 | 空白依赖 = 空白断言 | 三档验收（app / 依赖档 / 假上游）各管一段，缺哪一段就会有一类 bug 无人值守 |

---

## 坑 1：两级超时共用**一个** `AbortController`（否则空闲超时静默失效）

**第一版写法**（错的）：

```ts
const heading = new Deadline(requestTimeoutMs, '首次响应（到响应头）')
const idle = new Deadline(streamIdleTimeoutMs, '流内空闲')     // ← 各自持有 controller
const response = await fetch(url, { signal: heading.signal })  // ← 只接了一个！
...
for await (const piece of response.body) {
  idle.arm()          // 计时器照常装、照常触发、controller 照常 abort
  ...
}
```

**现象**：`verify:llm` 第一次跑，`gate` 里的"流内空闲超时"用例**永不返回**，
整条命令挂到 bash 工具超时被 SIGTERM（exit 137，且因为 stdout 还没 flush，**一个字都没打出来**）。
去掉那一项后脚本 8 秒跑完 —— 说明挂的就是它。

**根因**：`AbortController` 只有被交给 `fetch` 的那一个才有用。`idle.controller` 从未接到任何
东西上，于是"标记置位 + 计时器触发"全都发生了，而底层连接毫不知情；读取循环等的还是那个
永不结束的 socket。

**修法**：**一个控制器 + 一个可重装的计时器**（`Deadline#arm(ms, label)`），
阶段切换时只换时长与阶段名：

```ts
deadline.arm(headingMs, '首次响应（到响应头）')
const response = await fetch(url, { signal: deadline.signal })
deadline.arm(idleMs, '流内空闲')            // 响应头到手：撤掉上一个，换窗口，信号同一个
for await (const piece of response.body) {
  deadline.arm(idleMs, '流内空闲')          // 每收一块重置
}
```

**留下的断言**：`「流内空闲」超时 → UPSTREAM_TIMEOUT` 一条，注入 `idleTimeoutMs: 300`，
断言"**3 秒内**返回 504"并且"超时前收到的增量已交给回调"。
（同时留了一条对"到响应头"超时的同款断言：注入 `timeoutMs: 300`。）

---

## 坑 2：中断必须**每帧之前**显式查一次信号

**第一版写法**（不完整的）：只把 `options.abortSignal` 接进 `Deadline`，指望
"abort → 读流失败 → 抛 `AbortError` → 分类成 `LlmAbortError`"。

**现象**：验收里"调用方中断"那条**没抛错** —— `chatStream()` 正常返回了。假上游只有 4 个小帧，
**整个响应早就在一个 TCP 包里缓冲好了**：`abort()` 之后 `for await` 依旧把这些已缓冲的
chunk 一个一个吐出来，直到流自然结束。

**为什么这条比"测试失败"更严重**：真实场景里它是**用户可感知的功能 bug** ——
用户点了"停止"，SSE 却还在往外推 delta，界面上的字继续往外冒（`02` §5.2 的
「停止后 5s 内收到 done{STOPPED}」也就不成立）。

**修法**：在**每一帧之前**显式查一次调用方的信号：

```ts
const throwIfAborted = () => {
  if (options.abortSignal?.aborted === true) throw new LlmAbortError('调用已被调用方中断（流式）')
}
// 读循环里每收一块查一次（覆盖"一块里塞了多帧"）；dispatch() 里每帧再查一次（更紧）
```

**留下的断言**：中断后 `deltas.length === 1 && deltas.join('') === '你好，'` ——
不是"收到过至少一块"，而是**"正好只收到 1 块"**：这才同时证明了"增量真的逐块流到了回调"
与"abort 之后立刻停手"。

---

## 坑 3：`stream_options` 默认不能发（坑预判求真的落点）

`06` 的坑预判原文是"部分 provider 不支持 `stream_options`"。做法不是"小心一点"，而是
**默认不发**这个字段，并把 usage 降级成"有就收、没有就算了"：

```ts
// ⚠️ 刻意不写 `stream_options`（见文件头 ②）：它是 400 的常见来源，而 usage 只是锦上添花
const body = { model, messages, stream: true }
```

**留下的断言**：假上游把收到的请求体记下来，断言 `!('stream_options' in body)`。
（`usage` 的读取仍然保留：真收到就采纳，`prompt_tokens` / `input_tokens` 两种命名都认。）

---

## 坑 4：末帧可能没有结尾空行

SSE 的帧边界是空行。但真实实现里"最后一帧之后直接关连接、不发 `\n\n`"并不罕见。
第一版只按"遇到空行才 dispatch"处理 → **最后几个字会凭空消失**，
而症状是"回答看起来是完整的，只是结尾被截断了一点"—— 极其难发现。

**修法**：流结束后把残留缓冲也当作一帧处理（并容忍末尾 `\r`）。

**留下的断言**：假上游的**最后一帧故意不发结尾空行**，而全文断言是**逐字相等**
（`'你好，这是流式回答。'`），少一个"。"这条就会红。

---

## 坑 7：上游 401 的响应体常回显 `Authorization` ⇒ 必须脱敏

**取证**：假上游的 `/fail/chat/completions` 与 `/authfail/models` 都是
`401 + {error:{message: 'invalid api key: ' + req.headers.authorization}}` ——
这是很多网关的真实行为。若把这段 body 直接拼进错误消息，**Key 就借错误消息漏出去了**
（错误消息会进日志、也会经信封回给前端）。

**修法**：所有进日志/错误消息的响应片段先过 `redactSecret(text, key)`；
日志只用 `describeTarget()`（id/名字/hasKey），**绝不整体序列化 target**。

```ts
export function redactSecret(text: string, secret: string | null): string {
  if (secret === null || secret.length < 4) return text   // 太短的替换会把正文打花
  return text.split(secret).join('****')
}
```

**留下的断言**（三条，分属不同出口）：
① 401 时 `error.message` **不含**明文 Key 且含 `****`；
② `remote-models` 的 401 同样不含；
③ `remote-models` 的**成功响应体**里既没有明文 Key、也没有 `Bearer` 形态的串。

---

## 坑 10：把"真实 provider"换成**真 HTTP 的假上游**

`06` P0-1-12 的验收原文是"对一个**真实 provider** 发一次极小请求能拿到响应；流式模式下能逐块收到 delta"。
如果照字面接一个外部厂商，验收会立刻变成噪声源（凭据、网络、限额、厂商改报文），
而且**关键路径反而验不到**："Key 到底有没有被解密注入"没法证明。

**做法**：脚本起一个 `http.createServer`（`listen(0)`，端口由系统给），按 OpenAI 兼容协议应答，
把每个请求的 `method / path / authorization / body` 全记下来：

```
假上游：http://127.0.0.1:49997（真 HTTP 服务，端口 0）
  [PASS] chat()：`max_tokens: 1` 真的发出去了，且 Authorization 是 `Bearer <明文 Key>`（上游侧取证）
  [PASS] 路由 GET /api/model-providers/:id/remote-models：200 + 契约 + 上游侧收到 Bearer Key
```

一次覆盖：报文形状（路径/方法/`max_tokens`/`stream`）、凭据注入（**上游侧**看到的是明文，
而库里是 `v1.<iv>.<tag>.<ct>`）、以及"集成"那一半（`resolveChatTarget` → 解密 → 真出网 → 拿回文本）。
顺带用一个 `closeAllConnections()` 把"永不响应"的 `/slow` 上挂着的连接收干净。

---

## 坑 11：拉模型列表的两种"不"（与 `resolveChatTarget` 相反）

| | `resolveChatTarget()` | `listProviderRemoteModels()` |
|---|---|---|
| Provider 未启用 | **409**（不让调） | **照探**（这正是"换 Key 后先探一次"的诊断动作） |
| 未配 Key | **424 `NEED_CREDENTIAL`** | **照探，不带 `Authorization` 头**（本地 vLLM / llama.cpp / ollama 兼容层常免鉴权） |

这两条差异是刻意的，验收里各有一条断言（无 Key 的 Provider 探 `/alt/models` 成功，
且**上游侧**看到 `authorization === null`）。

同族的三条：**只读**（断言"探完模型条数一条没变"）、**三种返回形态归一 + 去重 + 按 id 排序**、
**不做静默截断**（`items` 上限 500 + 显式 `truncated` + 真实 `total`）。

---

## 验收记录（原始输出）

```
══ P0-1-12 LLM client 验收：报文 / 流式边界 / 超时与中断 / 上游模型列表 ══
  假上游：http://127.0.0.1:49997（真 HTTP 服务，端口 0）
  [PASS] chat()：`max_tokens: 1` 真的发出去了，且 Authorization 是 `Bearer <明文 Key>`（上游侧取证）
  [PASS] `temperature` 不带就不发；`extraBody` 原样并入（给 F 包的逃生口）
  [PASS] 上游 401 → `UPSTREAM_ERROR`(502)，且错误消息里**不含明文 Key**（脱敏取证）
  [PASS] 上游 200 里藏 `{error}` / 回非 JSON → 都归成 `UPSTREAM_ERROR` 而不是"答了个空"
  [PASS] `redactSecret` 纯函数：抹掉全部出现处、短串不动（防"脱敏把正文打花"）
  [PASS] 「到响应头」超时 → `UPSTREAM_TIMEOUT`(504)，且**不等**满配置值就返回
  [PASS] 「流内空闲」超时 → `UPSTREAM_TIMEOUT`：响应头已到手、之后一个字节都没有也得断开
  [PASS] 调用方中断 → `LlmAbortError`（**不是** AppError）：用户点停止不是故障
  [PASS] chatStream()：逐块收到 delta（≥3 块）、顺序拼接**逐字**等于全文
  [PASS] 流式的四类真实差异都被收敛：思考增量 / 无 `[DONE]` / 无结尾空行 / 保活帧
  [PASS] 上游忽略 `stream: true`（回 JSON）→ 降级成一次性 delta，而不是报错
  [PASS] 流内出现畸形帧 → 跳过并计数，**不丢**整条回答
  [PASS] `normalizeRemoteModels`：三种形态归一 + 去重 + 按 id 排序（两次调用逐字相同）
  [PASS] `resolveChatTarget()`：解密 Key 注入上游 —— 假上游收到的正是**明文**（密文只在库里）
  [PASS] `resolveChatTarget()` 的四道前置校验：404 / 向量模型 409 / 停用模型 409 / 停用 Provider 409 / 无 Key 424
  [PASS] 路由 `GET /api/model-providers/:id/remote-models`：200 + 契约 + 上游侧收到 Bearer Key
  [PASS] 无 Key 的 Provider：探模型列表照样能成（免鉴权的自建实现），且**不带** Authorization 头
  [PASS] 裸数组形态 + 去重 + 排序（真 HTTP，不是纯函数）
  [PASS] 上游 401（回显 Authorization）→ 502 且消息里**没有明文 Key**；上游 404 → 文案点明"可能不提供列表"
  [PASS] Provider 不存在 → 404；非 ADMIN / 匿名 → 403 / 401
  [PASS] 拉取列表**不落库**（只读探测）：调完之后模型条数一条没变
  [PASS] `fetchRemoteModels` 也能被 F 包直接调用（不带库、只要 baseUrl + Key）

✅ P0-1-12 LLM client 验收通过：22 项全通过
```

**回归**（全部未动过断言、只跑一遍）：

```
pnpm verify:app              → ✅ 44 项全通过（本批 +2）
pnpm verify:db               → ✅ 17 项全通过
pnpm verify:session          → ✅ 13 项全通过
pnpm verify:auth             → ✅ 21 项全通过
pnpm verify:users            → ✅ 17 项全通过
pnpm verify:model-providers  → ✅ 18 项全通过
pnpm verify:models           → ✅ 17 项全通过
pnpm verify:e2e              → ✅ 17 项全通过
pnpm lint / -r typecheck / -r build → 全绿
```

**配置自检**：

```
$ pnpm config:check | grep -A2 '"llm"'
      "llm": {
        "requestTimeoutMs": 30000,
        "streamIdleTimeoutMs": 120000
$ DOUBULEA_SKIP_ENV_FILE=1 LLM_REQUEST_TIMEOUT_MS=abc pnpm --filter @doubulea/backend config:check
    · LLM_REQUEST_TIMEOUT_MS
        LLM_REQUEST_TIMEOUT_MS 必须是数字
```

---

## 交付物清单（本批）

- `backend/src/llm/client.ts`（新）：`chat()` / `chatStream()` / `fetchRemoteModels()` /
  `normalizeRemoteModels()` / `redactSecret()` / `describeTarget()` / `LlmAbortError`
- `backend/src/services/model.service.ts`（追加）：`resolveChatTarget()`、`listProviderRemoteModels()`、
  `readProviderCredential()`（Key 明文的唯一落点）
- `backend/src/routes/modelProviders.ts`（追加）：`GET /api/model-providers/:id/remote-models`
- `shared/src/modelProvider.ts`（追加）：`remoteModelItemSchema` / `remoteModelListResultSchema`
- `backend/src/config.ts`（追加）：`llm.requestTimeoutMs` / `llm.streamIdleTimeoutMs` + `describeConfig`
- `infra/.env.example`、`infra/.env`（追加 2 个变量）
- `backend/scripts/verify-llm.mjs`（新，22 项）、`backend/scripts/verify-app.mjs`（+2 项）
- `package.json` / `backend/package.json`（追加 `verify:llm`）
- `backend/src/index.ts`（启动信封 `step` → `P0-1-12`）
