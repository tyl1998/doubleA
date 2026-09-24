#!/usr/bin/env node
/**
 * verify-app.mjs —— **接口级验收**（不占端口、不需要真实依赖）
 *
 * 覆盖四批：
 *   · P0-1-4：信封形态 / HTTP 状态码 / Zod 校验失败字段明细 / 领域错误 / 未知异常不泄内部信息 /
 *             404 兜底 / 非法 JSON / CORS 预检 / requestId 透传 / `/health` 三项探活恒 200
 *   · P0-1-6：密文往返与**篡改检出**（GCM tag）/ 版本与 AAD 上下文 / bcrypt 形态与拒绝超长 /
 *             初始密码生成 / **未登录一律 401 且不碰会话存储**
 *   · P0-1-7：`/api/auth/*` 已注册 + 请求体 schema 的字段明细 + 首登闸门不给匿名请求增加依赖调用 /
 *             shared 认证契约的纯函数（`utf8ByteLength` 与 `Buffer.byteLength` 对照、用户名归一化）
 *   · P0-1-8：`/api/users` 已注册 + 用户管理契约（建号/改角色/分页 schema 与字段明细）
 *   · P0-1-10：`/api/model-providers` 已注册 + Provider 契约（`maskApiKey` 边界、
 *              baseUrl 归一化、**PATCH 的 apiKey 三态**、密文**绑定到记录**（AAD 换 id 即解不开）、
 *              输出形态里不存在任何 key/密文字段）
 *   · P0-1-11：`/api/models` 与 `/api/models/available` **两条路径各自独立注册**
 *              （⚠️ 同路径注册两个 GET 会在**启动期**抛 `FST_ERR_DUPLICATED_ROUTE`，
 *              这是"必须拆路径"的硬证据）+ 模型契约（型号名/别名校验、
 *              `available` 的 `type` 必填、`maxContext` 三态、两套投影的键集合互不串味）
 *   · P0-1-12：`/api/model-providers/:id/remote-models` 已注册（**子路径**，匿名 401 / 非法 UUID 400）
 *              + 上游模型列表契约（形态与取值域、键集合里不存在任何凭据名）
 *   · P0-1-15：`/api/knowledge-bases` 五条路由已注册、且**刻意没有** `/available` 子路径
 *              （本资源对全员开放，不像模型池那样需要第二套投影）+ 知识库契约
 *              （`retrieval_config` 的**逐键兜底**与越界退回默认、建库四项可省、
 *              `description` 三态、`embeddingModelChanged` 三态）
 *   · P0-1-16：`POST /api/knowledge-bases/:id/documents` 已注册（且只有这一条 —— 列表/下载/删除
 *              属后续批次，不提前注册）+ **前置校验的纯函数矩阵**（扩展名白名单 / `.doc` 专拦 /
 *              MIME 交叉校验 / **文件头魔数**：改名的假 PDF、不含 OOXML 的 zip、OLE2 改名、
 *              NUL 字节、图片）+ 文档契约（`UPLOAD_EXTENSIONS` 与 `MIME_BY_EXTENSION` 同源、
 *              `documentItemSchema` / `uploadDocumentResultSchema` 的 `deduplicated` 必填、
 *              `countChars` 按**码点**计而非 `.length`）
 *   · P0-1-17：**文档状态机的转换表**（合法转换恰好 5 条；`READY` 不得被打回 `FAILED`、也不能
 *              自转 `READY` —— 这是"过期 job 把已成功的文档写坏"的唯一防线，没有任何 HTTP 路径
 *              能验到它，只能在这一档守）。队列与 worker 的行为要真 Redis/PG/S3，归 `verify-pipeline`。
 *   · P0-1-18：**分块策略的纯函数契约**（`hybrid`/`fixed`）—— 小文档特例（全文 ≤ chunk_size
 *              恰好 1 块）、边界回退到句末（而不是硬切）、**每块都是原文的逐字子串**、
 *              重叠 64 字符、尾块合并、定长滑窗、**按码点切（不劈开代理对）**、
 *              页码 meta 取"块起点所在页"、同名标题不相邻时**顺序保持**、未知策略回落默认。
 *              分块模块不 import `config`/logger ⇒ 这一档（无依赖、可进 CI）能直接断言它；
 *              夹具（手写 PDF/DOCX 字节）也是纯生成器。行为侧（真上传 → 真解析 → 真分块）
 *              归 `verify-pipeline` 的 H 组。
 *   · P0-1-20：**检索的三条规则 + 契约** —— 全文路的 query 预处理（只剥首尾脚手架、剔标点
 *              （含 `%` / `_` 这两个 LIKE 通配符）、按码点截断 64、`< 2` 字跳过）、
 *              引用片段（±80 字符、按码点、**不加工**）、**RRF 融合公式**（两路/单路/权重 0 的
 *              数值逐项反算 + 同分确定性）。行为侧（真库 + 真 SQL + 假 embedding 上游）
 *              归 `verify-retrieval.mjs`。
 *   · P0-1-21：**文档列表 / 下载的契约** —— 两条路由注册（含"不该存在的 PATCH/GET 变体"）、
 *              列表查询 schema（coercion + 上限）、列表响应与上传响应**同一套投影**、
 *              `READY ⟺ 可检索` 的三态判据与「更新中，暂不参与检索」文案、以及
 *              **`Content-Disposition` 的 RFC 6266 双写**（中文名靠 `filename*`、EOF 回落规则、
 *              **CR/LF 头注入被剔除**、路径分隔符与引号被替换、RFC 5987 的额外转义）
 *              与**下载类型表与上传白名单不脱节**。行为侧（真 S3 取字节、流式响应、对象丢失）
 *              归 `verify-documents.mjs` 的 F/G 组。
 *   · P0-1-22：**智能体契约与路由** —— 五条路由已注册 + 三条**刻意不注册**（P0-1-23 的
 *              组件整体替换、P1 的复制、P0-1-25 的会话列表）；权限判据 `canEditAgent` 的
 *              **四个方向**（创建者 / ADMIN / 第三方 / 已软删）；`guideQuestions` 的上限与
 *              元素类型；`normalizeGuideQuestions`（读取端补默认值，永不抛错、**不截断**）；
 *              建/改 body 的**三态**与"不可改的 type"；输出投影的键集合固定（**没有 `deletedAt`**）。
 *              ⚠️ 这里刻意**不**断言任何"库里有几行"的东西：软删三件套（打标记 / 解绑组件 /
 *              会话转只读）与 403/200 这两族都要真 PG + Redis，归 `verify-agents.mjs`。
 *              权限判据是**纯函数**、且改坏了不会有任何接口报错（最坏是静默越权）⇒ 这一档
 *              是它唯一的守门处；行为侧还要靠那一档的"两个真实 MEMBER + 一个 ADMIN"。
 *   · P0-1-25：**会话契约与路由** —— 五条路由已注册 + **四条刻意不注册**（会话详情、消息分页、
 *              SSE、停止/确认）；`topic` **不是三态**（`null` 被拒）；输出投影的键集合固定
 *              （**没有 `userId`/`deletedAt`**）；以及两处"派生/判据"的守门 ——
 *              **`streaming` 只出现在响应契约里、不在 Redis 快照里**（锁与"在流"必须是同一件事）
 *              与 `parseActiveSnapshot` 的降级矩阵（断线重连路径最不能 500）。
 *              ⚠️ 这里**不**断言任何"库里有几行"的东西：四族权限的差别（**会话 = 仅本人，
 *              连 ADMIN 也不开后门**）、`last_message_at` 的排序与 CAS、级联删除的真数
 *              都要真 PG + Redis，归 `verify-conversations.mjs`。
 *   · P0-1-27：**上下文组装与并发闸的纯函数** —— 检索块（连续序号 + 「来源：文档名」前缀 +
 *              片段**逐字**不二次截断 + 零命中的明文提示）、system prompt 的三段顺序与
 *              "rules 每一轮都注入"（`01` 决策 12 在 prompt 层的那一半）、多库命中的
 *              `rrfScore desc` + `chunkId asc` tie-break 与**不设条数上限**、引用卡
 *              `score` 取**融合分**、历史的 `rounds × 2` 截断与"从 user 开始 / 丢空助手行"、
 *              落库形态（`text` 恒写而空 `thinking`/`citations` **不加键**）、以及信号量的
 *              "满 ⇒ 同步 `null`（不排队）+ `release` 幂等"。
 *              两个被测文件**不 import 任何运行期模块**（手法同 `pipeline/chunk/`）⇒ 本档直验；
 *              行为侧（真检索 + 真假上游 + SSE 出口 + 落库）归 `verify-chatbot.mjs`。
 *   · P0-1-28：**消息历史的契约与取页逻辑** —— `/messages` 已注册（**翻转 P0-1-25 留下的
 *              "刻意未注册"断言**，并补一条"消息只有读取出口"）、消息投影的键集合
 *              （不带 `tokensIn`/`conversationId`）、以及**最重要的一条**：`content` 是
 *              `z.unknown()` **原样透出**（含反向对照：写入端的 `messageContentSchema`
 *              会把 `tool_calls` 静默剥掉 ⇒ 读取端不许用它）、游标参数
 *              （`beforeId` 可选且必须是 UUID、`limit` 的默认与上下限、**没有"全量"取值**）、
 *              分页响应三件套（`items`/`nextCursor`/`hasMore`，**刻意没有 `total`**）。
 *              取页逻辑 `toMessagePage` 是**纯函数** ⇒ 一并在这里断言："多取的那一条只用来判
 *              `hasMore`"、"恰好取满 ⇒ `nextCursor:null`"、"逐页翻到底不重不漏（且拼接方向是
 *              **新页在前**）"、"同毫秒的两条不会被吞掉"、以及时间口径常量
 *              `MESSAGE_CHRONO_ORDER`（与上下文窗口**同源**）。
 *              行为侧（真 PG 上的游标 SQL 与跨页翻取）归 `verify-conversations.mjs` 的 H 组。
 *   · P0-2-2：**MCP server 的路由表与契约** —— 六条路由已注册 + 三条**刻意不注册**
 *              （`/credentials**` 属 P0-2-4；`/:id` 详情与 `PUT /:id` 本批不提供）、
 *              投影的键集合（**没有 `oauthConfig` / `toolCache`**）、
 *              `mcpServerTestResultSchema` 的**两分支互斥**（union：`{ok:true}` 缺 `tools`
 *              与 `{ok:false}` 缺 `error` 都必须被拒）、`GET /:id/tools` 的三态字段语义
 *              （`null` 与 `0` 是两件事）、以及三个纯函数族：`slugifyServerName` /
 *              `uniqueSlug`（中文回落、截断 32、**后缀不得被截掉**）、`normalizeCredentialSchema`
 *              （逐条过滤、永不抛错）、`toolCache` 的读写（**坏数据整体作废**，不是逐条过滤）。
 *              三个被测模块**都不 import 运行期模块** ⇒ 本档（无依赖、可进 CI）直接断言；
 *              行为侧（真 PG + 真假 MCP 上游 + 全员权限 + 409 守卫）归 `verify-mcp-servers.mjs`。
 *
 * 会话与认证的**行为**（Cookie 属性、限速锁定、首登闸门 403、改密）离不开真实 Redis/PG，
 * 分别由 `verify-session.mjs` / `verify-auth.mjs` 覆盖 —— 那两档要 `pnpm infra:up`。
 * Provider 的**落库形态**（`api_key_enc` 是密文、读接口不含明文、三态真地写对列）
 * 由 `verify-model-providers.mjs` 覆盖；模型的落库与守卫（含"provider 停用后模型从
 * 可选列表消失"）由 `verify-models.mjs` 覆盖；知识库的落库、快照、级联与 S3 清理
 * 由 `verify-knowledge-bases.mjs` 覆盖，三档都需要真实 PG（知识库那档不需要 Redis）。
 *
 * 为什么用 `app.inject` 而不是 curl：
 *   ① 本机端口是稀缺资源（3000/5173 都被别的项目占着，见 `06` §七 待决事项 6），
 *      inject 直接走 Fastify 内部请求生命周期，不监听、不留端口；
 *   ② CI 里不需要 docker-compose 就能验证 HTTP 层契约（依赖探活失败也是一种可断言的状态）。
 *
 * 验的是「协议契约」+「纯函数正确性」，不是「依赖可用性」——会话在真实 Redis/PG 上的
 * 完整往返（Cookie 属性、停用即失效、登出、滑动续期）在 `verify-session.mjs` 里跑，
 * 那一个**需要** `pnpm infra:up` + 已迁移的库。
 *
 * 附加探针路由（`/__verify/*`）由**本脚本自己注册**，不进源码树：
 *   产品代码里只有 `/health` 一个路由，测试用的路由不该混进去。
 *
 * 用法：
 *   pnpm verify:app                     # 本机（依赖起着 → 断言 /health 全绿）
 *   EXPECT_DEGRADED=1 pnpm verify:app   # 无依赖环境（CI）→ 断言三项探活全部降级
 */

import { z } from 'zod'

import {
  AppError,
  PASSWORD_MAX_BYTES,
  authUserSchema,
  changePasswordBodySchema,
  createModelBodySchema,
  createModelProviderBodySchema,
  createUserBodySchema,
  createKnowledgeBaseBodySchema,
  DEFAULT_RETRIEVAL_CONFIG,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_TRANSITIONS,
  DOCUMENT_PARSING_HINT,
  canTransitionDocumentStatus,
  documentItemSchema,
  documentListResultSchema,
  documentParamsSchema,
  FULLTEXT_PATH_SKIPPED_TOO_SHORT,
  FULLTEXT_QUERY_MAX_CHARS,
  FULLTEXT_QUERY_MIN_CHARS,
  isDocumentSearchable,
  LEGACY_DOC_EXTENSION,
  LEGACY_DOC_HINT,
  listDocumentsQuerySchema,
  MIME_BY_EXTENSION,
  SNIPPET_WINDOW_CHARS,
  UPLOAD_EXTENSIONS,
  UPLOAD_FILE_FIELD,
  VECTOR_PATH_SKIPPED_MODEL_CHANGED,
  VECTOR_PATH_SKIPPED_NOT_READY,
  initialPasswordResultSchema,
  knowledgeBaseItemSchema,
  knowledgeBaseListResultSchema,
  listAvailableModelsQuerySchema,
  listModelProvidersQuerySchema,
  listModelsQuerySchema,
  listUsersQuerySchema,
  loginBodySchema,
  maskApiKey,
  modelItemSchema,
  modelOptionListResultSchema,
  modelOptionSchema,
  modelProviderItemSchema,
  normalizeRetrievalConfig,
  normalizeUsername,
  offsetPageOf,
  ok,
  retrievalConfigInputSchema,
  retrievalHitSchema,
  remoteModelListResultSchema,
  REUPLOAD_UNCHANGED_HINT,
  reuploadDocumentResultSchema,
  removeDocumentResultSchema,
  retryDocumentResultSchema,
  searchKnowledgeBaseBodySchema,
  searchKnowledgeBaseResultSchema,
  SPLIT_STRATEGIES,
  // 智能体（P0-1-22 / P0-1-23）
  AGENT_TYPES,
  agentItemSchema,
  agentListResultSchema,
  canEditAgent,
  COMPONENT_TYPES,
  createAgentBodySchema,
  GUIDE_QUESTIONS_MAX,
  guideQuestionsSchema,
  normalizeGuideQuestions,
  replaceAgentComponentsBodySchema,
  updateAgentBodySchema,
  // 会话（P0-1-25）
  CONVERSATION_STATUSES,
  CONVERSATION_UNTITLED_HINT,
  conversationActiveSchema,
  conversationActiveSnapshotSchema,
  conversationIdParamsSchema,
  conversationItemSchema,
  conversationListResultSchema,
  createConversationBodySchema,
  isConversationReadOnly,
  parseActiveSnapshot,
  removeConversationResultSchema,
  renameConversationBodySchema,
  // 消息落库形态（P0-1-27 写入端 / P0-1-28 读取端）
  citationItemSchema,
  messageContentSchema,
  // 消息历史（P0-1-28）
  MESSAGE_PAGE_LIMIT_DEFAULT,
  MESSAGE_PAGE_LIMIT_MAX,
  MESSAGE_ROLES,
  cursorPageOf,
  listMessagesQuerySchema,
  messageItemSchema,
  messagePageResultSchema,
  // MCP server 注册（P0-2-2）
  CREDENTIAL_INJECT_LOCATIONS,
  MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES,
  MCP_ENDPOINT_URL_MAX,
  MCP_SERVER_NAME_MAX,
  MCP_SERVER_STATUSES,
  MCP_SLUG_FALLBACK,
  MCP_SLUG_MAX,
  createMcpServerBodySchema,
  listMcpServersQuerySchema,
  mcpServerCreateResultSchema,
  mcpServerIdParamsSchema,
  mcpServerItemSchema,
  mcpServerListResultSchema,
  mcpServerTestResultSchema,
  mcpServerToolsResultSchema,
  mcpToolDescriptorSchema,
  normalizeCredentialSchema,
  removeMcpServerResultSchema,
  slugifyServerName,
  uniqueSlug,
  updateMcpServerBodySchema,
  updateModelBodySchema,
  updateModelProviderBodySchema,
  updateKnowledgeBaseBodySchema,
  updateUserBodySchema,
  uploadDocumentResultSchema,
  userListItemSchema,
  utf8ByteLength,
} from '@doubulea/shared'
import { buildApp } from '../dist/backend/src/app.js'
import {
  BCRYPT_COST,
  DUMMY_PASSWORD_HASH,
  INITIAL_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  SecretDecryptionError,
  SecretFormatError,
  decryptSecret,
  encryptSecret,
  generateInitialPassword,
  hashPassword,
  passwordByteLength,
  verifyPassword,
} from '../dist/backend/src/infra/crypto.js'
import { closePg } from '../dist/backend/src/infra/pg.js'
import { closeRedis } from '../dist/backend/src/infra/redis.js'
import { countChars, detectFormat, parseDocument } from '../dist/backend/src/pipeline/parse/index.js'
// 分块模块刻意**不依赖 config/logger**（见其文件头）⇒ 它可以在这一档（无依赖、可进 CI）里被断言，
// 这也是本档第一条"纯函数契约必须有无依赖断言"的实践：分块的三种典型错误（劈开代理对、
// 硬切在 chunk_size、跨段乱序合并）都不会被 lint/typecheck/build 拦下，也不会让接口 400。
import {
  DEFAULT_CHUNK_MIN_CHARS,
  SENTENCE_BOUNDARY_CHARS,
  chunkStrategyNames,
  resolveChunkStrategy,
  splitIntoChunks,
} from '../dist/backend/src/pipeline/chunk/index.js'
import { providerKeyAad } from '../dist/backend/src/services/model.service.js'
// 文档列表 / 下载的两条规则（`Content-Disposition` 的构造、下载类型的口径表）也是**纯函数**
// ⇒ 同样在这一档断言：它们错了不会被 lint/typecheck/build 拦下，症状是"下载下来名字乱码"
// 或者更糟 —— 头注入（P0-1-21）。
import {
  buildContentDisposition,
  downloadContentType,
} from '../dist/backend/src/services/document.service.js'
// 检索的**规则本身**（query 预处理 / 引用窗口 / RRF 融合公式）是纯函数 ⇒ 在这一档就能断言。
// 它们的错误不会被 lint/typecheck/build 拦下、也不会让接口 400，症状是"结果不对但界面正常"
// （命中少几条、片段截错位置、融合排名看着随机）—— 与 P0-1-18 把分块做成纯函数是同一条理由。
// 行为侧（真库 + 真 SQL）归 `verify-retrieval.mjs`。
import {
  buildSnippet,
  fuseRrf,
  normalizeFulltextQuery,
  rrfScoreOf,
} from '../dist/backend/src/services/retrieval.js'
// 上下文组装与并发闸（P0-1-27）—— 两个文件**刻意不 import 任何运行期模块**
// （不碰 `config`/`prisma`/日志，手法同 `pipeline/chunk/`）⇒ 这一档（无依赖、可进 CI）能直接断言。
// 理由与 P0-1-18 把分块做成纯函数一样：它们的错**没有 HTTP 表现**（流照常 200 结束），
// 症状是"模型开始编造来源""多轮对话答非所问""闸门悄悄失效"。
// 行为侧（真 PG + 真 Redis + 假上游 + 真 TCP）归 `verify-chatbot.mjs`。
import {
  DEFAULT_SYSTEM_PROMPT,
  RETRIEVAL_BLOCK_TITLE,
  RETRIEVAL_EMPTY_HINT,
  RETRIEVAL_RULES,
  buildAssistantContent,
  buildSystemPrompt,
  formatRetrievalBlock,
  mergeRetrievalHits,
  selectHistoryMessages,
  textOfHistoryRow,
  toCitationItems,
} from '../dist/backend/src/orchestrator/chatContext.js'
import { createSemaphore } from '../dist/backend/src/orchestrator/semaphore.js'
// 消息历史（P0-1-28）的**取页逻辑**是纯函数（多取一条判 hasMore、反转成正序、
// nextCursor 指向本页最旧）⇒ 与 `pipeline/chunk/`、`chatContext.ts` 同款：这一档直接断言。
// "不重不漏"这条验收的**全部**正确性就在这几行里，而它在真库上只表现为"某次翻页少/多一条"
// —— 一个 SQL 写对的实现配一个错的取页逻辑，照样能顺利跑完。行为侧归 `verify-conversations` 的 H 组。
import { MESSAGE_CHRONO_ORDER, toMessagePage } from '../dist/backend/src/services/conversation.service.js'
// `tool_cache` 的读写（P0-2-2）同样**刻意不 import 任何运行期模块**
// （不碰 config/prisma/日志/SDK）⇒ 这一档能直接断言"库里塞了半截数据时三处读端给出同一种降级"。
// 它的错没有任何 HTTP 表现：`toolCount` 会比真实值小一点，而界面上看不出来。
import { buildToolCache, parseToolCache, toolCountOf } from '../dist/backend/src/mcp/toolCache.js'
// 夹具是纯 JS 生成器（手写 PDF/DOCX/ZIP 字节），不引依赖、不读外部文件 ⇒ 仍然满足本档"无依赖"
import * as fixtures from './fixtures/documents.mjs'

const useColor = process.stdout.isTTY === true
const c = {
  g: useColor ? '\u001b[32m' : '',
  r: useColor ? '\u001b[31m' : '',
  d: useColor ? '\u001b[90m' : '',
  b: useColor ? '\u001b[1m' : '',
  x: useColor ? '\u001b[0m' : '',
}

let passed = 0
let failed = 0

/** 单条断言 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

/** 字符串包含（P0-1-20 起在别处脚本里也有同名助手，保持一致以免看错方向） */
function assertIncludes(haystack, needle, label) {
  assert(
    typeof haystack === 'string' && haystack.includes(needle),
    `${label}：应含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`,
  )
}

/** 浮点近似（RRF 的分子分母都是整数，容差只为吃掉 JS 数字的表示误差） */
function assertClose(actual, expected, label, epsilon = 1e-12) {
  assert(
    typeof actual === 'number' && Math.abs(actual - expected) <= epsilon,
    `${label}：期望 ≈ ${expected}，实际 ${actual}`,
  )
}

/**
 * 集合类比较**两侧先排序再比**（`06` P0-1-17 的教训：别把"书写顺序"也当成契约）。
 * P0-1-25 起本档也要比键集合，故补上（与其余几个验收脚本同名同义）。
 */
function assertSameSet(actual, expected, label) {
  const a = [...actual].sort()
  const b = [...expected].sort()
  assert(JSON.stringify(a) === JSON.stringify(b), `${label}：期望集合 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}

/**
 * 对象比较：**按排序后的键**逐字段比（对象键序不是契约 —— `JSON.stringify` 两个对象会把
 * "键的书写顺序"也判成不一致，那是最难分辨的一类假失败：输出里两者"看着一样"）。
 */
function assertSameObject(actual, expected, label) {
  const norm = (value) =>
    JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    )
  assert(norm(actual) === norm(expected), `${label}：期望 ${norm(expected)}，实际 ${norm(actual)}`)
}

/** 跑一条用例：失败不中断（一次跑完，把问题看全） */
async function it(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ${c.g}[PASS]${c.x} ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ${c.r}[FAIL]${c.x} ${name}`)
    console.log(`         ${c.r}${error instanceof Error ? error.message : String(error)}${c.x}`)
  }
}

const expectDegraded = process.env.EXPECT_DEGRADED === '1'

console.log(`\n${c.b}══ 接口级验收：信封 / /health / 密码与会话 / 认证 / 用户管理 / 模型池 / 知识库 / 智能体 ══${c.x}`)
console.log(`  ${c.d}模式：${expectDegraded ? '依赖全部不可达（断言 degraded）' : '本机依赖（断言 /health 全绿）'}${c.x}`)

const app = buildApp()

// ── 探针路由：只在本脚本里注册，用来把错误处理的每条分支都真跑一遍 ──
app.post(
  '/__verify/echo',
  {
    schema: {
      body: z.object({ name: z.string().min(2), age: z.coerce.number().int().min(0) }),
      querystring: z.object({ page: z.coerce.number().int().min(1).default(1) }),
    },
  },
  async (request) => ok({ body: request.body, query: request.query }),
)
// 极小的 bodyLimit：用来验证「请求体过大」（413）也被翻译成信封
app.post(
  '/__verify/tiny',
  { bodyLimit: 32, schema: { body: z.object({ note: z.string() }) } },
  async (request) => ok(request.body),
)
app.get('/__verify/conflict', () => {
  throw AppError.conflict('该会话正在生成回答', { position: 2 })
})
app.get('/__verify/boom', () => {
  // 故意夹带「内部细节」：验证它**不会**出现在响应体里（`02` §十）
  throw new Error('内部细节：secret-token-abc / password=hunter2')
})
// 会话探针（P0-1-6）：`requireAuth` 的实现里，「无 Cookie」这一条**不碰 Redis**，
// 因此它在有/无依赖两种环境下都应当稳定返回 401 —— 这正是下面要断言的。
app.get('/__verify/protected', { preHandler: app.requireAuth }, async (request) =>
  ok({ userId: request.auth?.user.id, role: request.auth?.user.role }),
)
app.get('/__verify/admin-only', { preHandler: app.requireAdmin }, async () => ok({ scope: 'admin' }))
// 首登闸门（P0-1-7）的探针：一个 `/api/**` 下的**公共**路由（不挂任何鉴权钩子）。
// 用来验「闸门不会给匿名请求增加依赖调用」—— 没有 Cookie 时闸门必须直接放行，
// 否则依赖不可达的 CI 里这条会变成 500（而它本该是 200）。
app.get('/api/__verify/open', async () => ok({ open: true }))

