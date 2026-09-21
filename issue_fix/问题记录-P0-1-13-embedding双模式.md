# 问题记录 · P0-1-13 embedding 双模式 provider

> 批次：**P0-1-13 embedding 双模式 provider**（包 C 第 4 步，也是包 C 的收口）
> 日期：2026-09-21
> 产出：`backend/src/llm/embedding/{index,api,local,embedding.worker}.ts`、
> `backend/src/llm/upstream.ts`（从 P0-1-12 抽出的通用上游件）、`backend/src/llm/client.ts`（改为复用）、
> `backend/src/config.ts`（+2 变量）、`backend/scripts/verify-embedding.mjs`、根/子包 `verify:embedding`
> 一句话：**本批两个"实现问题"同样是跑验收才暴露的**（worker 的 `execArgv` 继承、`spawnSync` 钉死事件循环），
> 而且都是"看起来完全正常、只在特定启动方式下炸"的类型 —— 只有真起线程/真起子进程才抓得到。
> 另有一条**架构决定**（local 的推理运行时走注入）写在这里，因为它是本批唯一"没验到的东西"的由来。

---

## 汇总（2 个实现问题 + 12 条结论）

| # | 坑 / 结论 | 一句话 |
|---|-----------|--------|
| 1 | **worker 不能无脑继承 `process.execArgv`** | 父进程若是 `node --input-type=module -e …` 起的，继承下来的 `--input-type` 让 worker 一起就崩；规则：`.ts` 入口才继承，`.js` 传 `[]` |
| 2 | **别用 `spawnSync` 起子进程去验"和父进程说话"的东西** | 它把父进程事件循环钉住 → 跑在父进程里的假上游无法应答，症状是"地址明明配对了却报 30 秒超时"。改异步 `spawn` |
| 3 | **先抽公共件，再写第二个上游调用点** | 看门狗/中断/脱敏/状态码映射抽到 `llm/upstream.ts`，否则 P0-1-12 的两个坑要养两份；`verify:llm` 22 项逐项通过 = 抽取没改行为 |
| 4 | **`worker_threads` 的隔离要用"线程内的 `threadId`"取证** | 只断言"调用了 worker"是自欺：让 stub 从**线程里**回报 `threadId`，断言它 ≠ 主线程 id |
| 5 | **推理运行时（含分词）走注入，不写死 `onnxruntime-node`** | bge-m3 的分词取决于最终交付物形态（§七 待决事项 2 未关闭），写死等于赌；副产品是**本批零新增依赖** |
| 6 | 就绪自检要**在起线程之前**做，且三态各给一句人话 | 目录不存在 / 目录里没有 `.onnx` / 没配运行时模块 —— 否则运维看到的是 `ERR_MODULE_NOT_FOUND` |
| 7 | **就绪判定两级**（延续 §十一 口径） | `config.ts` 只 WARN 不拦启动；`getEmbeddingProvider()` **取用时硬报错**并给全问题清单 |
| 8 | `name()` 由 provider 自己给，自检别另拼一遍 | 否则"自检里的名字"和"实际落库的名字"可能不是同一个值（换模型检测直接失效） |
| 9 | `dim()` 恒返回配置维度，**实际维度逐条校验** | api → 502；local → 500。维度不对的向量写进 `vector(1024)` 后**事后无法分辨** |
| 10 | 批必须**串行**（不裸 `Promise.all`） | `子方案①` §4-3 的 `Promise.all` 是形状示意；5000 chunk 会变成 157 个并发请求，上游限流当场打回 |
| 11 | 报文最小化 = 少一类 400 | 只发 `{model, input}`，**刻意不发** `encoding_format`/`dimensions`/`user`（同 P0-1-12 不发 `stream_options`） |
| 12 | `index` 要归位，且必须是 `0..n-1` 的排列 | 不归位会出现"第 3 段配了第 7 段的向量"；验收的假上游**故意倒序返回** |
| 13 | `input: []` 不发请求 | "没有文本"不是错误，而有的实现会对空数组回 400 |
| 14 | 重试不在这层 | `子方案①` §4-3 的"单批重试 2 次"属流水线任务级策略（P0-1-19），两处各重试一遍只会放大上游压力 |

