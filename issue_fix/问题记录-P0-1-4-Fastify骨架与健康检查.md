# 问题记录 — P0-1-4 Fastify 骨架与健康检查

> 批次：P0-1-4（Fastify 骨架 + `/health` + CI）
> 日期：2026-09-21
> 关联：`docs/06` P0-1-4 落地要点 / `docs/02` §四·§4.9·§十一·§十三 /
> `backend/src/{app.ts,index.ts,plugins/errorHandler.ts,routes/health.ts}` / `eslint.config.mjs` / `.github/workflows/ci.yml`
> 定位：本批踩到的坑与结论。**其中坑 1 是「错误处理自己崩了、把真实错误掩成 500」**——
> 纯读代码看不出来，是这个批次顺带做的接口级验收脚本抓出来的。

---

## 汇总（6 个坑）

| # | 问题 | 严重度 | 状态 |
|---|------|--------|------|
| 1 | **错误处理自身崩溃**：`envelope.data` 为 `null` 时读 `.fields` → 抛错被兜成 500，真实错误被掩盖 | 高（会掩盖一切非校验类 4xx） | ✅ 已解决：改用 `instanceof RequestValidationError` 判断 |
| 2 | 领域错误 → 状态码由错误码映射表决定，**把框架的 415/413 压成了 400** | 中（丢客户端处理依据） | ✅ 已解决：框架错误保留原始 `statusCode` |
| 3 | Fastify 校验**按部位短路**：body 失败就轮不到 querystring —— 验收断言写错 | 低（认知题） | ✅ 已确认语义，验收拆成两条用例 |
| 4 | Fastify v5：传 pino 实例会用实例类型**参数化 `FastifyInstance`**，插件签名全对不上 | 中 | ✅ 已解决：断言成 `FastifyBaseLogger` |
| 5 | Fastify v5：`disableRequestLogging` / `requestIdLogLabel` 已废弃 → 启动打 FSTDEP023/024 警告 | 低 | ✅ 已解决：改用 `logController: new LogController({…})` |
| 6 | ioredis 只报「达到重试上限」，**不报 `ECONNREFUSED`** → `/health` 的 detail 没有运维价值 | 中 | ✅ 已解决：连接层错误单独留一份并拼进 message |
| 7 | `pnpm verify:app -- --flag` 的额外参数被中间 `--filter` 吞掉 | 低（会静默丢参数） | ✅ 已解决：开关改走环境变量 |

---

## 坑 1 — 错误处理自身崩溃，把真实错误掩成 500（本批最大的坑）

**现象**：`POST` 一个非法 JSON（`content-type: application/json`，body = `{ not json`）时，期望
400 + VALIDATION 信封，实际拿到：

```
500 {"statusCode":500,"error":"Internal Server Error","message":"Cannot read properties of null (reading 'fields')"}
```

**根因**：错误处理里为了打印字段明细，直接读了信封的 data：

```ts
// ❌ 只有「带字段的校验错误」才有 data.fields，其它 VALIDATION（如 body 解析失败）
//    的 data 是 null —— 于是错误处理器自己抛 TypeError，被 Fastify 兜成 500
logger.info({ fields: (envelope.data as { fields?: FieldIssue[] }).fields }, ...)
```

**两个教训**：

1. **错误处理器是最后一道防线，它自己不能抛**。任何"顺手读一下"的字段都要先判类型 ——
   否则表现是"所有非校验类 4xx 都变成 500"，而且日志里只有那句 TypeError，**真正的错误被完全掩盖**。
2. 这类缺陷**读代码几乎发现不了**（要同时在脑子里跑两条错误路径），是本批顺带写的
   `pnpm verify:app`（用 `app.inject` 把每条错误分支都真打一遍）抓出来的。
   —— 结论：**错误出口必须有接口级验收**，不能只靠"看起来对"。

**对策**：

```ts
// ✅ 只有 zod 校验失败才带字段明细，且按实例判断（而不是"从信封里捞"）
const fields = appError instanceof RequestValidationError ? appError.fields : undefined
```

---

## 坑 2 — 框架错误的状态码被错误码映射表压平

**现象**：`content-type: application/xml`（Fastify 没注册 parser）应得 415，实际得 400；
请求体超 `bodyLimit` 应得 413，实际也是 400。

**根因**：第一版的出口状态码一律走 `toHttpStatus(appError)` ——
而 `AppError` 的 `status` 来自 `HTTP_STATUS_BY_ERROR_CODE`，那里只有 10 个错误码，
`415/413/408` 这些**框架级的细粒度状态码**全被归进 `VALIDATION` → 统一 400。

