# 开放平台：智能体 OpenAPI（API Key + SSE）

> **状态**：**已落地**（2026-10-20 初稿 / 2026-10-21 决策定稿 / **2026-10-22 B1–B3 实现**）。
> 落地物：迁移 `20261022150000_open_api_keys`、`shared/src/openApi.ts`、`plugins/openAuth.ts`、
> `services/openApiKey.service.ts`、`routes/openKeys.ts`（内部 3 条）、`routes/open/{index,shared}.ts`（对外 17 条）；
> 前端「开放调用」区块：`frontend/src/api/openKeys.ts` + `pages/agents/OpenApiKeysSection.tsx` + `AgentFormPage` 的 `05 / 开放调用`。
> 自证：`pnpm openapi:regression`（19 项）+ `pnpm openapi:check`（6 项）+ `router:regression`（60 项）+ `pnpm verify:open-api-ui`（13 项）。
> **B4 已落地**：契约源 = `backend/src/openapi/openV1Spec.ts` 的 `OPEN_ROUTE_DOCS`（17 条）；
> 导出 `pnpm openapi:export` → 入库的 `openapi/open-v1.json`；文档站 `GET /open/v1/docs`；
> 防漂移三条 `openapi:check`（入库文件一致 / security+scope / operationId）+ `openapi-regression` A5–A7；
> nginx 样例 `infra/nginx/open-v1.conf.example`；curl 冒烟 `pnpm openapi:smoke`。
> ⚠️ **`@fastify/swagger` 最终没有采用**（原因见 §9 的实测记录）—— 它在本仓 zod 校验器下扫不动路由 schema。
> **一句话**：用户在某智能体的「开放调用」页给自己签发一把 Key，外部系统拿 Key 就能
> **定位到"这个用户 × 这个智能体"** → 建会话 → 走 SSE 拿回答；不需要平台登录态，
> 也不碰平台内部的 `/api/*` 会话链路。

---

## 0. 已定案（2026-10-21，用户逐条拍板）

| # | 决策 | 内容 |
|---|------|------|
| Q1 | **Key 归属 = 用户 + 智能体** | 一把 Key 三元组 `(userId, agentId, keyId)`。会话 `user_id` **就是真人用户**，不引入虚拟账号 |
| Q2 | **只开放"调用智能体"** | 含：建会话 / 查历史会话 / 查历史会话内容 / 接收聊天流 / **快速确认**（+ 停止、插话、重新生成、附件）。**不能**增删改智能体 |
| Q3 | **不做浏览器公钥形态** | 只做服务端 OpenAPI（`Authorization: Bearer`） |
| Q4 | **隔离粒度 = 用户 + 智能体**（同用户多把 Key **共享**会话池，2026-10-21 追加定案 X5） | Key 的归属是 `(userId, agentId)`；同一个人对同一 Agent 的多把 Key **看到同一批会话**（轮换/多环境不丢会话）；不同用户之间严格隔离 |
| Q5 | **用户被收回/Key 失效后：外部只能看历史** | Q5 + X2：会话保留；**外部（缺 Key / Key 吊销 / 过期）一律 401 进不来**，历史在**平台界面**里由本人只读可见 |
| Q6 | **支持附件上传** | 图片多模态 + 文本类解析，复用内部 `files` 链路 |
| Q7 | **允许会话级自动审批**；确认超时按 Q12 可配 | 由签发 Key 的用户自己决定；配置项可配 |
| Q8 | **不做函数/插件调用形态** | — |
| Q9 | **本期只对 ChatBot 开放** | `TASK_AGENT` 一律 403（先不开放沙箱） |
| Q10 | **用量绑定用户**（+ X1：加 `channel` 与 `open_key_id` 两列，报表能分内外） | `usage_records.user_id` = Key 所属用户；`channel ∈ {INTERNAL, OPEN_API}`；`open_key_id` 可空，仅 `OPEN_API` 行有值 |
| Q11 | **必须先建会话再发消息** | 不提供"一枪式"临时会话 |
| Q12 | **Key 过期时间可配置** | 签发时可填，也可不填 |
| Q13 | **管理面只在内部页面** | Key 的签发/吊销走 `/api`（Cookie + 行级权限），不做 `/open/v1/admin/*` |
| Q14 | **不做逐工具白/黑名单** | — |
| Q15 | **共用现有网关** | 只加路由粘性分类，不新增网关实例 |

**由这些决策连带确认的推论**（我按一致性补齐，如与预期不符请指出）：

| 推论 | 内容 | 理由 |
|------|------|------|
| R1 | 只有**智能体所属人**能给自己签发 Key | Q1 = 用户+Agent ⇒ 授权链是"这个 Agent 是我的（或我被 ADMIN 授权管理它）"。他人无法给自己的 Key 挂上别人的 Agent |
| R2 | **ADMIN 也不能替别人签发**（可代建，但 Key 明文只回显给操作者一次，且 Key 的 `user_id` = **目标用户**） | 否则等于 ADMIN 能以任意用户身份对外发流量 |
| R3 | 可见性（`PRIVATE/SHARED/PUBLIC`）**不影响**开放层 | 有 Key ⇒ Agent 可调；可见性只决定内部列表能否看到。`SHARED/PUBLIC` 的 Agent，受众**自己**也能给自己签 Key（否则"分享给团队用"就断在最后一步） |
| R4 | 只能调 `type=CHATBOT` 且 `deleted_at IS NULL` 的 Agent | Q9 |
| R5 | **不新建虚拟用户、不加 `service_accounts`、不给 `conversations` 加列** | Q1 + X5 ⇒ 结构性增量只有 `open_api_keys` 一张新表 + `usage_records` 两列 |
| R6 | 会话的"归属者"仍是真人 ⇒ **外部调用会出现在该用户的会话列表里** | Q1 的必然结果（不是缺陷）。X5 之后**无法精确标注来源**，见 §8 与 §12.1 P1 |

---

## 1. 目标 / 非目标