await app.ready()

// ── 1. /health ──
await it('/health 返回 200 + 信封 + 三项依赖状态', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' })
  assertEqual(response.statusCode, 200, 'HTTP 状态码（依赖不可用也必须是 200，不是 500）')
  const body = response.json()
  assertEqual(body.code, 0, '信封 code')
  assertEqual(body.data.service, 'doubulea-backend', 'service')
  assertEqual(body.data.checks.map((check) => check.target).join(','), 'postgres,redis,s3', '探活顺序')
  for (const check of body.data.checks) {
    assert(typeof check.latencyMs === 'number' && check.latencyMs >= 0, `${check.target}.latencyMs 应为非负数字`)
    assert(typeof check.detail === 'string' && check.detail !== '', `${check.target}.detail 不应为空`)
  }
  const allOk = body.data.checks.every((check) => check.ok)
  assertEqual(body.data.status, allOk ? 'ok' : 'degraded', 'status 与各项探活结论一致')
  assert(typeof body.data.timeoutMs === 'number', 'timeoutMs 应回显，便于对照「超时」类原因')
  console.log(`         ${c.d}${JSON.stringify(body.data.checks.map((x) => `${x.target}=${x.ok ? 'ok' : x.detail}`))}${c.x}`)
})

if (expectDegraded) {
  await it('/health 在依赖不可达时**逐项**报出原因（而非整体报错）', async () => {
    const body = (await app.inject({ method: 'GET', url: '/health' })).json()
    assertEqual(body.data.status, 'degraded', 'status')
    for (const check of body.data.checks) {
      assertEqual(check.ok, false, `${check.target} 应判为不可用`)
      assertEqual(check.detail.includes('超时'), false, `${check.target} 应立即失败（连接被拒），不应走到超时兜底`)
    }
  })
}

// ── 2. Zod 校验失败 → VALIDATION 信封 + 字段明细 ──
await it('Zod 校验失败 → 400 / VALIDATION / body 字段级 path（多条一次报全）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    payload: { name: 'x', age: 'not-a-number' },
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  const paths = body.data.fields.map((field) => field.path)
  assert(paths.includes('body.name'), `应报出 body.name，实际 ${JSON.stringify(paths)}`)
  assert(paths.includes('body.age'), `应报出 body.age，实际 ${JSON.stringify(paths)}`)
})

await it('querystring 校验失败同样带部位前缀（body 合法时才轮到它）', async () => {
  // ⚠️ Fastify 按 params → body → querystring 顺序校验，**任一处失败即短路**，
  //    所以必须给合法 body 才能验到 querystring 这一路
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo?page=0',
    payload: { name: 'ab', age: 3 },
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  const paths = response.json().data.fields.map((field) => field.path)
  assert(paths.includes('querystring.page'), `应报出 querystring.page，实际 ${JSON.stringify(paths)}`)
})

await it('校验通过时 coerce/transform 的产物对 handler 可见', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    payload: { name: 'ab', age: '30' },
  })
  assertEqual(response.statusCode, 200, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.data.body.age, 30, 'body.age 应已被 z.coerce 转成数字')
  assertEqual(body.data.query.page, 1, 'querystring.page 应取到默认值 1')
})

// ── 3. 领域错误原样带出 ──
await it('领域错误（AppError）→ 409 / CONFLICT / msg + data 原样', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/conflict' })
  assertEqual(response.statusCode, 409, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'CONFLICT', '信封 code')
  assertEqual(body.msg, '该会话正在生成回答', 'msg 应是领域错误自带的中文文案')
  assertEqual(body.data.position, 2, 'data 应带出附加信息')
})

// ── 4. 未知异常：500 + 通用文案，不泄内部信息 ──
await it('未知异常 → 500 / INTERNAL，且**不回显**原始 message', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/boom' })
  assertEqual(response.statusCode, 500, 'HTTP 状态码')
  const raw = response.body
  assert(raw.includes('secret-token-abc') === false, '原始错误信息泄露到响应体（`02` §十 不允许）')
  assert(raw.includes('hunter2') === false, '密码片段泄露到响应体')
  const body = JSON.parse(raw)
  assertEqual(body.code, 'INTERNAL', '信封 code')
  assertEqual(body.msg, '服务内部错误', 'msg 应为通用文案')
})

// ── 5. 404 兜底 ──
await it('未注册路由 → 404 / NOT_FOUND（不是 Fastify 默认结构）', async () => {
  const response = await app.inject({ method: 'GET', url: '/__verify/nope' })
  assertEqual(response.statusCode, 404, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'NOT_FOUND', '信封 code')
  assert(typeof body.msg === 'string' && body.msg !== '', 'msg 不应为空')
})

// ── 6. 请求体形态错误 ──
await it('非法 JSON → 400 / VALIDATION（框架错误被翻译成信封）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{ not json',
  })
  assertEqual(response.statusCode, 400, 'HTTP 状态码')
  assertEqual(response.json().code, 'VALIDATION', '信封 code')
})

await it('不支持的 Content-Type → 415 / VALIDATION（状态码保持 415 不被压成 400）', async () => {
  // ⚠️ Fastify 默认自带 application/json 与 text/plain 两个 parser，
  //    要触发 415 得用一个它没注册的类型
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/echo',
    headers: { 'content-type': 'application/xml' },
    payload: '<name>ab</name>',
  })
  assertEqual(response.statusCode, 415, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  assert(body.msg.includes('Content-Type'), `msg 应说清是 Content-Type 的问题，实际：${body.msg}`)
})

await it('请求体超限 → 413 / VALIDATION（上限信息保留在状态码上）', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__verify/tiny',
    payload: { note: 'x'.repeat(200) },
  })
  assertEqual(response.statusCode, 413, 'HTTP 状态码')
  const body = response.json()
  assertEqual(body.code, 'VALIDATION', '信封 code')
  assert(body.msg.length > 0, 'msg 不应为空')
})

// ── 7. CORS 预检 ──
await it('CORS 预检 → 回显来源且允许携带凭据', async () => {
  const origin = 'http://localhost:5174'
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/health',
    headers: { origin, 'access-control-request-method': 'GET' },
  })
  assertEqual(response.statusCode, 204, '预检状态码')
  assertEqual(response.headers['access-control-allow-origin'], origin, 'allow-origin 应回显配置的来源')
  assertEqual(response.headers['access-control-allow-credentials'], 'true', '必须允许携带 Cookie')
})

// ── 8. requestId 贯穿 ──
await it('requestId：上游 x-request-id 透传 + 响应头回带', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { 'x-request-id': 'verify-rid-123' },
  })
  assertEqual(response.headers['x-request-id'], 'verify-rid-123', '响应头应回带同一个 requestId')

  const generated = await app.inject({ method: 'GET', url: '/health' })
  assert(
    typeof generated.headers['x-request-id'] === 'string' && generated.headers['x-request-id'].length > 0,
    '未提供 x-request-id 时应自动生成',
  )
})

// ── 9. 密文加解密（P0-1-6）：往返 / 篡改检出 / 版本 / AAD ──
const SAMPLE = 'sk-live-这是一个带中文与 emoji 🔐 的密钥-0O1lI'

await it('AES-256-GCM 往返一致（含中文/emoji/空串），且密文形态为 v1.<iv>.<tag>.<ct>', async () => {
  const encrypted = encryptSecret(SAMPLE)
  assertEqual(decryptSecret(encrypted), SAMPLE, '解密结果')
  const parts = encrypted.split('.')
  assertEqual(parts.length, 4, '密文段数')
  assertEqual(parts[0], 'v1', '版本前缀')
  assertEqual(decryptSecret(encryptSecret('')), '', '空串也应能往返')
  console.log(`         ${c.d}${encrypted.slice(0, 46)}…（${encrypted.length} 字符）${c.x}`)
})

await it('同一明文两次加密得到**不同**密文（IV 随机），且明文不出现在密文里', async () => {
  const a = encryptSecret(SAMPLE)
  const b = encryptSecret(SAMPLE)
  assert(a !== b, '两次加密结果相同 —— IV 没有随机化')
  assertEqual(decryptSecret(a), SAMPLE, 'a 解密')
  assertEqual(decryptSecret(b), SAMPLE, 'b 解密')
  assert(a.includes('sk-live') === false && b.includes('sk-live') === false, '密文里出现了明文片段')
})

await it('篡改密文 / 认证标签 → SecretDecryptionError（GCM tag 校验生效）', async () => {
  const parts = encryptSecret(SAMPLE).split('.')
  for (const index of [2, 3]) {
    const tampered = [...parts]
    const segment = tampered[index]
    // 改一个字符（首字符换掉）即可让 tag 校验失败
    tampered[index] = (segment[0] === 'A' ? 'B' : 'A') + segment.slice(1)
    let thrown
    try {
      decryptSecret(tampered.join('.'))
    } catch (error) {
      thrown = error
    }
    assert(thrown !== undefined, `篡改第 ${index} 段后仍然解密成功 —— 篡改未被检出`)
    assert(
      thrown instanceof SecretDecryptionError,
      `篡改第 ${index} 段应抛 SecretDecryptionError，实际 ${thrown?.name}：${thrown?.message}`,
    )
  }
})

await it('IV 被替换成另一个合法 IV → 解密失败（不会解出错误明文）', async () => {
  const a = encryptSecret(SAMPLE).split('.')
  const b = encryptSecret(SAMPLE).split('.')
  a[1] = b[1]
  let thrown
  try {
    decryptSecret(a.join('.'))
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof SecretDecryptionError, `应抛 SecretDecryptionError，实际 ${thrown?.name}`)
})

await it('AAD 上下文：同值可解、错值被拒、缺省不匹配', async () => {
  const bound = encryptSecret(SAMPLE, 'provider:abc')
  assertEqual(decryptSecret(bound, 'provider:abc'), SAMPLE, '同一上下文应能解密')
  for (const [label, context] of [
    ['换了上下文', 'provider:def'],
    ['不传上下文', undefined],
  ]) {
    let thrown
    try {
      decryptSecret(bound, context)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof SecretDecryptionError, `${label} 时应解密失败，实际 ${thrown?.name}`)
  }
  // 反向：不带上下文加密的密文，带上下文也解不开
  let thrown
  try {
    decryptSecret(encryptSecret(SAMPLE), 'provider:abc')
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof SecretDecryptionError, `带上下文解无上下文密文应失败，实际 ${thrown?.name}`)
})

await it('密文串结构非法 → SecretFormatError（版本未知 / 段数不对 / 编码非法）', async () => {
  const bytes32 = Buffer.alloc(32).toString('base64url')
  const bytes16 = Buffer.alloc(16).toString('base64url')
  const cases = [
    ['未知版本', `v9.${bytes32}.${bytes16}.`],
    ['段数不足', `v1.${bytes32}.${bytes16}`],
    ['IV 长度不对', `v1.${Buffer.alloc(8).toString('base64url')}.${bytes16}.`],
    ['标签长度不对', `v1.${bytes32}.${bytes16}.`],
  ]
  for (const [label, payload] of cases) {
    let thrown
    try {
      decryptSecret(payload)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof SecretFormatError, `${label} 应抛 SecretFormatError，实际 ${thrown?.name}`)
  }
})

// ── 10. 密码哈希（P0-1-6）：bcrypt 形态 / 校验 / 拒绝超长 ──
await it(`bcrypt 摘要形态正确（$2b$${BCRYPT_COST}$… / 60 字符）且能校验正确与错误密码`, async () => {
  const hash = await hashPassword('Passw0rd-中文-🔐')
  assert(hash.startsWith(`$2b$${BCRYPT_COST}$`), `摘要前缀应为 $2b$${BCRYPT_COST}$，实际 ${hash.slice(0, 7)}`)
  assertEqual(hash.length, 60, '摘要长度')
  assertEqual(await verifyPassword('Passw0rd-中文-🔐', hash), true, '正确密码')
  assertEqual(await verifyPassword('Passw0rd-中文-🔐x', hash), false, '错误密码')
  const again = await hashPassword('Passw0rd-中文-🔐')
  assert(again !== hash, '同一密码两次哈希结果相同 —— salt 没随机化')
})

await it('超长密码（>72 字节）被**显式拒绝**，不做静默截断', async () => {
  const long = `${'a'.repeat(MAX_PASSWORD_BYTES)}中文` // 72 字节 + 6 字节
  assert(passwordByteLength(long) > MAX_PASSWORD_BYTES, '构造的样本应当超长')
  let thrown
  try {
    await hashPassword(long)
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof RangeError, `应抛 RangeError，实际 ${thrown?.name}`)
  assert(thrown.message.includes('72'), `报错应点明 72 字节上限，实际：${thrown.message}`)
  // 恰好 72 字节（多字节字符按字节算）应当放行 —— 边界不能"少一个也算超"
  const exact = '中'.repeat(24) // 24 × 3 = 72 字节
  assertEqual(passwordByteLength(exact), MAX_PASSWORD_BYTES, '样本字节数')
  assert((await hashPassword(exact)).length === 60, '恰好在上限的密码应可哈希')
})

await it('DUMMY_PASSWORD_HASH 是**结构合法**的摘要（等时比较的前提），且恒不匹配', async () => {
  // ⚠️ 实测：bcrypt 对结构非法的摘要 compare 会立刻返回 false（0ms）—— 那样就起不到等时作用
  assert(DUMMY_PASSWORD_HASH.startsWith(`$2b$${BCRYPT_COST}$`), '必须是 cost 12 的合法摘要')
  assertEqual(DUMMY_PASSWORD_HASH.length, 60, '摘要长度')
  assertEqual(await verifyPassword('', DUMMY_PASSWORD_HASH), false, '空密码不应匹配')
  assertEqual(await verifyPassword(DUMMY_PASSWORD_HASH, DUMMY_PASSWORD_HASH), false, '摘要自身不应匹配')
})

await it('摘要本身损坏时 verifyPassword 返回 false（不抛错，避免把脏数据包装成 500）', async () => {
  assertEqual(await verifyPassword('whatever', 'not-a-bcrypt-hash'), false, '非法摘要')
  assertEqual(await verifyPassword('whatever', ''), false, '空摘要')
})

// ── 11. 初始密码生成（P0-1-6；P0-1-8 建号用） ──
await it('初始密码：长度 / 无易混字符 / 三类字符齐备 / 每次不同', async () => {
  const samples = Array.from({ length: 30 }, () => generateInitialPassword())
  for (const password of samples) {
    assertEqual(password.length, INITIAL_PASSWORD_LENGTH, '长度')
    assert(/^[A-Za-z0-9]+$/.test(password), `应只含字母数字，实际 ${password}`)
    assert(/[0O1lI]/.test(password) === false, `不应含易混字符 0/O/1/l/I，实际 ${password}`)
    assert(/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password), `三类字符应齐备：${password}`)
  }
  assertEqual(new Set(samples).size, samples.length, '30 次生成应当互不相同')
  assertEqual(generateInitialPassword(8).length, 8, '显式长度参数应生效')
})

// ── 12. 会话的「未登录」出口（P0-1-6）：不碰依赖也必须稳定拒绝 ──
await it('未登录访问受保护路由 → 401 / UNAUTHORIZED（且**不依赖 Redis 可达**）', async () => {
  for (const url of ['/__verify/protected', '/__verify/admin-only']) {
    const response = await app.inject({ method: 'GET', url })
    assertEqual(response.statusCode, 401, `${url} 状态码`)
    const body = response.json()
    assertEqual(body.code, 'UNAUTHORIZED', `${url} 信封 code`)
    assert(typeof body.msg === 'string' && body.msg !== '', `${url} msg 不应为空`)
    // 无 Cookie 时**不该**去查会话存储：所以依赖不可达的环境（CI）里这条也必须是 401 而不是 500
  }
})

await it('伪造/过期会话 Cookie → 拒绝且**绝不放行**（有依赖时 401，依赖不可达时 500）', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/__verify/protected',
    headers: { cookie: 'doubulea_sid=not-a-real-session-token' },
  })
  assert(response.statusCode !== 200, '伪造的会话令牌竟然通过了鉴权')
  if (expectDegraded) {
    // 会话存储不可用 → 失败关闭（fail-closed）：语义是"服务端此刻给不出结论"，
    // 不是"你的凭据不对"，故 500 而非 401（`plugins/session.ts` 文件头「②」）。
    assertEqual(response.statusCode, 500, '依赖不可达时状态码')
    assertEqual(response.json().code, 'INTERNAL', '依赖不可达时信封 code')
  } else {
    assertEqual(response.statusCode, 401, 'Redis 可达但会话不存在时状态码')
    assertEqual(response.json().code, 'UNAUTHORIZED', '信封 code')
  }
})

// ── 13. 认证契约（P0-1-7）：路由已注册 + schema 生效 + 纯函数正确性 ──
await it('/api/auth/* 四个端点已注册（不再是 404 兜底），且请求体校验给出字段明细', async () => {
  const missing = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })
  assertEqual(missing.statusCode, 400, '空 body 的状态码')
  const fields = missing.json().data.fields.map((field) => field.path)
  assert(fields.includes('body.username'), `应报出 body.username，实际 ${JSON.stringify(fields)}`)
  assert(fields.includes('body.password'), `应报出 body.password，实际 ${JSON.stringify(fields)}`)

  // 未登录的四个端点行为（都不需要数据库，因此在 CI 里也可断言）
  const me = await app.inject({ method: 'GET', url: '/api/auth/me' })
  assertEqual(me.statusCode, 401, '/api/auth/me 未登录状态码')
  const change = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    payload: { oldPassword: 'x'.repeat(9), newPassword: 'y'.repeat(9) },
  })
  assertEqual(change.statusCode, 401, '/api/auth/password 未登录状态码')
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout' })
  assertEqual(logout.statusCode, 200, '/api/auth/logout 幂等状态码')
})

await it('首登闸门不给**匿名**请求增加依赖调用：/api/** 的公共路由在无 Cookie 时仍是 200', async () => {
  // 闸门若在无 Cookie 时也去查 Redis，依赖不可达的环境（CI）里这里会是 500。
  // 两种模式下都断言 200，等于把「匿名请求不碰会话存储」钉死。
  const response = await app.inject({ method: 'GET', url: '/api/__verify/open' })
  assertEqual(response.statusCode, 200, '状态码')
  assertEqual(response.json().data.open, true, '响应体')
})

await it('shared 的 utf8ByteLength 与 Buffer.byteLength 完全一致（前端要靠它算字节数）', async () => {
  const samples = ['', 'abc', '中文测试', '🔐🔐', 'a中🙂z', '中'.repeat(24), 'ünïcödé', '\u0000\u007f\u0080\u0800\uffff']
  for (const sample of samples) {
    const expected = Buffer.byteLength(sample, 'utf8')
    assertEqual(utf8ByteLength(sample), expected, `utf8ByteLength(${JSON.stringify(sample)})`)
  }
  assertEqual(utf8ByteLength('中'.repeat(24)), PASSWORD_MAX_BYTES, '24 个汉字应恰好等于 bcrypt 的 72 字节上限')
})

await it('normalizeUsername：去首尾空白 + 转小写（建号与登录必须共用同一口径）', async () => {
  assertEqual(normalizeUsername('  Alice  '), 'alice', '带空白与大写')
  assertEqual(normalizeUsername('admin'), 'admin', '已归一化的值不变')
  assertEqual(normalizeUsername('ADMIN@EXAMPLE'), 'admin@example', '含符号')
})

await it('登录/改密 schema：拒绝空值、过短、超字节数；接受合法输入', async () => {
  const badLogins = [
    ['空用户名', { username: '', password: 'x' }],
    ['空白用户名', { username: '   ', password: 'x' }],
    ['空密码', { username: 'a', password: '' }],
    ['缺字段', { username: 'a' }],
  ]
  for (const [label, payload] of badLogins) {
    assertEqual(loginBodySchema.safeParse(payload).success, false, `登录应拒绝：${label}`)
  }
  assertEqual(loginBodySchema.safeParse({ username: ' a ', password: 'p' }).success, true, '合法登录应通过')

  assertEqual(
    changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: 'short1' }).success,
    false,
    '改密应拒绝过短的新密码',
  )
  const tooLongBytes = '中'.repeat(25) // 75 字节
  assertEqual(
    changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: tooLongBytes }).success,
    false,
    '改密应拒绝超过 72 字节的新密码',
  )
  const result = changePasswordBodySchema.safeParse({ oldPassword: 'old-pass-1', newPassword: 'new-pass-1' })
  assertEqual(result.success, true, '合法改密应通过')

  // authUserSchema 是前后端共用的响应形态：能被解析才算契约一致
  const user = { id: 'x', username: 'a', nickname: null, role: 'ADMIN', mustChangePassword: false }
  assertEqual(authUserSchema.safeParse(user).success, true, 'authUserSchema 应接受典型响应体')
  assertEqual(authUserSchema.safeParse({ ...user, nickname: 1 }).success, false, 'authUserSchema 应拒绝非法 nickname')
})

// ── 14. 用户管理契约（P0-1-8）：路由已注册 + schema 生效 + 纯函数 ──
await it('/api/users 四个路由已注册：未登录一律 401（不碰数据库），非法参数 400 而不是 404', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/users' })
  assertEqual(anonymous.statusCode, 401, '列表未登录状态码')
  const missingId = await app.inject({
    method: 'PATCH',
    url: '/api/users/00000000-0000-7000-8000-000000000000',
    payload: { status: 'ACTIVE' },
  })
  assertEqual(missingId.statusCode, 401, 'PATCH 未登录状态码（说明路由存在、只是没登录）')
  const reset = await app.inject({
    method: 'POST',
    url: '/api/users/00000000-0000-7000-8000-000000000000/reset-password',
  })
  assertEqual(reset.statusCode, 401, '重置密码未登录状态码')
})

await it('用户管理请求体/路径参数校验：字段明细齐备（校验先于鉴权，故匿名下也能断言）', async () => {
  const emptyCreate = await app.inject({ method: 'POST', url: '/api/users', payload: {} })
  assertEqual(emptyCreate.statusCode, 400, '建号空 body 状态码')
  assert(
    emptyCreate.json().data.fields.some((field) => field.path === 'body.username'),
    '建号空 body 应报 body.username',
  )

  const emptyPatch = await app.inject({
    method: 'PATCH',
    url: '/api/users/00000000-0000-7000-8000-000000000000',
    payload: {},
  })
  assertEqual(emptyPatch.statusCode, 400, 'PATCH 空 body 状态码')

  const badUuid = await app.inject({
    method: 'PATCH',
    url: '/api/users/not-a-uuid',
    payload: { status: 'DISABLED' },
  })
  assertEqual(badUuid.statusCode, 400, '非法 uuid 状态码')
  assert(
    badUuid.json().data.fields.some((field) => field.path === 'params.id'),
    '应报 params.id',
  )

  const badEnum = await app.inject({
    method: 'PATCH',
    url: '/api/users/00000000-0000-7000-8000-000000000000',
    payload: { status: 'SUSPENDED' },
  })
  assertEqual(badEnum.statusCode, 400, '非法枚举状态码')
  assert(
    badEnum.json().data.fields.some((field) => field.path === 'body.status'),
    '应报 body.status',
  )
})

await it('shared 用户管理契约：建号/改角色/分页 schema 与列表响应形态', async () => {
  // 建号：用户名不能含空白（会抄错）、nickname 空串按"没填"处理、role 可缺省
  assertEqual(createUserBodySchema.safeParse({ username: 'a b' }).success, false, '含空格的用户名应被拒')
  assertEqual(createUserBodySchema.safeParse({ username: '   ' }).success, false, '纯空白应被拒')
  const created = createUserBodySchema.safeParse({ username: '  Alice  ', nickname: '' })
  assertEqual(created.success, true, '合法建号应通过')
  assertEqual(created.data?.username, 'Alice', 'trim 后保留原样（归一化在服务层做）')
  assertEqual(created.data?.nickname, undefined, '空串 nickname 应被视为未填')

  // 改角色：至少要给一个字段
  assertEqual(updateUserBodySchema.safeParse({}).success, false, '空 body 应被拒')
  assertEqual(updateUserBodySchema.safeParse({ status: 'DISABLED' }).success, true, '只给 status 应通过')
  assertEqual(updateUserBodySchema.safeParse({ role: 'OWNER' }).success, false, '非法 role 应被拒')

  // 分页：coerce + 默认值 + 上限
  const query = listUsersQuerySchema.parse({})
  assertEqual(query.offset, 0, 'offset 默认值')
  assertEqual(query.limit, 20, 'limit 默认值')
  assertEqual(listUsersQuerySchema.safeParse({ limit: '999' }).success, false, 'limit 超上限应被拒')
  assertEqual(listUsersQuerySchema.parse({ limit: '5' }).limit, 5, 'limit 应被 coerce')

  // 响应形态：三个 schema 能解析同构数据
  const item = {
    id: 'x',
    username: 'a',
    nickname: null,
    role: 'ADMIN',
    status: 'ACTIVE',
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
  }
  assertEqual(userListItemSchema.safeParse(item).success, true, 'userListItemSchema')
  assertEqual(
    initialPasswordResultSchema.safeParse({ user: item, initialPassword: 'Abc123456789012345' }).success,
    true,
    'initialPasswordResultSchema',
  )
  assertEqual(
    offsetPageOf(userListItemSchema).safeParse({ items: [item], total: 1, offset: 0, limit: 20 }).success,
    true,
    '列表分页 schema',
  )
})

// ── 15. 模型池 Provider 契约（P0-1-10）──
await it('maskApiKey：长 key 给「前3+****+后4」、短 key 只露尾巴、极短直接全遮', () => {
  assertEqual(maskApiKey('sk-1234567890abcdef'), 'sk-****cdef', '19 字符 → 前3+****+后4')
  assertEqual(maskApiKey('a'.repeat(16)), 'aaa****aaaa', '恰好 16 字符是临界点（含）')
  assertEqual(maskApiKey('abcdefgh'), '****efgh', '8 字符 → 只露尾巴')
  assertEqual(maskApiKey('abcdefg'), '****', '7 字符 → 全遮')
  assertEqual(maskApiKey(''), '****', '空串 → 全遮（不报错）')

  // 关键性质：中间段**一个字都不能露** —— 掩码的用途是"认出是哪把 key"，不是"拼回去"。
  // ⚠️ 只比对**字母数字**：key 里常带 `-`/`_` 这类分隔符，它们本来就会出现在首/尾里，
  //    拿"字符集不相交"去断言会误报（第一版就这么写成假失败了）。
  const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const masked = maskApiKey(key)
  const alnum = (text) => text.replace(/[^A-Za-z0-9]/g, '')
  const hiddenMiddle = alnum(key.slice(3, key.length - 4))
  assert(masked.length < key.length / 2, `掩码应显著短于原文：${masked.length} vs ${key.length}`)
  assert(
    [...new Set(hiddenMiddle)].every((ch) => !masked.includes(ch)),
    `掩码不得含中间段的任何字母数字，实际 ${masked}（中间段 ${hiddenMiddle}）`,
  )
  assert(!masked.includes(alnum(key).slice(5, 20)), '掩码不得含中间段的连续片段')
})