---

## 坑 1：worker 的 `execArgv` —— 无脑继承会崩

**现象**（跑验收才出现）：

```
AppError: 本地 embedding worker 崩溃：
  --input-type can only be used with string input via --eval, --print, or STDIN
```

**根因**：验收的 C 组用 `node --input-type=module -e '<code>'` 起子进程来验"工厂接线"，
子进程里 `process.execArgv = ['--input-type=module', ...]`；而 `new Worker(file)` 默认**继承
`process.execArgv`**（显式传也一样）→ worker 拿一个文件入口 + `--input-type`，Node 直接拒绝。

**对策**：只有 `.ts` 入口需要继承（dev 下 tsx 靠 `--import` 注入加载器，否则 `.ts` 加载不了），
编译产物 `.js` 一律传 `[]`：

```ts
const entry = workerEntryUrl()
new Worker(entry, { execArgv: entry.pathname.endsWith('.ts') ? process.execArgv : [] })
```

**更一般的教训**：`process.execArgv` 是"父进程**碰巧**怎么被启动的"记录，不是"我需要什么"。
凡是把它整包传下去的地方（worker / `child_process.fork`），都要先问一句"当前运行形态会往里塞什么"。

## 坑 2：`spawnSync` 会钉死父进程事件循环

**现象**：C 组的 api 子进程报了 30 秒上游超时 —— 而地址、Key、模型名全是刚配好的，
同一个地址在主进程里刚刚验通过。

**根因**：假上游跑在**父进程**里（`http.createServer` + 端口 0）。`spawnSync` 是同步等待，
父进程的事件循环在等子进程期间完全停摆 → 子进程发出的 HTTP 请求排队等不到应答 → 超时。

**对策**：改异步 `spawn` + `close` 事件收口（并在注释里写明"为什么不能用 spawnSync"，
否则下一个人会觉得同步更简单）。

**教训**：验收脚本的"父进程"往往同时扮演**被测服务的对端**（假上游/假 webhook）。
任何阻塞父进程事件循环的等待方式都会把这类验收变成假失败。

## 决定 1：local 的推理运行时走注入（本批唯一"没验到的东西"的由来）

**背景**：`06` P0-1-13 的坑预判原文就是「**模型文件需另行下载**（`/models/bge-m3-int8`）→ 本步先落
`api` 模式跑通链路，`local` 模式依赖模型就位后补验」。做到一半发现还有一个更要命的未知量：
**分词**。bge-m3 是 XLM-RoBERTa，分词依赖 `tokenizer.json`/sentencepiece 的具体形态，
而这取决于最终拿到的是哪一份交付物 —— 在 §七 待决事项 2 关闭前写死 = 赌。

**决定**：把"onnx 推理 + 分词"整体收进一个可注入的**运行时模块**：

```ts
// LOCAL_EMBEDDING_RUNTIME_MODULE 指向的模块
export async function createEmbedder({ modelPath, dim }) {
  return { dim?, embed(texts), dispose?, describe? }
}
```

**换来什么**：
- 本批把 local 模式**与推理库无关的部分**全部做完并验收：就绪三态、线程隔离、批 32、
  维度/条数校验、出错后线程仍可用、`dispose()` 后懒重建、工厂接线；
- **零新增依赖**（不把 100MB+ 的原生包塞进每台开发机与 CI）；
- 模型就位那天只需要"丢一个模块进去 + 把验收里的 stub 换成真模块"，`api` 侧与流水线不受影响。

**代价（必须说清）**：**local 的推理正确性与精度、以及"单条 < 500ms"的性能门槛，本批验不了**。
待决事项 2 已按此**收窄**（只剩"运行时模块"这一件），补验方式写在 `docs/06` §七 里。