### 1.1 目标

1. **按 Key 定位到唯一 `(用户, 智能体)`**（Key 只是这组关系的凭证），不可跨用户、不可跨智能体。
2. **建会话 / 列会话 / 看历史 / 收流 / 确认** —— 即 Q2 的五件事，一条不缺。
3. SSE 语义与内部**逐字相同**（`docs/07` 即对外协议页）。
4. 附件上传与引用（Q6）。
5. 可运营：签发/吊销、用量（绑用户）、审计、配额。

### 1.2 非目标

- ❌ 智能体 CRUD（Q2）、浏览器公钥形态（Q3）、函数调用（Q8）、逐工具白名单（Q14）。
- ❌ TaskAgent / 沙箱相关的一切（Q9）。
- ❌ **产物两条端点（`/conversations/{id}/artifacts`、`/artifacts/{id}/download`）本期删除**：
  ChatBot 不产文件，暴露两个恒空/恒 404 的端点只会让客户误以为该功能可用。
  将来放开 TaskAgent 时再作为**新增端点**补上（非破坏性，不需 `/v2`）。

### 1.3 端点计数

**17 条**（原 19 条去掉产物两条）+ 内部管理 3 条（§8）。
- ❌ 多租户计费（`usage_records` 无金额列）。
- ❌ 智能体异步任务提交 API。

---

## 2. 现状盘点（为什么这套方案几乎不用改内部）

| 现状 | 位置 | 对方案的影响 |
|------|------|-------------|
| 鉴权只有 Cookie 会话 + Redis | `backend/src/plugins/session.ts` | Key 鉴权必须新增旁路（`plugins/openAuth.ts`） |
| 首登改密闸门拦所有 `/api/**` | `plugins/session.ts#installPasswordChangeGate` | `/open/**` 不在 `/api/**` 下 ⇒ 天然不经过 |
| 会话权限 = "这一行是不是你的"（`conversations.user_id`） | `services/conversation.service.ts` 文件头 ① | ★ **Q1 的最大红利**：身份就是真人用户 ⇒ 会话侧 service **一行都不用改** |
| 会话列表 / 历史 / 消息 / active / chat / stop / steer / confirm 全部按 `(id, userId)` 取 | 同上 | 开放层路由只做"Key → userId"的翻译，然后调同一批函数 |
| SSE 事件契约单一真源（13 个事件） | `shared/src/sse.ts` | 只复用，绝不另写一套名字 |
| 网关只对 `/api/conversations/:id/{chat,regenerate,stream,workspace*}` 粘性 | `shared/src/router.ts#classifyRoute` | ★ 必须同步加 `/open/v1/...`（虽然本期只有 ChatBot，但一致性与将来放开 TaskAgent 都要求这一条） |
| 网关不加载业务 config、只转发 | `backend/src/router/gateway.ts` 文件头 | Key 校验在业务后端做，网关零改动（除粘性表） |
| `docs/06:140`：将来引入 `@fastify/swagger` | `docs/06-实施计划.md` | 本次即"将来"，按该条落地 |
| 用量表 `usage_records` 已有 `user_id` / `agent_id` / token / 轮次 | `schema.prisma:1208` | Q10 ⇒ 天然满足，**加一列 `channel` 仅为"能否区分内外"，见 §12 待确认 X1** |

**结论**：结构性增量 = **一张 `open_api_keys` 表 + 一个鉴权插件 + 一层薄路由**。

---

## 3. 总体架构

```
外部系统 (服务端)
   │  Authorization: Bearer oak_xxxxxxxx
   ▼
┌──────────── 路由网关（现有单副本，Q15 共用）────────────┐
│  classifyRoute(): /open/v1/conversations/:id/* 粘性     │
│  其余 /open/v1/* 轮询                                    │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌──────────────────────── 业务后端 ────────────────────────┐
│  plugins/openAuth.ts    ← 新增：Key → {userId, agentId}  │
│                            + 作用域 + 限速 + 审计         │
│  routes/open/*.ts       ← 新增：薄路由，调既有 service    │
│  services/*.service.ts  ← 复用，判据不变                  │
│  orchestrator/sse.ts    ← 复用（/chat 出口）              │
└──────────────────────────────────────────────────────────┘
```

---

## 4. 数据模型

### 4.1 唯一新增表

```prisma
/// open_api_keys —— 对外开放调用凭据（P1-22）
///
/// ★ 三元组 `(userId, agentId)`：用户给自己拥有的（或被授权管理的）智能体签发，
///   一把 Key 只对应一个智能体，且**只能以该用户身份**操作。
///   ⇒ 会话的 `user_id` 就是 `userId` 本人（Q1）：**不存在虚拟账号**。
model ApiKey {
  id              String   @id @default(uuid(7)) @db.Uuid
  userId          String   @map("user_id") @db.Uuid
  agentId         String   @map("agent_id") @db.Uuid
  name            String   @db.VarChar(64)
  /// 展示用前缀（`oak_` + 8 字符），界面与日志里识别是哪把 Key
  keyPrefix       String   @map("key_prefix") @db.VarChar(16)
  /// 只存 **sha256(明文)**，不可逆（与 `api_key_enc` 的"密文"是两回事：那个能解密，这个不能）
  keyHash         String   @unique @map("key_hash") @db.Char(64)
  /// 前端展示用的尾 4 位（如 `…a9f3`），便于人眼对齐日志
  keySuffix       String   @map("key_suffix") @db.VarChar(8)
  /// 作用域（§6.3）；空数组 = 无权限（等于停用，但语义不同）
  scopes          String[]
  /// Q12：过期时间；**null = 不过期**（允许，但界面默认建议填）
  expiresAt       DateTime? @map("expires_at") @db.Timestamptz(3)
  lastUsedAt      DateTime? @map("last_used_at") @db.Timestamptz(3)
  /// 吊销（幂等、不可恢复）；吊销后外部立即进不来，历史仍在**平台界面**可见（Q5 + X2）
  revokedAt       DateTime? @map("revoked_at") @db.Timestamptz(3)
  /// Q7 + X7：是否允许这把 Key 打开会话级自动审批。**默认 true**（用户拍板），界面用危险色提示
  allowAutoApprove Boolean @default(true) @map("allow_auto_approve")
  /// Q12：本 Key 的确认卡超时秒数（null = 用全局默认）
  confirmTimeoutSec Int?   @map("confirm_timeout_sec")
  /// 单 Key 并发上限（默认 2；null = 用全局默认）
  maxConcurrency  Int?     @map("max_concurrency")
  /// 单 Key 每分钟请求上限（默认 120；null = 用全局默认）
  rateLimitPerMin Int?     @map("rate_limit_per_min")
  /// X6：单 Key 日 token 上限；**0 / null = 不限**（界面可填，防刷爆 provider 额度）
  dailyTokenLimit Int?     @map("daily_token_limit")
  createdBy       String   @map("created_by") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  agent Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@index([userId, agentId])
  @@index([agentId, revokedAt])
  @@map("open_api_keys")
}
```