await it('Provider 路由已注册且仅 ADMIN：未登录 401；非法参数 400（校验先于鉴权，故匿名下可断言）', async () => {
  // 已注册：不再走 404 兜底 —— 若无 Cookie 得到 401 而不是 404，即证明路由存在
  const list = await app.inject({ method: 'GET', url: '/api/model-providers' })
  assertEqual(list.statusCode, 401, '未登录访问列表')
  assertEqual(list.json().code, 'UNAUTHORIZED', '列表错误码')

  // 校验先于 preHandler：所以匿名 + 非法 body 得到的是 400（带字段明细）而不是 401
  const badBody = await app.inject({
    method: 'POST',
    url: '/api/model-providers',
    payload: { name: '', baseUrl: 'not-a-url', type: 'RERANK' },
  })
  assertEqual(badBody.statusCode, 400, '非法 body 状态码')
  const fields = badBody.json().data?.fields ?? []
  const paths = fields.map((field) => field.path)
  assert(paths.includes('body.name'), `应报 body.name，实际 ${JSON.stringify(paths)}`)
  assert(paths.includes('body.baseUrl'), `应报 body.baseUrl，实际 ${JSON.stringify(paths)}`)
  assert(paths.includes('body.type'), `应报 body.type，实际 ${JSON.stringify(paths)}`)

  const badId = await app.inject({ method: 'DELETE', url: '/api/model-providers/not-a-uuid' })
  assertEqual(badId.statusCode, 400, '非法 UUID 状态码')
  assert(
    JSON.stringify(badId.json().data?.fields ?? []).includes('params.id'),
    '应报 params.id',
  )
})

await it('shared Provider 契约：baseUrl 归一化 / 空 apiKey 被拒 / PATCH 三态保住 undefined 与 null', () => {
  // baseUrl：尾斜杠归一化（将来拼 /chat/completions 不能出现 //）、必须 http(s)、必须是真 URL
  const trimmed = createModelProviderBodySchema.safeParse({
    name: 'x',
    baseUrl: 'https://api.openai.com/v1///',
    type: 'CHAT',
  })
  assertEqual(trimmed.success, true, '合法地址应通过')
  assertEqual(trimmed.data?.baseUrl, 'https://api.openai.com/v1', '尾部斜杠应被去掉')
  assertEqual(
    createModelProviderBodySchema.safeParse({ name: 'x', baseUrl: 'ftp://a.com', type: 'CHAT' }).success,
    false,
    '非 http(s) 应被拒',
  )
  assertEqual(
    createModelProviderBodySchema.safeParse({ name: 'x', baseUrl: 'https://', type: 'CHAT' }).success,
    false,
    '只有 scheme 应被拒',
  )
  assertEqual(
    createModelProviderBodySchema.safeParse({ name: 'x', baseUrl: 'https://a.com', type: 'RERANK' }).success,
    false,
    'type 取值域只有 CHAT/EMBEDDING',
  )

  // 建：apiKey 缺省 = 不配置；显式 null 与缺省同义（都保留 null / undefined 原样）
  const noKey = createModelProviderBodySchema.parse({ name: 'x', baseUrl: 'https://a.com', type: 'CHAT' })
  assertEqual(noKey.apiKey, undefined, '缺省 apiKey 应是 undefined')
  assertEqual(
    createModelProviderBodySchema.parse({ name: 'x', baseUrl: 'https://a.com', type: 'CHAT', apiKey: null }).apiKey,
    null,
    'apiKey: null 应保留 null',
  )
  // 空串不是"清空"的写法 —— 契约只留 undefined / null 两条路，避免"到底清没清"的歧义
  assertEqual(
    createModelProviderBodySchema.safeParse({ name: 'x', baseUrl: 'https://a.com', type: 'CHAT', apiKey: '' }).success,
    false,
    '空串 apiKey 应被拒',
  )

  // ⭐ PATCH 三态：这是本批最容易写错的地方（写错 → 改个名字顺手把 Key 抹了）
  assertEqual(updateModelProviderBodySchema.safeParse({}).success, false, '空 body 应被拒')
  const absent = updateModelProviderBodySchema.parse({ name: '新名字' })
  assertEqual(absent.apiKey, undefined, '不带 apiKey = 不动（必须是 undefined，不能被 default 成 null）')
  const cleared = updateModelProviderBodySchema.parse({ apiKey: null })
  assertEqual(cleared.apiKey, null, 'apiKey: null = 清空（且 null 本身要算"给了字段"）')
  const replaced = updateModelProviderBodySchema.parse({ apiKey: 'sk-new' })
  assertEqual(replaced.apiKey, 'sk-new', 'apiKey: 字符串 = 写入')
  assertEqual(updateModelProviderBodySchema.safeParse({ apiKey: '' }).success, false, 'PATCH 空串同样被拒')
  // enabled 的三种取值（真/假/不给）都要能过 —— 它是最常用的开关
  assertEqual(updateModelProviderBodySchema.parse({ enabled: false }).enabled, false, 'enabled: false 应保留')
})

await it('Provider Key 的密文绑定到记录（AAD）：换个 providerId 就解不开，不能跨记录搬运', () => {
  const idA = '01a0c289-6738-715c-a10c-ef95c1286bf9'
  const idB = '01a0c289-6831-76ab-b7d9-65e991557ba1'
  // AAD 公式本身是契约（写/读两侧共用同一个函数，这里把公式也钉住）
  assertEqual(providerKeyAad(idA), `model-providers:${idA}.api_key_enc`, 'AAD 公式')

  const plaintext = 'sk-proj-ThisIsOnlyATestKey-0123456789'
  const cipher = encryptSecret(plaintext, providerKeyAad(idA))
  assertEqual(decryptSecret(cipher, providerKeyAad(idA)), plaintext, '同一记录的密文应能解回')
  assert(!cipher.includes(plaintext), '密文里不得出现明文')

  let wrongContextThrew = false
  try {
    decryptSecret(cipher, providerKeyAad(idB))
  } catch (error) {
    wrongContextThrew = error instanceof SecretDecryptionError
  }
  assert(wrongContextThrew, '换成另一个 Provider 的 AAD 必须抛 SecretDecryptionError')

  // 不带 AAD（旧式/裸用）同样解不开 —— 防"某处忘了传 context"而静默可用
  let noContextThrew = false
  try {
    decryptSecret(cipher)
  } catch (error) {
    noContextThrew = error instanceof SecretDecryptionError
  }
  assert(noContextThrew, '漏传 AAD 必须解不开（否则 AAD 形同虚设）')
})

await it('shared Provider 输出形态：只含掩码与 hasKey，无任何 apiKey 字段；列表分页同构', () => {
  const now = new Date().toISOString()
  const item = {
    id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    type: 'CHAT',
    // ⚠️ `protocol` 是 **P0-1-37** 加进投影的（上游协议扩展）；本夹具当时漏改，
    //    于是这一条一直红着而没人看见（§七"刻意未注册型断言的保质期"的同款 —— 只有全量回归能抓到）。
    //    P0-2-2 顺手补上，并把它变成一条**真断言**（下一条用例）。
    protocol: 'OPENAI_COMPAT',
    enabled: true,
    hasKey: true,
    apiKeyPreview: 'sk-****cdef',
    modelCount: 3,
    createdAt: now,
    updatedAt: now,
  }
  assertEqual(modelProviderItemSchema.safeParse(item).success, true, 'item schema')
  assertEqual(
    modelProviderItemSchema.safeParse({ ...item, apiKeyPreview: null, hasKey: false }).success,
    true,
    '未配置 Key 时 hasKey=false / apiKeyPreview=null',
  )
  assertEqual(
    modelProviderItemSchema.safeParse({ ...item, type: 'EMBEDDING' }).success,
    true,
    'EMBEDDING 也是合法类型',
  )
  // 三协议：**必填**（不是 nullable、也没有默认值）—— 省略它意味着"要发到哪个上游说不清"，
  // 而上游协议一旦猜错，症状是"模型回的东西完全不对"，不会在别处报错。
  assertEqual(
    modelProviderItemSchema.safeParse({ ...item, protocol: undefined }).success,
    false,
    '⚠️ `protocol` 必填（P0-1-37 起）：漏了它就是"发到哪个上游说不清"',
  )
  assertEqual(
    modelProviderItemSchema.safeParse({ ...item, protocol: 'GEMINI' }).success,
    false,
    '取值域之外一律拒（取值域唯一落点：`UPSTREAM_PROTOCOLS`）',
  )
  assertSameSet(
    Object.keys(modelProviderItemSchema.shape),
    ['apiKeyPreview', 'baseUrl', 'createdAt', 'enabled', 'hasKey', 'id', 'modelCount', 'name', 'protocol', 'type', 'updatedAt'],
    '投影键集合（`protocol` 必须在；任何密文字段都不得在）',
  )
  // 形态自检：schema 的键集合里**不允许**出现任何 apiKey* 以外的敏感名
  const keys = Object.keys(modelProviderItemSchema.shape)
  assert(!keys.includes('apiKey'), `输出形态不得含 apiKey，实际键：${keys.join(',')}`)
  assert(!keys.some((key) => key.toLowerCase().includes('enc')), `输出形态不得含密文字段：${keys.join(',')}`)

  assertEqual(
    listModelProvidersQuerySchema.parse({}).limit,
    20,
    '列表 limit 默认值应与其它列表一致',
  )
  assertEqual(
    offsetPageOf(modelProviderItemSchema).safeParse({ items: [item], total: 1, offset: 0, limit: 20 }).success,
    true,
    '列表分页 schema',
  )
})

// ── 16. 模型契约与路由分流（P0-1-11）──
await it('两条路径各自注册、互不遮蔽：/api/models 与 /api/models/available 都是真路由（不是 404 兜底）', async () => {
  // 注册层面就断言"路径确实不同"：同路径两个 GET 会让 Fastify 在**启动期**抛
  // `FST_ERR_DUPLICATED_ROUTE`（已实测），所以这里能挂上就说明分流是干净的
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/models' }), true, '管理列表路由')
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/models/available' }), true, '可选列表路由')
  // `GET /api/models/:id` **不该**存在（只有 PATCH/DELETE）：否则"取单条模型"会成为一个
  // 没人设计过的端点。用一条合法 UUID 打过去，期望 404 兜底
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/models/:id' }), false, '不应有单条 GET')

  // 校验先于鉴权（Fastify 生命周期：validation → preHandler），所以匿名请求也能验 schema 是否接线
  const missingType = await app.inject({ method: 'GET', url: '/api/models/available' })
  assertEqual(missingType.statusCode, 400, 'available 缺 type 的状态码')
  const typeFields = missingType.json().data?.fields ?? []
  const fieldPaths = typeFields.map((field) => field.path)
  assert(
    fieldPaths.includes('querystring.type'),
    `应报 querystring.type（说明 type 真的是必填），实际 ${JSON.stringify(fieldPaths)}`,
  )
  // 文案也要说清"必填"：zod v3 里 `required_error` 与自定义 errorMap 互斥
  // （同时给会在**模块加载期**抛错），所以这句文案是 errorMap 分派 `invalid_type` 产出的 ——
  // 断言它在，等于守住了"必填语义没有被降级成通用的类型错误"
  const missingTypeMessage = typeFields.find((field) => field.path === 'querystring.type')?.message ?? ''
  assert(
    missingTypeMessage.includes('必填'),
    `缺 type 的文案应说明"必填"，实际：${missingTypeMessage}`,
  )

  const badType = await app.inject({ method: 'GET', url: '/api/models/available?type=chat' })
  assertEqual(badType.statusCode, 400, 'type 大小写敏感（枚举是大写）')
  const badTypeMessage =
    (badType.json().data?.fields ?? []).find((field) => field.path === 'querystring.type')?.message ?? ''
  assert(
    badTypeMessage.includes('CHAT/EMBEDDING'),
    `大小写写错时应提示合法取值，实际：${badTypeMessage}`,
  )

  // schema 通过后才轮到鉴权：401 说明这条路由**真的走到了自己的 preHandler**
  // （若被 `/api/models/:id` 吞掉，这里会是 400「模型 ID 不是合法 UUID」）
  const anonymousAvailable = await app.inject({ method: 'GET', url: '/api/models/available?type=CHAT' })
  assertEqual(anonymousAvailable.statusCode, 401, 'available 匿名状态码')
  assertEqual(anonymousAvailable.json().code, 'UNAUTHORIZED', 'available 匿名错误码')

  const anonymousManage = await app.inject({ method: 'GET', url: '/api/models' })
  assertEqual(anonymousManage.statusCode, 401, '管理列表匿名状态码（校验通过后落到鉴权）')

  // GET 未注册在 `:id` 上 → 404 兜底（而不是被 PATCH/DELETE 的 schema 误判成 400）
  const noSingleGet = await app.inject({
    method: 'GET',
    url: '/api/models/01a0c289-6738-715c-a10c-ef95c1286bf9',
  })
  assertEqual(noSingleGet.statusCode, 404, 'GET 单条模型状态码')
  assertEqual(noSingleGet.json().code, 'NOT_FOUND', 'GET 单条模型错误码')
})

await it('shared 模型契约：type 必填 / 型号名与别名纪律 / maxContext 三态 / 分页过滤', () => {
  // `available` 的 type 必填：它的唯一用途是填"选模型"的下拉，而对话模型与向量模型不可互换
  const noType = listAvailableModelsQuerySchema.safeParse({})
  assertEqual(noType.success, false, 'available 必须要求 type')
  assertEqual(listAvailableModelsQuerySchema.safeParse({ type: 'CHAT' }).success, true, 'CHAT 合法')
  assertEqual(
    listAvailableModelsQuerySchema.safeParse({ type: 'EMBEDDING' }).success,
    true,
    'EMBEDDING 合法',
  )

  // 管理列表：默认值 + `enabled` 从查询串转布尔（`?enabled=false` 是字符串 "false"）
  const pageDefaults = listModelsQuerySchema.parse({})
  assertEqual(pageDefaults.offset, 0, 'offset 默认值')
  assertEqual(pageDefaults.limit, 20, 'limit 默认值应与其它列表一致')
  assertEqual(listModelsQuerySchema.parse({ enabled: 'true' }).enabled, true, 'enabled=true 应转布尔')
  assertEqual(listModelsQuerySchema.parse({ enabled: 'false' }).enabled, false, 'enabled=false 应转布尔')
  assertEqual(listModelsQuerySchema.safeParse({ enabled: '1' }).success, false, 'enabled 只认 true/false')
  assertEqual(listModelsQuerySchema.safeParse({ providerId: 'not-a-uuid' }).success, false, 'providerId 要 UUID')
  assertEqual(listModelsQuerySchema.safeParse({ limit: 101 }).success, false, 'limit 上限 100')

  // 建模型：型号名 trim + 拒内部空白；别名可中文；maxContext 边界
  const named = createModelBodySchema.safeParse({
    providerId: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    modelName: '  gpt-4o-mini\n',
    label: '  小钢炮  ',
    type: 'CHAT',
  })
  assertEqual(named.success, true, '合法建模型请求应通过')
  assertEqual(named.data?.modelName, 'gpt-4o-mini', '型号名应 trim（粘贴常带空格/换行）')
  assertEqual(named.data?.label, '小钢炮', '别名应 trim（可中文）')
  // 默认值走服务层而不是 schema：`supportsVision`/`enabled` 缺席时必须是 `undefined`，
  // 否则服务层没法区分"调用方没给"与"调用方给了 false"
  assertEqual(named.data?.supportsVision, undefined, 'supportsVision 缺席应保持 undefined')
  assertEqual(named.data?.enabled, undefined, 'enabled 缺席应保持 undefined')
  assertEqual(named.data?.maxContext, undefined, 'maxContext 缺席应保持 undefined')

  const base = { providerId: '01a0c289-6738-715c-a10c-ef95c1286bf9', label: 'x', type: 'CHAT' }
  assertEqual(
    createModelBodySchema.safeParse({ ...base, modelName: 'gpt 4o' }).success,
    false,
    '型号名不得含空格（上游 model id 不含空格，放行只会把错误推迟到调上游时）',
  )
  assertEqual(createModelBodySchema.safeParse({ ...base, modelName: '' }).success, false, '型号名不得为空')
  assertEqual(createModelBodySchema.safeParse({ ...base, modelName: 'a'.repeat(129) }).success, false, '型号名 128 上限')
  assertEqual(createModelBodySchema.safeParse({ ...base, modelName: 'm', maxContext: 0 }).success, false, 'maxContext 至少 1')
  assertEqual(
    createModelBodySchema.safeParse({ ...base, modelName: 'm', maxContext: 10_000_001 }).success,
    false,
    'maxContext 上限',
  )
  assertEqual(
    createModelBodySchema.safeParse({ ...base, modelName: 'm', maxContext: 128_000 }).data?.maxContext,
    128_000,
    'maxContext 正常值应保留',
  )
})

await it('shared 模型契约：PATCH 的 maxContext 三态 + 空改动被拒 + 多余键不会静默通过', () => {
  assertEqual(updateModelBodySchema.safeParse({}).success, false, '空改动应被拒（至少一个字段）')
  // 三态：缺席 = 不动（`undefined`）、`null` = 清空。二者的区分是这一层的核心职责
  const untouched = updateModelBodySchema.safeParse({ label: '改个名' })
  assertEqual(untouched.success, true, '只改别名合法')
  assertEqual(untouched.data?.maxContext, undefined, '不带 maxContext 时应保持 undefined（= 不动）')
  const cleared = updateModelBodySchema.safeParse({ maxContext: null })
  assertEqual(cleared.success, true, 'maxContext=null 是"清空"，算一次合法改动')
  assertEqual(cleared.data?.maxContext, null, 'maxContext=null 必须原样保留')
  assertEqual(
    updateModelBodySchema.safeParse({ maxContext: 4096 }).data?.maxContext,
    4096,
    'maxContext 数字应保留',
  )

  // `providerId` 在契约里（为的是能把"想迁移"这种无效意图变成显式 409，而不是被静默剥掉）
  assertEqual(
    updateModelBodySchema.safeParse({ providerId: '01a0c289-6738-715c-a10c-ef95c1286bf9' }).success,
    true,
    'providerId 应在契约内（值不同时由服务层 409）',
  )

  // 与 `providerId` 相反：**完全不存在**的键会被 zod 剥掉，剥完等于没给字段 → 被 refine 拒掉。
  // 这条断言把"静默 no-op"钉死：`{"foo": 1}` 不会返回 200 让人以为改成功了
  assertEqual(updateModelBodySchema.safeParse({ foo: 1 }).success, false, '未知键不该静默通过')
})

await it('shared 模型两套投影：键集合互不串味（管理面有 agentCount，可选面不该有）', () => {
  const now = new Date().toISOString()
  const item = {
    id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    providerId: '01a0c289-6738-715c-a10c-ef95c1286bf8',
    providerName: 'OpenAI',
    providerEnabled: true,
    modelName: 'gpt-4o-mini',
    label: '小钢炮',
    type: 'CHAT',
    maxContext: 128_000,
    supportsVision: true,
    enabled: true,
    agentCount: 2,
    createdAt: now,
    updatedAt: now,
  }
  assertEqual(modelItemSchema.safeParse(item).success, true, '管理投影 schema')
  assertEqual(
    modelItemSchema.safeParse({ ...item, maxContext: null }).success,
    true,
    'maxContext 可为 null（未填写）',
  )
  assertEqual(modelItemSchema.safeParse({ ...item, type: 'EMBEDDING' }).success, true, 'EMBEDDING 合法')

  const option = {
    id: item.id,
    providerId: item.providerId,
    providerName: item.providerName,
    modelName: item.modelName,
    label: item.label,
    type: 'CHAT',
    maxContext: 128_000,
    supportsVision: true,
  }
  assertEqual(modelOptionSchema.safeParse(option).success, true, '可选投影 schema')
  // 可选投影**故意**不含 enabled：按定义只含"能选的"，再下发一个恒为 true 的字段
  // 只会诱使前端写 `if (option.enabled)` 这种永远为真的分支
  const optionKeys = Object.keys(modelOptionSchema.shape)
  for (const forbidden of ['enabled', 'agentCount', 'createdAt', 'updatedAt']) {
    assert(!optionKeys.includes(forbidden), `可选投影不得含 ${forbidden}，实际键：${optionKeys.join(',')}`)
  }
  // 两套投影必须真的不同（否则"拆两条路径"就白拆了）
  const itemKeys = Object.keys(modelItemSchema.shape)
  assert(itemKeys.includes('agentCount'), `管理投影应含 agentCount，实际：${itemKeys.join(',')}`)
  assert(itemKeys.includes('providerEnabled'), `管理投影应含 providerEnabled，实际：${itemKeys.join(',')}`)

  assertEqual(
    modelOptionListResultSchema.safeParse({ items: [option] }).success,
    true,
    '可选列表响应形态',
  )
  assertEqual(
    offsetPageOf(modelItemSchema).safeParse({ items: [item], total: 1, offset: 0, limit: 20 }).success,
    true,
    '管理列表分页形态',
  )
})

// ── 17. LLM client 契约与路由（P0-1-12）──
await it('拉取上游模型列表的路由已注册（子路径，不是查询参数分流）：匿名 401、非法 UUID 400', async () => {
  const route = '/api/model-providers/:id/remote-models'
  assertEqual(app.hasRoute({ method: 'GET', url: route }), true, '路由应已注册')
  // 与 P0-1-11 同一条结论：同路径同方法注册两次会在**启动期**抛错，所以这里挂得上
  // 就说明它是独立子路径，而不是跟 `GET /api/model-providers` 抢同一个 handler
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/model-providers' }), true, '列表路由仍在')

  // 校验先于鉴权（validation → preHandler），所以匿名也能验 schema 是否接线
  const badUuid = await app.inject({ method: 'GET', url: '/api/model-providers/not-a-uuid/remote-models' })
  assertEqual(badUuid.statusCode, 400, '非法 UUID 的状态码')

  // schema 通过后才轮到鉴权：401 说明它真的走到了自己的 preHandler
  const anonymous = await app.inject({
    method: 'GET',
    url: '/api/model-providers/01a0c289-6738-715c-a10c-ef95c1286bf9/remote-models',
  })
  assertEqual(anonymous.statusCode, 401, '匿名状态码（仅 ADMIN 的端点）')
  assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名错误码')
})

await it('shared 上游模型列表契约：形态与取值域 + 键集合不含任何凭据名', () => {
  const sample = {
    providerId: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    providerName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    total: 2,
    truncated: false,
    items: [
      { id: 'bge-m3', ownedBy: null, created: null },
      { id: 'gpt-4o-mini', ownedBy: 'system', created: 1_700_000_000 },
    ],
  }
  assertEqual(remoteModelListResultSchema.safeParse(sample).success, true, '标准形态应通过')
  assertEqual(
    remoteModelListResultSchema.safeParse({ ...sample, items: [{ id: 'x' }] }).success,
    false,
    '缺 ownedBy/created 应被拒（服务层负责补 null，而不是让前端判 undefined）',
  )
  assertEqual(
    remoteModelListResultSchema.safeParse({ ...sample, total: -1 }).success,
    false,
    'total 不能为负',
  )
  assertEqual(
    remoteModelListResultSchema.safeParse({ ...sample, truncated: 'yes' }).success,
    false,
    'truncated 必须是布尔（"被截断了多少"这种事不许用字符串糊过去）',
  )
  // 键级自检：与 Provider 的读接口同一条不变式（`02` §十：Key 有进无出）
  const keys = Object.keys(remoteModelListResultSchema.shape)
  for (const forbidden of ['apiKey', 'apiKeyEnc', 'apiKeyPreview', 'hasKey', 'authorization']) {
    assert(!keys.includes(forbidden), `该响应不得含凭据类键 ${forbidden}，实际：${keys.join(',')}`)
  }
})

// ── 17. 知识库契约与路由（P0-1-15）──
await it('知识库五条路由已注册，且**刻意没有** /available 子路径（本资源对全员开放，不需要第二套投影）', async () => {
  // `02` §4.6 的 CRUD 四端点 + `GET /:id` 详情
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/knowledge-bases' }), true, '列表路由')
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/:id' }), true, '详情路由')
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/knowledge-bases' }), true, '建库路由')
  assertEqual(app.hasRoute({ method: 'PATCH', url: '/api/knowledge-bases/:id' }), true, '改库路由')
  assertEqual(app.hasRoute({ method: 'DELETE', url: '/api/knowledge-bases/:id' }), true, '删库路由')
  // 与 `/api/models/available` 的对照：模型池的管理列表是 ADMIN 专属，所以必须另开一条全员可读的；
  // 知识库列表**本来就对全员开放**（`03` §25 的权限列是「登录」），再开一条就是多余的第二个真相
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/available' }),
    false,
    '不应存在 /available（本资源无需拆投影）',
  )

  // 匿名：校验先于鉴权，所以先看到 400（非法 UUID）再看到 401（鉴权）
  const badId = await app.inject({ method: 'GET', url: '/api/knowledge-bases/not-a-uuid' })
  assertEqual(badId.statusCode, 400, '非法 UUID 的状态码')
  assertEqual(
    (badId.json().data?.fields ?? []).some((field) => field.path === 'params.id'),
    true,
    '应报 params.id（说明路径参数 schema 真的接线了）',
  )

  const anonymous = await app.inject({ method: 'GET', url: '/api/knowledge-bases' })
  assertEqual(anonymous.statusCode, 401, '匿名列表状态码')
  assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名列表错误码')
})