---

## 验收记录（原始输出）

### `pnpm verify:embedding`（27 项，⚠️ 不需要 PG/Redis）

```
══ P0-1-13 embedding 双模式验收：api 报文 / local worker / 工厂接线 ══
  假上游：http://127.0.0.1:51076（真 HTTP 服务，端口 0）｜ stub 运行时：/var/folders/…/runtime-stub.mjs
  主线程 threadId=0（local 组要证明推理**不在**这个线程里跑）

── A 组 · api 模式（真 HTTP 假上游）──
  [PASS] api：40 条文本 → 2 次请求（批 32 + 8），报文只有 `model`/`input`，Authorization 是明文 Key
  [PASS] api：返回**乱序** `data` 也能按 `index` 归位；跨批拼接顺序逐条正确；维度 = 1024
  [PASS] api：四种响应形态都归一（带/不带 index、`data` 放数组、ollama 的 `{embeddings}`）
  [PASS] api：`input: []` 不发任何请求（"没有文本"不是错误）
  [PASS] api：上游少回一条 → 502 且文案指向"该实现可能不支持批量"
  [PASS] api：上游回 768 维 → 502 且点明与 `vector(1024)` 不符（维度不符绝不写库）
  [PASS] api：`index` 不是 0..n-1 的排列 → 502（宁可报错也不猜顺序）
  [PASS] api：向量里含非数字 → 502（NaN 进了向量列，检索会得到莫名其妙的结果）
  [PASS] api：401（回显 Authorization）→ 502 且消息里**没有明文 Key**
  [PASS] api：200 里藏 `{error}` / 回非 JSON / 上游 404 → 都归成 502 而不是"算了个空"
  [PASS] api：超时 → `UPSTREAM_TIMEOUT`(504)，且**不等**满配置值就返回
  [PASS] api：`name()` = `api:<EMBEDDING_API_MODEL>`、`dim()` = 配置维度（供换模型检测）
  [PASS] `readEmbeddingPayload` 纯函数：空 data / 无向量 → 502（不是静默返回空数组）

── B 组 · local 模式（worker_threads + stub 运行时）──
  [PASS] local：就绪自检三态各自给出**可执行**的文案（目录不存在 / 没有 onnx / 没配运行时）
  [PASS] local：未就绪时 `embed()` 直接报错（不会先去起线程再炸一个 ENOENT）
  [PASS] local：40 条 → worker 侧正好 2 批（32+8），返回值逐条有序、每条 1024 维
  [PASS] local：推理**真的**跑在独立线程里（stub 报回的 `threadId` ≠ 主线程）
  [PASS] local：运行时自报维度与 `EMBEDDING_DIM` 不符 → init 就报错（一分钟都别跑）
  [PASS] local：返回维度不符 / 条数不符 → 明确报错（不把坏向量交给上层）
  [PASS] local：某一次推理抛错 → 该次报错，但线程与运行时可继续用（后面的调用照常成功）
  [PASS] local：`name()` = `local:<模型目录名>`，与 api 的 `name()` **不同**（换模型检测的基础）
  [PASS] local：`dispose()` 之后再 `embed()` 能重新懒加载（线程与运行时都重建）
  [PASS] local：worker 入口在**构建产物**里存在（dist 与源码两种形态都能被找到）

── C 组 · 工厂与配置（子进程注入环境变量，与 .env 当前状态解耦）──
  [PASS] 工厂：`EMBEDDING_MODE=api` 但三项未配 → 就绪自检为 false，取用时**硬报错**并列出缺项
  [PASS] 工厂：`EMBEDDING_MODE=api` 配齐 → 接上 `ApiEmbeddingProvider` 并真的能算（配置接线端到端）
  [PASS] 工厂：`EMBEDDING_MODE=local` 配齐（模型目录 + stub 运行时）→ 接上 `LocalEmbeddingProvider` 并能算
         本机 .env：EMBEDDING_MODE=api ready=false（EMBEDDING_MODE=api 但缺 EMBEDDING_API_URL / EMBEDDING_API_KEY …）
  [PASS] 工厂：本进程当前配置（来自 `infra/.env`）的就绪结论可打印，且 `resetEmbeddingProvider()` 无副作用
  清理复核：临时目录 /var/folders/…/doubulea-embedding-NblUo4 已删除

✅ P0-1-13 embedding 双模式验收通过：27 项全通过
```