**为什么不需要 `service_accounts` / 虚拟用户**（初稿方案已作废）：

- Q1 定了"Key 属于用户 ⇒ 会话 `user_id` = 真人" ⇒ 会话、消息、附件**全部天然归属**，
  内部那套"这一行是不是你的"判据原样生效，**零改造、零新判据**。
- X5 定了"同用户多 Key **共享**会话池" ⇒ **不需要在 `conversations` 上加任何列**：
  会话的归属就是 `(userId, agentId)`，开放层列表查 `where: { userId, agentId }`，
  与内部"我在这 个 Agent 下的会话"完全同一形状（`listConversationsForAgent` 直接可用）。
- X2 定了"外部进不来" ⇒ 吊销 Key 不影响历史会话（历史本来就属于用户），只是没 Key 就走不进开放层。

### 4.2 X2 落地后的语义（已定案：外部进不来）

| 场景 | 外部（`/open/v1`） | 平台界面（本人） |
|------|-------------------|-----------------|
| Key 有效 | 正常读写 | 正常读写（会话来源标 `API`） |
| Key **吊销 / 过期** | **401**（连历史也读不到） | 仍可看全部历史（含外部建的），可继续在里面聊 |
| Agent **软删** | 401（④b） | 会话转只读保留（内部既有规则） |
| Agent **转移** | 原 Key 401（④b 的 ACL 判据） | 原用户不再可见；新 owner 可见 |

> 无需 `open_read_grants` 之类的新表。

### 4.3 第二处（也是最后一处）结构性增量：`usage_records` 加两列

X1 定案"要能分内外"，因此：

```prisma
model UsageRecord {
  // ...既有列不动
  /// 调用来源：内部界面 / 开放 API
  channel     String  @default("INTERNAL") @db.VarChar(16)   // 'INTERNAL' | 'OPEN_API'
  /// 仅 `OPEN_API` 行有值；内部行为 NULL（便于"按 Key 看用量"）
  openKeyId   String? @map("open_key_id") @db.Uuid

  @@index([openKeyId, createdAt(sort: Desc)])
}
```

- `channel` 用 `VarChar` 而不是 enum：`usage_records` 是**按月分区表**（`@@id([id, createdAt])`），
  加 enum 类型在多环境迁移里更容易卡住；字符串 + 服务层常量（`shared` 里一份）足够。
- 写入点只有 `orchestrator/persist.ts` 一处；开放层把 `channel/openKeyId` 经 `ChatSendContext` 透传，
  **内部路径默认 `INTERNAL`**（回归断言：内部聊一轮后该行 `channel='INTERNAL'`、`openKeyId IS NULL`）。

### 4.4 生命周期规则

| 事件 | 处理 |
|------|------|
| Agent **软删**（`deleted_at`） | Key 立即 401（校验链第 ④ 步查 `deletedAt`）；会话按内部规则转只读 |
| Agent **转移**给他人 | Key 的 `userId` 不变 ⇒ 原用户仍有 Key，但**他对该 Agent 已无所有权** ⇒ 校验链改为"Key 有效 ∧ (userId 是当前 owner ∨ 在受众内)"⇒ 转移后原 Key **失效**（401），需新 owner 重新签发。**这条要额外落一层判据**（见 §5.2 ④b） |
| Key **吊销** | `revoked_at` + **删 Redis 缓存键**（否则最长 60s 内仍可用） |
| 用户 **停用/删除** | 复用 `plugins/session.ts` 的 60s 快照口径：`status=DISABLED` ⇒ 401 |
| 用户 **改密** | **不失效**（Key 与密码无关）；若产品要求"改密即轮换全部 Key"，加一条（X3） |

---

## 5. 鉴权设计

### 5.1 Key 形态

```
Authorization: Bearer oak_<32 字节 base62>     ← 推荐
X-API-Key: oak_<...>                          ← 兼容
```

- 前缀 `oak_`（open api key）**可识别**：日志脱敏规则按它兜底。
- 明文**只在创建那一刻返回一次**；库里只有 `sha256`。重置 = 建新 Key + 吊销旧的。
- 不做 HMAC 签名/时间戳（服务端调用 + HTTPS 已足够）。

### 5.2 校验链（`requireApiKey`，`plugins/openAuth.ts`）

```
① 取 Key → 无 ⇒ 401 UNAUTHORIZED（不碰 Redis/DB：不做存在性预言机）
② 形态校验（oak_ + 长度）→ 非法 ⇒ 401
③ 缓存 open:key:{sha256}（TTL 60s）命中 ⇒ 用；未命中 ⇒ 查库回填
④a 状态：revoked_at / expires_at / user.status=DISABLED ⇒ 401（同一文案，不区分）
④b 资源状态：agent.deleted_at IS NULL ∧ agent.type = CHATBOT（否则 403 NOT_OPENABLE）
             ∧ canViewAsset(agent, {用户})（转移后原 Key 失效）
⑤ 作用域：所需 scope ∉ key.scopes ⇒ 403 FORBIDDEN
⑥ 限速/配额（§6.4）：超 ⇒ 429 BUSY + Retry-After
⑦ request.open = { key, userId, agentId, scopes, allowAutoApprove, confirmTimeoutSec }
   enrichRequestContext({ userId, openKeyId })   ← 日志自动带
```