await it('shared 知识库契约：retrieval_config 补默认值（唯一入口）与建/改 schema 纪律', () => {
  // ① 规范默认值 = `子方案①` §二 的"完整形状"（6 键）—— 与 DB 默认值必须是同一组值
  assertEqual(Object.keys(DEFAULT_RETRIEVAL_CONFIG).length, 6, '默认形状应有 6 个键')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.topK, 5, '默认 topK')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.score, 0.3, '默认 score')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.mode, 'HYBRID', '默认 mode')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.splitStrategy, 'hybrid', '默认 splitStrategy')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.rrfK, 60, '默认 rrfK')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.weights.vector, 1, '默认向量权重')
  assertEqual(DEFAULT_RETRIEVAL_CONFIG.weights.fulltext, 1, '默认全文权重')

  // ② **逐键兜底**（这是它的核心契约）：整体缺失、空对象、缺一半、类型错、越界值 —— 都要给出完整形状
  for (const broken of [
    undefined,
    null,
    {},
    { topK: 10 }, // 只给一个键（PATCH 局部写入的典型形态）
    { topK: 'abc', score: null, mode: 'NOPE', splitStrategy: 42, rrfK: {}, weights: 'x' },
    { topK: 0, score: 5, mode: 'VECTOR', splitStrategy: 'fixed', rrfK: 99999, weights: { vector: -1 } },
    'not-an-object',
    [1, 2, 3],
  ]) {
    const normalized = normalizeRetrievalConfig(broken)
    const parsed = retrievalConfigInputSchema.safeParse(normalized)
    assertEqual(
      parsed.success,
      true,
      `坏数据 ${JSON.stringify(broken)} 归一后必须仍符合契约，实际 ${JSON.stringify(normalized)}`,
    )
    // 越界值**退回默认**而不是 clamp：5 → 1 会被误读成"用户就是要 1"
    if (typeof broken === 'object' && broken !== null && !Array.isArray(broken) && broken.score === 5) {
      assertEqual(normalized.score, DEFAULT_RETRIEVAL_CONFIG.score, '越界 score 应退回默认值')
    }
    if (typeof broken === 'object' && broken !== null && !Array.isArray(broken) && broken.mode === 'VECTOR') {
      assertEqual(normalized.mode, 'VECTOR', '合法 mode 应被保留')
    }
  }
  // `patch` 的优先级必须**高于** `base`（建库时把请求体叠到环境默认值上、改库时叠到当前值上）——
  // 反了的话症状很隐蔽：接口 200、响应看着正常，但**用户改的值被静默丢弃**（这条断言就是盯它）
  assertEqual(normalizeRetrievalConfig({ topK: 99 }, { topK: 7 }).topK, 7, 'patch 应压过 base')
  assertEqual(
    normalizeRetrievalConfig({ topK: 6, score: 0.5 }, { score: 0.9 }).topK,
    6,
    'patch 没给的键应保留 base 的值（改一半不能把另一半打回默认）',
  )
  assertEqual(
    normalizeRetrievalConfig({ weights: { vector: 2, fulltext: 3 } }, { weights: { vector: 9, fulltext: 3 } })
      .weights.vector,
    9,
    'weights 也应按键合并',
  )

  // ③ 建库：四项全可省（`子方案①` §十一：建库时快照环境默认值）
  assertEqual(createKnowledgeBaseBodySchema.safeParse({ name: '只给名字' }).success, true, '只给 name 应通过')
  assertEqual(createKnowledgeBaseBodySchema.safeParse({}).success, false, '缺 name 应被拒')
  assertEqual(createKnowledgeBaseBodySchema.safeParse({ name: '   ' }).success, false, '空白 name 应被拒')
  assertEqual(
    createKnowledgeBaseBodySchema.safeParse({ name: 'x'.repeat(129) }).success,
    false,
    'name 超 128 应被拒（列是 VARCHAR(128)）',
  )
  assertEqual(
    createKnowledgeBaseBodySchema.safeParse({ name: 'n', retrievalConfig: { mode: 'vector' } }).success,
    false,
    'mode 枚举是大写，小写应被拒',
  )
  assertEqual(
    createKnowledgeBaseBodySchema.safeParse({ name: 'n', chunkSize: 8193 }).success,
    false,
    'chunkSize 超 8192 应被拒（单位是字符，超上限只可能来自单位误解）',
  )
  // weights 要么都给、要么都不给
  assertEqual(
    createKnowledgeBaseBodySchema.safeParse({ name: 'n', retrievalConfig: { weights: { vector: 1 } } }).success,
    false,
    'weights 给一半应被拒（另一半会静默取默认值，像"设了没生效"）',
  )

  // ④ 改库：`description` 三态 —— 不带 / null（清空）/ 字符串，三者必须可区分
  const patch = updateKnowledgeBaseBodySchema
  assertEqual(patch.safeParse({}).success, false, '空改动应被拒')
  const untouched = patch.safeParse({ name: 'x' })
  assertEqual(untouched.success, true, '只改 name 应通过')
  assertEqual(
    Object.prototype.hasOwnProperty.call(untouched.data, 'description'),
    false,
    '不带 description 时该键**不应存在**（存在且为 undefined 都是"不动"的另一种写法，会误导服务层）',
  )
  const cleared = patch.safeParse({ description: null })
  assertEqual(cleared.success, true, 'null 描述应通过（= 清空）')
  assertEqual(cleared.data.description, null, 'null 必须原样保留（不能被 default 吃掉）')

  // ⑤ 输出投影：`embeddingModelChanged` 是三态（null = provider 未就绪、无法判定）
  const sample = {
    id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    name: '示例库',
    description: null,
    embeddingModel: 'api:bge-m3',
    embeddingModelChanged: null,
    chunkSize: 512,
    chunkOverlap: 64,
    retrievalConfig: DEFAULT_RETRIEVAL_CONFIG,
    documentCount: 0,
    agentCount: 0,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  }
  assertEqual(knowledgeBaseItemSchema.safeParse(sample).success, true, '列表项 schema')
  assertEqual(
    knowledgeBaseItemSchema.safeParse({ ...sample, embeddingModelChanged: 'no' }).success,
    false,
    'embeddingModelChanged 必须是布尔或 null（不许用字符串糊过去）',
  )
  assertEqual(
    knowledgeBaseListResultSchema.safeParse({ items: [sample], total: 1, offset: 0, limit: 20 }).success,
    true,
    '分页响应同构',
  )
})

// ── 18. 文档上传：路由 + 前置校验四道 + 解析契约（P0-1-16）──
await it('文档上传路由已注册：非法 UUID 400、匿名 401（校验先于鉴权，都不碰依赖）', async () => {
  // `02` §4.6：上传挂在知识库下的子路径
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents' }), true, '上传路由')
  // ⚠️ P0-1-16 时这里还有两条"列表/下载**不该存在**"的断言（"提前注册一条返回空列表的 GET，
  // 会让'上传成功但列表里没有'被当成已交付"）。**P0-1-21 把两条真端点补齐了**，
  // 于是那两条负向断言完成了使命 —— 改成正向的：端点存在，且"只有这一条 POST"。
  // （它们自身的契约在第 23 节；负向断言留在源码里只会变成"每次补端点都要改的噪声"。）
  assertEqual(
    app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents/:docId' }),
    false,
    '不该出现 `POST /:docId` 这种"改文档"的路径（换内容只能靠覆盖重建）',
  )

  const badId = await app.inject({ method: 'POST', url: '/api/knowledge-bases/not-a-uuid/documents' })
  assertEqual(badId.statusCode, 400, '非法 UUID 的状态码')
  assertEqual(
    (badId.json().data?.fields ?? []).some((field) => field.path === 'params.id'),
    true,
    '应报 params.id（路径参数 schema 真的接线了）',
  )

  // 无 Cookie ⇒ `requireAuth` 直接拒绝，**不去查会话存储** ⇒ CI（无 Redis）里也必须是 401 而不是 500。
  // body 用 JSON 而非 multipart：鉴权在 `preHandler`，早于 handler 里的 `request.file()`，
  // 所以这条断言验的是"闸门在不在"，与 multipart 解析无关（那条路在 verify-documents 里验）。
  const anonymous = await app.inject({
    method: 'POST',
    url: '/api/knowledge-bases/01a0c289-6738-715c-a10c-ef95c1286bf9/documents',
    payload: {},
  })
  assertEqual(anonymous.statusCode, 401, '匿名上传状态码')
  assertEqual(anonymous.json().code, 'UNAUTHORIZED', '匿名上传错误码')
})

await it('前置校验的纯函数矩阵：白名单 / .doc 专拦 / MIME 交叉 / **文件头魔数**（改名的假 PDF 必须被拦）', () => {
  // ── 夹具：只用几十字节的手工字节串，不依赖 scripts/fixtures 的生成器 ──
  const TEXT = Buffer.from('这是一个纯文本文件\n第二行', 'utf8')
  const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'latin1')
  const ZIP_OOXML = Buffer.concat([
    Buffer.from('PK\x03\x04', 'latin1'),
    Buffer.alloc(20),
    Buffer.from('[Content_Types].xml', 'latin1'),
  ])
  const ZIP_PLAIN = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(64, 0x41)])
  const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(32)])
  const OLE2 = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(32),
  ])

  /** 断言"这一组输入必须以 VALIDATION 被拒，且文案里含某个关键字" */
  const rejected = (input, includes, label) => {
    let error = null
    try {
      detectFormat(input)
    } catch (caught) {
      error = caught
    }
    assert(error !== null, `${label}：本应被拒，却通过了`)
    assertEqual(error.code, 'VALIDATION', `${label}：错误码`)
    assert(
      String(error.message).includes(includes),
      `${label}：文案应含「${includes}」，实际「${error.message}」`,
    )
  }

  // ── 通过的四条（含大小写扩展名与 octet-stream 放行）──
  assertEqual(detectFormat({ fileName: 'a.txt', declaredMime: 'text/plain', bytes: TEXT }), 'txt', 'txt')
  assertEqual(detectFormat({ fileName: '读我.MD', bytes: TEXT }), 'md', '大写扩展名应归一化')
  assertEqual(
    detectFormat({ fileName: 'a.pdf', declaredMime: 'application/pdf', bytes: PDF }),
    'pdf',
    'pdf',
  )
  // `application/octet-stream` = 客户端"我不知道"，不是矛盾声明 ⇒ 放行（否则 curl -F 传不了）
  assertEqual(
    detectFormat({ fileName: 'a.pdf', declaredMime: 'application/octet-stream', bytes: PDF }),
    'pdf',
    'octet-stream 应放行',
  )
  const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  assertEqual(detectFormat({ fileName: 'a.docx', declaredMime: docxMime, bytes: ZIP_OOXML }), 'docx', 'docx')

  // ── ① 扩展名白名单 + `.doc` 专拦（验收原文：400 + 「请另存为 .docx 后重传」）──
  assertEqual(LEGACY_DOC_HINT, '请另存为 .docx 后重传', '`.doc` 的提示文案（前后端共用同一句）')
  rejected({ fileName: '老合同.doc', declaredMime: 'application/msword', bytes: OLE2 }, LEGACY_DOC_HINT, '.doc')
  rejected({ fileName: 'a.exe', bytes: TEXT }, '不支持的文件类型', '非白名单扩展名')
  rejected({ fileName: '没有扩展名', bytes: TEXT }, '缺少扩展名', '无扩展名')
  rejected({ fileName: 'a.', bytes: TEXT }, '缺少扩展名', '点结尾（等于没有扩展名）')

  // ── ② MIME 交叉校验 ──
  rejected(
    { fileName: 'a.pdf', declaredMime: 'text/plain', bytes: PDF },
    '不符',
    'MIME 与扩展名矛盾',
  )

  // ── ③ 文件头魔数：**唯一能抓住"改名"的一道** ──
  //    改名成 .pdf 的文本：扩展名与 MIME 完全自洽（浏览器就是这么报的），只有内容对不上
  rejected(
    { fileName: 'fake.pdf', declaredMime: 'application/pdf', bytes: TEXT },
    '看起来是纯文本',
    '改名成 .pdf 的文本',
  )
  rejected({ fileName: 'a.pdf', declaredMime: 'application/pdf', bytes: PNG }, '图片', 'PNG 改名成 .pdf')
  rejected({ fileName: 'a.docx', declaredMime: docxMime, bytes: OLE2 }, LEGACY_DOC_HINT, 'OLE2 改名成 .docx')
  // 任意 zip 改名成 .docx：签名过了（PNG 那种会被抓），必须靠包内 `[Content_Types].xml` 再确认
  rejected({ fileName: 'a.docx', declaredMime: docxMime, bytes: ZIP_PLAIN }, 'OOXML', '普通 zip 改名成 .docx')
  // 反向：真 PDF 改名成 .txt（内容是二进制、扩展名说是文本）
  rejected({ fileName: 'a.txt', declaredMime: 'text/plain', bytes: PDF }, '不符', 'PDF 改名成 .txt')
  // 文本扩展名里混进 NUL = 二进制内容的铁证
  rejected(
    { fileName: 'a.txt', declaredMime: 'text/plain', bytes: Buffer.concat([TEXT, Buffer.from([0]), TEXT]) },
    'NUL',
    '含 NUL 的 .txt',
  )
})

await it('shared 文档契约 + `countChars` 的口径（按**码点**计，不是 `.length`）', () => {
  // 白名单与 `.doc` 是**互斥**的两件事：`.doc` 不在白名单里，但有专门的拦截分支
  assertEqual([...UPLOAD_EXTENSIONS].join(','), 'pdf,docx,md,txt', '扩展名白名单')
  assertEqual(UPLOAD_EXTENSIONS.includes(LEGACY_DOC_EXTENSION), false, '.doc 不应在白名单里')
  assertEqual(UPLOAD_FILE_FIELD, 'file', 'multipart 文件字段名（`02` §4.6 未定，本批定案）')

  // MIME 表必须**恰好**覆盖白名单（多一个键 = 有条目永远不会被查到；少一个 = 该格式的 MIME 校验失效）
  assertEqual(
    Object.keys(MIME_BY_EXTENSION).sort().join(','),
    [...UPLOAD_EXTENSIONS].sort().join(','),
    'MIME 表的键集合应与白名单逐字一致',
  )
  for (const [extension, mimes] of Object.entries(MIME_BY_EXTENSION)) {
    assert(mimes.length > 0, `${extension} 的 MIME 列表不应为空`)
    assert(
      mimes.every((mime) => mime === mime.toLowerCase()),
      `${extension} 的 MIME 必须是小写（比对前会归一化，表里大写看不出问题但会误导人）`,
    )
  }

  // 输出投影
  const sample = {
    id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    kbId: '01a0c289-6738-715c-a10c-ef95c1286bf9',
    fileName: '员工手册.pdf',
    status: 'PARSING',
    chunkCount: 0,
    errorMsg: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  }
  assertEqual(documentItemSchema.safeParse(sample).success, true, '文档项 schema')
  assertEqual(
    documentItemSchema.safeParse({ ...sample, status: 'PENDING' }).success,
    false,
    'status 只允许 PARSING/READY/FAILED（与 schema.prisma 的枚举逐字一致）',
  )
  assertEqual(
    documentItemSchema.safeParse({ ...sample, chunkCount: -1 }).success,
    false,
    'chunkCount 不应允许负数',
  )
  // `deduplicated` 必填：调用方必须知道"这次到底有没有产生新文档"，否则前端会去列表里找一个不存在的新文档
  assertEqual(
    uploadDocumentResultSchema.safeParse({ document: sample }).success,
    false,
    'deduplicated 是必填，不能被省略',
  )
  assertEqual(
    uploadDocumentResultSchema.safeParse({ document: sample, deduplicated: true }).success,
    true,
    '上传响应 schema',
  )
  assertEqual(
    documentParamsSchema.safeParse({ id: sample.id, docId: 'not-a-uuid' }).success,
    false,
    'docId 必须是 UUID',
  )

  // `countChars`：`.length` 会把 emoji 数成 2（UTF-16 代理对），`[...str]` 按码点迭代才是"字符数"。
  // P0-1-18 的 `chunk_size=512` 单位是**字符**，这条口径现在就钉死，免得下游各写一遍。
  assertEqual(countChars('😀'), 1, '单个 emoji 应算 1 个字符')
  assertEqual('😀'.length, 2, '（对照）`.length` 会数成 2')
  assertEqual(countChars('中 a 文'), 3, '空白字符不计入')
  assertEqual(countChars(''), 0, '空串')
})

// ── 19. 文档状态机（P0-1-17）──
console.log(`\n${c.b}── 文档状态机契约 ──${c.x}`)

await it('状态机转换表：合法转换恰好 5 条，且 **READY 不得被打回 FAILED**', () => {
  // 这条不变式没有任何 HTTP 路径能验到它：worker 是唯一的写者，而"过期 job 把 READY 文档
  // 打回失败"只会表现为"内容明明能用却报失败、重投也救不回来"。就靠这条纯函数断言守着。
  assertEqual(DOCUMENT_STATUSES.join(','), 'PARSING,READY,FAILED', '状态集合（与 schema.prisma 枚举逐字一致）')

  const legal = []
  for (const from of DOCUMENT_STATUSES) {
    for (const to of DOCUMENT_STATUSES) {
      if (canTransitionDocumentStatus(from, to)) legal.push(`${from}->${to}`)
    }
  }
  // 集合语义：两边都排序再比（按枚举书写顺序写死期望值，换个顺序就会假失败）
  assertEqual(
    [...legal].sort().join(','),
    ['PARSING->PARSING', 'PARSING->READY', 'PARSING->FAILED', 'READY->PARSING', 'FAILED->PARSING']
      .sort()
      .join(','),
    '合法转换集合',
  )

  assertEqual(canTransitionDocumentStatus('READY', 'FAILED'), false, 'READY 不得直接转 FAILED')
  assertEqual(canTransitionDocumentStatus('READY', 'READY'), false, 'READY 是终态：重复投递必须被跳过，而不是重写')
  assertEqual(canTransitionDocumentStatus('FAILED', 'READY'), false, 'FAILED 必须先回 PARSING（重试要可见）')
  assertEqual(canTransitionDocumentStatus('PARSING', 'READY'), true, '成功路径')
  assertEqual(canTransitionDocumentStatus('PARSING', 'FAILED'), true, '失败路径')

  // 与声明式表逐条一致（防"函数与表各写一套"）
  for (const from of DOCUMENT_STATUSES) {
    const declared = [...DOCUMENT_STATUS_TRANSITIONS[from]].sort().join(',')
    const computed = DOCUMENT_STATUSES.filter((to) => canTransitionDocumentStatus(from, to)).sort().join(',')
    assertEqual(computed, declared, `${from} 的后继集合应与 DOCUMENT_STATUS_TRANSITIONS 一致`)
  }
})

// ── 20. 分块策略契约（P0-1-18；纯函数 + 真夹具，不需要任何依赖）──
console.log(`\n${c.b}── 分块策略契约（hybrid / fixed：逐条盯"做错会静默"的地方）──${c.x}`)

/** 分块参数取 §二 的默认值（KB 建库时快照的就是这几个数） */
const CHUNK_OPT = { chunkSize: 512, chunkOverlap: 64, chunkMin: DEFAULT_CHUNK_MIN_CHARS }
/** 码点数（`chunk_size` 的单位是字符，见 §二 B8 —— 断言也必须用它，否则量错了对象） */
const cps = (text) => [...text]
/** 造一份"一段文本 + 无标题"的解析结果（纯函数入参，不经过解析器） */
const flatDoc = (text, headingPath = [], page = null) => ({
  blocks: [{ text, headingPath, page }],
  text,
  meta: {
    format: 'txt',
    pageCount: page === null ? null : 1,
    charCount: countChars(text),
    hasHeadings: headingPath.length > 0,
    encoding: 'utf-8',
  },
})
/** 解析一个夹具（真跑解析器：分块的上游就是它，桩掉等于把"能接到真数据"这件事漏掉） */
const parseFixture = (fileName, bytes) => parseDocument(detectFormat({ fileName, bytes }), bytes)

/** 结构清晰 docx：1 个标题 + 6 段各 105 字（同一 Section 内共 ~646 字 ⇒ 必须切两刀以上） */
const LONG_DOCX_BLOCKS = [{ level: 1, text: '员工手册' }]
for (let i = 1; i <= 6; i += 1) LONG_DOCX_BLOCKS.push({ text: `第${i}条规定：${'甲'.repeat(98)}。` })

await it('小文档特例：全文 ≤ chunk_size → **恰好 1 块**，且与原文逐字相同（不被切开）', async () => {
  // `docs/06` 该批验收原句："传 200 字短通知 → 恰好 1 个 chunk（不被切开）"
  const notice = '通'.repeat(200)
  const noticeChunks = splitIntoChunks(flatDoc(notice), CHUNK_OPT)
  assertEqual(noticeChunks.length, 1, '200 字短通知应恰好 1 块')
  assertEqual(noticeChunks[0].content, notice, '单块的内容应与原文逐字相同')
  assertEqual(noticeChunks[0].seq, 0, '首块 seq 从 0 起（`chunks.seq` 的口径）')

  // 带 3 个标题但全文只有 80 字（去空白后）的 md：小文档特例判在"全文"而不是"每个 Section"
  // ⇒ 仍然是 1 块（按 Section 判会切出 4 块，与验收原句矛盾）
  const markdown = fixtures.makeMarkdown()
  const mdParsed = await parseFixture('staff.md', markdown)
  assertEqual(mdParsed.meta.hasHeadings, true, 'md 夹具应当解析出标题结构（否则下一条断言失去意义）')
  const mdChunks = splitIntoChunks(mdParsed, CHUNK_OPT)
  assertEqual(mdChunks.length, 1, '全文 ≤ chunk_size 时即使有多个标题也只出 1 块')
  assertEqual(mdChunks[0].content, mdParsed.text, '整块内容应与 parsed.text 逐字相同')
})

await it('hybrid：边界**回退到句末**（首块长度小于 chunk_size，末字符是句末边界）', async () => {
  // 这条是 hybrid 与 fixed 的分水岭：不做回退的实现会在 chunk_size 处硬切（首块恰好 512 字、
  // 且末字符是"甲"），而 `docs/06` 的验收要求"chunk 边界落在句末"。
  const docx = fixtures.makeDocx(LONG_DOCX_BLOCKS)
  const parsed = await parseFixture('staff.docx', docx)
  const chunks = splitIntoChunks(parsed, CHUNK_OPT)
  assert(chunks.length >= 2, `长文档应切成多块，实际 ${chunks.length} 块`)

  const first = chunks[0]
  const firstChars = cps(first.content)
  assert(
    firstChars.length < CHUNK_OPT.chunkSize,
    `首块长度应小于 chunk_size（回退过），实际 ${firstChars.length}`,
  )
  const lastChar = firstChars[firstChars.length - 1]
  assert(
    SENTENCE_BOUNDARY_CHARS.includes(lastChar),
    `首块末字符应是句末边界，实际 ${JSON.stringify(lastChar)}（硬切会落在"甲"上）`,
  )
  // 回退到段末 ⇒ 末字符就是段间分隔符（`\n`）—— 顺带证明"段间分隔符也算边界"这个扩充分支生效
  assertEqual(lastChar, '\n', '本夹具的最近边界是段间换行')
  // 每段的句号都完整保留（没有把某一段的句号切到下一块去）
  assert(cps(first.content).filter((ch) => ch === '。').length === 4, '首块应完整包含前 4 段的句号')
})

await it('不变式：每一块都是 `parsed.text` 的**逐字子串**（P0-1-20 的引用片段靠它）', async () => {
  // 整条链只做"取连续区间"（重叠也是取前一块尾部）⇒ 不存在"重新拼接出原文里没有的句子"。
  // P0-1-20 要输出"snippet 与原文逐字一致"，这条不变式就是它的前提；破了则引用无法核对。
  for (const [fileName, bytes] of [
    ['staff.docx', fixtures.makeDocx(LONG_DOCX_BLOCKS)],
    ['staff.md', fixtures.makeMarkdown()],
    ['staff.txt', fixtures.makeTxtUtf8()],
  ]) {
    const parsed = await parseFixture(fileName, bytes)
    const chunks = splitIntoChunks(parsed, CHUNK_OPT)
    assert(chunks.length > 0, `${fileName} 应至少产出 1 块`)
    for (const chunk of chunks) {
      assert(
        parsed.text.includes(chunk.content),
        `${fileName} 的第 ${chunk.seq} 块不是原文的逐字子串：${JSON.stringify(chunk.content.slice(0, 40))}…`,
      )
    }
  }
})

await it('重叠：第 2 块以第 1 块末尾 chunk_overlap 个字符开头，且块长 ≤ chunk_size + overlap', async () => {
  const parsed = await parseFixture('staff.docx', fixtures.makeDocx(LONG_DOCX_BLOCKS))
  const chunks = splitIntoChunks(parsed, CHUNK_OPT)
  assert(chunks.length >= 2, '本夹具应至少 2 块')
  const first = cps(chunks[0].content)
  const second = cps(chunks[1].content)
  const expectedPrefix = first.slice(first.length - CHUNK_OPT.chunkOverlap).join('')
  assertEqual(
    second.slice(0, CHUNK_OPT.chunkOverlap).join(''),
    expectedPrefix,
    '第 2 块开头应是第 1 块的末 chunk_overlap 个字符（重叠是"取前块尾"，不是新造的句子）',
  )
  // 上界：重叠前缀 + 段体 ≤ chunk_size + overlap（尾块合并那一条会再放宽 chunk_min，见下一例）
  for (const chunk of chunks) {
    assert(
      cps(chunk.content).length <= CHUNK_OPT.chunkSize + CHUNK_OPT.chunkOverlap,
      `块长 ${cps(chunk.content).length} 越界（应 ≤ ${CHUNK_OPT.chunkSize + CHUNK_OPT.chunkOverlap}）`,
    )
  }
})

await it('尾块合并：尾块 < chunk_min 并入前块（与 fixed 的对照证明是 hybrid 的行为）', async () => {
  // 561 字：chunkSize(512) + 49（< chunk_min 50）且**通篇没有句读**
  // ⇒ hybrid 应并成 1 块 561 字；fixed 不做合并，会切成 512 + 113（重叠后）
  const flat = flatDoc('丙'.repeat(561))
  const hybridChunks = splitIntoChunks(flat, CHUNK_OPT)
  assertEqual(hybridChunks.length, 1, 'hybrid：49 字的尾块应并入前块 ⇒ 只剩 1 块')
  assertEqual(cps(hybridChunks[0].content).length, 561, '合并后的块应包含全部 561 字')

  const fixedChunks = splitIntoChunks(flat, CHUNK_OPT, 'fixed')
  assertEqual(fixedChunks.length, 2, 'fixed 不做尾块合并 ⇒ 2 块（这正是两者的差别）')
})