### 全量回归（10 档，`pnpm verify:<x>` 逐档跑）

```
===== verify:app =====            ✅ 接口级验收通过：44 项全通过
===== verify:embedding =====      ✅ P0-1-13 embedding 双模式验收通过：27 项全通过
===== verify:db =====             ✅ P0-1-5 数据层验收通过：17 项全通过
===== verify:session =====        ✅ P0-1-6 会话验收通过：13 项全通过
===== verify:auth =====           ✅ P0-1-7 认证接口验收通过：21 项全通过
===== verify:users =====          ✅ P0-1-8 用户管理接口验收通过：17 项全通过
===== verify:model-providers =====✅ P0-1-10 模型池 Provider 验收通过：18 项全通过
===== verify:models =====         ✅ P0-1-11 模型管理验收通过：17 项全通过
===== verify:llm =====            ✅ P0-1-12 LLM client 验收通过：22 项全通过
===== verify:e2e =====            ✅ P0-1-9 端到端验收通过：17 项全通过
```

> `verify:llm` 那一行是本批**最重要的回归**：它证明"把传输层公共件抽到 `upstream.ts`"
> 没有改变任何行为与文案（22 项断言里有一半是在读错误消息的措辞）。

### 静态检查

```
pnpm lint        → 无输出（0 problem）
pnpm -r typecheck→ 三包全绿
pnpm -r build    → 三包全绿（dist 里有 embedding.worker.js）
```

`pnpm config:check` 新增两项可见：`embedding.batchSize = 32`、`embedding.localRuntimeModule = null`；
本机 `.env` 的 `EMBEDDING_MODE=api` + 三项空 ⇒ WARN 两条（与本批的"取用时硬报错"配套）。

---

## 交付物清单（本批）

| 文件 | 说明 |
|------|------|
| `backend/src/llm/upstream.ts` | **新**：通用上游件（`Deadline`/`LlmAbortError`/`redactSecret`/`snippet`/`upstreamHeaders`/`throwUpstreamStatus`/`toUpstreamFailure`/`fetchUpstreamJson`/`UpstreamEndpoint`） |
| `backend/src/llm/client.ts` | 改为复用 `upstream.ts`；`chat()` 缩成一次 `fetchUpstreamJson`；对外导出与文案**逐字未变** |
| `backend/src/llm/embedding/index.ts` | **新**：`EmbeddingProvider` 接口 + 工厂（记忆化）+ `embeddingReadiness()` + `resetEmbeddingProvider()` |
| `backend/src/llm/embedding/api.ts` | **新**：OpenAI 兼容 `/embeddings` provider（批 32 串行、四形态归一、`index` 归位、维度/条数校验） |
| `backend/src/llm/embedding/local.ts` | **新**：`LocalEmbeddingProvider`（worker 客户端、懒加载、批切片、维度校验、`dispose`）+ `localEmbeddingProblems()` + worker 协议类型 |
| `backend/src/llm/embedding/embedding.worker.ts` | **新**：线程内宿主（加载运行时模块、串行跑批、错误回传） |
| `backend/src/config.ts` | `EMBEDDING_BATCH_SIZE` / `LOCAL_EMBEDDING_RUNTIME_MODULE` + local 缺运行时的 WARN |
| `backend/scripts/verify-embedding.mjs` | **新**：27 项（A 假上游 / B stub 运行时 / C 子进程工厂） |
| `infra/.env(.example)`、`docs/02`（§8.1 新增、§十一）、`docs/06`、`README.md` | 配置与文档同步 |