- **失败语义**：Key 错 / 停用 / 过期**一律 401 同一句文案**；scope 不足 403；Agent 不可开放 403。
- **依赖故障 = 500，不是 401**（照抄 `plugins/session.ts` 文件头 ② 的理由：把 Redis/DB 故障映射成 401
  会让客户以为 Key 错了）。
- **第 ④b 步是新增判据**，也是本方案唯一"新增的权限判定"，必须集中在这一个函数里（不许散到各路由）。

### 5.3 与内部会话链的关系

- `/open/**` **不读不写** Cookie；`/api/**` **不接受** API Key。两条链互不可替代。
- 每个带 `:conversationId` 的开放端点，都要**额外**校验 `conversation.agentId === key.agentId`
  （防"用 A 智能体的 Key 去操作同用户的 B 智能体会话"）。归属判据仍由 `assertConversationOwner` 给，
  这一条是**叠加**，实现建议放在 `openAuth` 的一个 `assertOpenConversation(id, request.open)` 里。

---

## 6. API 设计（`/open/v1`）

### 6.1 通用约定

| 项 | 约定 |
|----|------|
| 版本 | 路径内 `/v1`；破坏性变更 ⇒ `/v2`，旧版保留 ≥6 个月 + `Deprecation` 头 |
| 成功/失败体 | `{ "code": 0|"<ERROR_CODE>", "msg": "...", "data": ... }`（与内部信封同形） |
| HTTP 状态 | 沿用 `shared/src/errors.ts#HTTP_STATUS_BY_ERROR_CODE`；**新增错误码 `NOT_OPENABLE` → 403**（X4 已确认） |
| 幂等 | **建会话**接受 `Idempotency-Key` 头（24h Redis）；重复 ⇒ 返回第一次结果 |
| 追踪 | `x-request-id`（已有）+ 响应头回带 `X-Open-Key-Id`（便于客户对账） |
| 分页 | `?limit=&cursor=`（游标；会话与消息都在变，不用 offset） |

### 6.2 端点总表（17 条）

| 方法 | 路径 | scope | 粘性 | 说明 |
|------|------|-------|------|------|
| GET | `/open/v1/agent` | — | ✖ | **我是谁**：Key 绑定的智能体公开画像 + 能力 |
| GET | `/open/v1/agent/models` | `chat` | ✖ | 可选的模型（池内且 `available`） |
| POST | `/open/v1/conversations` | `conversation:write` | ✖ | 建会话（Q11：必须先建） |
| GET | `/open/v1/conversations` | `conversation:read` | ✖ | **我这把 Key 对应 `(我, 该 Agent)` 的**会话列表（Q4/X5：同用户多 Key 共享） |
| GET | `/open/v1/conversations/{id}` | `conversation:read` | ✖ | 会话详情（含 `status` / `readOnly`） |
| DELETE | `/open/v1/conversations/{id}` | `conversation:write` | ✖ | 删除（级联消息） |
| GET | `/open/v1/conversations/{id}/messages` | `conversation:read` | ✖ | 历史（游标，正序） |
| GET | `/open/v1/conversations/{id}/active` | `conversation:read` | ✖ | 断线恢复：在跑？排队位次？待确认 id？ |
| POST | `/open/v1/conversations/{id}/chat` | `chat` | ✔ | **SSE** 发消息 |
| GET | `/open/v1/conversations/{id}/stream` | `conversation:read` | ✔ | **SSE** 只读观察流（迟到补帧） |
| POST | `/open/v1/conversations/{id}/regenerate` | `chat` | ✔ | 重新生成（SSE） |
| POST | `/open/v1/conversations/{id}/stop` | `chat` | ✖ | 停止本轮（幂等） |
| POST | `/open/v1/conversations/{id}/steer` | `chat` | ✖ | 中途插话 |
| POST | `/open/v1/conversations/{id}/confirm` | `chat` | ✖ | **快速确认**（Q2 点名的能力） |
| POST | `/open/v1/conversations/{id}/auto-approve` | `chat` | ✖ | 开关会话自动审批（Q7；受 Key 的 `allowAutoApprove` 约束） |
| POST | `/open/v1/files` | `chat` | ✖ | 附件上传（Q6，multipart） |
| GET | `/open/v1/usage` | — | ✖ | 本 Key 的用量与限速余量 |

#### Q4 / X5 落地细节（会话可见范围）

X5 定案：**同一用户在同一 Agent 下的多把 Key 共享会话池**。于是：

- 开放层列表 = `where: { userId, agentId }` —— 与内部 `listConversationsForAgent`
  **完全同一形状**，**不需要在 `conversations` 上加任何列**。
- 于是：界面里建的会话、Key A 建的会话、Key B 建的会话，**在开放层都能看到**（同一三件套）。
  这就是"共享"的字面含义，也是它带来的直接后果：**没有"仅 API 可见"的隔离层**。
- 跨用户严格隔离（`userId`），跨 Agent 严格隔离（`agentId`）。
- 轮换 Key（建新 + 吊销旧）**不影响任何会话** —— 这正是 X5 选"共享"的主要收益。

| 对比（已作废的严格隔离） | 后果 |
|---|---|
| 需要 `conversations.open_key_id` 列 + 迁移 + 内部查询不受影响 | ✗ 不需要了 |
| 界面建的会话在开放层不可见（否则"Key 下线会话还在外面"说不清） | ✗ 现在可见，反而更符合"人以人的身份看自己的会话" |

### 6.3 作用域（scope）