await it('fixed：定长滑窗，块长恒 ≤ chunk_size（+重叠），且首块就是 chunk_size', async () => {
  const chunks = splitIntoChunks(flatDoc('丁'.repeat(1000)), CHUNK_OPT, 'fixed')
  // 1000 = 512 + 488，步长 = 512 − 64 = 448 ⇒ 起点 0 / 448 / 896 → 3 块
  assertEqual(chunks.map((chunk) => cps(chunk.content).length).join(','), '512,512,104', '定长滑窗的块长序列')
  assertEqual(chunks.map((chunk) => chunk.seq).join(','), '0,1,2', 'seq 连续且从 0 起')
})

await it('单位是**码点**：长 emoji 文本按 fixed 切不会劈开代理对', () => {
  // `.length` 会把 emoji 数成 2，用 `text.slice()` 就可能只取到半个代理对 ——
  // 产出的是**非法字符串**（下游 embedding 直接报错），而**本层没有任何报错**。
  const emoji = '😀'.repeat(600)
  const chunks = splitIntoChunks(flatDoc(emoji), CHUNK_OPT, 'fixed')
  assertEqual(chunks.map((chunk) => cps(chunk.content).length).join(','), '512,152', '按码点计的长度')
  for (const chunk of chunks) {
    assert(
      cps(chunk.content).every((char) => char === '😀'),
      `第 ${chunk.seq} 块里出现了半个代理对（说明是按 UTF-16 下标切的）`,
    )
  }
})

await it('页码 meta 取"块起点所在页"：跨页的块不会被说成第 1 页', async () => {
  // PDF 夹具每页 20 行（必须**折行**：单条超长 `Tj` 会超出 MediaBox，pdf.js 只提取页面框内的文本，
  // 于是被静默截断 —— 见 `issue_fix/问题记录-P0-1-18-*.md`）
  const lines = (tag) => Array.from({ length: 20 }, (_, i) => `${tag} line ${i + 1} ${'x'.repeat(20)}`)
  const parsed = await parseFixture('two-pages.pdf', fixtures.makePdf([lines('alpha'), lines('bravo')]))
  assertEqual(parsed.meta.pageCount, 2, 'PDF 夹具应有 2 页')
  assertEqual(parsed.blocks.map((block) => block.page).join(','), '1,2', '每个段应带上自己的页码')

  const chunks = splitIntoChunks(parsed, CHUNK_OPT)
  assertEqual(chunks.length, 3, '1222 字按默认参数应切 3 块')
  assertEqual(chunks[0].meta.page, 1, '首块的起点落在第 1 页')
  assertEqual(chunks[chunks.length - 1].meta.page, 2, '末块的起点落在第 2 页（按 Section 取页码的实现会说成 1）')
})

await it('同名标题**不相邻**时不合并（顺序保持 = 与原文一致）', () => {
  // 按 `headingPath` 分组（Map）的实现会把两段"考勤"并到一起，于是第二段被排到"报销"前面。
  // 这种错位在检索层几乎无法发现：命中的片段读起来通顺，只是位置不对。
  const body = '甲'.repeat(300)
  const blocks = [
    { text: body, headingPath: ['考勤'], page: null },
    { text: '乙'.repeat(300), headingPath: ['报销'], page: null },
    { text: body, headingPath: ['考勤'], page: null },
  ]
  const parsed = {
    blocks,
    text: blocks.map((block) => block.text).join('\n\n'),
    meta: { format: 'docx', pageCount: null, charCount: 900, hasHeadings: true, encoding: 'utf-8' },
  }
  const chunks = splitIntoChunks(parsed, CHUNK_OPT)
  assertEqual(chunks.length, 3, '三个同名/异名交替的段各占一块')
  assertEqual(
    chunks.map((chunk) => chunk.meta.headingPath.join('/')).join(','),
    '考勤,报销,考勤',
    '标题路径应随原文顺序（合并实现的输出是"考勤,考勤,报销"或少一块）',
  )
})

await it('策略注册表：默认与回落都是 hybrid，且策略名集合与 shared 的 `SPLIT_STRATEGIES` 同源', () => {
  assertEqual([...chunkStrategyNames()].sort().join(','), [...SPLIT_STRATEGIES].sort().join(','), '策略名集合')
  assertEqual(resolveChunkStrategy('hybrid').name, 'hybrid', '按名取 hybrid')
  assertEqual(resolveChunkStrategy('fixed').name, 'fixed', '按名取 fixed')
  // 未知值退默认而不是抛错：补默认值的口径由 `normalizeRetrievalConfig` 定死（"永不抛错"），
  // 这里再抛一次等于同一件事两个相反口径；且报错代价是"文档被标成 FAILED、用户去重传"。
  assertEqual(resolveChunkStrategy('nope').name, 'hybrid', '未知策略回落 hybrid')
  assertEqual(splitIntoChunks(flatDoc('戊'.repeat(100)), CHUNK_OPT).length, 1, '省略策略参数时走默认 hybrid')
  assertEqual(DEFAULT_CHUNK_MIN_CHARS, 50, 'chunk_min 是 §二 的 50（它不是环境变量，见 strategy.ts 注释）')
})

// ── 21. 覆盖重建 / 重试 / 删除的契约与路由（P0-1-19）──
console.log(`\n${c.b}── 覆盖重建 / 重试 / 删除 endpoints（契约 + 路由注册）──${c.x}`)

/** 文档项的样例（与 §18 那份同形，改动字段时两处都要看） */
const DOC_SAMPLE = {
  id: '01a0c289-6738-715c-a10c-ef95c1286bf9',
  kbId: '01a0c289-6738-715c-a10c-ef95c1286bf9',
  fileName: '员工手册.pdf',
  status: 'PARSING',
  chunkCount: 0,
  errorMsg: null,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
}

await it('三条新路由已注册（都是文档路径下的子路径，不是查询参数分流）', () => {
  // 子路径而不是 `/reupload?id=...`：与 P0-1-11/12 同一条结论 —— 同路径同方法注册两次会在
  // **启动期**抛 `FST_ERR_DUPLICATED_ROUTE`，能挂上就说明是干净的分流
  assertEqual(
    app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents/:docId/reupload' }),
    true,
    '覆盖重建路由',
  )
  assertEqual(
    app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents/:docId/retry' }),
    true,
    '重试路由',
  )
  assertEqual(
    app.hasRoute({ method: 'DELETE', url: '/api/knowledge-bases/:id/documents/:docId' }),
    true,
    '删除路由',
  )
  // 上传那条仍在（子路径不该把它挤掉）
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents' }), true, '上传路由')
  // 列表与下载在 P0-1-21 已落地（本节只断言"当时刻意没有"的那两条现在有了；
  // 它们自身的契约在下面第 23 节）
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/:id/documents' }), true, '列表路由')
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/:id/documents/:docId/download' }),
    true,
    '下载路由',
  )
})

await it('上传与覆盖重建的响应字段名**刻意不同**：`deduplicated` ≠ `unchanged`', () => {
  // 两者回答的问题不同（见 `shared/src/document.ts` 的注释）：上传的 `deduplicated` 是
  // "库里已有同样内容 ⇒ 没产生新文档"；重建的 `unchanged` 是"**这一篇**没变 ⇒ 没跑流水线"。
  // 串味的后果是前端分不清"要不要刷新列表"与"要不要提示内容没变"
  assertEqual(
    reuploadDocumentResultSchema.safeParse({ document: DOC_SAMPLE, unchanged: true }).success,
    true,
    '重建响应 schema',
  )
  assertEqual(
    reuploadDocumentResultSchema.safeParse({ document: DOC_SAMPLE }).success,
    false,
    '`unchanged` 是必填（省略会让前端无法区分"没变"与"不知道"）',
  )
  assertEqual(
    uploadDocumentResultSchema.safeParse({ document: DOC_SAMPLE, unchanged: true }).success,
    false,
    '上传响应不该接受 `unchanged`',
  )
  assertEqual(
    reuploadDocumentResultSchema.safeParse({ document: DOC_SAMPLE, deduplicated: true }).success,
    false,
    '重建响应不该接受 `deduplicated`',
  )
})

await it('重试与删除的响应契约（`retryDocumentResultSchema` / `removeDocumentResultSchema`）', () => {
  assertEqual(retryDocumentResultSchema.safeParse({ document: DOC_SAMPLE }).success, true, '重试响应')
  assertEqual(retryDocumentResultSchema.safeParse({}).success, false, '重试响应必须带 document')
  assertEqual(
    removeDocumentResultSchema.safeParse({ id: DOC_SAMPLE.id, fileName: 'a.txt', deletedChunks: 3 }).success,
    true,
    '删除响应',
  )
  assertEqual(
    removeDocumentResultSchema.safeParse({ id: DOC_SAMPLE.id, fileName: 'a.txt', deletedChunks: -1 }).success,
    false,
    '`deletedChunks` 不能为负（界面要拿它给提示）',
  )
  // 路径参数：三个端点共用两个 UUID 的口径
  assertEqual(
    documentParamsSchema.safeParse({ id: DOC_SAMPLE.id, docId: DOC_SAMPLE.id }).success,
    true,
    '两段 UUID 合法',
  )
  assertEqual(
    documentParamsSchema.safeParse({ id: DOC_SAMPLE.id, docId: 'not-a-uuid' }).success,
    false,
    'docId 必须是 UUID',
  )
})

await it('「内容未变化，已跳过」是 shared 里的常量（前后端共用同一句，避免文案漂移）', () => {
  // 与 `LEGACY_DOC_HINT` 同款：这条提示是"用户的下一步动作"（别传了 / 去改内容），
  // 措辞漂了就会让人以为是两种问题
  assertEqual(REUPLOAD_UNCHANGED_HINT, '内容未变化，已跳过', '提示文案')
})

// ── 22. 双路检索 + RRF 融合的契约与纯函数（P0-1-20）──
console.log(`\n${c.b}── 检索契约与 RRF 纯函数（双路分数 / 融合公式 / 引用片段）──${c.x}`)

await it('检索路由已注册（列表与下载在 P0-1-21 补上，本节只管检索这一条）', () => {
  assertEqual(
    app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/search' }),
    true,
    '检索路由（`02` §4.6）',
  )
  // 检索是"读侧"的入口，不该顺带注册出别的写操作
  assertEqual(app.hasRoute({ method: 'DELETE', url: '/api/knowledge-bases/:id/search' }), false, '不该有 DELETE /search')
})

await it('检索请求体契约：`query` 必填非空、`mode` 三值、`topK` 有界（覆盖只对本次请求生效）', () => {
  assertEqual(searchKnowledgeBaseBodySchema.safeParse({ query: '报销标准' }).success, true, '最小请求体')
  assertEqual(searchKnowledgeBaseBodySchema.safeParse({}).success, false, 'query 必填')
  assertEqual(searchKnowledgeBaseBodySchema.safeParse({ query: '   ' }).success, false, 'trim 后为空 ⇒ 不合法')
  assertEqual(searchKnowledgeBaseBodySchema.safeParse({ query: 'a'.repeat(1000) }).success, true, '上限边界')
  assertEqual(searchKnowledgeBaseBodySchema.safeParse({ query: 'a'.repeat(1001) }).success, false, '超上限')
  assertEqual(
    searchKnowledgeBaseBodySchema.safeParse({ query: '报销', mode: 'SEMANTIC' }).success,
    false,
    '`mode` 只能是 HYBRID/VECTOR/FULLTEXT',
  )
  assertEqual(searchKnowledgeBaseBodySchema.safeParse({ query: '报销', topK: 0 }).success, false, 'topK 下界')
  assertEqual(searchKnowledgeBaseBodySchema.safeParse({ query: '报销', topK: 101 }).success, false, 'topK 上界')
  assertEqual(
    searchKnowledgeBaseBodySchema.safeParse({ query: '报销', topK: 3, mode: 'FULLTEXT' }).success,
    true,
    '试查页要能"同一 query 试三种模式"（覆盖只影响本次请求，服务层有用例证明不落库）',
  )
  // 必填语义的**文案**也要断言（P0-1-11 的教训：只断言"校验失败"会让"必填被降级成通用类型错误"漏过去）
  const missing = searchKnowledgeBaseBodySchema.safeParse({})
  assertIncludes(JSON.stringify(missing.error.issues), '请输入检索内容', '必填文案')
})

await it('结果契约：六列齐备，且 `null`（未命中）与 `0`（命中但分数为 0）是两件事', () => {
  const hit = {
    chunkId: DOC_SAMPLE.id,
    docId: DOC_SAMPLE.id,
    docName: '报销制度.txt',
    seq: 3,
    page: null,
    headingPath: [],
    snippet: '……出差住宿标准为……',
    vectorScore: 0,
    vectorRank: 3,
    fulltextScore: 0.31,
    fulltextRank: 1,
    rrfScore: 0.032,
    finalRank: 1,
  }
  assertEqual(retrievalHitSchema.safeParse(hit).success, true, '完整命中')
  assertEqual(
    retrievalHitSchema.safeParse({ ...hit, vectorScore: null, vectorRank: null }).success,
    true,
    '一路未命中是 `null`（不是 0 —— 前端据此显示 `—`）',
  )
  const withoutRrf = { ...hit }
  delete withoutRrf.rrfScore
  assertEqual(retrievalHitSchema.safeParse(withoutRrf).success, false, '`rrfScore` 必填（融合分是排序依据）')
  assertEqual(
    retrievalHitSchema.safeParse({ ...hit, headingPath: undefined }).success,
    false,
    '`headingPath` 必填（引用卡要显示"在哪一节"，空数组表示无标题）',
  )

  assertEqual(
    searchKnowledgeBaseResultSchema.safeParse({
      items: [hit],
      mode: 'HYBRID',
      topK: 5,
      rrfK: 60,
      candidatePool: 15,
      elapsedMs: 12,
      vectorPathSkipped: false,
      warnings: [],
    }).success,
    true,
    '完整响应',
  )
  assertEqual(
    searchKnowledgeBaseResultSchema.safeParse({
      items: [],
      mode: 'HYBRID',
      topK: 5,
      rrfK: 60,
      candidatePool: 15,
      elapsedMs: -1,
      vectorPathSkipped: false,
      warnings: [],
    }).success,
    false,
    '`elapsedMs` 不能为负',
  )
})

await it('RRF 融合公式：两路都在、只在单路、权重为 0 —— 逐项按 §6-2 的公式反算', () => {
  const weights = { vector: 1, fulltext: 1 }
  // 三个数值同时也是 `子方案①` §6-2 那个"反直觉但正确"的例子（**实测值**，不是纸上推的）
  assertEqual(
    rrfScoreOf({ vectorRank: 1, fulltextRank: null, rrfK: 60, weights }).toFixed(4),
    '0.0164',
    '单路第 1 名：1/(60+1)',
  )
  assertEqual(
    rrfScoreOf({ vectorRank: 1, fulltextRank: 1, rrfK: 60, weights }).toFixed(4),
    '0.0328',
    '两路都第 1：2/61',
  )
  assertEqual(
    rrfScoreOf({ vectorRank: 1, fulltextRank: 4, rrfK: 60, weights }).toFixed(4),
    '0.0320',
    '向量第 1 + 全文第 4：1/61 + 1/64（⚠️ 文档原写 0.0323，实测是 0.0320，已回写订正）',
  )
  assertEqual(
    rrfScoreOf({ vectorRank: null, fulltextRank: null, rrfK: 60, weights }),
    0,
    '两路都没命中 ⇒ 0（但**不会出现在结果里**：融合的输入就是两路命中的并集）',
  )
  assertEqual(
    rrfScoreOf({ vectorRank: 1, fulltextRank: null, rrfK: 60, weights: { vector: 0, fulltext: 1 } }),
    0,
    '权重为 0 ⇒ 该路不贡献（权重是"要不要算这一路"，不是"降权"）',
  )
  assertEqual(
    rrfScoreOf({ vectorRank: null, fulltextRank: 1, rrfK: 60, weights: { vector: 0, fulltext: 1 } }).toFixed(4),
    '0.0164',
    '权重只影响各自那一项',
  )
})

await it('融合排序：并集去重、按 `rrfScore` 降序、同分按 `chunkId` 升序（**只看排名，不看原始分**）', () => {
  const weights = { vector: 1, fulltext: 1 }
  const fused = fuseRrf({ vector: ['b', 'a', 'c'], fulltext: ['c'], rrfK: 60, weights })
  // c：向量第 3 + 全文第 1 ⇒ 1/63 + 1/61 = 0.0323（**双路共同认可能压过单路第 1 名**，§6-2 的设计意图）
  // b：向量第 1 ⇒ 1/61 = 0.0164；a：向量第 2 ⇒ 1/62 = 0.0161
  assertEqual(fused.map((row) => row.chunkId).join(','), 'c,b,a', '排序结果')
  assertClose(fused[0].rrfScore, 1 / 63 + 1 / 61, '双路命中的融合分')
  assertClose(fused[1].rrfScore, 1 / 61, '单路命中的融合分（缺失的一路记 0）')
  assert(fused[0].rrfScore > fused[1].rrfScore, '「两路都在」应当赢「单路第 1」—— 这正是混合检索相比单路的价值')
  assertEqual(fused.length, 3, '并集去重：c 只出现一条（同一块在两路命中不会变成两条）')
  assertEqual(fused.find((row) => row.chunkId === 'c').vectorRank, 3, '同一块的两路名次并存')
  assertEqual(fused.find((row) => row.chunkId === 'c').fulltextRank, 1, '同一块的两路名次并存')

  // 同分时必须**确定**（否则"同一 query 两次调用顺序不同"会让分页与问题复现全部失去意义）
  const tieA = fuseRrf({ vector: ['zz'], fulltext: ['aa'], rrfK: 60, weights })
  const tieB = fuseRrf({ vector: ['aa'], fulltext: ['zz'], rrfK: 60, weights })
  assertEqual(tieA.map((row) => row.chunkId).join(','), 'aa,zz', '同分按 id 升序')
  assertEqual(
    tieB.map((row) => row.chunkId).join(','),
    tieA.map((row) => row.chunkId).join(','),
    '同分结果与输入顺序无关（这就是"确定性"的含义）',
  )
})

await it('全文路 query 预处理：**只剥首尾脚手架**、剔标点（含 LIKE 通配符）、按码点截断', () => {
  assertEqual(normalizeFulltextQuery('请问出差住宿标准是多少？').text, '出差住宿标准', '剥掉首尾的提问脚手架')
  assertEqual(
    normalizeFulltextQuery('报销的标准是什么').text,
    '报销的标准',
    '⚠️ **不删中间的停用词**：LIKE 要连续子串，把中间的"的"删掉会把能命中的变成命中不了',
  )
  assertEqual(normalizeFulltextQuery('报销的标准与流程').text, '报销的标准与流程', '两端没有脚手架 ⇒ 原样')
  assertEqual(normalizeFulltextQuery('呀呀呀报销呀呀').text, '报销', '两端可反复剥（循环到稳定）')
  assertEqual(normalizeFulltextQuery('5%0').text, '50', '`%` 被剔除（否则 LIKE 会变成模式匹配）')
  assertEqual(normalizeFulltextQuery('100_元').text, '100元', '`_` 同样是 LIKE 通配符')
  assertEqual(normalizeFulltextQuery('😀😀').skipped, true, '表情属 `\\p{S}` ⇒ 剔除后没有有效字符')
  assertEqual(normalizeFulltextQuery('的').skipped, true, '单个虚词剥到等长就不剥 ⇒ 交给"过短"判定（不静默变空）')
  assertEqual(normalizeFulltextQuery('报').skipped, true, '`< 2` 字跳过全文路（§十三 待决事项 2）')
  assertEqual(normalizeFulltextQuery('报销').skipped, false, '恰好 2 字 ⇒ 走全文路')

  // 截断单位是**码点**：`slice()` 会把 64 切在 32 个代理对上（本层毫无报错，下游才对不上）
  const astral = '𠮷'.repeat(100)
  const truncated = normalizeFulltextQuery(astral).text
  assertEqual([...truncated].length, FULLTEXT_QUERY_MAX_CHARS, '截断到 64 个**字符**')
  assertEqual(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(truncated),
    false,
    '不得劈开代理对（否则产出非法字符串）',
  )
  assertEqual(FULLTEXT_QUERY_MAX_CHARS, 64, '上限值（§6-1 定案）')
  assertEqual(FULLTEXT_QUERY_MIN_CHARS, 2, '下限值（§十三 待决事项 2 定案）')
})

await it('引用片段：窗口 ±80 字符、按码点、**不加工**（加了省略号就不再是原文子串）', () => {
  const content = '零一二三四五六七八九'
  assertEqual(buildSnippet(content, '五六', 2), '三四五六七八', '命中居中：前后各 2 个字符')
  assertEqual(buildSnippet(content, '零', 2), '零一二', '命中贴文首：窗口在 0 处裁剪')
  assertEqual(buildSnippet(content, '九', 2), '七八九', '命中贴文末：窗口在末尾裁剪')
  assertEqual(buildSnippet(content, '不存在', 2), '零一二三', '字面未命中 ⇒ 取块首窗口（没有"命中位置"可取）')
  for (const needle of ['五六', '零', '九', '不存在']) {
    assert(content.includes(buildSnippet(content, needle, 2)), `“${needle}” 的片段必须是原文的**逐字子串**`)
  }
  assertEqual(
    buildSnippet(content, '五六', SNIPPET_WINDOW_CHARS),
    content,
    '夹具比窗口短时整块返回（窗口不会越界）',
  )
  assertEqual(SNIPPET_WINDOW_CHARS, 80, '窗口半径（§九 定案）')

  // 窗口边界落在代理对中间时也必须合法（P0-1-18 的同款教训）
  const astralContent = `前面是普通文字${'𠮷'.repeat(20)}后面也是普通文字`
  const astralSnippet = buildSnippet(astralContent, '前面', 1)
  assertEqual(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(astralSnippet),
    false,
    '窗口切片不得劈开代理对',
  )
})

await it('降级的提示文案是 shared 常量（前后端共用同一句），且两种原因**不混用**', () => {
  assert(VECTOR_PATH_SKIPPED_MODEL_CHANGED.length > 0, '模型变更的提示')
  assert(VECTOR_PATH_SKIPPED_NOT_READY.length > 0, '未就绪的提示')
  assert(
    VECTOR_PATH_SKIPPED_MODEL_CHANGED !== VECTOR_PATH_SKIPPED_NOT_READY,
    '两种原因必须分开：一个要运维修配置，一个要业务重建（合成一句会让用户去做治不好的动作）',
  )
  assertIncludes(FULLTEXT_PATH_SKIPPED_TOO_SHORT, String(FULLTEXT_QUERY_MIN_CHARS), '过短的提示里要带上阈值')
})

// ── 23. 文档列表 / 下载 与"可检索"判据（P0-1-21，包 D 收口）──
console.log(`\n${c.b}── 列表 / 下载契约 与 可检索判据（分页 / Content-Disposition / 三态提示）──${c.x}`)

await it('两条新路由已注册；文档路径下不该出现第四条"同路径同方法"', () => {
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/:id/documents' }), true, '列表路由')
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/knowledge-bases/:id/documents/:docId/download' }),
    true,
    '下载路由',
  )
  // 四条老路由仍在（新增子路径不该把它们挤掉）
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents' }), true, '上传')
  assertEqual(
    app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents/:docId/reupload' }),
    true,
    '覆盖重建',
  )
  assertEqual(
    app.hasRoute({ method: 'POST', url: '/api/knowledge-bases/:id/documents/:docId/retry' }),
    true,
    '重试',
  )
  assertEqual(app.hasRoute({ method: 'DELETE', url: '/api/knowledge-bases/:id/documents/:docId' }), true, '删除')
  // `PATCH /:docId` 之类**刻意不存在**：文档内容只能靠覆盖重建换，不存在"改个名字"的入口
  assertEqual(
    app.hasRoute({ method: 'PATCH', url: '/api/knowledge-bases/:id/documents/:docId' }),
    false,
    '不应有 PATCH 文档',
  )
})

await it('列表查询契约：offset/limit 与其余列表同口径（含字符串 coercion 与上限 100）', () => {
  assertEqual(listDocumentsQuerySchema.safeParse({}).success, true, '两个都可省')
  assertEqual(listDocumentsQuerySchema.parse({}).offset, 0, 'offset 默认 0')
  assertEqual(listDocumentsQuerySchema.parse({}).limit, 20, 'limit 默认 20')
  assertEqual(listDocumentsQuerySchema.parse({ limit: '5' }).limit, 5, 'query string 要能 coerce')
  assertEqual(listDocumentsQuerySchema.safeParse({ limit: 101 }).success, false, 'limit 上限 100')
  assertEqual(listDocumentsQuerySchema.safeParse({ offset: -1 }).success, false, 'offset 不能为负')
})

await it('列表响应契约：与上传响应**同一套投影**（同一份数据不许有第二种形状）', () => {
  const item = {
    id: DOC_SAMPLE.id,
    kbId: DOC_SAMPLE.kbId,
    fileName: '报销制度.txt',
    status: 'READY',
    chunkCount: 3,
    errorMsg: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  }
  const parsed = documentListResultSchema.safeParse({ items: [item], total: 1, offset: 0, limit: 20 })
  assertEqual(parsed.success, true, '完整响应')
  assertEqual(
    documentListResultSchema.safeParse({ items: [item], total: 1, offset: 0 }).success,
    false,
    '分页三件套一个都不能少（前端分页器靠它）',
  )
  // 同一个 `documentItemSchema`：把上传响应的样例直接塞进列表项也必须过
  assertEqual(documentItemSchema.safeParse(item).success, true, '列表项应能被上传响应的 schema 解析')
  assertEqual(
    documentItemSchema.safeParse({ ...item, status: 'DONE' }).success,
    false,
    '状态只能是 PARSING/READY/FAILED',
  )
})

await it('"可检索"的判据与"更新中"的文案：`READY` 是唯一可检索态，且 `PARSING` ≠ `FAILED`', () => {
  // 这条判据的语义变过一次（P0-1-17 的 READY 只是"解析完成"，P0-1-19 起才是"可检索"），
  // 故收进 shared 成一个函数，而不是让各处写 `status === 'READY'` 的字面量比较
  assertEqual(DOCUMENT_STATUSES.filter((status) => isDocumentSearchable(status)).join(','), 'READY', '唯一可检索态')
  assertEqual(isDocumentSearchable('PARSING'), false, '还在处理 ⇒ 查不到（`§七` 的检索空窗）')
  assertEqual(isDocumentSearchable('FAILED'), false, '失败要人介入 ⇒ 也查不到')
  assertEqual(DOCUMENT_PARSING_HINT, '更新中，暂不参与检索', '提示文案（前后端共用同一句）')
  assert(!DOCUMENT_PARSING_HINT.includes('失败'), '⚠️ 这句话不能说成"失败"：PARSING 是我们还在干活')
})