**为什么这算问题**：前端要靠 413 提示"文件太大"、靠 415 提示"格式不支持"、
靠 429 做退避；压成 400 后这些判断都没了。信封 `code` 是唯一契约没错，但**HTTP 状态码不该倒退**。

**对策**：**框架错误保留 Fastify 原始 `statusCode`，领域错误才按错误码映射**：

```ts
const status = frameworkStatusCode(error) ?? toHttpStatus(appError)
```

（`frameworkStatusCode` 只认 400–599 的整数；`AppError` 没有 `statusCode` 字段，天然不会误命中。）
已回写 `docs/02` §四。

---

## 坑 3 — Fastify 的校验是「按部位短路」的

**现象**：一个用例同时给非法 `body` 和非法 `querystring`，只报出了 `body` 的字段，
断言 `fields` 里应含 `querystring.page` 直接失败。

**根因**：Fastify 内部按 `params → body → querystring → headers` 顺序校验，**任一处失败即返回**，
不再校验后面的部位（见 `fastify/lib/validation.js` 的 `validate()`）。

**对策**：这是**设计如此**（不必改），但验收要按真实语义拆开写：

- 用例 A：非法 body → 断言 `body.*` 的 path；
- 用例 B：**合法 body + 非法 querystring** → 才能验到 `querystring.*`。

> 顺带一个容易忽略的事实：`text/plain` 在 Fastify v5 里**有内置 parser**，
> 用它测 415 是测不出来的（会走到「body 是字符串、校验失败」的 400）。要用 `application/xml` 这类。

---

## 坑 4 — 传 pino 实例会把 `FastifyInstance` 参数化

**现象**：`loggerInstance: logger` 之后，`pnpm -r typecheck` 报一大片：

```
Argument of type 'FastifyInstance<…, Logger, …>' is not assignable to parameter of type
'FastifyInstance<…, FastifyBaseLogger, …>' …
  Property 'msgPrefix' is missing in type 'FastifyBaseLogger' but required in type 'BaseLogger'
```

**根因**：Fastify 5 的 `loggerInstance?: Logger` 是泛型参数，传什么类型**整个 `FastifyInstance`
就按它参数化**。于是 `installErrorHandler(app: FastifyInstance)`（默认泛型 = `FastifyBaseLogger`）
与实例类型对不上 —— 而且**后续每个 `(app: FastifyInstance)` 插件都会中招**。

**对策**：在 `app.ts` 一处断言，换取全仓库签名干净：

```ts
loggerInstance: logger as unknown as FastifyBaseLogger,   // 运行期兼容，差别只在 msgPrefix 等类型细节
```

---

## 坑 5 — 两个已废弃的 Fastify 选项

**现象**：启动时打警告（不影响功能，但污染日志、CI 里也刺眼）：

```
[FSTDEP024] FastifyDeprecation: requestIdLogLabel option is deprecated…
[FSTDEP023] FastifyDeprecation: disableRequestLogging option is deprecated…
```

**对策**：改用 v5 的 `logController`（**要的是实例，不是类** —— 传类会抛
`logController option must be an instance of LogController`）：

```ts
logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
```

保留 `requestIdLogLabel: 'requestId'` 是有意的：让 Fastify 的 `request.log` 与业务代码
`getLogger()`（AsyncLocalStorage 注入）用**同一个字段名**，否则日志里会同时出现 `reqId` / `requestId` 两套。

---

## 坑 6 — ioredis 的报错不含 `ECONNREFUSED`

**现象**：停掉 redis 容器后 `/health` 报：

```
redis  ok:false  detail: "Reached the max retries per request limit (which is 1). Refer to
                          \"maxRetriesPerRequest\" option for details."
```

能看出"不可用"，但**看不出为什么**（端口错了？容器没起？网络不通？）。

**根因**：ioredis 的命令层错误是**结果**（重试次数用尽），真正的 `connect ECONNREFUSED …`
只出现在**连接层**的 `error` 事件里。

**对策**：`infra/redis.ts` 在 `error` 事件里留一份 `lastConnectionError`（`ready` 时清空），
`pingRedis()` 失败时拼进抛出的 message：

```
detail: "Connection is closed.（客户端状态：reconnecting；最近一次连接错误：connect ECONNREFUSED 127.0.0.1:16379）"
```

> 同时把「一轮故障只 warn 一次、恢复时补一条 info」写进连接事件处理：
> redis 宕机期间 ioredis 会持续 emit error，不做节流会把日志刷爆。

顺带一个设计点：`retryStrategy` 给了**有限重试**（约 1.5s 后放弃），否则 `/health` 只能等到外层超时、
拿不到「连接被拒」这个真正的原因。放弃后状态变 `end`，下一次探活会重新 `connect()` ——
**所以容器起回后无需重启进程即可自愈**（已实测）。