| scope | 覆盖端点 |
|-------|---------|
| `chat` | `chat` / `regenerate` / `stop` / `steer` / `confirm` / `auto-approve` / `files` / `agent/models` |
| `conversation:read` | 会话列表/详情、消息、`active`、`stream` |
| `conversation:write` | 建 / 删会话 |

> 原 `artifact:read` 已随产物端点一并删除（§1.2）。将来放开 TaskAgent 时再加回，**旧的 Key 不会自动获得它**（需重新签发或编辑 scope）。

默认全选；**界面提供"只读"预设**（`conversation:read` 单项）。

### 6.4 限速与配额（单 Key 维度，Q4）

| 维度 | 键 | 默认（Key 可覆盖） | 说明 |
|------|-----|------|------|
| 单 Key 并发 `/chat` | `open:conc:{keyId}` | 2（`maxConcurrency`） | 跨会话同时只能 2 条在跑 |
| 单 Key 请求 | `open:rpm:{keyId}` | 120/min（`rateLimitPerMin`） | 固定窗口 |
| 单 Key 日 Token | `open:day:tok:{keyId}` | 0 = 不限（`dailyTokenLimit`） | 由 `done.usage` 累加（X6 已确认要） |

超限统一 `429 BUSY` + `Retry-After` + `X-RateLimit-Remaining`。

### 6.5 示例

**① 我是谁**

```bash
curl -s https://<host>/open/v1/agent -H "Authorization: Bearer $KEY"
```

```json
{ "code": 0, "msg": "ok", "data": {
  "id": "0192f0c4-...",
  "name": "订单助手",
  "description": "回答订单与售后问题",
  "type": "CHATBOT",
  "icon": null,
  "openingRemarks": "你好，我是订单助手。",
  "guideQuestions": ["怎么查物流？"],
  "defaultModelId": "0192f0c4-...",
  "models": [{ "id": "0192...", "label": "gpt-4o", "available": true }],
  "capabilities": {
    "streaming": true, "confirm": true, "autoApprove": true,
    "attachments": true, "steer": true, "regenerate": true
  },
  "limits": { "maxConcurrency": 2, "rateLimitPerMin": 120, "confirmTimeoutSec": 300, "dailyTokenLimit": 0 }
}}
```

**② 建会话**（Q11：必须先建）

```bash
curl -s -X POST https://<host>/open/v1/conversations \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $UUID" \
  -H 'Content-Type: application/json' -d '{"title":"订单 123 咨询"}'
```

```json
{ "code": 0, "msg": "ok", "data": {
  "id": "0192f0d1-...", "agentId": "0192f0c4-...",
  "title": "订单 123 咨询", "status": "ACTIVE", "readOnly": false,
  "createdAt": "2026-10-20T09:00:00.000Z", "lastMessageAt": null
}}
```

**③ 发消息（SSE）**

```bash
curl -N -X POST https://<host>/open/v1/conversations/$CID/chat \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"content":"我的订单到哪了？","modelId":"0192...","attachmentFileIds":[]}'
```

```
event: delta
data: {"text":"您的订单"}

event: delta
data: {"text":"已到达上海..."}

event: citations
data: {"items":[{"documentName":"物流FAQ.pdf","snippet":"..."}]}

event: done
data: {"messageId":"0192...","finishReason":"COMPLETE","usage":{"tokensIn":823,"tokensOut":96}}
```

事件全集、`confirm` 卡、`ping`、`done`/`error` 收尾规则**完全照 `docs/07`**。

**④ 快速确认（Q2 点名）**

```bash
# 1) 流里收到 event: confirm {confirmId, source, toolName, inputSummary, expiresAt}
# 2) 应答（另开一条普通 HTTP，不占流）
curl -s -X POST https://<host>/open/v1/conversations/$CID/confirm \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"confirmId":"758b508b-...","accepted":true}'
```

```json
{ "code": 0, "msg": "ok", "data": { "id": "...", "confirmId": "758b508b-...", "accepted": true, "applied": true } }
```

> `applied:false` = 没人在等这个 id（已超时/已处理/迟到点击）—— **正常终局，不要重试**（`docs/07` §3.2）。
> `expiresAt` 取服务端给的值；本 Key 若配了 `confirmTimeoutSec`，以它为准（§4.1）。

**⑤ 断线重连**

```
GET /open/v1/conversations/{id}/active
→ { "streaming": true, "currentTool": null, "startedAt": "...", "pendingConfirmId": "…或 null",
    "queuedPosition": null, "autoApprove": false, "readOnly": false }

pendingConfirmId != null ⇒ POST /confirm
然后 GET /messages?limit=50 补齐历史，或 GET /stream 继续看实时帧（迟到会补发本轮已发帧）
```

**⑥ 附件**

```bash
curl -s -X POST https://<host>/open/v1/files -H "Authorization: Bearer $KEY" -F "file=@shot.png"
→ { "code":0, "data": { "id":"0192...", "name":"shot.png", "mime":"image/png", "size":102400 } }
# 然后在 /chat 的 attachmentFileIds 里引用（≤5 个，与内部同口径）
```

---

## 7. SSE 实现要点（踩坑清单）