await it('`Content-Disposition`：RFC 6266 双写、中文名可还原、路径与引号被清理', () => {
  const chinese = buildContentDisposition('报销制度（2026版）.pdf')
  assertIncludes(chinese, 'attachment;', '必须是另存为')
  assertIncludes(chinese, "filename*=UTF-8''", '必须有 RFC 5987 形式')
  assertEqual(
    decodeURIComponent(/filename\*=UTF-8''([^;]+)/u.exec(chinese)[1]),
    '报销制度（2026版）.pdf',
    '`filename*` 必须能还原中文原名',
  )
  const ascii = /filename="([^"]*)"/u.exec(chinese)[1]
  assert(/^[\u0020-\u007e]*$/u.test(ascii), `ASCII 回落里不该有非 ASCII：${ascii}`)
  // 规则是"非 ASCII 逐个换 `_`、ASCII 原样保留"，故 `报销制度（2026版）.pdf` →
  // `_____2026__.pdf`（前 5 个非 ASCII = 报销制度（，后 2 个 = 版））。写成**逐字期望值**
  // 而不是"看着像就行"：这条回落规则一旦被改成音译/截断，下游的"另存为文件名"就变了。
  assertEqual(ascii, '_____2026__.pdf', '非 ASCII 逐个替换成 _（不做音译：真名在 filename* 里）')

  // ⚠️ 安全：文件名是用户给的（老浏览器还会塞进整条本地路径）⇒ 必须挡住头注入与路径逃逸。
  //    注意 `\r\n` 是**删掉**而不是转义：CR/LF 在头部里没有任何正当用途，删掉就断了"响应拆分"
  //    这条路；剩下的 `X-Evil: 1` 只是一段无害的文件名文本（它不再独占一行）。
  const injected = buildContentDisposition('a\r\nX-Evil: 1.txt')
  assert(
    !injected.includes('\r') && !injected.includes('\n'),
    `不得含 CR/LF（响应头注入）：${JSON.stringify(injected)}`,
  )
  assertEqual(injected.split('\n').length, 1, '清理后仍必须是**单行**（多一行就是注入成功）')
  assertIncludes(injected, 'filename="aX-Evil: 1.txt"', '控制字符被删掉，其余文本原样保留')
  const pathful = buildContentDisposition('../../etc/passwd')
  assert(!pathful.includes('/'), `不得残留路径分隔符：${JSON.stringify(pathful)}`)
  const quoted = buildContentDisposition('他说"你好".txt')
  assertEqual(
    /filename="([^"]*)"/u.exec(quoted)[1].includes('"'),
    false,
    '引号必须被替换（否则会提前闭合 filename="..." 这个引号串）',
  )
})

await it('`Content-Disposition` 的边界：空名回落、RFC 5987 的额外转义（`\'`/`(`/`)`/`*`）', () => {
  const empty = buildContentDisposition('   ')
  assertIncludes(empty, 'filename="document.bin"', '空名要有可用的回落名')
  assertIncludes(empty, "filename*=UTF-8''document.bin", '回落名同时进 filename*')

  // `encodeURIComponent` 会放过 `!'()*`，而 RFC 5987 的 attr-char **不含** `'()*` ⇒ 必须自己转义
  const tricky = buildContentDisposition("a'b(c)d*e.txt")
  const encoded = /filename\*=UTF-8''([^;]+)/u.exec(tricky)[1]
  for (const ch of ["'", '(', ')', '*']) {
    assert(!encoded.includes(ch), `RFC 5987 的编码结果不该出现 ${ch}：${encoded}`)
  }
  assertEqual(decodeURIComponent(encoded), "a'b(c)d*e.txt", '转义之后仍要能解回原名')
})

await it('下载的口径表与上传白名单**不脱节**（下载给的类型必须是该扩展名允许的类型之一）', () => {
  // 服务层刻意没复用 `MIME_BY_EXTENSION`（那张表是"允许客户端声明哪几种"，语义是**多选**，
  // 而响应头只能有一个值）—— 代价是两张表可能漂移，这条断言就是防漂移的：
  // 把下载给出的类型（去掉 `charset` 参数）反查回上传白名单，必须命中；
  // 扩展名的集合则由 `UPLOAD_EXTENSIONS` 兜住（多一个扩展名而下载表没跟，这条会红）。
  for (const extension of UPLOAD_EXTENSIONS) {
    const type = downloadContentType(`样例.${extension}`)
    const bare = type.split(';')[0]
    assert(
      MIME_BY_EXTENSION[extension].includes(bare),
      `${extension} 的下载类型 ${type} 不在上传白名单 ${JSON.stringify(MIME_BY_EXTENSION[extension])} 里`,
    )
  }
  // 文本类型带 charset 是刻意的（不带时浏览器猜编码，中文会乱码）；未知扩展名回落到二进制
  assertIncludes(downloadContentType('a.txt'), 'charset=utf-8', 'txt 要声明编码')
  assertEqual(downloadContentType('a.pdf'), 'application/pdf', 'pdf 不带 charset')
  assertEqual(downloadContentType('无扩展名'), 'application/octet-stream', '未知扩展名回落二进制')
  assertEqual(downloadContentType('a.md'), 'text/markdown; charset=utf-8', 'md 的类型')
})

// ── 24. 智能体契约与路由（P0-1-22；组件绑定写侧 P0-1-23）──
console.log(`\n${c.b}── 智能体契约与路由（权限判据 / 三态 / 引导问题 / 组件绑定整体替换）──${c.x}`)

await it('六条路由已注册；复制（P1）**刻意不存在**（会话列表在 P0-1-25 已落地，见本节末尾）', () => {
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/agents' }), true, '列表')
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/agents' }), true, '创建')
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/agents/:id' }), true, '详情')
  assertEqual(app.hasRoute({ method: 'PATCH', url: '/api/agents/:id' }), true, '编辑')
  assertEqual(app.hasRoute({ method: 'DELETE', url: '/api/agents/:id' }), true, '删除')
  // ⚠️ P0-1-22 时这条写的是 `false`（"属 P0-1-23，本批不提前注册"）；本批落地后翻转为 `true`
  assertEqual(
    app.hasRoute({ method: 'PUT', url: '/api/agents/:id/components' }),
    true,
    '组件绑定整体替换（P0-1-23）',
  )
  // 复制是 **P1**（`02` §4.4 与 `01` §3.3 都标了 P1）
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/agents/:id/copy' }), false, '复制是 P1')
  // ⚠️ P0-1-22 时这条写的是 `false`（"属 P0-1-25"）；**P0-1-25 落地后翻转为 `true`**
  //    （注册在 `routes/conversations.ts`，它读的是 conversations 表）。断言翻转是"刻意不做"清单
  //    的例行收尾：留着旧的 `false` 会让下一批的"已落地"变成一条假红。
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/agents/:id/conversations' }),
    true,
    '会话列表（P0-1-25）',
  )
})

await it('权限判据 `canEditAgent`：四个方向（创建者 / ADMIN / 第三方 / 已软删）', () => {
  // ⚠️ 这条规则在 `01` §3.3 决策 18 里写作"创建者 + admin 可编删"，是**或**关系。
  //    写成"仅 ADMIN"或"仅创建者"都能让**一半**断言通过 ⇒ 四个方向必须都给。
  //    行为侧（403 / 200）由 `verify-agents.mjs` 用两个真实 MEMBER + 一个 ADMIN 覆盖：
  //    那里还有一个只在**这一档**能守的点 —— 判据是纯函数，改坏了不会有任何接口报错。
  const row = { createdBy: 'user-owner', deletedAt: null }
  assertEqual(canEditAgent(row, { id: 'user-owner', role: 'MEMBER' }), true, '创建者本人')
  assertEqual(canEditAgent(row, { id: 'user-admin', role: 'ADMIN' }), true, 'ADMIN 改别人的')
  assertEqual(canEditAgent(row, { id: 'user-other', role: 'MEMBER' }), false, '第三方普通用户')
  assertEqual(
    canEditAgent({ ...row, deletedAt: new Date() }, { id: 'user-admin', role: 'ADMIN' }),
    false,
    '软删的一律不可（它连详情都查不到）',
  )
  // 验收脚本从 JSON 里拿到的是**字符串**，判据必须同时认（否则"可编辑"会有第二份实现）
  assertEqual(
    canEditAgent({ ...row, deletedAt: '2026-09-22T00:00:00.000Z' }, { id: 'user-owner', role: 'MEMBER' }),
    false,
    'deletedAt 传字符串的形态',
  )
})

await it('`guideQuestions` 契约：上限 / 元素类型 / 空白项都给**字段级文案**', () => {
  assertEqual(guideQuestionsSchema.safeParse([]).success, true, '空数组合法（就是"清空"）')
  assertEqual(
    guideQuestionsSchema.safeParse(Array.from({ length: GUIDE_QUESTIONS_MAX }, (_, i) => `问${i}`)).success,
    true,
    `恰好 ${GUIDE_QUESTIONS_MAX} 条要放行`,
  )
  assertEqual(
    guideQuestionsSchema.safeParse(Array.from({ length: GUIDE_QUESTIONS_MAX + 1 }, (_, i) => `问${i}`)).success,
    false,
    `超过 ${GUIDE_QUESTIONS_MAX} 条要拒`,
  )
  assertEqual(guideQuestionsSchema.safeParse(['好', 3]).success, false, '元素必须是字符串')
  assertEqual(guideQuestionsSchema.safeParse('不是数组').success, false, '必须是数组')
  assertEqual(guideQuestionsSchema.safeParse(['   ']).success, false, '空白项要拒（渲染出来是个点不了的按钮）')
  assertEqual(guideQuestionsSchema.parse([' 空格 '])[0], '空格', '元素要 trim')
})

await it('`normalizeGuideQuestions`（读取端唯一入口）：永不抛错、只做类型收敛、**不截断**', () => {
  // jsonb 列可能是任何形状（手工改库 / 老数据），而前端对它 `.map()` ⇒ 拿到一个数字就是白屏。
  // 这是"读取端补默认值"（P0-1-15 的 `normalizeRetrievalConfig` 是同族问题）。
  assertEqual(JSON.stringify(normalizeGuideQuestions(undefined)), '[]', 'undefined')
  assertEqual(JSON.stringify(normalizeGuideQuestions(null)), '[]', 'null')
  assertEqual(JSON.stringify(normalizeGuideQuestions({ a: 1 })), '[]', '对象')
  assertEqual(JSON.stringify(normalizeGuideQuestions('字符串')), '[]', '字符串（`.map` 会炸在字符串上）')
  assertEqual(
    JSON.stringify(normalizeGuideQuestions([' a ', 3, null, '', '   ', 'b'])),
    JSON.stringify(['a', 'b']),
    '丢非字符串、丢 trim 后的空串、其余保持顺序',
  )
  assertEqual(
    normalizeGuideQuestions(Array.from({ length: GUIDE_QUESTIONS_MAX + 5 }, (_, i) => `问${i}`)).length,
    GUIDE_QUESTIONS_MAX + 5,
    '⚠️ 刻意**不截断**：截断等于静默丢数据（上限只在写入口拦）',
  )
})

await it('建/改 body 的三态与"不可改的 type"：`undefined`（不动）与 `null`（清空）必须分得开', () => {
  const validId = '01930000-0000-7000-8000-000000000001'
  const created = createAgentBodySchema.safeParse({ name: '探针', type: 'CHATBOT', modelId: validId })
  assertEqual(created.success, true, '三个必填给齐就能过')
  // ⚠️ 省略的可选字段**不能**被补成 `null`：补了就等于"创建时没给"与"显式清空"合并
  assertEqual(
    JSON.stringify(Object.keys(created.data).sort()),
    JSON.stringify(['modelId', 'name', 'type']),
    '省略项应**不出现**在解析结果里',
  )
  assertEqual(createAgentBodySchema.safeParse({ name: '缺类型', modelId: validId }).success, false, 'type 必填')
  assertEqual(createAgentBodySchema.safeParse({ name: '坏 id', type: 'CHATBOT', modelId: 'x' }).success, false, 'modelId 必须是 UUID')

  // 改：三态 + 至少一个字段
  assertEqual(updateAgentBodySchema.safeParse({}).success, false, '空 body 要拒')
  assertEqual(updateAgentBodySchema.safeParse({}).error.issues[0].message, '至少要提供一个要修改的字段', '空 body 的文案')
  assertEqual(updateAgentBodySchema.safeParse({}).error.issues[0].path.length, 0, '`.refine()` 的 path 是空串（只能靠 message 定位）')
  assertEqual(updateAgentBodySchema.safeParse({ description: null }).success, true, '`null` 算"给了字段"（清空）')
  assertEqual(updateAgentBodySchema.safeParse({ guideQuestions: [] }).success, true, '`[]` 算"给了字段"（清空）')
  assertEqual(
    updateAgentBodySchema.safeParse({ name: 'x' }).data.description,
    undefined,
    '⚠️ 三态：不带 description ⇒ `undefined`（绝不能有 `.default(null)`）',
  )
  assertEqual(updateAgentBodySchema.safeParse({ description: null }).data.description, null, '`null` 要保持是 null')
})

await it('组件绑定 body 契约（P0-1-23）：`components` 必填、重复项给**真 path**（与 `.refine()` 的空 path 对照）', () => {
  const kbId = '01930000-0000-7000-8000-000000000001'
  const mcpId = '01930000-0000-7000-8000-000000000002'
  const bind = (componentType, refId) => ({ componentType, refId })

  assertEqual(
    replaceAgentComponentsBodySchema.safeParse({ components: [] }).success,
    true,
    '空数组合法（**唯一**一种"解绑全部"的写法）',
  )
  assertEqual(
    replaceAgentComponentsBodySchema.safeParse({ components: [bind('KNOWLEDGE', kbId)] }).success,
    true,
    '一条合法绑定',
  )

  // 必填：省略 `components` 若被当作"清空"，前端某次忘带字段就会**静默解绑所有知识库**
  const missing = replaceAgentComponentsBodySchema.safeParse({})
  assertEqual(missing.success, false, '`components` 必填（清空要显式传 `[]`）')
  assertEqual(
    JSON.stringify(missing.error.issues[0].path),
    JSON.stringify(['components']),
    '缺字段的 path 指到 components',
  )
  assertEqual(
    replaceAgentComponentsBodySchema.safeParse({ components: 'x' }).success,
    false,
    '非数组要拒',
  )
  assertEqual(
    replaceAgentComponentsBodySchema.safeParse({ components: [bind('SANDBOX', kbId)] }).success,
    false,
    '枚举外的 componentType 要拒（组件范围只有知识库 + MCP）',
  )
  assertEqual(
    replaceAgentComponentsBodySchema.safeParse({ components: [bind('KNOWLEDGE', 'x')] }).success,
    false,
    'refId 必须是 UUID（列是 `@db.Uuid`，放非 uuid 过去只会变成一个 DB 500）',
  )

  // ⚠️ 与上面"空 body"那条**刻意对照**：`.refine()` 的 path 是空串（只能遍历 message 找），
  //    而 `superRefine` + `addIssue({ path })` 能给出真正的下标 —— 前端可以高亮到具体那一行。
  const dup = replaceAgentComponentsBodySchema.safeParse({
    components: [bind('KNOWLEDGE', kbId), bind('KNOWLEDGE', kbId)],
  })
  assertEqual(dup.success, false, '重复项要拒（否则落库撞 `@@unique(agentId, componentType, refId)` → P2002 → 500）')
  assertEqual(
    JSON.stringify(dup.error.issues[0].path),
    JSON.stringify(['components', 1, 'refId']),
    '重复项的 path 要精确到第 2 项',
  )
  assertEqual(
    replaceAgentComponentsBodySchema.safeParse({ components: [bind('MCP', mcpId)] }).success,
    true,
    'MCP 在**形态上**合法 —— 拒绝它是服务层的能力状态（`mcp_servers` 表属 P0-2），归 `verify-agents.mjs` H 组',
  )
})

await it('输出投影的键集合固定：没有 `deletedAt` 之类的内部列（防"以后有人顺手 select 出去"）', () => {
  // 取值域的字面量钉在这里（与真实数据库枚举的一致性由 `verify-agents.mjs` 对 `Object.values` 断言）
  assertEqual(JSON.stringify(AGENT_TYPES), JSON.stringify(['CHATBOT', 'TASK_AGENT']), 'Agent 类型取值域')
  assertEqual(JSON.stringify(COMPONENT_TYPES), JSON.stringify(['KNOWLEDGE', 'MCP']), '组件类型取值域')

  const keys = Object.keys(agentItemSchema.shape)
  // 软删标记是**内部**状态：列表默认过滤掉软删的行，把它下发出去只会诱使前端写
  // `if (agent.deletedAt)` 这种永远为假的分支。
  assertEqual(keys.includes('deletedAt'), false, '不该下发 deletedAt')
  for (const expected of [
    'id',
    'name',
    'description',
    'icon',
    'type',
    'systemPrompt',
    'openingRemarks',
    'guideQuestions',
    'modelId',
    'modelName',
    'modelLabel',
    'modelAvailable',
    'createdBy',
    'creatorName',
    'canEdit',
    'components',
    'createdAt',
    'updatedAt',
  ]) {
    assert(keys.includes(expected), `投影里应有 ${expected}`)
  }
  assertEqual(
    keys.length,
    18,
    `新增字段要连这条断言一起改（否则等于悄悄扩大了契约）：实际 ${JSON.stringify(keys.sort())}`,
  )
  // 列表响应：分页三件套一个都不能少（前端分页器靠它）
  assertEqual(
    agentListResultSchema.safeParse({ items: [], total: 0, offset: 0 }).success,
    false,
    'offset/limit/total 缺一不可',
  )
  assertEqual(agentListResultSchema.safeParse({ items: [], total: 0, offset: 0, limit: 20 }).success, true, '完整响应')
})

// ── 25. 会话契约与路由（P0-1-25）──
console.log(`\n${c.b}── 会话契约与路由（权限「仅本人」/ active 的派生字段 / last_message_at 的时点）──${c.x}`)

await it('八条已注册（P0-1-25 五条 + P0-1-26 两条 + P0-1-28 的消息历史）；P0-2 的那一条**刻意不存在**', () => {
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/agents/:id/conversations' }), true, '某 Agent 的会话列表')
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/conversations' }), true, '新建会话')
  assertEqual(app.hasRoute({ method: 'PATCH', url: '/api/conversations/:id' }), true, '重命名')
  assertEqual(app.hasRoute({ method: 'DELETE', url: '/api/conversations/:id' }), true, '删除')
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/conversations/:id/active' }), true, '活跃流状态')
  // `GET /api/conversations/:id`（详情）**没有**被设计过 —— 会话的全部信息都在列表项里，
  // 多一条"取单条"只会变成一个没人维护的第二套投影
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/conversations/:id' }), false, '不该有会话详情端点')
  // ⚠️ 「刻意未注册」型断言**有保质期**（`06` 的施工纪律）：下面这一条在 P0-1-25 时是 `false`
  //    （原文："**提前注册一条返回空数组的 `/messages` 会让'历史恢复'看起来已交付**"），
  //    **P0-1-28 落地后在这里翻转成 `true`**。翻转必须留痕 ——
  //    否则将来读的人会以为它从来就是 true，也就丢掉了"它曾经是刻意不做的"。
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/conversations/:id/messages' }),
    true,
    '消息历史（P0-1-28 已落地）',
  )
  // ⚠️ 同一族的第二次翻转（P0-1-25 时是 `false`，P0-1-26 落地 SSE 出口与停止后翻成 `true`）
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/conversations/:id/chat' }), true, 'SSE 出口（P0-1-26 落地）')
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/conversations/:id/stop' }), true, '停止（P0-1-26 落地）')
  // `confirm` 的应答端点要 `mcp_servers` 表（工具确认属工具系统）⇒ 归 **P0-2**，不是 P0-1-26。
  // （P0-1-25 时这句写的是"属 P0-1-26"；P0-1-26 落地时发现它的真实前置是 P0-2，一并改正。）
  // ⚠️ P0-1-28 落地后，这一条成了**九条路由里唯一没有出口的那条**（上面八条都已注册）。
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/conversations/:id/confirm' }), false, '确认属 P0-2（要 mcp_servers）')
  // ⚠️ 会话是**私有资源**：一条 `requireAdmin` 都不该出现 ⇒ 用一个普通 MEMBER 的 403 是验不出的，
  //    这里能验的是"路由本身只挂 requireAuth"（真权限判定在服务层的 `where` 里，归 verify-conversations）
  assertEqual(app.hasRoute({ method: 'PUT', url: '/api/conversations/:id' }), false, '重命名只走 PATCH（不提供整对象 PUT）')
  // 消息历史只提供 GET：`POST /:id/messages` 这种"手工塞一条消息"的入口**刻意不存在**
  // （消息的唯一写者是编排循环；开出口就等于让历史可以被伪造 —— 与上面"没有会话详情"同一判断）
  assertEqual(app.hasRoute({ method: 'POST', url: '/api/conversations/:id/messages' }), false, '消息只有读取出口')
})

await it('建/改请求体契约：`agentId` 必填且是 UUID；`topic` **不是三态**（null/空串/超长各自有文案）', () => {
  assertEqual(createConversationBodySchema.safeParse({ agentId: '01930000-0000-7000-8000-000000000000' }).success, true, '合法 body')
  assertEqual(createConversationBodySchema.safeParse({}).success, false, '缺 agentId')
  assertEqual(createConversationBodySchema.safeParse({ agentId: 'nope' }).success, false, '非 UUID')

  assertEqual(renameConversationBodySchema.safeParse({ topic: '标题' }).success, true, '合法标题')
  assertEqual(renameConversationBodySchema.safeParse({ topic: ' 前后有空白 ' }).data?.topic, '前后有空白', 'trim')
  assertEqual(renameConversationBodySchema.safeParse({ topic: '   ' }).success, false, '全空白被拒（trim 后为空）')
  // ⚠️ `null` 必须被拒：`topic` 不是三态（"清空标题"没有交互，见 shared 的注释）
  assertEqual(renameConversationBodySchema.safeParse({ topic: null }).success, false, '`null` 被拒')
  assertEqual(renameConversationBodySchema.safeParse({ topic: 'x'.repeat(256) }).success, false, '超长被拒（列是 255）')
  assertEqual(renameConversationBodySchema.safeParse({}).success, false, '必填')
  // 逐字段文案（前端要挂到输入框上，靠 message 找；`.refine()` 那种 path 为空串的写法在这里没有）
  assertIncludes(
    renameConversationBodySchema.safeParse({ topic: null }).error.issues.map((issue) => issue.message).join(' '),
    '必须是字符串',
    'null 的文案',
  )
  assertEqual(
    JSON.stringify(renameConversationBodySchema.safeParse({}).error.issues[0].path),
    JSON.stringify(['topic']),
    '必填的错误路径精确到 topic（不是 `.refine()` 的空串）',
  )
})

await it('输出投影：键集合固定（**没有 `deletedAt` 之类的内部列**），列表响应是同一套分页三件套', () => {
  const keys = Object.keys(conversationItemSchema.shape)
  // 软删是 Agent 的概念，会话表没有这一列；而 `userId` **刻意不**下发
  // （它就是"这是我的会话"的依据，下发出去只会诱使前端拿它做判断 —— 那是服务端的事）
  assertSameSet(
    keys,
    ['id', 'agentId', 'agentName', 'agentType', 'topic', 'status', 'lastMessageAt', 'createdAt', 'updatedAt'],
    '会话投影键集合',
  )
  assertEqual(keys.includes('userId'), false, '不该下发 userId')
  assertEqual(keys.includes('deletedAt'), false, '不该下发 deletedAt')
  assertEqual(
    conversationListResultSchema.safeParse({ items: [], total: 0, offset: 0 }).success,
    false,
    'offset/limit/total 缺一不可',
  )
  assertEqual(
    conversationListResultSchema.safeParse({ items: [], total: 0, offset: 0, limit: 20 }).success,
    true,
    '完整响应',
  )
  // 删除响应必须带 `deletedMessages`（`03` §七 的级联确认框要用它）
  assertEqual(
    removeConversationResultSchema.safeParse({ id: 'a', agentId: 'b', topic: null, deletedMessages: 3 }).success,
    true,
    '删除响应',
  )
  assertEqual(
    removeConversationResultSchema.safeParse({ id: 'a', agentId: 'b', topic: null }).success,
    false,
    '缺 deletedMessages',
  )
  assertEqual(conversationIdParamsSchema.safeParse({ id: 'not-a-uuid' }).success, false, '路径参数要是 UUID')
})

await it('⚠️ `streaming` 是**派生**字段：它只出现在响应契约里，**不在** Redis 快照里', () => {
  // 这条断言守的是"锁与在流是同一件事"（`shared` 文件头 ⑤）：一旦有人把 `streaming` 也写进
  // 快照（存起来），就会出现"键在但快照说不在"的矛盾态，而两种读法都能在某些页面显得正常。
  assertEqual(
    Object.keys(conversationActiveSnapshotSchema.shape).includes('streaming'),
    false,
    '⚠️ 快照里不许有 streaming（它由"键在不在"派生）',
  )
  assertSameSet(
    Object.keys(conversationActiveSnapshotSchema.shape),
    ['queuedPosition', 'currentTool', 'startedAt'],
    '快照三件套',
  )
  assertSameSet(
    Object.keys(conversationActiveSchema.shape),
    ['queuedPosition', 'currentTool', 'startedAt', 'streaming'],
    '响应 = 快照 + streaming',
  )
  assertEqual(
    conversationActiveSchema.safeParse({ queuedPosition: null, currentTool: null, startedAt: null }).success,
    false,
    '响应里 streaming 必填（缺了就是"没告诉我在不在流"）',
  )
})