---

## 坑 7 — `pnpm --filter` 会吞掉脚本参数

**现象**：CI 里想写 `pnpm verify:app -- --expect-degraded`，但根脚本是
`pnpm --filter @doubulea/backend verify:app` —— 多出来的参数会被中间的 `pnpm --filter`
当成自己的选项，**静默丢弃或直接报未知选项**。

**对策**：开关一律走**环境变量**（`EXPECT_DEGRADED=1`），不传命令行参数。
这条对后续所有"根脚本 → `--filter` → 子包脚本"的链路都成立。

---

## 附：本机验收记录（2026-09-21）

### 1. 静态检查

```bash
pnpm lint              # ✅ 0 problem（顺手修掉 P0-1-1 遗留的未使用 import：infra/scripts/infra.mjs 的 resolve）
pnpm -r typecheck      # ✅ 三包全绿
pnpm -r build          # ✅ 三包产物齐全
```

### 2. 接口级验收（`pnpm verify:app`，app.inject，不占端口）

```
本机模式（依赖在线）                      12 项全通过 ✅
CI 模式（依赖不可达 + EXPECT_DEGRADED=1）  13 项全通过 ✅
```

覆盖：`/health` 三项探活与状态一致性 / 依赖不可达时逐项报原因（且**不走超时兜底**）/
Zod 校验失败的 `body.*` 与 `querystring.*` 字段明细 / `coerce` 结果对 handler 可见 /
领域错误 409 原样带出 msg+data / 未知异常 500 且**不回显**原始 message（断言 body 里搜不到
`secret-token-abc`、`hunter2`）/ 404 信封 / 非法 JSON 400 / 415 / 413 / CORS 预检带凭据 /
`x-request-id` 透传与自动生成。

### 3. 真机端到端（`node backend/dist/backend/src/index.js`，监听 13000）

```bash
# ① 依赖全在线
$ curl -s --noproxy '*' http://127.0.0.1:13000/health | jq -c '.data.status,.data.checks[]'
"ok"
{"target":"postgres","ok":true,"latencyMs":41,"detail":"doubulea @ PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2) on aarch64-unknown-linux-gnu"}
{"target":"redis","ok":true,"latencyMs":15,"detail":"PING → PONG"}
{"target":"s3","ok":true,"latencyMs":36,"detail":"桶 doubulea 尚不存在（首次上传时创建）"}

# ② 停掉本项目 redis 容器（只动 doubulea 的，未碰同机另一项目）
$ docker compose -f infra/docker-compose.yml --env-file infra/.env stop redis
$ curl -s --noproxy '*' -w 'HTTP=%{http_code} 耗时=%{time_total}s\n' http://127.0.0.1:13000/health
HTTP=200  耗时=0.039866s        ← ✅ 不是 500、不挂起
"degraded"
{"target":"postgres","ok":true,"latencyMs":30,...}
{"target":"redis","ok":false,"latencyMs":5,"detail":"Connection is closed.（客户端状态：reconnecting；最近一次连接错误：connect ECONNREFUSED 127.0.0.1:16379）"}
{"target":"s3","ok":true,"latencyMs":13,...}

# ③ 容器起回 → 无需重启进程自愈
$ docker compose -f infra/docker-compose.yml --env-file infra/.env start redis
$ curl -s --noproxy '*' http://127.0.0.1:13000/health | jq .data.status      → "ok"
#   进程日志：{"level":"info","requestId":"3fe9…","msg":"Redis 连接已恢复"}

# ④ SIGTERM 优雅退出
$ kill -TERM <pid>
{"level":"info","reason":"SIGTERM","msg":"开始优雅退出：停止接收新请求"}
{"level":"info","reason":"SIGTERM","msg":"依赖连接已关闭，进程退出"}
$ lsof -nP -iTCP:13000 -sTCP:LISTEN        → 无输出（端口已释放 ✅）
```

其它实测：响应头回带 `x-request-id`（上游给了就透传、没给就生成）；`/health` 在
`logLevel: 'warn'` 下**不打访问日志**，降级时才出一条 warn（带 requestId、
`degraded` 字段列出每项原因）；启动日志里配置摘要已脱敏（`postgresql://doubulea:***@…`、
`credentialMasterKey: [REDACTED]`、S3 密钥只报长度）。

> ⚠️ 本机 curl 要走 `--noproxy '*'`：宿主有系统代理，不加会被代理拦成 502。

### 4. CI

`.github/workflows/ci.yml`（install → lint → typecheck → build → verify）——
推送到 `origin/main` 后 Actions 全绿，见 `gh run list`（记录见 `docs/06` P0-1-4 落地要点）。