| # | 坑 | 口径 |
|---|----|------|
| 1 | **网关粘性** | `shared/src/router.ts` 的 `STICKY_CONVERSATION_ENDPOINTS` 是按 `/api/conversations/...` 正则匹配 ⇒ 必须加 `/open/v1/conversations/:id/(chat\|regenerate\|stream)`；`router:regression` 补断言 |
| 2 | **前置失败走 JSON 信封** | 401/400/404/403/409/424 在写第一帧**之前**；客户按 `Content-Type` 分支 |
| 3 | **流内错误** | 并发冲突仍走 `error{code:"CONFLICT"}` 事件（不是 409） |
| 4 | **反向代理** | `proxy_buffering off; proxy_read_timeout 3600s; proxy_http_version 1.1` |
| 5 | **断开检测** | 客户断连 ⇒ 后端清流；但轮次不会自动丢 —— 告诉客户"重连续上，别重发"（重发会 CONFLICT 或产生重复轮次） |
| 6 | **心跳** | `ping` 事件必须容忍并忽略（防空闲超时） |
| 7 | **`/stream` 补帧** | 帧总线按会话缓冲本轮已发帧；订阅晚到也能补齐开头；整轮已结束则立刻收尾 |
| 8 | **`confirm` 超时** | 默认 120s（`MCP_CONFIRM_TIMEOUT_SEC`）；本方案允许按 Key 覆盖为 300s（§4.1），因为外部人工审批更慢 |
| 9 | **`auto-approve`** | Q7 允许，但**受 `api_keys.allow_auto_approve` 约束**（默认 true，界面可关）；打开后该会话内危险工具由服务端直接放行（`docs/07` §3.5） |
| 10 | **`readOnly`** | Agent 软删或 Key 吊销后（Q5 方案 A）外部进不来；仅 Agent 软删时既存会话在**平台界面**只读保留 |

---

## 8. 管理面（内部页面，Q13）

| 位置 | 能力 |
|------|------|
| **我的凭据 → 「开放调用」Tab**（`/settings/credentials?section=openapi`；2026-10-22 定案，原定在智能体编辑页） | 列出**我名下的全部 Key**（可按智能体筛选；名称/前缀尾 4 位/关联智能体/作用域/过期/最后使用/状态）；**新建** 弹窗（**必选关联智能体**、名称、作用域预设、过期时间 Q12、并发 / RPM / 日 token 上限 X6、允许自动审批 X7）；**编辑** 弹窗（2026-10-22 追加：名称 / 作用域 / 过期时间 / 限额 / 自动审批可改；**放宽作用域需勾选确认**；**关联智能体与 Key 值不可改**；已吊销的 Key 不可编辑；已过期续期 = 重新启用）；**吊销**确认框（"吊销后外部立即无法访问，历史会话仍在你名下"）；创建后**一次性**弹明文 + 复制按钮。⚠️ Key 的主语是「我 × 智能体」—— 挂在智能体编辑页会让人以为"开了 Key 大家都能用" |
| 会话列表 | ⚠️ **无法精确标注"哪些会话是 API 建的"** —— 会话行没有记录来源（X5 共享池的代价）。折中：在会话详情里显示"最近一次外部调用时间"（读 `usage_records.channel='OPEN_API'` 的 `conversationId`，若该列没有则用消息 `created_at` 近似），或**干脆不标**。见 §12 遗留 P1 |
| `/admin/open-usage` | 按 **用户 / 智能体 / Key** 聚合（`usage_records.channel + open_key_id`）：请求数、token、错误码分布、Top 客户端（`x-client-name` 头） |
| 审计 | 每次 `/open/**` 一行结构化日志 `{ openKeyId, userId, agentId, route, status, latencyMs }`（requestId 已有） |

**内部管理端点**（`/api`，Cookie + 行级权限）：

| 方法 | 路径 | 权限 |
|------|------|------|
| GET | `/api/open-keys?agentId=&includeInactive=` | **只列自己名下的**（ADMIN 也不越权列举；`agentId` 可选过滤） |
| POST | `/api/open-keys` | 体里 `agentId` 必须"我能看见"（所属人 / ADMIN / SHARED 受众 ⇒ 受众给自己签，R3）；`userId` 仅 ADMIN 可指定（R2 代建） |
| PUT | `/api/open-keys/:keyId` | 编辑元数据（2026-10-22 追加）。Key 是我的，或我是 ADMIN（别人的一律 404）；**合并语义**（缺省字段保持原值）；可改 = name / scopes / expiresAt / 限额四项 / allowAutoApprove，**不可改 = 明文、agentId、userId**（换目标走吊销重签）；`expiresAt` 非 null 必须是未来时刻（续期即重新启用）；已吊销 ⇒ **409**；**保存即删缓存键**（scopes/限额在快照里，不删则外部最长 60s 仍按旧策略） |
| DELETE | `/api/open-keys/:keyId` | Key 是我的，或我是 ADMIN（别人的一律 404）；幂等 |

> ⚠️ **2026-10-22 形态变更**：管理面由 `/api/agents/:id/open-keys`（按智能体）改为 `/api/open-keys`（按人），
> 关联哪个智能体从**路径**挪到**签发请求体的 `agentId`**。理由：Key 的归属是「我 × 智能体」，
> 按智能体组织会让受众误读"这是这个智能体的共享凭据"。

---

## 9. OpenAPI 契约的生产方式

**契约从一张表出发，生成入库文件；两侧都有断言。**

```
backend/src/openapi/openV1Spec.ts 的 OPEN_ROUTE_DOCS（17 条，手写 JSON Schema）
→ pnpm openapi:export  → openapi/open-v1.json（入库，review 时看 diff）
→ GET /open/v1/openapi.json（线上返回同源数据）+ GET /open/v1/docs（极简文档站读它）
```

三条断言（`pnpm openapi:check` + `pnpm openapi:regression`）：

1. `openapi:regression` **A5**：spec 里的操作集合 == Fastify `printRoutes()` 的 17 条业务端点（不多不少），
   且每条都有 `security` 与 `x-open-scope`；
2. `openapi:regression` **A6**：入库的 `openapi/open-v1.json` 与 `buildOpenV1Spec()` 逐字节一致；
   `openapi:check` **S1** 再兜一次"改了契约没提交"（`git status` 看得见）；
3. `openapi:check` **S2–S6**：路径集合 / scope 闭集 / `operationId` 唯一 / 每条都有 200 与错误响应 /
   spec 里没有 `/api/**` 与文档端点自身。

### 9.1 为什么不用 `@fastify/swagger` 自动生成（2026-10-22 实测定案）

装了 `@fastify/swagger@9.9.2` 试过，**撤掉**了：