await it('`parseActiveSnapshot` 纯函数：合法值逐字保留，脏值**逐字段**降级且永不抛错', () => {
  // 它是 `/active` 的读取端唯一兜底点（`normalizeGuideQuestions` 同族）。**断线重连**路径最不能 500，
  // 所以"值坏了也要给出能用的东西"这条只能在这里守（真 Redis 那一档归 verify-conversations 的 F 组）。
  assertSameObject(
    parseActiveSnapshot(JSON.stringify({ queuedPosition: 2, currentTool: 'bash', startedAt: '2026-09-22T06:30:00.000Z' })),
    { queuedPosition: 2, currentTool: 'bash', startedAt: '2026-09-22T06:30:00.000Z' },
    '合法值逐字保留',
  )
  for (const [raw, label] of [
    [null, 'null'],
    [undefined, 'undefined'],
    ['', '空串'],
    ['{oops', '非法 JSON'],
    ['[]', '顶层是数组'],
    ['"字符串"', '顶层是字符串'],
  ]) {
    assertSameObject(
      parseActiveSnapshot(raw),
      { queuedPosition: null, currentTool: null, startedAt: null },
      `降级：${label}`,
    )
  }
  // 坏字段自己降级、**好字段留下**（整条丢弃会让"只有时间戳坏了"变成"什么都看不到"）
  assertSameObject(
    parseActiveSnapshot(JSON.stringify({ queuedPosition: 0, currentTool: 'bash', startedAt: 'x' })),
    { queuedPosition: null, currentTool: 'bash', startedAt: null },
    '字段级收敛',
  )
})

await it('判据与文案收在 shared：「只读」是纯函数、未命名会话的回落文案是常量', () => {
  assertEqual(JSON.stringify(CONVERSATION_STATUSES), JSON.stringify(['ACTIVE', 'FINISHED']), '状态取值域')
  // ⚠️ 判据只回答"能不能再产生消息"（P0-1-26 的闸门 + P0-1-34 的输入区禁用），
  //    **不是**"什么都不能改" —— 改名/删除刻意不按它拦（verify-conversations 的 D 组有反向断言）
  assertEqual(isConversationReadOnly('ACTIVE'), false, 'ACTIVE 可写')
  assertEqual(isConversationReadOnly('FINISHED'), true, 'FINISHED 只读（Agent 软删留下的标记）')
  assertEqual(CONVERSATION_UNTITLED_HINT, '新会话', 'topic 为 null 时的界面回落文案')
})

// ── 25·b 消息历史（P0-1-28）的契约 + 取页逻辑（纯函数）──
console.log(`\n${c.b}── 消息历史（P0-1-28）：游标口径 / content 原样透出 / 取页不重不漏 ──${c.x}`)

await it('消息投影：键集合固定（**不带 tokens / conversationId**），`content` 原样透出且不许缺键', () => {
  assertSameSet(Object.keys(messageItemSchema.shape), ['id', 'role', 'content', 'createdAt'], '消息投影键集合')
  assertEqual(Object.keys(messageItemSchema.shape).includes('conversationId'), false, '同一会话里的消息不必重复带会话 id')
  assertEqual(Object.keys(messageItemSchema.shape).includes('tokensIn'), false, 'token 计量属 P1 的用量端点，这里不带')

  // ⚠️ 本批最重要的一条契约：`content` 必须是"服务端不解释"的**原文**。
  //    用写入端那个 schema 过滤一遍的话，P0-2 写进去的 `tool_calls` 会在**刷新之后**消失
  //    （流里看得见、历史里没有），而且**没有任何报错** —— 前端只能靠肉眼发现。
  const raw = {
    id: '01930000-0000-7000-8000-000000000001',
    role: 'ASSISTANT',
    content: {
      text: '答案',
      thinking: '推理',
      citations: [{ docName: 'A.txt', snippet: 'S', score: 0.03 }],
      // ↓ 这两个段本版本**刻意不定型**（工具属 P0-2、附件属 P1），但读取端必须照样原样交出去
      tool_calls: [{ callId: 'c1', toolName: 'search' }],
      attachments: [{ fileId: 'f1' }],
    },
    createdAt: '2026-09-22T06:30:00.000Z',
  }
  const parsed = messageItemSchema.safeParse(raw)
  assertEqual(parsed.success, true, '含未知段的消息仍是合法响应')
  assertSameSet(
    Object.keys(parsed.data.content),
    ['text', 'thinking', 'citations', 'tool_calls', 'attachments'],
    '⚠️ 未定型的段（tool_calls / attachments）必须原样保留',
  )
  // 反向对照：**写入端**那个 schema 会静默剥掉它们 —— 两处放在一起，才不会有人"顺手统一一下 schema"
  assertSameSet(
    Object.keys(messageContentSchema.parse(raw.content)),
    ['text', 'thinking', 'citations'],
    '对照：写入端 schema 会把未声明的键静默剥掉（故读取端不许用它）',
  )

  assertEqual(messageItemSchema.safeParse({ ...raw, role: 'TOOL' }).success, false, '角色取值域来自 DB 枚举')
  assertSameSet(MESSAGE_ROLES, ['USER', 'ASSISTANT', 'SYSTEM'], '与 schema.prisma 的 MessageRole 同源')
  // ⚠️ `z.unknown()` 连 `undefined` 都接受，而 `undefined` 会被 JSON.stringify 丢掉整个键
  //    ⇒ 客户端看到的是"这个字段不存在"。故必须有那条 refine。
  assertEqual(
    messageItemSchema.safeParse({ id: 'x', role: 'USER', createdAt: 'y' }).success,
    false,
    '⚠️ content 缺键必须被拒（否则它会静默从响应里消失）',
  )
  assertEqual(messageItemSchema.safeParse({ ...raw, content: null }).success, true, 'jsonb 里存 JSON null 是合法值')
  assertEqual(messageItemSchema.safeParse({ ...raw, content: '裸字符串' }).success, true, '旧版本可能写入过裸串（历史是跨版本读的）')
})

await it('查询参数：`beforeId` 可选且必须是 UUID；`limit` 有默认与上下限（**没有"全量"这个取值**）', () => {
  const bare = listMessagesQuerySchema.safeParse({})
  assertEqual(bare.success, true, '都不传 = 取最新一页（对话页首次进入的形态）')
  assertEqual(bare.data.limit, MESSAGE_PAGE_LIMIT_DEFAULT, `默认 ${MESSAGE_PAGE_LIMIT_DEFAULT} 条`)
  assertEqual('beforeId' in bare.data, false, '⚠️ 不传就是**没有这个键**（与"传了空串"是两件事）')

  // querystring 到手都是字符串 ⇒ coercion 是必须的，不是可选项
  assertEqual(listMessagesQuerySchema.safeParse({ limit: '5' }).data.limit, 5, '字符串能收敛成数字')
  assertEqual(listMessagesQuerySchema.safeParse({ limit: '0' }).success, false, '0 条没有意义')
  assertEqual(listMessagesQuerySchema.safeParse({ limit: '101' }).success, false, `超过上限 ${MESSAGE_PAGE_LIMIT_MAX} 被拒`)
  assertEqual(listMessagesQuerySchema.safeParse({ limit: '100' }).data.limit, 100, '上限本身合法')
  assertEqual(listMessagesQuerySchema.safeParse({ limit: '2.5' }).success, false, '非整数被拒')

  assertEqual(listMessagesQuerySchema.safeParse({ beforeId: '01930000-0000-7000-8000-000000000000' }).success, true, '合法游标')
  assertEqual(listMessagesQuerySchema.safeParse({ beforeId: 'nope' }).success, false, '非 UUID 被拒')
  assertEqual(listMessagesQuerySchema.safeParse({ beforeId: '' }).success, false, '空串被拒（"不带"才是"最新一页"）')
  // 逐字段文案（前端要挂到输入框上，靠 message / path 找）
  assertEqual(
    JSON.stringify(listMessagesQuerySchema.safeParse({ beforeId: 'nope' }).error.issues[0].path),
    JSON.stringify(['beforeId']),
    '错误路径精确到字段',
  )
})

await it('分页响应契约：`items` + `nextCursor` + `hasMore` 三件套（缺一不可，且都比"total"更需要）', () => {
  assertEqual(
    messagePageResultSchema.safeParse({ items: [], nextCursor: null, hasMore: false }).success,
    true,
    '完整响应',
  )
  assertEqual(messagePageResultSchema.safeParse({ items: [], nextCursor: null }).success, false, '缺 hasMore')
  assertEqual(messagePageResultSchema.safeParse({ items: [] }).success, false, '缺 nextCursor + hasMore')
  // ⚠️ 游标分页**刻意没有 `total`**（见 `envelope.ts#cursorPageOf`）：在按月分区的表上多跑一次 count
  //    只为显示一个随时会变的数字，而这个端点真正要回答的只是"还有没有更早的"。
  assertEqual('total' in messagePageResultSchema.shape, false, '游标分页不带 total')
  assertSameSet(Object.keys(messagePageResultSchema.shape), ['items', 'nextCursor', 'hasMore'], '三件套')
  // 工厂本身与 offset 版**并存**：两套分页各有各的适用面（`02` §四 只让 messages 用游标）
  assertEqual(cursorPageOf(z.string()).safeParse({ items: ['a'], nextCursor: 'b', hasMore: true }).success, true, '工厂可用')
})

/** 造一条待分页的原始行（只有取页逻辑真正读的四列） */
const pageRow = (n, createdAt = `2026-09-22T06:30:${String(n).padStart(2, '0')}.000Z`) => ({
  id: `01930000-0000-7000-8000-00000000000${n}`,
  role: n % 2 === 0 ? 'USER' : 'ASSISTANT',
  content: { text: `第 ${n} 条` },
  createdAt: new Date(createdAt),
})

await it('`toMessagePage`：`take: limit+1` 的那一条只用来判 `hasMore`，不返回', () => {
  // 入参约定：rows 已按 `MESSAGE_CHRONO_ORDER`（新 → 旧）排好，且**多取了 1 条**
  const page = toMessagePage([pageRow(3), pageRow(2), pageRow(1)], 2)
  assertEqual(page.hasMore, true, '多出来那一条 ⇒ 还有更早的')
  assertEqual(page.items.length, 2, '只返回 limit 条（多取的那条不许漏出来）')
  assertEqual(page.nextCursor, page.items[0].id, '⚠️ nextCursor = 本页**最旧**那条（正序之后就是第一条）')
  assertEqual(page.items.map((item) => item.content.text).join('|'), '第 2 条|第 3 条', '⚠️ 对外是正序（旧 → 新）')
  assertEqual(page.items[0].createdAt, '2026-09-22T06:30:02.000Z', '时间序列化成 ISO 8601')
})

await it('`toMessagePage`：恰好取满 ⇒ `hasMore:false` 且 `nextCursor:null`（两者**同真同假**）', () => {
  const full = toMessagePage([pageRow(2), pageRow(1)], 2)
  assertEqual(full.hasMore, false, '没有多出来 ⇒ 到底了')
  assertEqual(full.nextCursor, null, '⚠️ 到底了就给 null，而不是给一个"用不上的游标"')
  const empty = toMessagePage([], 5)
  assertSameObject(empty, { items: [], hasMore: false, nextCursor: null }, '空会话的第一页')
  // 退化输入（端点不会产生：schema 的 limit 最小是 1）也不许自相矛盾
  const degenerate = toMessagePage([pageRow(1)], 0)
  assertEqual(degenerate.hasMore, false, 'limit 为 0 时不许说"还有更多"（那个 nextCursor 会没法给）')
  assertEqual(degenerate.nextCursor, null, '与 hasMore 一致')
})

await it('`toMessagePage`：逐页翻到底**不重不漏**，且拼起来就是完整的时间正序序列', () => {
  // 这是验收原文"分页拉取不重不漏"在**纯函数层**的形态：把一条 5 条的序列按 limit=2 走完，
  // 逐页断言，最后把所有页拼起来与完整序列逐字比。
  // ⚠️ 页与页之间"从哪里继续"由 SQL 的游标条件决定（归 verify-conversations 的 H 组），
  //    这里模拟的是"SQL 给对了切片之后，取页逻辑会不会漏/重"—— 一个 SQL 写对的实现
  //    配一个错的取页逻辑，照样能顺利跑完，且只在翻第二页时才显形。
  // ⚠️⚠️ 拼接方向是**页序倒过来**（第 3 页 → 第 2 页 → 第 1 页）：各页本身是"更早的一页"，
  //    页内正序 ⇒ 界面上"往上加载"＝把新拿到的页**前插**。写成 `[page1, page2, page3]` 顺序拼接
  //    会得到 [4,5,2,3,1] —— 这正是"加载更多把消息插错位置"那个 bug 的形态。
  const all = [pageRow(5), pageRow(4), pageRow(3), pageRow(2), pageRow(1)] // 新 → 旧
  const pages = []
  const cursors = []
  let offset = 0
  for (let round = 0; round < 10; round += 1) {
    const slice = all.slice(offset, offset + 3) // 3 = limit(2) + 1：SQL 的 take
    const page = toMessagePage(slice, 2)
    pages.push(page.items)
    cursors.push(page.nextCursor)
    if (!page.hasMore) break
    assertEqual(page.nextCursor, page.items[0].id, `第 ${round + 1} 页的游标 = 本页最旧那条`)
    offset += page.items.length // 真实实现里是"从游标那一条之后继续"，等价于消费掉本页
  }
  assertEqual(cursors.length, 3, '5 条按 2 条一页 ⇒ 恰好 3 页（不是 4 页、也不是死循环）')
  const assembled = pages.slice().reverse().flat()
  assertEqual(
    JSON.stringify(assembled.map((item) => item.content.text)),
    JSON.stringify(['第 1 条', '第 2 条', '第 3 条', '第 4 条', '第 5 条']),
    '⚠️ 各页按"新页在前"拼起来与完整序列**逐字相同**（不重、不漏、顺序对）',
  )
  assertEqual(new Set(assembled.map((item) => item.id)).size, 5, '5 个 id 互不相同（无重复）')
  assertEqual(cursors[2], null, '最后一页的游标是 null')
})

await it('`toMessagePage`：**同一毫秒**的两条不会被一起吞掉（真实存在：一轮问答是一个事务）', () => {
  // `chatBot.ts#persistRoundQuietly` 把用户消息与助手消息写在**同一个事务**里，而 PG 的 `now()`
  // 是事务开始时刻 ⇒ 这两条的 `created_at` **逐字相同**。取页逻辑对同毫秒必须一视同仁，
  // 而"用时间戳当游标"的那类实现会在这里丢掉一条。
  const same = '2026-09-22T06:30:00.000Z'
  const first = toMessagePage([pageRow(2, same), pageRow(1, same)], 1)
  assertEqual(first.items.length, 1, 'limit=1 时同毫秒的两条只给一条')
  assertEqual(first.hasMore, true, '另一条还在后面（这就是"不许吞掉"的意思）')
  const second = toMessagePage([pageRow(1, same)], 1)
  assertSameObject(
    second.items.map((item) => item.content.text),
    ['第 1 条'],
    '第二页拿到的是另一条（两个 id 不同 ⇒ SQL 的 id tie-break 才有意义）',
  )
})