| 试验 | 结果 |
|------|------|
| 注册插件 + 路由 schema 是 zod 实例 | `/api/auth/*` 之后的注册会撞 `FST_ERR_ROUTE_BODY_VALIDATION_SCHEMA_NOT_SUPPORTED`；而插件自身的 `onRoute` 钩子要求先注册 |
| 靠 `transform` 把 zod 换成 JSON Schema | 能出 spec，但 `/api/**` 的 zod schema 让 swagger 抛 `Cannot read properties of null (reading 'examples')`（它把 zod 实例当 JSON Schema 遍历） |
| `zod → JSON Schema` 派生 | 需要再引一条链路（依赖 zod 内部 `_def`），升级即坏，且字段映射要长期维护 |

⇒ 契约束在一张表上。代价是"字段级漂移靠 review"；收益是**生成不依赖任何运行时**（导出脚本
不连库、不需要 env，CI 里永假绿/假红），且两侧一致性由 A5/A6 真正钉住。

---

## 10. 实施拆分（4 批）

| 批 | 内容 | 验收（可自动化） | 规模 |
|----|------|-----------------|------|
| **B1 身份与 Key** | 两条迁移（`open_api_keys` 建表 + `usage_records` 加 `channel`/`open_key_id`）；`/api/open-keys` 三条（2026-10-22 由按智能体改为按人）；`plugins/openAuth.ts`（④a/④b 判据、缓存、吊销删键、`NOT_OPENABLE`）；`GET /open/v1/agent` | Key 明文只回一次；吊销立即 401（缓存键被删）；过期 401；作用域不足 403；`TASK_AGENT` 403 `NOT_OPENABLE`；转移后原 Key 401；他人 Agent 签不出 Key；内部聊一轮后 `usage_records.channel='INTERNAL'` 且 `open_key_id IS NULL` | ~1.5 人日 |
| **B2 会话与 SSE** | `/open/v1/conversations*`（建/列表/详情/删/消息/active/chat/stream/regenerate/stop/steer/confirm/auto-approve）；网关粘性表 + 回归补断言 | ChatBot 会话：delta 拼接 == 历史正文；并发第二次得流内 `CONFLICT`；`/stop` ⇒ `done.finishReason=STOPPED`；`confirm` 超时后 `applied:false`；**Key A 与 Key B（同用户同 Agent）看到同一批会话、Key C（另一用户）看不到**（X5）；界面建的会话在开放层**可见** | ~2 人日 |
| **B3 附件/限速/审计** | `/open/v1/files` + 附件校验；限速/并发/日 token（X6）；`/open/v1/usage`；`channel='OPEN_API'` 落库 | 上传后 chat 能引用；RPM 打满 429 且 `Retry-After` 正确；超并发 429；日 token 超限 429；审计字段齐全 | ~1 人日 |
| **B4 契约与文档** ✅ | 契约表 `openV1Spec.ts` + `openapi:export` + 入库 `openapi/open-v1.json` + 文档站 `/open/v1/docs` + `openapi:check` + nginx 样例（`infra/nginx/open-v1.conf.example`）+ curl 冒烟（`pnpm openapi:smoke`） | `openapi:check`（6）+ `openapi:regression`（19，含 A5–A7）全绿；冒烟的无 Key 部分默认跑、带 Key 部分给 `OPEN_API_KEY` 后跑通 | ~1 人日 |

> ⚠️ **跨批硬依赖**：粘性表不改，多机下 SSE 会落错（本期 ChatBot 也会：帧总线是进程内的，
> `/stream` 必须落同一台）⇒ **B2 内必须完成**，不能延后。

---

## 11. 风险清单

| 风险 | 影响 | 缓解 |
|------|------|------|
| **ChatBot 的共享 Key 额度被外部刷** | 用户自己的 provider 额度被烧 | 单 Key RPM + 并发 2 + 日 token 上限（X6）；`/open/v1/usage` 自助看 |
| **Key 泄露** | 冒充该用户聊、可能触发其 MCP 工具（Q7 允许自动审批 ⇒ 破坏性工具会被执行） | `oak_` 前缀便于密文扫描；吊销即失效；审计带 keyId；界面默认**不建议**开自动审批（X7） |
| **外部调用混进用户的会话列表**（R6，X5 共享池使其不可精确标注） | 用户觉得"我没有聊过这个" | 保留（Q1 的必然代价）；可选补救见 §8 会话列表行 —— 若需要**精确**区分，唯一办法是给 `conversations` 加"首次创建来源"列（`created_via ∈ {UI, OPEN_API}`），见 §12 遗留 P1 |
| **转移 Agent 后原 Key 仍能调** | 越权 | ④b 的 `canViewAsset` 判据 + 回归断言 |
| **`usage_records` 加列影响分区表迁移** | 迁移时间长 / 锁表 | `channel` 带 `DEFAULT 'INTERNAL'`（PG 11+ 的常量默认值不重写全表）；`open_key_id` 可空；索引 **`CONCURRENTLY`** 建（与既有 `usage_records` 迁移手法一致） |
| **契约漂移** | 客户升级坏 | spec 从代码生成 + CI 断言 + `/v1` 版本化 |
| **长连接被中间件掐断** | 客户以为服务挂了 | nginx 样例 + 心跳 + `/active` 恢复路径写进文档 |

---

## 12. 衍生决策（全部已定案，2026-10-21）