await it('时间口径 `MESSAGE_CHRONO_ORDER`：`(created_at desc, id desc)` —— 上下文窗口与历史分页**同源**', () => {
  // 两处消费方（`chatBot.ts` 的"最近 N 轮"与本批的历史分页）共用这一个常量。
  // 漂了的症状很具体：**模型看到的最近几轮与界面上显示的最近几条不是同一批**
  // （用户说"你刚才明明说过"，而模型那边是另一段对话）。
  assertSameObject(
    MESSAGE_CHRONO_ORDER,
    [{ createdAt: 'desc' }, { id: 'desc' }],
    '新 → 旧；`id desc` 只做 tie-break（同毫秒时没有第二排序键，顺序就是不确定的）',
  )
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// P0-1-27：上下文组装 + 并发闸（纯函数）
//
// 这一节守的全是**没有 HTTP 表现**的错：流照常以 200 结束、界面看着正常，
// 而模型已经开始编造来源 / 多轮对话开始答非所问 / 并发上限被悄悄放到无穷。
// 两个被测文件刻意不 import 任何运行期模块（手法同 `pipeline/chunk/`，见 `06` 的
// "能无依赖验的纯逻辑别粘依赖"）⇒ 这一档不需要 PG/Redis/上游。
// ═══════════════════════════════════════════════════════════════════════════════════════

/** 造一条检索命中：只有 `chatContext` 真正读的四列有意义（`docName`/`snippet`/`rrfScore`/`chunkId`） */
const makeHit = (over = {}) => ({
  chunkId: 'c0000000-0000-7000-8000-000000000001',
  docId: 'd0000000-0000-7000-8000-000000000001',
  docName: '报销制度.txt',
  seq: 0,
  page: null,
  headingPath: [],
  snippet: '出差住宿标准为每晚上限 500 元。',
  vectorScore: 0.81,
  vectorRank: 1,
  fulltextScore: 0.42,
  fulltextRank: 2,
  rrfScore: 0.0328,
  finalRank: 1,
  ...over,
})

await it('检索块：标题 + 连续序号 + 「来源：文档名」前缀，片段**原样**（不二次截断）', () => {
  // 为什么"片段原样"要单独守：检索层已按 `SNIPPET_WINDOW_CHARS` 截过一次。编排层再截一次，
  // 会让"引用卡显示的片段"与"模型看到的片段"不一样 —— 而引用卡的全部意义就是让人核对模型看到了什么。
  const messy = '  首行带缩进\n第二行\n  '
  const block = formatRetrievalBlock([
    makeHit({ docName: 'A.txt', snippet: messy }),
    makeHit({ docName: 'B.txt', snippet: 'B 的片段' }),
    makeHit({ docName: 'C.txt', snippet: 'C 的片段' }),
  ])
  assertIncludes(block, RETRIEVAL_BLOCK_TITLE, '含检索块标题（它是 prompt 与断言之间唯一的可观测点）')
  assertIncludes(block, '1. 来源：A.txt', '序号从 1 开始且带「来源：」前缀')
  assertIncludes(block, '2. 来源：B.txt', '序号连续（跳号会让模型把两条认成同一条）')
  assertIncludes(block, '3. 来源：C.txt', '序号连续到 3')
  assert(block.includes(messy), '片段必须**逐字**保留（首尾空白与换行都不动）')
  assert(!block.includes('(截断)'), '不得有任何截断标记')
})

await it('检索块：零命中时写出「没有检索到」的明文（留白等于让模型自己决定有没有）', () => {
  const block = formatRetrievalBlock([])
  assertIncludes(block, RETRIEVAL_BLOCK_TITLE, '标题照发（模型要能看到"这一节存在但为空"）')
  assertIncludes(block, RETRIEVAL_EMPTY_HINT, '空命中提示')
  assertEqual(block.split('\n').length, 2, '恰好两行：标题 + 空提示（多一行都说明格式漂了）')
})

await it('system prompt：三段顺序固定 = 人格 → 检索规则 → 检索块', () => {
  const prompt = buildSystemPrompt('你是报销专员。', [makeHit()])
  const iPersona = prompt.indexOf('你是报销专员。')
  const iRules = prompt.indexOf(RETRIEVAL_RULES)
  const iBlock = prompt.indexOf(RETRIEVAL_BLOCK_TITLE)
  assert(
    iPersona >= 0 && iRules > iPersona && iBlock > iRules,
    `三段顺序应为 人格→规则→检索块，实际 ${JSON.stringify([iPersona, iRules, iBlock])}`,
  )
})

await it('⚠️ 检索规则**每一轮都注入**（无论有没有命中）—— 这是「不编造来源」在 prompt 层的那一半', () => {
  // `01` 决策 12 是两半：不发 `citations` 事件 + prompt 明确禁止编造。只做前一半，
  // 模型照样会在正文里写「根据《XX制度》…」（凭空造一个文档名），而界面上没有引用卡 ⇒
  // 用户看到的是一段"看起来有出处、其实没有"的回答。这一半没有任何 HTTP 表现，只能在这里守。
  for (const [hits, label] of [[[makeHit()], '有命中'], [[], '零命中']]) {
    const prompt = buildSystemPrompt('你是报销专员。', hits)
    assertIncludes(prompt, RETRIEVAL_RULES, `${label}时也要带规则`)
    assertIncludes(prompt, '不要编造', `${label}时的规则里必须含"不要编造"字样`)
  }
})

await it('system prompt：空白 systemPrompt 回落兜底文案；有值时**逐字保留**（不 trim）', () => {
  for (const [value, label] of [[null, 'null'], [undefined, 'undefined'], ['', '空串'], ['   ', '全空格']]) {
    assertIncludes(buildSystemPrompt(value, []), DEFAULT_SYSTEM_PROMPT, `${label} 应回落兜底`)
  }
  // 与 P0-1-22「systemPrompt 刻意不 trim」同一条口径：起止空白是人格格式的一部分。
  // 若这里 trim 了，"库里存的"与"发出去的"就分叉（而库里那份是用户在表单里看到的）。
  const padded = '  你是报销专员。\n\n'
  const prompt = buildSystemPrompt(padded, [])
  assert(prompt.startsWith(padded), '两侧空白与换行必须保留')
  assert(!prompt.includes(DEFAULT_SYSTEM_PROMPT), '有值时不掺兜底文案（否则人格被两句话拉扯）')
})

await it('多库命中合并：`rrfScore desc` + 同分按 `chunkId asc`（确定性 tie-break）', () => {
  // 多库的分数分布不同、撞分很常见。没有 tie-break 时"两次调用顺序不同"会让引用卡在刷新前后换位置，
  // 用户会以为是"答案变了"。同口径见 P0-1-20 的检索层（那边是两路融合、这边是跨库展平）。
  const merged = mergeRetrievalHits([
    [makeHit({ chunkId: 'c-2', rrfScore: 0.01 }), makeHit({ chunkId: 'c-b', rrfScore: 0.03 })],
    [makeHit({ chunkId: 'c-a', rrfScore: 0.03 }), makeHit({ chunkId: 'c-3', rrfScore: 0.02 })],
  ])
  assertSameSet(merged.map((hit) => hit.chunkId), ['c-2', 'c-b', 'c-a', 'c-3'], '跨库展平，一条不丢')
  assertEqual(merged[0].chunkId, 'c-a', '0.03 的两条里 chunkId 小者在前')
  assertEqual(merged[1].chunkId, 'c-b', '0.03 的第二条')
  assertEqual(merged[2].chunkId, 'c-3', '0.02')
  assertEqual(merged[3].chunkId, 'c-2', '0.01 垫底')
})

await it('多库命中合并：**刻意不设条数上限**（每个库的 topK 是它自己的配置）', () => {
  // 在编排层再叠一个隐藏上限，会造出"我配了 topK=10、进模型的却只有 5 条"这种**查不出来**的事
  // （与 P0-1-23「组件绑定不设条数上限」同款判断）。
  const ten = Array.from({ length: 10 }, (_value, i) =>
    makeHit({ chunkId: `c-${String(i).padStart(2, '0')}`, rrfScore: 1 - i * 0.01 }),
  )
  assertEqual(mergeRetrievalHits([ten]).length, 10, '10 进 10 出')
  assertEqual(mergeRetrievalHits([ten, ten]).length, 20, '两个库各 10 条 ⇒ 20 条')
  assertEqual(mergeRetrievalHits([ten])[0].chunkId, 'c-00', '不改字段、不改顺序')
})

await it('引用卡：`score` 取**融合分** `rrfScore`（不是任何一路原始分），且只带三列', () => {
  // `§九` 的口径是"对外只给融合分"：`vectorScore`（余弦）与 `bigm_similarity` 量纲不可比，
  // 混在一张卡上会让用户无法解释自己看到的数字。三个数刻意取成各不相同，取错必然被抓。
  const items = toCitationItems([makeHit({ rrfScore: 0.0328, vectorScore: 0.91, fulltextScore: 0.17 })])
  assertSameObject(
    items[0],
    { docName: '报销制度.txt', snippet: '出差住宿标准为每晚上限 500 元。', score: 0.0328 },
    '三列逐字',
  )
  assertSameSet(Object.keys(items[0]), ['docName', 'snippet', 'score'], '恰好三列（多带 chunkId/page 会与 sse.ts 分叉）')
  assertSameObject(toCitationItems([]), [], '零命中 ⇒ 空数组（调用方据此决定"不发 citations 事件"）')
})

await it('`textOfHistoryRow`：跨版本读 jsonb 的唯一兜底点，脏值一律 `""` 且永不抛错', () => {
  // `messages.content` 的形状由**写入时的版本**决定，而历史是跨版本读的。一个解析不出来的行
  // 不该让整轮对话失败 —— 那意味着"三年前的一条脏数据让今天的提问用不了"。
  // ⚠️ 只做**类型收敛**，不做任何猜测（不去猜数组里第几个、不去猜 html）。
  assertEqual(textOfHistoryRow({ role: 'USER', content: '裸字符串' }), '裸字符串', '历史里可能存过裸串')
  assertEqual(textOfHistoryRow({ role: 'USER', content: { text: '正常' } }), '正常', '本批写入的形态')
  assertEqual(textOfHistoryRow({ role: 'USER', content: { text: '', thinking: 'x' } }), '', '有 thinking 无 text ⇒ 空')
  for (const [value, label] of [
    [null, 'null'],
    [[], '数组'],
    ['', '空串'],
    [{}, '空对象'],
    [{ text: 1 }, 'text 不是串'],
    [42, '数字'],
  ]) {
    assertEqual(textOfHistoryRow({ role: 'USER', content: value }), '', `降级：${label}`)
  }
})

await it('历史截断：取 `rounds × 2` 条（一轮 = 一问一答）且截断后**从 user 开始**', () => {
  // 两条口径各对应一种"看不太出来"的坏结果：
  //   ① 只按"条"取 `rounds` 条 = 只给一半轮数（`02` §六 写的是"最近 N 轮"）；
  //   ② 截点常落在助手回答中间 ⇒ 开头是一条没有问题的回答，模型会把它当"要继续写下去的上文"
  //      （症状是回答莫名其妙地接着上一轮的结论说）。
  const rows = [
    { role: 'USER', content: { text: 'u1' } },
    { role: 'ASSISTANT', content: { text: 'a1' } },
    { role: 'USER', content: { text: 'u2' } },
    { role: 'ASSISTANT', content: { text: 'a2' } },
    { role: 'USER', content: { text: 'u3' } },
    { role: 'ASSISTANT', content: { text: 'a3' } },
    { role: 'USER', content: { text: 'u4' } },
  ]
  assertSameObject(
    selectHistoryMessages(rows, 1),
    [{ role: 'user', content: 'u4' }],
    '1 轮 = 最近 2 条；截到 assistant 开头就把它丢掉',
  )
  const two = selectHistoryMessages(rows, 2)
  assertEqual(two.length, 3, '2 轮：最近 4 条里开头的 assistant 被丢 ⇒ 3 条')
  assertEqual(two[0].content, 'u3', '起点是 user')
  assertEqual(two[0].role, 'user', '角色映射成小写（LLM 入参口径）')
  assertEqual(selectHistoryMessages(rows, 99).length, 7, '轮数超出全量就全给')
  assertSameObject(selectHistoryMessages(rows, 0), [], '⚠️ 0 轮 ⇒ 空（不是"全给"）')
})

await it('历史截断：丢掉空文本的助手行与 SYSTEM 行', () => {
  // 停止得很早的一轮会留下"有 thinking 没 text"的助手行（P0-1-27 停止时"已生成部分保留"）。
  // 它对上下文没有贡献，却会让严格的实现在上游直接 400（一条空 content 的 assistant 消息是非法的）。
  const rows = [
    { role: 'SYSTEM', content: { text: '不该进上下文' } },
    { role: 'USER', content: { text: '问' } },
    { role: 'ASSISTANT', content: { text: '', thinking: '想到了但没吐字' } },
    { role: 'ASSISTANT', content: { text: '答' } },
  ]
  assertSameObject(
    selectHistoryMessages(rows, 10),
    [
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
    ],
    '唯二留下的两行（SYSTEM 与空助手行都出局）',
  )
})

await it('落库形态：`text` 恒写（可以是空串）；空的 `thinking`/`citations` **不加键**', () => {
  // 省掉键 = "这一段本来就没有"，与"有但是空"在界面上是两件事（思考折叠区/引用区都是"有才出现"，`03` §五）。
  // ⚠️ 反过来：`text` 不能省 —— 它是历史重建时唯一进上下文的部分，缺键会被 P0-1-28 当成"旧版本的行"。
  assertSameObject(buildAssistantContent({ text: '', thinking: '', citations: [] }), { text: '' }, '全空 ⇒ 只有 text 一个键')
  assertSameObject(
    buildAssistantContent({
      text: '答案',
      thinking: '推理',
      citations: [{ docName: 'A.txt', snippet: 'S', score: 0.0328 }],
    }),
    { text: '答案', thinking: '推理', citations: [{ docName: 'A.txt', snippet: 'S', score: 0.0328 }] },
    '三段齐全',
  )
  assertSameObject(
    buildAssistantContent({ text: '答', thinking: '  ', citations: [] }),
    { text: '答', thinking: '  ' },
    '空白 thinking 不是空 ⇒ 照写（与"不 trim"同口径）',
  )
})

await it('落库形态：返回的 `citations` 是**副本**（改返回值不得回写调用方的数组）', () => {
  const citations = [{ docName: 'A.txt', snippet: 'S', score: 1 }]
  const content = buildAssistantContent({ text: 't', thinking: '', citations })
  content.citations.push({ docName: 'B.txt', snippet: 'S', score: 2 })
  assertEqual(citations.length, 1, '入参数组长度不变')
})

await it('并发闸：满则 `tryAcquire()` 返回 `null`（**不是 Promise**）—— 不排队', () => {
  // `02` §六 给两个编排器的口径**不同**，别照着邻居抄：ChatBot 满 ⇒ `BUSY`（用户可以重发，
  // 且立刻知道自己被拒）；TaskAgent（P0-3）满 ⇒ `queued` + 排队位次（沙箱最贵、等待是常态）。
  // 给 ChatBot 也做排队只会造出"前端不知道该画什么"的中间态（`03` §五 的 queued 行写的是沙箱并发满）。
  const sem = createSemaphore(2)
  assertEqual(sem.limit, 2, '上限可读（日志要写 x/limit）')
  assertEqual(typeof sem.tryAcquire(), 'function', '第 1 个拿到释放函数')
  assertEqual(typeof sem.tryAcquire(), 'function', '第 2 个拿到释放函数')
  assertEqual(sem.inFlight, 2, '在飞 2')
  assertEqual(sem.tryAcquire(), null, '第 3 个立刻被拒')
  assert(!(sem.tryAcquire() instanceof Promise), '⚠️ 必须同步返回 null（返回 Promise 等于偷偷排了队）')
})

await it('并发闸：`release` **幂等**（否则计数减负 ⇒ 上限被悄悄放到无穷）', () => {
  const sem = createSemaphore(1)
  const release = sem.tryAcquire()
  release()
  assertEqual(sem.inFlight, 0, '释放后计数归零')
  release()
  release()
  assertEqual(sem.inFlight, 0, '重复释放不再减（不能变成 -2）')
  assertEqual(typeof sem.tryAcquire(), 'function', '计数没有减负 ⇒ 名额仍然只有 1 个')
  assertEqual(sem.tryAcquire(), null, '第 2 个仍被拒')
})

await it('并发闸：`limit < 1` 抬到 1、小数向下取整（0 会让所有请求都被拒 = 永远打不开的服务）', () => {
  assertEqual(createSemaphore(0).limit, 1, '0 → 1（要停服务应该走停机，不是把闸门关成 0）')
  assertEqual(createSemaphore(-5).limit, 1, '负数 → 1')
  assertEqual(createSemaphore(2.9).limit, 2, '小数向下取整')
  assertEqual(typeof createSemaphore(0).tryAcquire(), 'function', '抬高后确实能占到一个名额')
})

await it('契约同源：引用卡形状只定义一次，SSE 事件与落库共用同一份', () => {
  // 流里现画的引用卡与刷新后从 `messages.content.citations` 重画的卡必须长得一样（`03` §五 单一渲染路径）。
  // 各写一份的后果没有编译期错误、只有肉眼能发现 —— 与 P0-1-27 把 `sseCitationsPayloadSchema`
  // 改成引用 `citationItemSchema` 是同一条。
  assertSameSet(Object.keys(citationItemSchema.shape), ['docName', 'snippet', 'score'], '引用卡三列')
  assertEqual(citationItemSchema.safeParse({ docName: 'a', snippet: 'b', score: 0.1 }).success, true, '合法引用')
  assertEqual(citationItemSchema.safeParse({ docName: 'a', snippet: 'b' }).success, false, 'score 必填（缺了没法显示融合分）')
  assertSameSet(
    Object.keys(messageContentSchema.shape),
    ['text', 'thinking', 'citations'],
    '消息 content 三列（tool_calls / attachments 属 P0-2 / P1，本版本刻意不定型）',
  )
  assertEqual(messageContentSchema.safeParse({ thinking: '只有思考' }).success, false, '⚠️ text 必填 —— 历史重建唯一进上下文的部分')
  assertEqual(messageContentSchema.safeParse({ text: '' }).success, true, 'text 可以是空串（停止得很早的那一轮）')
  // ⚠️ 这条不是"要求报错"，而是把**坑本身**钉住：Zod 默认会**静默剥掉**未声明的键。
  //    将来给 content 加字段时，忘了同时改 shared 不会报任何错，只让历史渲染缺一块。
  const stripped = messageContentSchema.safeParse({ text: 't', ext: 1 })
  assertEqual(stripped.success, true, '未声明的键不会让解析失败')
  assertSameSet(Object.keys(stripped.data), ['text'], '⚠️ 而是被**静默剥掉**')
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// P0-2-2：MCP server 注册 —— 路由表 / 契约 / 三个纯函数族
//
// 这一节守的错**大多没有 HTTP 表现**：
//   · 路由漏注册一条 ⇒ 前端"点了没反应"，而所有后端单测照样绿；
//   · 投影多一个恒 `null` 的键 ⇒ 诱使前端写永远走不到的分支（`oauthConfig` 就是这样被拿掉的）；
//   · slug 的后缀被 `slice(0,32)` 截掉 ⇒ 两个 server 抢同一个工具名前缀（P0-2-6 才炸）；
//   · `tool_cache` 半截数据被逐条过滤 ⇒ "模型能调到的工具少了几个"，界面上完全看不出来。
// 三处被测模块都**刻意不 import 任何运行期模块** ⇒ 这一档（无依赖、可进 CI）能直接断言；
// 行为侧（真 PG + 假 MCP 上游 + 全员权限 + 409 守卫）归 `verify-mcp-servers.mjs`。
// ═══════════════════════════════════════════════════════════════════════════════════════

console.log(`\n${c.b}── MCP server 注册（P0-2-2）：路由表 / 投影 / slug 与缓存纯函数 ──${c.x}`)

/** 一个契约完备的 `McpServerItem`（每条用例按需覆写一两个字段） */
const mcpItemFixture = {
  id: '01930000-0000-7000-8000-000000000001',
  name: '内部工单平台',
  slug: 'server',
  endpointUrl: 'http://127.0.0.1:1/mcp',
  authType: 'NONE',
  credentialSchema: [],
  toolCount: 0,
  status: 'UNKNOWN',
  createdBy: '01930000-0000-7000-8000-000000000002',
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
}

/** 一个契约完备的 `McpToolDescriptor`（四个契约键 + `hasOutputSchema`，缺失的写成 `null`） */
const mcpToolFixture = {
  name: 'echo',
  title: null,
  description: null,
  inputSchema: { type: 'object', properties: {} },
  annotations: null,
  hasOutputSchema: false,
}

await it('六条路由已注册；三条**刻意不注册**（凭据属 P0-2-4，详情与整对象 PUT 本批不提供）', () => {
  const registered = [
    ['GET', '/api/mcp/servers', '列表'],
    ['POST', '/api/mcp/servers', '注册'],
    ['PATCH', '/api/mcp/servers/:id', '部分更新'],
    ['DELETE', '/api/mcp/servers/:id', '删除'],
    ['POST', '/api/mcp/servers/:id/test', '连通测试'],
    ['GET', '/api/mcp/servers/:id/tools', '工具列表（读缓存）'],
  ]
  for (const [method, url, label] of registered) {
    assertEqual(app.hasRoute({ method, url }), true, `${label}路由应已注册`)
  }
  // ⚠️ "刻意不注册"同样是要守的契约：多一条 = 提前承诺了没实现的东西
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/mcp/servers/:id' }), false, '详情属 P0-2-5')
  assertEqual(app.hasRoute({ method: 'PUT', url: '/api/mcp/servers/:id' }), false, '只有 PATCH（不提供整对象 PUT）')
  assertEqual(
    app.hasRoute({ method: 'GET', url: '/api/mcp/credentials' }),
    false,
    '⚠️ 凭据三条属 P0-2-4（收窄在 `user_id` 上、要建表），不要顺手补',
  )
  // 顺带守一条"本资源没有第二套投影"：它不像模型池那样需要 `/available`
  assertEqual(app.hasRoute({ method: 'GET', url: '/api/mcp/servers/available' }), false, '不需要 /available 子路径')
})

await it('投影 `McpServerItem`：十一个键；**刻意没有** `oauthConfig` / `toolCache`', () => {
  assertSameSet(
    Object.keys(mcpServerItemSchema.shape),
    [
      'authType',
      'createdAt',
      'createdBy',
      'credentialSchema',
      'endpointUrl',
      'id',
      'name',
      'slug',
      'status',
      'toolCount',
      'updatedAt',
    ],
    '投影键集合',
  )
  assertEqual(mcpServerItemSchema.safeParse(mcpItemFixture).success, true, '契约完备的条目应通过')
  assertEqual(mcpServerItemSchema.safeParse({ ...mcpItemFixture, toolCount: -1 }).success, false, 'toolCount 不能为负')
  assertEqual(
    mcpServerItemSchema.safeParse({ ...mcpItemFixture, status: 'DISABLED' }).success,
    false,
    `status 取值域固定为 ${MCP_SERVER_STATUSES.join('/')}（它**不是启停开关**）`,
  )
  assertEqual(
    mcpServerItemSchema.safeParse({ ...mcpItemFixture, authType: 'OAUTH' }).success,
    true,
    'OAUTH 在取值域内（拒绝发生在服务层 —— "接口留位、能力不做"）',
  )
  // ⚠️ 这条不是"要求报错"，而是把**坑本身**钉住：Zod 默认**静默剥掉**未声明的键。
  //    将来给这张表加字段时，忘了同时改 shared 不会报任何错，只让响应里少一块。
  const stripped = mcpServerItemSchema.safeParse({ ...mcpItemFixture, oauthConfig: { clientId: 'x' } })
  assertEqual(stripped.success, true, '未声明的键不会让解析失败')
  assertEqual('oauthConfig' in stripped.data, false, '⚠️ 而是被**静默剥掉**（恒 `null` 的字段不进契约）')
})

await it('`mcpServerTestResultSchema`：两分支**互斥**（union，而不是两个可选键）', () => {
  assertEqual(mcpServerTestResultSchema.safeParse({ ok: true, tools: [mcpToolFixture] }).success, true, '成功分支')
  assertEqual(mcpServerTestResultSchema.safeParse({ ok: false, error: '连接被拒绝' }).success, true, '失败分支')
  // 写成两个 `.optional()` 会放过下面两种"前端渲染不出来"的中间态
  assertEqual(mcpServerTestResultSchema.safeParse({ ok: true }).success, false, '⚠️ `ok:true` 必须带 `tools`')
  assertEqual(mcpServerTestResultSchema.safeParse({ ok: false }).success, false, '⚠️ `ok:false` 必须带 `error`')
  assertEqual(mcpServerTestResultSchema.safeParse({ tools: [] }).success, false, '`ok` 是判别式，不能缺')
  // 工具投影的六个键**恒存在**（缺失的一律 `null`）—— 前端据此少写一堆可选链
  const tool = mcpToolDescriptorSchema.parse(mcpToolFixture)
  assertSameSet(
    Object.keys(tool),
    ['annotations', 'description', 'hasOutputSchema', 'inputSchema', 'name', 'title'],
    '工具投影六个键',
  )
  assertEqual(
    mcpToolDescriptorSchema.safeParse({ name: 'echo' }).success,
    false,
    '⚠️ 缺失的键也必须显式给 `null`（"少一个键"与"值为 null"在渲染时是两件事）',
  )
  assertEqual(
    mcpToolDescriptorSchema.parse({ ...mcpToolFixture, inputSchema: { any: 'thing' } }).inputSchema.any,
    'thing',
    'inputSchema **原样**透传（任何兼容处理属 P0-2-6）',
  )
})

await it('`GET /:id/tools`：`fetchedAt:null` 与 `tools:[]` 是**两件事**（写进契约、界面据此留白）', () => {
  assertEqual(
    mcpServerToolsResultSchema.safeParse({ tools: [], fetchedAt: null, cached: false }).success,
    true,
    '从未拉过',
  )
  assertEqual(
    mcpServerToolsResultSchema.safeParse({ tools: [], fetchedAt: '2026-01-01T00:00:00.000Z', cached: true }).success,
    true,
    '确实就是 0 个工具（界面上要显示 `0` 而不是 `—`）',
  )
  assertEqual(
    mcpServerToolsResultSchema.safeParse({ tools: [], fetchedAt: null, cached: true }).success,
    true,
    '⚠️ 契约刻意**不**约束两者一致：P0-2-5 的 `?refresh=1` 会让它们分叉（拉失败但缓存还在）',
  )
  assertEqual(mcpServerToolsResultSchema.safeParse({ tools: [] }).success, false, '`fetchedAt`/`cached` 必填')
})

await it('注册响应是 `{server,test}`（不是"裸 item 多一个键"）；列表与删除各回自己的形状', () => {
  // ⚠️ 不做成"裸 item 再多一个键"：同一份数据两种形状 = 前端两套渲染分支（P0-1-21 的教训）
  assertSameSet(Object.keys(mcpServerCreateResultSchema.shape), ['server', 'test'], '两个键')
  assertEqual(
    mcpServerCreateResultSchema.safeParse({ server: mcpItemFixture, test: { ok: false, error: 'x' } }).success,
    true,
    '失败探测也照样是一份合法响应（注册**不**因它失败）',
  )
  assertEqual(mcpServerCreateResultSchema.safeParse({ server: mcpItemFixture }).success, false, '⚠️ `test` 必填')
  assertSameSet(Object.keys(mcpServerListResultSchema.shape), ['items', 'limit', 'offset', 'total'], '列表四件套')
  assertSameSet(Object.keys(removeMcpServerResultSchema.shape), ['id', 'name'], '删除只回 id + name（与删 Provider 同口径）')
})

await it('请求侧：endpoint 只认 http/https 且 `path` 精确到字段；三态与"至少一个字段"', () => {
  const min = { name: '内部工单平台', endpointUrl: 'https://mcp.example.com/mcp' }
  assertEqual(createMcpServerBodySchema.safeParse(min).success, true, '最小合法体')
  assertEqual(
    createMcpServerBodySchema.safeParse({ ...min, endpointUrl: 'http://127.0.0.1:1/mcp' }).success,
    true,
    'http 也认（本地/内网端点很常见）',
  )
  // ⚠️ `z.string().url()` 用的是 `new URL()` —— 它**接受任何协议**（ftp/file/ws 全过）。
  //    所以"其它协议 400"这条**必须自己判 scheme**，否则这条断言是假的。
  for (const endpointUrl of ['ftp://mcp.example.com/mcp', 'file:///etc/passwd', 'ws://mcp.example.com/mcp', 'not a url', '']) {
    const parsed = createMcpServerBodySchema.safeParse({ ...min, endpointUrl })
    assertEqual(parsed.success, false, `${JSON.stringify(endpointUrl)} 应被拒`)
    assertEqual(
      parsed.error.issues[0].path[0],
      'endpointUrl',
      `${JSON.stringify(endpointUrl)} 的字段路径要能定位到输入框（object 级 refine() 给不出 path）`,
    )
  }
  assertEqual(
    createMcpServerBodySchema.safeParse({ ...min, endpointUrl: `http://x/${'a'.repeat(MCP_ENDPOINT_URL_MAX)}` })
      .success,
    false,
    `endpoint 超过 ${MCP_ENDPOINT_URL_MAX} 字符应被拒`,
  )
  assertEqual(
    createMcpServerBodySchema.safeParse({ ...min, name: 'x'.repeat(MCP_SERVER_NAME_MAX + 1) }).success,
    false,
    `名称超过 ${MCP_SERVER_NAME_MAX} 字符应被拒`,
  )
  // 三态：`authType` **不是**三态字段（枚举没有"清空"可言）；`credentialSchema` 的"清空"就是提交 `[]`
  assertEqual(
    createMcpServerBodySchema.parse(min).credentialSchema,
    undefined,
    '省略 ⇒ 留 undefined 给服务层落成 []（不在 schema 层给默认值 —— 那会让"省略"与"给 []"变得无法区分）',
  )
  assertEqual(createMcpServerBodySchema.parse(min).authType, undefined, 'authType 省略 ⇒ 服务层落 NONE')
  assertEqual(updateMcpServerBodySchema.safeParse({}).success, false, '空体 ⇒ 400（"什么都没改"不该发请求）')
  assertEqual(
    updateMcpServerBodySchema.safeParse({ credentialSchema: [] }).success,
    true,
    '清空模板 = 提交 `[]`（本轮是**整体替换**语义，与 P0-2-4 的凭据**值**合并语义刻意相反）',
  )
  // ⚠️ `slug` 不在 PATCH 契约里：它进工具名前缀，跟着改名会让历史消息的 tool_calls 对不上
  assertEqual(
    'slug' in updateMcpServerBodySchema.parse({ name: 'n', slug: 'hacked' }),
    false,
    '⚠️ `slug` 被静默剥掉（只剩它时就等于"没给任何字段" ⇒ 400）',
  )
})

await it('路径参数与列表参数：uuid 校验 + coercion 与上下限', () => {
  assertEqual(mcpServerIdParamsSchema.safeParse({ id: 'not-a-uuid' }).success, false, '非法 uuid ⇒ 400')
  assertEqual(mcpServerIdParamsSchema.safeParse({ id: mcpItemFixture.id }).success, true, '合法 uuid')
  const defaults = listMcpServersQuerySchema.parse({})
  assertEqual(defaults.offset, 0, 'offset 默认 0')
  assertEqual(defaults.limit, 20, 'limit 默认 20')
  assertEqual(listMcpServersQuerySchema.parse({ offset: '10', limit: '5' }).offset, 10, 'query 是字符串 ⇒ 必须 coercion')
  assertEqual(listMcpServersQuerySchema.safeParse({ limit: '0' }).success, false, 'limit 至少 1（0 会让列表永远空）')
  assertEqual(listMcpServersQuerySchema.safeParse({ limit: '101' }).success, false, 'limit 上限 100')
  assertEqual(listMcpServersQuerySchema.safeParse({ offset: '-1' }).success, false, 'offset 不能为负')
})

await it('`slugifyServerName`：小写化 / 折 `-` / 截断 32 / 去尾 `-` / 纯中文回落', () => {
  assertEqual(slugifyServerName('GitHub Issues'), 'github-issues', '空格折成 -')
  assertEqual(slugifyServerName('  Trimmed  '), 'trimmed', '首尾空白')
  assertEqual(slugifyServerName('a___b'), 'a-b', '连续的非字母数字折成**一个** -')
  assertEqual(slugifyServerName('--Leading'), 'leading', '去首 -（否则工具名前缀以 - 开头）')
  assertEqual(slugifyServerName('内部工单平台'), MCP_SLUG_FALLBACK, '⚠️ 纯中文整串折空 ⇒ 回落（工具名只认 ASCII）')
  assertEqual(slugifyServerName(''), MCP_SLUG_FALLBACK, '空串同样回落')
  assertEqual(slugifyServerName('a'.repeat(60)).length, MCP_SLUG_MAX, `截断到 ${MCP_SLUG_MAX}`)
  assertEqual(
    slugifyServerName(`${'a'.repeat(MCP_SLUG_MAX - 1)}-b`),
    'a'.repeat(MCP_SLUG_MAX - 1),
    '⚠️ 截断正好落在分隔符上 ⇒ 必须再去尾 `-`（否则下一步会产出 `foo--2` 这种名字）',
  )
})

await it('`uniqueSlug`：撞名加序号，且**加后缀时先截短 base**（否则后缀被截掉又撞名）', () => {
  assertEqual(uniqueSlug('foo', []), 'foo', '没占用就直接用')
  assertEqual(uniqueSlug('foo', ['foo']), 'foo-2', '占用 ⇒ -2')
  assertEqual(uniqueSlug('foo', ['foo', 'foo-2', 'foo-3']), 'foo-4', '依次递增')
  assertEqual(uniqueSlug('foo', new Set(['foo'])), 'foo-2', '接受任意 Iterable')
  const full = 'b'.repeat(MCP_SLUG_MAX)
  const next = uniqueSlug(full, [full])
  assertEqual(next.length <= MCP_SLUG_MAX, true, `结果不得超长（实际 ${next.length}）`)
  assertEqual(next.endsWith('-2'), true, '⚠️ 后缀必须完整留下 —— 直接 `slice(0,32)` 会把 `-2` 截掉，于是两个 slug 又一样')
  // 尾 `-` 的那一例：`slice` 把 base 截在分隔符上 ⇒ 再去尾后才拼后缀
  const tailed = `${'a'.repeat(MCP_SLUG_MAX - 1)}-`
  assertEqual(uniqueSlug(tailed, [tailed]), `${'a'.repeat(MCP_SLUG_MAX - 2)}-2`, '不产出 `…--2`')
})

await it('`normalizeCredentialSchema`：**逐条过滤**、永不抛错、守住 64 条上限', () => {
  const emptyCases = [null, undefined, {}, 'x', 42, [[]]]
  for (const raw of emptyCases) {
    assertEqual(JSON.stringify(normalizeCredentialSchema(raw)), '[]', `非数组（${JSON.stringify(raw)}）⇒ []，永不抛错`)
  }
  const good = { key: 'token', label: '访问令牌', type: 'string', inject: 'HEADER' }
  assertEqual(normalizeCredentialSchema([good]).length, 1, '好条目留下')
  assertEqual(
    normalizeCredentialSchema([good, { key: '', label: 'x', type: 'string', inject: 'HEADER' }, good]).length,
    2,
    '⚠️ 坏条目丢掉、好条目保留（**逐条过滤**而不是整份作废 —— 这份模板要下发给前端渲染表单）',
  )
  assertEqual(normalizeCredentialSchema([{ ...good, inject: 'COOKIE' }]).length, 0, '取值域外的 inject 丢掉')
  assertEqual(normalizeCredentialSchema([{ ...good, type: 'number' }]).length, 0, 'type 非 string 丢掉（P0 只支持 string）')
  assertEqual(
    normalizeCredentialSchema(
      Array.from({ length: MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES + 20 }, (_value, index) => ({ ...good, key: `k${index}` })),
    ).length,
    MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES,
    `截断到 ${MCP_CREDENTIAL_SCHEMA_MAX_ENTRIES} 条（与契约用同一个常量 —— 它同时是渲染上限）`,
  )
  assertEqual(CREDENTIAL_INJECT_LOCATIONS.join('/'), 'HEADER/QUERY/BODY', '注入位置取值域')
})

await it('`toolCache` 读写：坏数据**整体作废** + 三处读端同一套降级（`0` 与"没有"要分得开）', () => {
  assertEqual(parseToolCache(null), null, '`NULL` ⇒ 没有缓存')
  assertEqual(parseToolCache(undefined), null, '`undefined` ⇒ 没有缓存')
  assertEqual(parseToolCache({ fetchedAt: 'x' }), null, '⚠️ 缺 `tools` ⇒ **整份**作废')
  assertEqual(parseToolCache({ tools: [mcpToolFixture] }), null, '⚠️ 缺 `fetchedAt` ⇒ 整份作废')
  assertEqual(
    parseToolCache({ fetchedAt: 'x', tools: [mcpToolFixture, { name: 'bad' }] }),
    null,
    '⚠️ 工具数组里混着坏条目 ⇒ 整份作废' +
      '（留下半份 = "模型能调到的工具少了几个"，而界面上只是那个数字小了一点、没人看得出来）',
  )
  const cache = buildToolCache([mcpToolFixture], '2026-01-01T00:00:00.000Z')
  assertSameObject(parseToolCache(cache), cache, '良性往返（`fetchedAt` 是 ISO 字符串，不过 `Date`）')
  assertEqual(toolCountOf(cache), 1, '正常计数')
  assertEqual(toolCountOf(null), 0, '没有缓存 ⇒ 0（⚠️ 界面据此显示 `—` 而不是 `0`）')
  assertEqual(toolCountOf({ fetchedAt: 'x' }), 0, '坏数据同样退化成 0，不抛错')
  assertEqual(cache.tools[0].name, 'echo', '缓存里存的是**投影后**的工具（与出口同一份 schema）')
})

await app.close()
await closePg()
await closeRedis()

console.log('')
if (failed === 0) {
  console.log(`${c.g}${c.b}✅ 接口级验收通过：${passed} 项全通过${c.x}`)
  process.exit(0)
} else {
  console.log(`${c.r}${c.b}❌ 接口级验收未通过：${failed} 项失败 / ${passed} 项通过${c.x}`)
  process.exit(1)
}