| # | 决定 | 落地影响 |
|---|------|---------|
| **X1** | ✅ **加列**：`usage_records.channel`（`INTERNAL`/`OPEN_API`）+ `usage_records.open_key_id` | 一条迁移；`persist.ts` 一处写入点；报表能分内外与按 Key 归集 |
| **X2** | ✅ **外部进不来**：Key 缺/吊销/过期 ⇒ 401，历史只在**平台界面**可见 | 无需 `open_read_grants`；无需只读凭据；`docs/07` 的断线恢复流程不变 |
| **X3** | ✅ **改密不吊销 Key** | 无额外逻辑；仅界面提示"改密不影响 API Key，如泄露请手动吊销" |
| **X4** | ✅ **新增错误码 `NOT_OPENABLE` → 403** | `shared/src/errors.ts` 的 `ERROR_CODES` / `HTTP_STATUS_BY_ERROR_CODE` / `DEFAULT_MESSAGE_BY_ERROR_CODE` 三处同步 + 前端文案映射 |
| **X5** | ✅ **同用户多 Key 共享会话池** | **不加** `conversations.open_key_id`；列表 `where = {userId, agentId}`（复用 `listConversationsForAgent`）；轮换 Key 不丢会话 |
| **X6** | ✅ **要日 token 上限** | `open_api_keys.daily_token_limit`（0/null = 不限）+ Redis `open:day:tok:{keyId}` + `/open/v1/usage` 暴露余量 |
| **X7** | ✅ **新 Key 默认允许自动审批** | `allow_auto_approve` 默认 `true`；界面用危险色提示 |

### 12.1 遗留（不阻塞开工，需要时可加）

| # | 事项 | 说明 |
|---|------|------|
| P1 | **会话来源无法精确标注** | X5 的共享池让"这个会话是不是 API 建的"没有列可查。若产品确需精确区分，加 `conversations.created_via VarChar(16) DEFAULT 'UI'`（一条迁移，内部行为不变）。**建议先不做**，用 `usage_records` 侧聚合近似 |
| P2 | **放开 TaskAgent 时的补充** | 届时需要：产物两条端点 + `artifact:read` scope + `/workspace*` 粘性 + 沙箱配额（原 Q9 的 B 案）。本方案已为它们留出位置但不实现 |
| P3 | **SDK** | 本期只给 `openapi.json` + `curl` 示例。TS/Java 薄封装按客户诉求再做 |

## 13. 与既有文档的关系

| 文档 | 关系 |
|------|------|
| `docs/07-第三方接入-会话确认(confirm)协议.md` | **就是本方案的对外协议页**（SSE/confirm/断线恢复全部引用它，不重写） |
| `docs/02-后端设计.md` §四（信封）/§五（SSE）/§十（安全） | 开放层沿用；需追加「§十五 开放平台（OpenAPI）」 |
| `docs/06-实施计划.md:140` | 兑现"引入 `@fastify/swagger`" |
| `shared/src/router.ts` | 追加 `/open/v1/**` 粘性分类（硬依赖） |
| `shared/src/sse.ts` | 不改 |
| `docs/05-P系列计划拆分.md` | 登记为 **P1-22「智能体开放平台（OpenAPI + API Key）」**（⚠️ 2026-10-22 订正：本方案初稿自称 P1-20，但该号已被**代码在用的「git 提交身份注入」**占用（2026-10-15）、P1-21 被「工具清单热更新」（2026-10-21）占用 ⇒ 本方案改立 **P1-22**，与代码注释里的 `P1-20` 并非同一项） |

---

## 14. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-10-20 | 初稿：19 条端点、虚拟服务账号方案、15 个待确认 |
| 2026-10-21 | **按 15 条决策重写**：Key 改为「用户 + 智能体」（去掉 `service_accounts` 与虚拟用户，改为真身模型）；Q2 收窄为"调用 + 建会话/历史/流/确认"；Q9 只开放 CHATBOT（新增 `NOT_OPENABLE` 判据）；Q6 附件、Q7 允许自动审批、Q12 可配过期/超时/限速；Q13 管理面全走 `/api` |
| 2026-10-22（B4） | **落地 B4**：契约表 + `openapi:export` → `openapi/open-v1.json` + 文档站 + `openapi:check` + nginx 样例 + `openapi:smoke`；`@fastify/swagger` 实测不可用（§9.1）⇒ 改为"手写表 + 双向断言"。同时**管理面按人**（`/api/open-keys`，见 §8）与前端入口移到「我的凭据」 |
| 2026-10-22 | **落地 B1–B3**：见文件头的落地物清单。两处实现口径写进代码注释：① `GET /open/v1/conversations` 用"游标 → offset"换算（跨页期间新会话插到最前可能重复/漏一条，客户端按 id 去重）；② Key 快照缓存 TTL 内，"用户停用 / Agent 软删 / Agent 转移"最多晚 `OPEN_API_KEY_CACHE_TTL_SEC` 生效，**吊销走主动删缓存键、立即生效**。B4 的 spec 生成未做 |
| 2026-10-21（第二次） | **X1–X7 全部定案并落文**：① X5=共享 ⇒ **删除 `conversations.open_key_id` 方案**，开放层列表复用 `listConversationsForAgent`（结构性增量收敛为"一张新表 + `usage_records` 两列"）；② X1 ⇒ `usage_records` 加 `channel`/`open_key_id`；③ X2 ⇒ 明确"外部进不来"并删除只读凭据分支；④ X4 ⇒ 新增错误码 `NOT_OPENABLE`；⑤ X6 ⇒ `daily_token_limit`；⑥ X7 ⇒ `allow_auto_approve` 默认 true；⑦ 产物两条端点**删除**（ChatBot 不产文件），端点总数 17；⑧ 新增 §12.1 遗留三项（P1 会话来源标注 / P2 放开 TaskAgent 的补充 / P3 SDK） |
| 2026-10-22（编辑） | **元数据可编辑**（用户定案，推翻早期"改 scope = 吊销 + 新建"）：新增 `PUT /api/open-keys/:keyId`（合并语义；name / scopes / expiresAt / 限额 / 自动审批可改；**明文、`agentId`、`userId` 不可改**；已吊销 409；保存即删缓存键）。理由：Key 值只有 sha256 谈不上改，但**策略字段全是明文**——"续个期就得换掉外部系统里嵌的全部 Key"不成比例。原则 = **值不可变、策略可编辑**（与 Cloudflare/Stripe 的 token 同型）。前端新增编辑弹窗（放宽作用域需勾选确认；过期 Key 续期即重新启用）；`shared` 抽出签发/编辑共用字段校验（`updateOpenApiKeyBodySchema`）；`verify:open-api-ui` 增至 **15** 项 |
