# 手工端测 · 命令行（归档）

> **归属**：`README.md` §一 的「手工端测 · 命令行」（**2026-09-26 拆出**，原文约 120KB / 1331 行）。
> **范围**：**P0-1-9 起**的第一族端测（第一个命令行里程碑）—— 从建号、首登改密、模型池、知识库、
> 对话 SSE 一路到 P0-2 的 MCP 工具链，全部是 **curl + 内联假上游**的可粘贴步骤。
> **状态**：所覆盖的批次（P0-1 全部 / P0-2 全部）**均已 `[✓]`**；本文属"当年怎么跑"的完整留存。
> **仍在主文件的**：「浏览器端测 · MCP」「阶段一出口验收（人工）」「阶段二出口验收（人工）」。
> ⚠️ **内联假上游**是这些步骤的前提（`backend/scripts/**` 已删，仓库里不再有夹具文件）——
> 每个小节的 ⓪ 段都自带一段可粘贴的 `node --input-type=module -e '…'`。
> **回主文件**：`../README.md`。

---

### 手工端测 · 命令行（⭐ 第一个可端测里程碑：P0-1-9 起）

**前置**：`pnpm infra:up && pnpm db:deploy && pnpm db:seed`（拿到 admin 的初始密码），然后
`pnpm dev:backend` 起后端。地址 **`http://127.0.0.1:13000`**（本机 3000 被别的项目占，见 `docs/06` §七 待决事项 6）；
macOS/Linux 走系统代理时 **curl 必须加 `--noproxy '*'`**，否则会被代理拦成 502。

```bash
BASE=http://127.0.0.1:13000
COOKIE=/tmp/jar        # ①②③ 用的登录 cookie 罐；下文统一用 $COOKIE 引用它
                       # ⭐ **只有密码类是"要你自己填"的占位符**：<初始密码> / <你的新密码> /
                       #    <member的初始密码> / <member的新密码>（`pnpm db:seed` 给的那几个）。
                       #    其余每个 `$变量` 都是**上一段 curl 的产物**，本段已逐个接上：
                       #      $ALICE(上面第 ④ 步建号) · $PROVIDER/$MODEL(附·模型池①②) · $KB(⑧建库) ·
                       #      $DOC(⑨传文档) · $AGENT(⑭-a建智能体) · $CONV(⑮-a建会话)
                       #    ⇒ **全程在同一个 shell 里跑**（换终端这些就全没了）；只想单跑某一段时，
                       #      按同一思路补一行"取现成值"，例如 ⑪⑫ 要的这两个：
                       #        KB=$(curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/knowledge-bases?limit=100" | jq -r '.data.items[-1].id')
                       #        DOC=$(curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/knowledge-bases/$KB/documents?limit=100" | jq -r '.data.items[0].id')
                       #    ⚠️ 另有 **4 条删除会让后面的步骤"没东西可查"**，别顺手先跑（各自位置都标了 ⚠️）：
                       #      ⑧ 删知识库 · ⑪ 删文档 · ⑭-f 软删智能体 · ⑮-f 删会话

# ① 用初始密码登录（用户名大小写不敏感）→ data.mustChangePassword=true
curl -s --noproxy '*' -c /tmp/jar -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"<初始密码>"}' | jq .

# ② 首登态访问业务接口 → 403「首次登录必须修改密码后才能使用其他功能」
curl -s --noproxy '*' -b /tmp/jar $BASE/api/users | jq .

# ③ 改密 → 200 且 mustChangePassword 转 false（旧密码写错会得到 400 + body.oldPassword 明细）
curl -s --noproxy '*' -b /tmp/jar -X POST $BASE/api/auth/password \
  -H 'content-type: application/json' \
  -d '{"oldPassword":"<初始密码>","newPassword":"<你的新密码>"}' | jq .

# ④ 建号 → data.initialPassword 只出现这一次
#    ⚠️ 这一条的响应**比其他 create 多包一层**：`data` = `{ user:{…}, initialPassword }`
#       （不是裸 item）⇒ 取 id 要写 `.data.user.id`，别顺手抄成 `.data.id`（会得到 null）
ALICE=$(curl -s --noproxy '*' -b /tmp/jar -X POST $BASE/api/users \
  -H 'content-type: application/json' -d '{"username":"alice","nickname":"爱丽丝"}' \
  | tee /tmp/alice.json | jq -r '.data.user.id')
jq . /tmp/alice.json ; echo "ALICE=$ALICE"   # initialPassword 就在这份响应里，只出现这一次 —— 抄下来

# ⑤ 用 ④ 拿到的初始密码登录 alice → 同样是首登态（必须改密）；改密后 403 的理由变成「仅限管理员」
# ⑥ 停用 alice → 她**手里已有的会话下一个请求就 401**（无需等 60s）
curl -s --noproxy '*' -b /tmp/jar -X PATCH $BASE/api/users/$ALICE \
  -H 'content-type: application/json' -d '{"status":"DISABLED"}' | jq .

# ⑦ 连打 6 次错密码 → 第 6 次 429「账号已锁定，请 10 分钟后重试」
for i in 1 2 3 4 5 6; do curl -s --noproxy '*' -o /tmp/b.json -w "%{http_code} " \
  -X POST $BASE/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"member","password":"nope"}'; jq -r .msg /tmp/b.json; done
```

**该看到什么**：① 200 + `mustChangePassword: true`；② 403（闸门文案）；③ 200 + `mustChangePassword: false`；
④ 200 + `initialPassword`（18 字符、无易混字符）；⑥ 401 + 「账号已停用」；⑦ 前 5 次 401 通用文案、第 6 次 429。

#### 附：模型池（P0-1-10 Provider / P0-1-11 模型）

> **P0-1-36 起这一段有了界面替代**：`/admin/models` 能建 Provider / 建模型 / 启停 / 改 / 删 / 拉上游列表
> （见「浏览器端测 · 管理页」⑨~⑫）。这一段保留的价值是：① **不依赖浏览器**就能备好数据（脚本化 / CI）；
> ② 它显式展示了**接口层的形态**（`type=CHAT`、`hasKey` 与 `apiKeyPreview`、`enabled`），
> 而界面上这些是被封装掉的。

```bash
# ⓪ 先拿一个"非首登态"的 MEMBER 会话（种子账号 member 也是首登态，会被闸门拦 —— 需先自助改密）
curl -s --noproxy '*' -c /tmp/member.jar -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"member","password":"<member的初始密码>"}' > /dev/null
curl -s --noproxy '*' -b /tmp/member.jar -X POST $BASE/api/auth/password \
  -H 'content-type: application/json' \
  -d '{"oldPassword":"<member的初始密码>","newPassword":"<member的新密码>"}' | jq .

# ① 建一个带 Key 的 Provider → 响应里只有掩码，**没有明文**
#    ⭐ 顺手把 id 抓进 $PROVIDER（②④⑤ 都要用它；⑭ 的 $MODEL 也是同一套套路）
PROVIDER=$(curl -s --noproxy '*' -b /tmp/jar -X POST $BASE/api/model-providers \
  -H 'content-type: application/json' \
  -d '{"name":"OpenAI","baseUrl":"https://api.openai.com/v1","type":"CHAT","apiKey":"sk-proj-abcdefghijklmnop"}' \
  | tee /tmp/prov.json | jq -r '.data.id')
jq . /tmp/prov.json ; echo "PROVIDER=$PROVIDER"
#  → apiKeyPreview 形如 "sk-****mnop"，hasKey:true（明文只进不出）

# ② 在它下面建一个模型（id 抓进 $MODEL）
MODEL=$(curl -s --noproxy '*' -b /tmp/jar -X POST $BASE/api/models \
  -H 'content-type: application/json' \
  -d "{\"providerId\":\"$PROVIDER\",\"modelName\":\"gpt-4o-mini\",\"label\":\"小钢炮\",\"type\":\"CHAT\",\"maxContext\":128000}" \
  | tee /tmp/model.json | jq -r '.data.id')
jq . /tmp/model.json ; echo "MODEL=$MODEL"

# ③ 全员可选列表（MEMBER 会话也能读；用 ADMIN 会话打同一地址，结果必须一模一样）
curl -s --noproxy '*' -b /tmp/member.jar "$BASE/api/models/available?type=CHAT" | jq .
#  → 只含 enabled 且 Provider 也 enabled 的模型；缺 ?type= 会得到 400（type 必填）

# ④ 停用那个模型 → 立刻从 ③ 消失，但管理列表里还看得见（两套投影的差别）
curl -s --noproxy '*' -b /tmp/jar -X PATCH $BASE/api/models/$MODEL \
  -H 'content-type: application/json' -d '{"enabled":false}' | jq .
curl -s --noproxy '*' -b /tmp/jar "$BASE/api/models?limit=100" | jq '.data.items[] | {modelName, enabled}'
# ④-b 看完差别就**启用回来** —— ⑭ 要的是"启用中的 CHAT 模型"，停着的它取不到
#      （库里只有这一个模型时尤其致命；本批 ⑤ 的 remote-models 是只读探测、不看 enabled，不受影响）：
curl -s --noproxy '*' -b /tmp/jar -X PATCH $BASE/api/models/$MODEL \
  -H 'content-type: application/json' -d '{"enabled":true}' | jq '.data | {modelName, enabled}'

# ⑤ 拉取"这个 Provider 上游实际有哪些模型"（P0-1-12）—— 省得手敲 modelName 敲错
#    ⚠️ 这一条会**真的出网**打到 baseUrl；想在本机零成本验，可先建一个指向本地服务的 Provider：
#       # 起一个假上游：node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({object:'list',data:[{id:'demo-model',owned_by:'local',created:1}]}))}).listen(18080)"
#       # 然后 POST /api/model-providers {"name":"本地假上游","baseUrl":"http://127.0.0.1:18080/v1","type":"CHAT"}
#    再打：
curl -s --noproxy '*' -b /tmp/jar "$BASE/api/model-providers/$PROVIDER/remote-models" | jq .
#  → { providerId, providerName, baseUrl, total, truncated, items:[{id, ownedBy, created}] }
#    只读探测、不落库（库里模型条数一条都不变）；上游 401/超时会得到 502/504 + 可读文案，
#    且**错误消息里不会出现你的 Key**（上游把 Authorization 回显进 body 时也照样被抹掉）。

# ⑥ embedding 双模式自检（P0-1-13）—— 没有 HTTP 端点（入库/检索是 D 包的事），
#    所以这里验的是"配置接对了没有、就绪了没有"：
pnpm config:check | grep -A8 '"embedding"'
#  → 看 mode / dim / batchSize / localRuntimeModule / apiReady
#    维度必须与 chunks.embedding 的 vector(1024) 一致（不一致会打 WARN）
node --input-type=module -e "const m=await import('./backend/dist/backend/src/llm/embedding/index.js');console.log(m.embeddingReadiness())"
#  → { mode:'api'|'local', ready:true|false, dim:1024, name:'api:<模型>'|'local:<目录名>'|null, problems:[…] }
#    ready=false 时 problems 就是"缺什么"的人话清单（同一句话会在 getEmbeddingProvider() 抛出来）
#  → api 模式：填好 EMBEDDING_API_URL/KEY/MODEL 三项即 ready；
#    local 模式：除了模型目录，还要 LOCAL_EMBEDDING_RUNTIME_MODULE（推理运行时，见 docs/02 §八）

# ⑦ 知识库数据层自检（P0-1-14）—— 没有 HTTP 端点（CRUD 是 P0-1-15 的事），
#    所以这里验的是"库结构对不对"：两扩展启用没有、两条特殊索引在不在、migrate 会不会把它们删掉：
psql "$(grep -E '^DATABASE_URL=' infra/.env | cut -d= -f2- | tr -d '"')" -c '\d+ chunks'
#  → 必须看到这两行（缺任一行都是 bug，见 issue_fix/问题记录-P0-1-14-知识库数据模型.md）：
#      "idx_chunks_embedding" hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE kb_id IS NOT NULL
#      "idx_chunks_bigram" gin (content gin_bigm_ops)
pnpm verify:knowledge
#  → 23 项全通过；其中「结构无漂移：migrate diff --exit-code = 0」是关键的一条 ——
#    它证明上面两条手写索引不会被下一次 `migrate dev` 生成 DROP INDEX（P0-1-14 实测踩到过的坑）。

# ⑧ 知识库 CRUD（P0-1-15）—— 第一个**业务资源**接口。先确认 embedding 就绪（建库要快照 provider 名）：
pnpm verify:embedding                     # 只看它有没有 ready=true 的结论行
#  → 若 ready=false，填好 EMBEDDING_API_URL/KEY/MODEL 再往下（否则建库会 500，这是刻意的）

# 用 MEMBER 账号走一遍 —— 知识库是**登录即可**，不是 ADMIN（与模型池相反）：
#   本段刻意用 /tmp/kb.jar 而不是 $COOKIE 就是为了演示这一点；两个罐看到的是**同一个库**，
#   因为 `knowledge_bases` **没有 owner 列**（⑪⑫ 用 admin 罐取 $KB/$DOC 一样能过）。
curl --noproxy '*' -c /tmp/kb.jar -X POST http://127.0.0.1:13000/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"verify-kb-member","password":"…"}'
#  → 首登会 403 要求改密，先走 /api/auth/change-password 再登一次（见上面 ② 的步骤）

# ⭐ 这一行的 `KB=$(…)` 顺手把新库的 id 抓进 $KB —— 下面 ⑨⑩⑪⑫ 全靠它：
KB=$(curl -sS --noproxy '*' -b /tmp/kb.jar -X POST http://127.0.0.1:13000/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"我的知识库"}' | tee /tmp/kb.json | jq -r '.data.id')
jq . /tmp/kb.json ; echo "KB=$KB"
#  → 201/200，**省略的参数全部快照自 `infra/.env` 的环境默认值**（不是硬编码）：
#      chunkSize / chunkOverlap / retrievalConfig{topK,score,mode,splitStrategy,rrfK,weights}
#      以及 embeddingModel（= 当前 provider 的 name()，如 api:<模型名>）+ embeddingModelChanged
#      · `tee` 那截是"既看完整响应、又把 id 抓出来"；列表按 `createdAt asc` 排
#        ⇒ 直接取"最新那个库"要写 `.data.items[-1].id`（`items[0]` 是**最老**的）

curl --noproxy '*' -b /tmp/kb.jar -X PATCH http://127.0.0.1:13000/api/knowledge-bases/$KB \
  -H 'content-type: application/json' -d '{"retrievalConfig":{"topK":12}}'
#  → 200；**只调 topK 不会把 mode 打回默认值**（局部合并，不是整体覆盖）。
#     试试 `{"description":null}`（清空）与不传 description（保持不动）—— 三态。

# ⚠️ 删除**留到最后**再跑：删了它 ⑨⑩⑪⑫ 就没库可用了（本段是"看形状"，不是"跑完就删"）
curl --noproxy '*' -b /tmp/kb.jar -X DELETE http://127.0.0.1:13000/api/knowledge-bases/$KB
#  → 200 { id, name, deletedDocuments, deletedObjects }；再 GET 该 id 应 404。
#     若这个库被某个 Agent 绑定 → **409 且什么都不删**（`agent_components.ref_id` 是多态引用、没有外键兜底）。

pnpm verify:knowledge-bases
#  → 19 项全通过（需要 PG + Redis + **MinIO**，因为验的是"删库时 S3 原文件真的消失"）。

# ⑨ 文档上传（P0-1-16）—— 四格式进门前的**四道前置校验**。先有库（用 ⑧ 抓到的 $KB）：
# ⭐ 这一行的 `DOC=$(…)` 顺手把新文档的 id 抓进 $DOC —— 下面 ⑩⑪⑫ 全靠它：
DOC=$(curl -sS --noproxy '*' -b /tmp/kb.jar -F 'file=@./员工手册.pdf' \
  http://127.0.0.1:13000/api/knowledge-bases/$KB/documents | tee /tmp/doc.json | jq -r '.data.document.id')
jq . /tmp/doc.json ; echo "DOC=$DOC"
#  → 200 { document:{ id, kbId, fileName, status:"PARSING", chunkCount:0, errorMsg:null, … },
#           deduplicated:false }
#     status 是**响应那一刻**的值，恒为 PARSING —— 解析是异步的，交给队列（P0-1-17）。
#     **worker 现在已经就位**：随后端进程启动，几秒内会把记录推成 READY（见下面 ⑩）。
#     但"传完就能检索"仍**不成立** —— 分块/向量化是 P0-1-18/19、检索是 P0-1-20。
#     同一个文件再传一次 → 200 且 deduplicated=true、**document.id 与上次相同**（不新建行，
#     且**不重复入队**）。
#     · 文档列表按 `createdAt desc` 排 ⇒ 上面"取最新一篇"的写法是 `.data.items[0].id`

# 反例三条：都是 400，但**文案不同** —— 区别在于"用户能不能自己解决"
curl --noproxy '*' -b /tmp/kb.jar -F 'file=@./老合同.doc' \
  http://127.0.0.1:13000/api/knowledge-bases/$KB/documents
#  → 400「暂不支持 .doc（旧版 Word 二进制格式），请另存为 .docx 后重传」
cp ./某张截图.png ./笔记.txt      # 改名：扩展名说 txt、内容还是 PNG
curl --noproxy '*' -b /tmp/kb.jar -F 'file=@./笔记.txt' \
  http://127.0.0.1:13000/api/knowledge-bases/$KB/documents
#  → 400「文件内容与扩展名不符：内容是「图片」，却被命名为 .txt」
#     ⭐ 改名绕过靠**文件头**抓，不靠 MIME —— 改名后浏览器照样声明 text/plain，
#        单靠"扩展名 × MIME"交叉校验这条路是**一路绿灯**的。
curl --noproxy '*' -b /tmp/kb.jar -F 'file=@./大于100MB.pdf' \
  http://127.0.0.1:13000/api/knowledge-bases/$KB/documents
#  → 413（超 `UPLOAD_BODY_LIMIT`，默认 100MB）；漏掉 -F 用 JSON 发 → 406

pnpm verify:documents
#  → 32 项全通过（需要 PG + Redis + **MinIO**）。⚠️ 它自己把 `UPLOAD_BODY_LIMIT` 注成 8KB，
#    否则超限那条只能"假装通过"（造一个 100MB 的文件会把脚本拖死）。

# ⑩ 异步流水线（P0-1-17 起；P0-1-18 补 ④⑤；P0-1-19 补 ⑥⑦）—— 上传之后**谁**把它从 PARSING 推到 READY。
#    worker 跟随后端进程启动（`pnpm dev:backend` / `pnpm start:backend` 都带它），
#    并发默认 2（`PIPELINE_CONCURRENCY`），任务队列是 Redis List（键 `PIPELINE_QUEUE_KEY`，默认 `pipeline:jobs`）。
#    阶段序列现在是六步：load-source → parse → detect-empty-text → chunk → embed → index。
#    ⚠️ **还没有列表端点**（P0-1-21），所以进度现在只能查库看：
psql "$(grep -E '^DATABASE_URL=' infra/.env | cut -d= -f2- | tr -d '"')" \
  -c "select id, file_name, status, chunk_count, error_msg from documents order by created_at desc limit 5"
#  → 刚传完是 PARSING；**几秒内变成 READY**，error_msg 为 null，chunk_count 是**真数**
#     （P0-1-19 起 = chunks 表里这篇的行数 ⇒ **READY 就是"可检索"**；检索端点本身是 P0-1-20）。
#     想看块的内容（$DOC 是 ⑨ 抓到的那个 id；**双引号**裹 -c 才会把 $DOC 展开成真值）：
#       psql "$(grep -E '^DATABASE_URL=' infra/.env | cut -d= -f2- | tr -d '"')" \
#         -c "select seq, left(content, 40), (embedding is not null) as has_vec
#             from chunks where doc_id='$DOC' order by seq limit 20"
#  → 一直停在 PARSING：worker 没起来，看后端启动日志里有没有 worker 那行；
#    变 FAILED 时 error_msg 就是原因（人话，例：S3 对象不见了 → "原文件读取失败…"）。
#
#    ⚠️ 现在有三类失败原因会在 error_msg 里出现（都能在库里直接看到）：
#      · 扫描件 / 空白文档 —— 解析出的有效字符 < `EMPTY_TEXT_THRESHOLD`（默认 50）⇒
#        含「疑似扫描件」（**注意：太短的正常文档也会命中这条门槛**，比如一张只有标题的 txt）。
#      · 文件内容与扩展名不符（改过名、对象被替换）⇒ 含「文件内容与扩展名不符」。
#      · **向量化失败** ⇒ 含「文本向量化失败（已重试 2 次）」。⚠️ P0-1-19 起流水线会真的调
#        embedding，而本机 `infra/.env` 的 `EMBEDDING_*` 三项是空的 ⇒ **手动端测前必须先配好**
#        （`EMBEDDING_MODE=api` 填 URL/KEY/MODEL，或走 local 并配好运行时模块），
#        否则每篇文档都会卡在 ⑥ 变成 FAILED —— 这不是 bug，是"没接上 embedding"。

# ⚠️ 手动重试 / 覆盖重建 / 删除现在**都有 HTTP 入口**了（P0-1-19）；
#    界面上的按钮（列表页的"重建/重试/删除"）才是 P0-1-21 的事。
#    ⑪ 覆盖重建 / 重试 / 删除文档（P0-1-19）—— 三条端点的 curl 与预期。
#    $KB 是 ⑧ 建库时抓的、$DOC 是 ⑨ 上传时抓的（换成 $COOKIE 这个 admin 罐照样能过：
#    知识库没有 owner 列，谁登录都看得到同一个库 —— ⑧ 用 member 罐只是演示"登录即可"）。
curl -sS --noproxy '*' -b "$COOKIE" -X POST \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents/$DOC/retry"
#  → 200 {document:{... status:"PARSING", errorMsg:null}}；⚠️ 已是 READY 时回 **409**「无需重试」
#    （没有东西可重试；回 200 会让界面以为在重新处理）
#    所以：刚走完 ⑨⑩（文档已 READY）时这条**按预期就是 409**，别当 bug；
#    想看到上面那个 200，就在 ⑨ 传完**马上**重试（PARSING 放行），或按本段末尾删掉重传一篇。

curl -sS --noproxy '*' -b "$COOKIE" -F "file=@./报销制度-v2.txt" \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents/$DOC/reupload"
#  → 200 {document:{id 不变, status:"PARSING", chunkCount:0}, unchanged:false}
#    ✅ 文档 id 不变（不新建行）；旧 chunk 立刻清掉（检索空窗是 §七 的刻意取舍）
#  → 再传**一模一样**的内容 → 200 且 **unchanged:true**（「内容未变化，已跳过」）：
#    不落新对象、不删旧 chunk、不入队 —— 三个"没做"

# ⚠️ 删文档这一步同样**留到最后**（⑫ 的检索就靠 $DOC 这篇在库里 —— 删了它 ⑫ 只会搜到空结果）
curl -sS --noproxy '*' -b "$COOKIE" -X DELETE \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents/$DOC"
#  → 200 {id, fileName, deletedChunks:N}；DB 行 + 其 chunk（级联）+ S3 原文件都清掉
#  → 再删一次 → 404（不是 500，也不是静默成功）

# ⑫ 双路检索 / RRF 融合（P0-1-20）—— D 包这条链路的终点：上传 → READY → **检索得到**
#    前置：库里有 `READY` 的文档（⑨⑩ 做完，**且没跑上一条删除**），且 `EMBEDDING_*` 已配好（检索要算 query 向量）
#    $KB 沿用 ⑧ 抓到的那个库（检索按 `kbId` 圈定范围，跑错库会得到一堆空结果）
curl -sS --noproxy '*' -b "$COOKIE" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:13000/api/knowledge-bases/$KB/search" \
  -d '{"query":"出差住宿标准"}' | jq .
#  → 200 {code:0, msg:"ok", data:{items:[{…六列分数…, rrfScore, finalRank}], mode:"HYBRID", topK, rrfK,
#          candidatePool, elapsedMs, vectorPathSkipped:false, warnings:[]}}
#    · items 里每一条都带：vectorScore/vectorRank、fulltextScore/fulltextRank（**没命中的那一路是 null**）、
#      rrfScore（= RRF 融合分）、finalRank；`snippet` 是命中位置前后各 80 字符的**原文**（可直接核对）
#    · 同一句话加上 `"mode":"FULLTEXT"` / `"mode":"VECTOR"` 可以分别只跑单路（试查页就靠它）
#    · 加 `"topK":1` 只返回一条；**这两个覆盖项不会写进库配置**（库的检索口径不受影响）

curl -sS --noproxy '*' -b "$COOKIE" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:13000/api/knowledge-bases/$KB/search" \
  -d '{"query":"请问出差住宿标准是多少？","mode":"FULLTEXT"}' | jq '.data.items[0].fulltextRank,.data.items[0].snippet'
#  → 全文路 1 与原文片段：证明①**标点与"请问/是多少"这类脚手架被剥掉了**（否则字面匹配必空）、
#    ② pg_bigm 中文 bigram 真的生效（⚠️ 若这里恒为空，先看 `pnpm verify:knowledge` 的索引断言）
#    ⚠️ 全文路是**字面子串**匹配 ⇒ 只适合短查询。一句长问句（哪怕截断到 64 字符）几乎不可能连续
#       出现在正文里，那是**预期行为**不是 bug；长问句请用 HYBRID/VECTOR。

pnpm verify:retrieval
#  → 27 项全通过（需要 PG + Redis + MinIO；脚本自己起"词面重叠型"的假 embedding 上游）。
#    它额外钉死两件事：**两条路的名次/分数与独立 SQL 逐条相等**（证明分数不是编出来的）、
#    **RRF 的数值可以用返回的两路名次反算出来**（证明融合就是那个公式）。

# ⑬ 文档列表 / 下载原始文件（P0-1-21）—— 流水线进度的可视出口 + 取回原件核对
curl -sS --noproxy '*' -b "$COOKIE" \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents?limit=20" \
  | jq '.data | {total, items: [.items[] | {fileName, status, chunkCount}]}'
#  → {total, items:[{fileName,status,chunkCount},…]}：每篇的状态一眼可见
#    · `PARSING` 必须显示「更新中，暂不参与检索」（shared 的 `DOCUMENT_PARSING_HINT`）——
#      `§七` 的"先删后建"有一段检索空窗，这期间搜不到它**不是 bug**；
#    · **最新上传的在第一条**（排序 `createdAt desc`，与 `/api/users` 等相反，理由见 `docs/02` §4.6）；
#    · 库不存在 → 404（不是空列表）；`limit` 上限 100。

curl -sS --noproxy '*' -b "$COOKIE" -D /tmp/dl-headers -o /tmp/orig.txt \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents/$DOC/download"
grep -iE 'content-type|content-length|content-disposition' /tmp/dl-headers
#  → content-type: text/plain; charset=utf-8（按扩展名唯一确定，文本类型带 charset）
#    content-disposition: attachment; filename="…"; filename*=UTF-8''%E6%8A%A5%E9%94%80…（中文名靠后一段）
#    ✅ 取回来的字节与上传的**逐字节相等**（`cmp -s /tmp/orig.txt <你上传的文件>`）
#  → 行还在但对象丢了（存储被清）→ 404「原始文件已不在存储中…请重新上传」（**不是** 500、也不动数据库）
#  ⚠️ 这是本仓唯一**不返回 JSON 信封**的端点：成功时是字节流，失败时才是信封 —— 客户端要按状态码分支。

# ⑭ 智能体 CRUD（P0-1-22）—— 包 E 起步：列表 / 建 / 详情 / 改 / 软删 + 权限
#    前置：需要一个**启用中的对话模型**（`type=CHAT` 且 Provider 也启用）。
#    下面这行**现取**一个，不写死 ①② 那个 id（它中途被"附·模型池④"停用、④-b 又启用回来）：
MODEL=$(curl -sS --noproxy '*' -b "$COOKIE" \
  "http://127.0.0.1:13000/api/models/available?type=CHAT" | jq -r '.data.items[0].id')
#    本机 `.env` 没配 embedding 也不影响这一组（智能体不碰流水线）。
#  ⚠️ 这条响应是 `{items:[…]}` 而**不是**裸数组 —— 写成 `.data[0].id` 会得到 `null`，
#     于是下面建智能体时 modelId="null" → 400「模型 ID 不是合法 UUID」。
#     （同一类"信封多包一层"的坑：`/api/users` 建号返回的是 `{user:{…}, initialPassword}`）
#  ⚠️ 若 `$MODEL` 取到**空**，就是库里没有启用中的 CHAT 模型（常见原因：④ 停用后没跑 ④-b）
#     ⇒ `echo $MODEL` 确认一下，空的话回去启用一个再往下。

# ⑭-a 建一个 ChatBot（字段全覆盖：图标 / 系统提示词 / 开场白 / 引导问题）
# ⭐ 这一行的 `AGENT=$(…)` 顺手把新智能体的 id 抓进 $AGENT —— 下面的 ⑭-d/⑭-f/⑭-h 与整个 ⑮⑯ 全靠它：
AGENT=$(curl -sS --noproxy '*' -b "$COOKIE" -X POST http://127.0.0.1:13000/api/agents \
  -H 'content-type: application/json' -d "{
    \"name\":\"报销小助手\",\"type\":\"CHATBOT\",\"modelId\":\"$MODEL\",
    \"description\":\"回答报销制度问题\",\"icon\":\"🧾\",
    \"systemPrompt\":\"你是报销制度助手，只依据知识库回答。\",
    \"openingRemarks\":\"你好，问我报销的事吧。\",
    \"guideQuestions\":[\"差旅费怎么报？\",\"发票丢了怎么办？\"] }" \
  | tee /tmp/agent.json | jq -r '.data.id')
jq '.data | {id, name, type, modelLabel, modelAvailable, canEdit, guideQuestions}' /tmp/agent.json
echo "AGENT=$AGENT"
#  → canEdit:true（自己建的）、modelAvailable:true、guideQuestions 是**数组**（列默认 []）

# ⑭-b 列表：**对全员开放**，每项带 canEdit（自己真 / 他人假 / ADMIN 真）
curl -sS --noproxy '*' -b "$COOKIE" 'http://127.0.0.1:13000/api/agents?limit=20' \
  | jq '.data | {total, items: [.items[] | {name, type, canEdit}]}'
#  → 刚建的排**第一条**（排序 `updatedAt desc`；与 `/api/users` 等的 asc 相反，理由见 `docs/02` §4.4）

# ⑭-c 绑定一个**停用的**模型 → 409（四种失败各有可执行的文案，见 `docs/02` §4.4「契约增量 · Agent」④）
#      · 不存在 → 404 ｜ 是 EMBEDDING 模型 → 409 ｜ 模型停用 → 409 ｜ 所属 Provider 停用 → 409

# ⑭-d 三态：只改名字（不带 description）→ description **原样不动**；显式传 null → 清空
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH http://127.0.0.1:13000/api/agents/$AGENT \
  -H 'content-type: application/json' -d '{"name":"报销助手 v2"}' | jq '.data | {name, description}'
#  → description 还是"回答报销制度问题"（**不是**被清空）—— `.nullable().optional()` 且**没加** `.default()`

# ⑭-e 改 type → 409「智能体类型创建后不可修改」（可传但不可改；传同值 200，幂等）
# ⑭-f 删除（**软删**）：返回两个连带数字；随后详情/编辑/再删一律 404（**不是** 403）
#      ⚠️ 也**留到最后**再跑：删了它 ⑮⑯ 就没 agent 可用了（会话建不了 ⇒ ⑯ 也没会话可发）
curl -sS --noproxy '*' -b "$COOKIE" -X DELETE http://127.0.0.1:13000/api/agents/$AGENT \
  | jq '.data'   # → {id, name, removedComponents, finishedConversations}
#  → 会话没被删（只转 FINISHED「只读保留」）、组件绑定已解除（否则**绑过的知识库会永远删不掉**）

# ⑭-g 权限守门（用 MEMBER 会话）：改**别人**的智能体 → 403；改**自己**的 → 200
#      ⚠️ "别人的 id"要**真人工**：最省事的做法是直接把上面 admin 的 $AGENT 填进去
#         （member 改 admin 建的 = 反方向），想验"改自己的 200"就用 member 罐自己 POST 一个
curl -sS --noproxy '*' -b /tmp/member.jar -X PATCH \
  http://127.0.0.1:13000/api/agents/<别人的 agent-id> \
  -H 'content-type: application/json' -d '{"name":"偷改"}' | jq .msg
#  → 「只有该智能体的创建者或管理员可以修改它」；用 admin 的会话改**同一个** id 必须 200
#    （只验"普通用户 403"的话，一个"仅创建者"的实现会全绿 —— 所以两个方向都要亲手试一次）

# ⑭-h 组件绑定（P0-1-23）—— **整体替换**：提交什么，库里就有什么
# （$KB1/$KB2 是**为这条用例另取的两个**库 id，跟 ⑧ 的 $KB 不是一回事；名字像，别混）
# ⚠️ 要**至少两个**知识库：清单按 `createdAt asc` 排，所以这两行拿的是**最老的两个**；
#    库里不足两个时 `.data.items[1]` 是 null ⇒ 下面 PUT 会得到 400「refId 不是合法 UUID」
KB1=$(curl -sS --noproxy '*' -b "$COOKIE" 'http://127.0.0.1:13000/api/knowledge-bases?limit=20' | jq -r '.data.items[0].id')
KB2=$(curl -sS --noproxy '*' -b "$COOKIE" 'http://127.0.0.1:13000/api/knowledge-bases?limit=20' | jq -r '.data.items[1].id')

curl -sS --noproxy '*' -b "$COOKIE" -X PUT \
  http://127.0.0.1:13000/api/agents/$AGENT/components \
  -H 'content-type: application/json' \
  -d "{\"components\":[{\"componentType\":\"KNOWLEDGE\",\"refId\":\"$KB1\"},
                       {\"componentType\":\"KNOWLEDGE\",\"refId\":\"$KB2\"}]}" \
  | jq '.data.components'
#  → 两条绑定（顺序恒为 componentType+refId 升序）；响应就是**详情那一套投影**（不是只回 components）

curl -sS --noproxy '*' -b "$COOKIE" -X PUT \
  http://127.0.0.1:13000/api/agents/$AGENT/components \
  -H 'content-type: application/json' -d "{\"components\":[{\"componentType\":\"KNOWLEDGE\",\"refId\":\"$KB1\"}]}" \
  | jq '.data.components'   # → 只剩 KB1：**全量替换**，没提交的那条立即消失
#  → 传 [] 即"解绑全部"（清空**只有**这一种写法：省略 components 是 400，不是清空 ——
#    否则前端某次忘带字段就会**静默解绑所有知识库**而界面显示"保存成功"）

#  ⚠️ 三条会踩到的（都是**预期**，不是 bug）：
#    · 引用了**不存在**的知识库 → 404，且**旧的绑定一条都不会动**（校验排在删除之前；文案带上是哪个 id）；
#    · 提交里含 `MCP` → 400「MCP 服务器功能尚未开放（P0-2 才提供注册与绑定）」——
#      `mcp_servers` 表要到 P0-2 才建，现在**不可能**选出一个真实 server，写进去只会留下修不好的孤儿绑定；
#    · 重复提交同一份（哪怕换个顺序）→ 200 但**什么都不写**（幂等：`agent_components` 的行 `id` 不变）。
#  另一条容易忽略的：这个请求**不会**改智能体的 `updated_at`
#  ⇒ 首页列表顺序不跳（"解绑一个知识库"跟"编辑智能体"是两件事）。

pnpm verify:kb-package
#  → 11 项全通过（包 D 收口）：一行一组逐行跑 `子方案①` §十二 的 8 行，每行打印结论。

pnpm verify:pipeline
#  → 29 项全通过（需要 PG + Redis + MinIO）。它用**随机队列键**（`verify:pipeline:jobs:<rand>`）
#    跑，不碰你开发队列里的任务，收尾会删掉该键并断言残留为零。
#    ⚠️ 它和 ⑪ ⑫ 都会自己起一个**假 embedding 上游**（本机 .env 的三项是空的也能跑）。

pnpm verify:ingest
#  → 23 项全通过（同样需要 PG + Redis + MinIO）。这一档专验"入库之后的形态"：
#    chunk 真的落库且都有向量、id 版本位是 7、覆盖重建换内容不换 id、重试能救回 FAILED、删除三清。

# ⑮ 会话管理（P0-1-25）—— 包 F 起步：某 Agent 的会话列表 / 建 / 改名 / 删 / 活跃态
#    ⚠️ 权限是**第四族**：会话 = **仅创建者本人**（连 ADMIN 也看不到别人的会话，一律 404）。
#    前置：一个**未软删**的智能体与它的 agent-id —— 就是 ⑭-a 抓到的 $AGENT
#    （所以别先跑 ⑭-f 那条软删，删了它这里建会话会 404）。

# ⑮-a 新建会话 → topic:null、lastMessageAt:null（本批没有自动命名）
#    ⭐ 同样顺手把会话 id 抓进 $CONV —— ⑮-c 到 ⑯ 全靠它：
CONV=$(curl -sS --noproxy '*' -b "$COOKIE" -X POST http://127.0.0.1:13000/api/conversations \
  -H 'content-type: application/json' -d "{\"agentId\":\"$AGENT\"}" \
  | tee /tmp/conv.json | jq -r '.data.id')
jq '.data | {id, agentName, agentType, topic, status, lastMessageAt}' /tmp/conv.json
echo "CONV=$CONV"
#  → status:"ACTIVE"；topic 与 lastMessageAt 都是 null（"还没说过话"与"刚说了话"必须分得开）
#    建会话只校验"Agent 存在且未软删"——**刻意不校验**模型可用/Provider 有没有配 Key
#    （那是"发消息"的前置，属 P0-1-26/27；否则模型停用后连自己的历史都进不去）

# ⑮-b 列表：**新会话排最前**（`lastMessageAt desc` 且 `nulls:'first'`）
curl -sS --noproxy '*' -b "$COOKIE" "http://127.0.0.1:13000/api/agents/$AGENT/conversations?limit=20" \
  | jq '.data | {total, items: [.items[] | {topic, lastMessageAt}]}'
#  → ⚠️ 最容易误判成"新建没成功"的一条：新会话的 lastMessageAt 是 null，
#    若实现漏写 `nulls:'first'` 它会被排到列表**最后**（PG 的 DESC 默认是 NULLS FIRST，
#    但这条口径必须**显式**写出来，见 `docs/02` §4.5 ③）。
#    另外**软删的 Agent 照样能查**（会话"只读保留"），但"Agent 不存在"回 404 而不是空列表。

# ⑮-c 改名（行内编辑）→ 200；`topic` **不是三态**：传 null 会被 400 拒（界面没有"清空标题"）
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH http://127.0.0.1:13000/api/conversations/$CONV \
  -H 'content-type: application/json' -d '{"topic":"差旅费怎么报"}' | jq '.data.topic'
#  → 已结束（FINISHED）的会话也照样能改名/删除（"只读"只拦"产生消息"，见 `docs/02` §4.5 ⑦）

# ⑮-d 活跃流状态 → **恒为无流**（写侧 `chat.active:{id}` 属 P0-1-26）
curl -sS --noproxy '*' -b "$COOKIE" http://127.0.0.1:13000/api/conversations/$CONV/active | jq '.data'
#  → {streaming:false, queuedPosition:null, currentTool:null, startedAt:null}
#    ⚠️ `streaming` 是**派生**的（Redis 键在 ⇒ true）⇒ 不可能出现"键在但 streaming:false"；值坏也只降级不 500。
#       本批没有发消息的端点 ⇒ 一直 false 是**预期行为，不是 bug**。

# ⑮-e 权限守门：用**别的账号**（ADMIN 也一样）读/改/删同一个会话 → 一律 **404**（不是 403）
curl -sS --noproxy '*' -b /tmp/member.jar http://127.0.0.1:13000/api/conversations/$CONV | jq .msg
#  → 404「会话不存在」（`PATCH` / `DELETE` / `/active` 同理）。**刻意不是 403**：
#    403 等于确认这个 id 有效，而会话 id 不出现在任何对他人可见的列表里，藏得住。

# ⑮-f 删除 → 级联删消息，响应给出**同事务"先数后删"**得出的 deletedMessages
#      ⚠️ 这是本段**唯一会毁掉后续步骤**的一条（⑯ 还要用 $CONV 发消息）⇒ 放到 ⑯ 之后再删
curl -sS --noproxy '*' -b "$COOKIE" -X DELETE http://127.0.0.1:13000/api/conversations/$CONV | jq '.data'
#  → {id, agentId, topic, deletedMessages}；会话从列表里消失，活跃流锁一并清掉。
#    ⚠️ P0-1 阶段**没有会话级的 S3 对象**（产物属 P0-3、附件属 P1）⇒ 这一步不进 S3，
#       是**诚实的空操作**（接回点在 `collectConversationObjectKeys`，见 `docs/02` §4.5 ⑥）。

# ⑯ SSE 出口（P0-1-26）—— 发消息 / 停止 / 互斥 / 心跳
#    ⚠️ 必须带 `curl -N`（关掉 curl 自己的输出缓冲），否则你看到的永远是空
curl -N -sS --noproxy '*' -b "$COOKIE" -X POST \
  http://127.0.0.1:13000/api/conversations/$CONV/chat \
  -H 'content-type: application/json' -d '{"content":"你好"}'
#  → 响应头 **text/event-stream 立刻到达**（不是等到第一帧），随后是**真正的回答**：
#      event: citations   data: {"items":[{"docName":"…","snippet":"…","score":0.0328}]}   ← 有命中知识库时才发
#      event: thinking    data: {"text":"…"}                                             ← 模型支持思维链时才有
#      event: delta       data: {"text":"…"}                                              ← 逐字追加
#      event: ping        data: {"ts":"…"}                                                ← 每 20s 一条，**与回答无关**
#      event: done        data: {"finishReason":"COMPLETE","messageId":"…","usage":{…}}
#    ⚠️ `ping` 是**无条件周期**发的（活跃时也在发），前端对它**静默忽略**；想快点看到它就用
#       `SSE_PING_INTERVAL_SEC=2` 起后端。⚠️ 回答"跑起来"有前置：Provider 配了 Key、模型启用、
#       Agent 绑了 CHAT 模型 —— 缺了会在**开流之前**拿到 424/409 的 **JSON 信封**（不是事件）。
#    另开终端看活跃态（`streaming` 是**派生**的：键在 ⇒ true）：
curl -sS --noproxy '*' -b "$COOKIE" http://127.0.0.1:13000/api/conversations/$CONV/active | jq '.data'
#  → {streaming:true, startedAt:"…", queuedPosition:null, currentTool:null}

# ⑯-b 互斥：**流还跑着**的时候再发一次
#  → HTTP **200** + 单帧 `error` 事件（**不是 409 信封** —— 冲突的主语是"这一轮生成"，
#    前端按"消息流内错误卡"渲染；而 401/400/404/424 那类是"请求/目标"的问题，才走信封）：
#      event: error
#      data: {"code":"CONFLICT","message":"该会话正在生成中，请等当前回答结束或先停止它"}
#    第一条流**不受影响**，仍在发心跳。

# ⑯-c 停止（第三个终端）→ 200 {"signaled":true}
curl -sS --noproxy '*' -b "$COOKIE" -X POST http://127.0.0.1:13000/api/conversations/$CONV/stop | jq '.data'
#  → 5s 内第一条流收到**最后一帧** `event: done` / `data: {"finishReason":"STOPPED",…}` 后关闭；
#    再打一次 `/stop` → {"signaled":false}。⚠️ **幂等**：对"没有流"的会话也是 200，
#    点了两次不该报错，停止信号也不会残留（紧接着新开一条流不会被上一轮秒停）。
#    停止之后 `/active` 回到 {streaming:false,…}，两个 Redis 键（active / stop）都不残留。

# ⑯-d 断线即解锁：把第一条流直接 Ctrl-C 掐掉，然后**立刻**重发 ⑯ → 能拿到 200（不必等 TTL）。

# ⑯-e "只读"写不进去（P0-1-24 门槛④ 的另一半）：删掉该会话所属的 Agent 之后，同一句 chat
#  → **409 信封**（主语是"这个会话"，故不是事件），且**不是** SSE —— 与 ⑯-b 对照着看。

# ⑰ ChatBot 编排循环（P0-1-27）—— 检索块 / 引用卡 / 落库 / 并发闸
#    前置（缺任何一个都会在**开流之前**拿到信封，见 `docs/02` §4.5 ⑨）：
#      · Provider 配了 Key（`/api/model-providers/:id` 的 apiKey）
#      · 模型启用且属于该 Provider，`type=CHAT`
#      · 这个 Agent **绑了这个模型**（`PATCH /api/agents/$AGENT` 传 modelId）——
#        建 Agent 时刻意不校验模型（P0-1-22），但**发消息**必须能解析出一个可用的聊天目标
#    ⑰-a 命中知识库：用 ⑬ 建好的、里面真有内容的库，且把该库用
#         `PUT /api/agents/$AGENT/components` 绑到这个 Agent 上，然后发一句**库里有答案**的话：
curl -N -sS --noproxy '*' -b "$COOKIE" -X POST \
  http://127.0.0.1:13000/api/conversations/$CONV/chat \
  -H 'content-type: application/json' -d '{"content":"出差住宿标准是多少"}'
#  → `citations` 事件**先于**任何 `delta` 到达，且它的 `snippet` 与库里那块正文**逐字相同**
#    （引用卡的全部意义就是"让人核对模型看到了什么"）；随后 `delta` 逐字追加；最后
#    `done{finishReason:"COMPLETE", messageId:"…", usage:{tokensIn,tokensOut}}`。
#    ⚠️ 回答里出现的文档名**只可能来自注入的检索块**（模型没见过别的）⇒ 这是"检索真的进了 prompt"的旁证。
#    服务端日志里另有一条 `本轮首字延迟（TTFT）` 的 info 行 —— 它是 `01` 阶段一"首字 < 3s"的**唯一**测量依据。

# ⑰-b 未命中：对一个**没绑库**的 Agent 发同样的话
#  → **没有 `citations` 事件**（不是发一个空 items —— 前端按"有没有这个事件"决定要不要画引用区），
#    且 system prompt 里写明了"没有检索到…不要编造文档名或来源"，回答里**不应出现任何文档名**。
#    ⚠️ 这条是 `01` 决策 12 的两半（prompt 约束 + 不发引用卡），只做一半都是治表面。

# ⑰-c 落库：等 ⑰-a 的流收尾后，直接查库看"这一轮真的进了历史"
#      （**P0-1-28 起**更该用 ⑱ 的 `GET /:id/messages` 拉 —— 那才是产品路径；psql 只是另一种取数方式）
docker exec -i doubulea-postgres psql -U doubulea -d doubulea -c \
  "select role, content->>'text' as text, tokens_in, tokens_out from messages where conversation_id='$CONV' order by created_at;"
#  → 两条：USER（正文 = 提问原文）+ ASSISTANT（正文 = 你刚才看到的那串 delta 拼接，**不多不少**）。
#    ⚠️ 若是"用户刚发出去就点了停止"且一个字都没生成，则**只有 USER** —— 不写空气泡，
#       此时 `done.messageId` 是 **null**，语义正是"这一轮没有产生可持久化的消息"。
#    这个会话的 `last_message_at` 也**同时**前进（三件事一个事务：两条消息 + 活跃时间）。

# ⑰-d 停止（P0-1-27 起"已生成部分会保留"）：在 ⑰-a 的流还在吐字时另开终端打 ⑯-c
#  → 收到 `done{finishReason:"STOPPED"}` 且 **messageId 非空**；库里那半条回答**原样保留**，
#    紧接着**直接再问一句**能成（历史里含刚被停掉的那半条 —— 追问不用重来）。
#    ⚠️ 停止前若一个字都没吐（`thinking` 也没有），则没有助手行、`messageId` 为 null（见 ⑰-c）。

# ⑰-e 并发闸：把后端用 `CHATBOT_CONCURRENCY=1` 起，然后**同时**开两条流
#  → 第一条正常；第二条 HTTP **200** + 单帧 `error{code:"BUSY"}`（**不是 429 信封** ——
#    满/冲突的主语都是"这一轮生成"，与 ⑯-b 的 CONFLICT 同一判断），
#    且**被拒的那一轮一个字都不落库**（前置失败 ⇒ 这一轮没发生）。

# ⑰-f 超长会话：连着问 20 轮以上
#  → 不报错；进 prompt 的历史只保留最近 `CONTEXT_ROUNDS`（默认 20）**轮**（= 40 条）。
#    ⚠️ 本版本**不做 token 级裁剪**（没有可用的 tokenizer，按字符估算是"假保护"，见 `docs/02` §6.2 ⑧）。

# ⑱ 消息历史（P0-1-28）—— 刷新页面 / 翻页 / 看引用卡结构
#     ⚠️ 前置：⑮-a 建过会话（$CONV），且 ⑰-a 说过至少一句（否则库里没消息可翻）。
#     ⚠️ 这条端点就是**浏览器刷新后**重新画出整个对话页的那一个请求（界面渲染属 P0-1-32~34，
#        现在浏览器里仍是占位页；但**它返回的东西**已经和你刷新页面时要看到的一模一样）。

# ⑱-a 拉最近一页（不传游标 ⇒ 从最新往前数）
curl -s --noproxy '*' -b "$COOKIE" "http://127.0.0.1:13000/api/conversations/$CONV/messages" | tee /tmp/msg1.json | jq .
#  → { "items": [...], "nextCursor": "<最早那条的 id>", "hasMore": true/false }
#    ⚠️ 是 `{code,msg,data:{items,nextCursor,hasMore}}` 三层信封，取值写 `.data.items`。
#    ⚠️ **没有 total**：messages 是**按月分区表**，数一次要在 14 个分区上各跑一遍 ——
#       所以分页用"多取一条判 hasMore"，翻完就停，不要去找总数。
#    ⚠️ items 是**时间正序**（旧的在前），与界面从上到下的顺序一致。

# ⑱-b 引用卡结构（`01` §3.4「完整还原」的取证点）：翻到那条**带引用的助手回答**
jq -r '.data.items[] | "\(.role)｜\(.content.text // "")｜citations=\((.content.citations // []) | length)"' /tmp/msg1.json
#  → 助手那条的 `content.citations[]` 是 `{docName, snippet, score}`（score 是**融合分** rrfScore），
#    与 ⑰-a 流里 `citations` 事件里看到的**同一份形状、同一份内容**（`shared` 里只定义了一次）。
#    ⚠️ `content` 是**原样透出**的 jsonb：P0-2 的 `tool_calls`、P1 的 `attachments` 将来就躺在同一层，
#       读取端**刻意不过滤**（过滤会把没声明的键静默剥掉 ⇒ 历史里工具调用凭空消失且没有任何报错）。

# ⑱-c 翻页（游标 = 上一页的 `nextCursor`，也就是"比这一页更早的最近一条"的 id）
CUR1=$(jq -r '.data.nextCursor' /tmp/msg1.json)
curl -s --noproxy '*' -b "$COOKIE" "http://127.0.0.1:13000/api/conversations/$CONV/messages?beforeId=$CUR1&limit=50" \
  | tee /tmp/msg2.json | jq '.data | {n: (.items|length), nextCursor, hasMore}'
#  → 新一页里**不包含** `$CUR1` 那条（游标是**严格更早**）⇒ 两页拼起来**不重不漏**。
#    方便时自证：`jq -r '.data.items[].id' /tmp/msg1.json /tmp/msg2.json | sort | uniq -d` 应当**无输出**。

# ⑱-d 两个边界（都是**故意的**行为，别当 bug）
#   ① limit 上限 100：`?limit=1000` → **400**（不设上限等于允许一次拉爆分区表）；
#   ② `beforeId` 必须是**这个会话里的**消息 id：拿别的会话的 id（或一个纯 UUID）来 → **400**
#      （而不是"当成没有游标"静默返回第一页 —— 那会让客户端陷入"永远在第一页"的死循环，
#        而且状态码全是 200、日志里什么都没有）。
#   ⚠️ 权限：只读**自己**的会话，别人的 / 不存在的 / ADMIN 看别人的 **一律 404**（403 等于确认 id 有效）。

# ⑲ 对话包验收（P0-1-29 —— 包 F 收口 / 阶段一出口）：七条门槛一次串跑
#     与 ⑰⑱ 的区别：那两段是"一个端点一个端点地看"，这一段是**把整条链从头串一遍** ——
#       B 建号 → C Provider/模型 → D 建库+上传+流水线 → E 建 Agent+绑库 → F 提问→检索→流式→引用→落库。
#     这也是**唯一**一条能一次验完七条门槛的路径；⑰（提问带引用）+ ⑱（刷新后历史含引用卡恢复）
#     两条合起来正是门槛①②③，其余四条（并发 CONFLICT / 25 轮超长 / 首字 < 3s / 无手工干预数据）在 ⑯⑰ 里各有一角。
#     ⚠️ 前置：依赖全起（**PG + Redis + MinIO** —— 三篇 PDF 要真落 S3）+ 迁移（`pnpm infra:up && pnpm db:deploy`）；
#        脚本**自己**起真进程（默认 **13096**）+ 真 TCP + 两个假上游 + 3 篇真 PDF，**不碰你 13000 的后端**，跑完自清。
pnpm verify:chat-package
#  → 24 项全通过，末尾一张结论表（R1~R7 逐行 PASS/FAIL；三处"部分完成"**单列、不混进 ✅**）。
#    ⚠️ 想手工走这条链而不是跑脚本：按 ①→④→⑧→⑨→⑩→⑭→⑮→⑰→⑱ 的顺序照抄即可。
#    ⚠️ 门槛⑦「全程无手工干预数据」是**意图**、不是一句可断言的话 —— 脚本把它拆成四条
#       "只有服务端能产生"的证据（自选密码登这个新号 401 / `POST /api/users` 回的 `initialPassword` 200 /
#       chunk 正文含上传特征短语且 `chunkCount` == 表行数 / 助手正文 == 事件流增量拼接）；
#       手工端测时对应做法就是**全程不碰 SQL**（⑰-c 的 psql 只为看结果、不为改数据）。

pnpm verify:conversations
#  → 24 项全通过（需要 PG + Redis，**不需要 MinIO**；含 P0-1-28 的 H 组 9 项）。

pnpm verify:chatbot
#  → 21 项全通过（需要 PG + Redis，**不需要 MinIO**；脚本自己起进程 + 两个假上游，跑完删净）。

# ⑳ MCP server 注册与连通测试（P0-2-2）—— 工具闭环第 2 步：注册 server → 测连通（拿 tools/list）→ 看工具清单
#     这一段**不需要 ADMIN**：`/api/mcp/**` 的**建 / 看**是"登录即可"。
#     ⚠️⚠️ **本段的权限口径在 P0-2-12（2026-09-24）改过一次** —— 原文写的是"权限第五族 = 登录即可、
#         `created_by` 只是留痕、任何登录用户都能改/删别人注册的 server"。**现在不是了**：
#         **改/删 = 注册者（= 所属人，`created_by`）+ ADMIN**（与智能体同族）；建 / 看 / 测试 / 调用仍全员可用。
#         下面 ⑳-* 各条的命令行**照旧能敲**（$MCP_USER 自己建的就是自己所属的，改/删自己是 200），
#         但"拿 $MEMBER_USER 删 $MCP_USER 建的 server 会 200"那半句**已作废** ⇒ 现在是 **403**
#         （浏览器侧的跑法见「浏览器端测 · MCP」的**【所属人】组** ②~④⑦）。
#     ⚠️ P0-2 的凭据收窄（`/api/mcp/credentials` 只能动自己的，P0-2-4）与本节是**两个判据**，别混。

# ⑳-⓪ 另开一个终端：起一个**假 MCP server** 并前台常驻（Ctrl-C 收工）—— 它打印的地址就是 $MCPURL
#     ⚠️ 这一段是**内联**的：仓库里**不再放夹具文件**（夹具已随 2026-09-24 的定案删除 —— 上一版这里
#        引用的 `backend/scripts/fixtures/mcp-upstream.mjs` 已经不存在了，整条 ⑳ 当时是跑不起来的）。
#        它**逐条打印收到的 method**，那就是"上游到底被请求了几次"的**唯一取证方式**（见 ㉒-b）。
node --input-type=module -e '
const http = await import("node:http");
let n = 0;
const srv = http.createServer(async (req, res) => {
  if (req.method !== "POST") { console.log(`[假上游] ${req.method}（不计入）`); res.writeHead(200).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  const msg = body === "" ? null : JSON.parse(body);
  n += 1;
  console.log(`[假上游] #${n} ${msg?.method ?? "(无 method)"}`);
  if (msg === null || msg.id === undefined) { res.writeHead(202).end(); return; }
  const result = msg.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.0.0" } }
    : msg.method === "tools/list"
      ? { tools: [ { name: "echo", description: "原样回显传入的 text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
                   { name: "now", description: "返回服务器当前时间", inputSchema: { type: "object", properties: {} } } ] }
      : {};
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});
srv.listen(0, "127.0.0.1", () => console.log("MCPURL=http://127.0.0.1:" + srv.address().port + "/mcp"));
'
#  → 形如 `MCPURL=http://127.0.0.1:54321/mcp`（Streamable HTTP 端点是**单一 URL**，不拼路径段）
#  ⚠️ **记账口径**（先看清楚再数，别自己吓自己）：一次成功的"连接 + 拉列表"固定是 **3 条** ——
#     `initialize` + `notifications/initialized` + `tools/list`；握手后 SDK 还会发一个 **GET**
#     （想开 SSE 推送流），那一条**不计入**（假上游对非 POST 一律回 200 并单独打印）。
#     ⇒ 想验"某条路径到底联没联网"，**数 # 的增量**就行 —— 这是 ㉒-b 的取证方式。

# ⑳-a 注册（注册**不要求上游可达** —— endpoint 写错也照常建成功，连通留给 test 那一步）
MCP=$(curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/mcp/servers \
  -H 'content-type: application/json' \
  -d '{"name":"本地假 MCP","endpointUrl":"'"$MCPURL"'","authType":"NONE"}' \
  | tee /tmp/mcp.json | jq -r '.data.server.id')
jq . /tmp/mcp.json ; echo "MCP=$MCP"
#  → data = `{ server:{…}, test:{…} }`：**多包一层**（不是裸 item）⇒ 取 id 要写 `.data.server.id`
#     （别抄成 `.data.id`，会得 null）；`server` 里还有派生的 `slug`、`status`（UNKNOWN/OK/ERROR）、
#     `createdBy`/`creatorName`（**所属人** —— 改/删的判据、也是探测主语）、`canEdit`（**服务端现算**：
#     我能不能改/删这台；⚠️ 管理员看别人的 server 也是 `true`）、`createdAt`；
#     `test` 是这次 best-effort 探测的结论。
#     ⚠️ **新建后第一次的 `test.ok` 通常是 `false`** —— 探测用的是**你（所属人）**的凭据，而这时你还没填
#        ⇒ 文案是「所属人尚未在「我的凭据」里配齐参数」，且**上游一个请求都没收到**。这是**预期行为**。

# ⑳-b 连通测试 → **HTTP 恒 200**，结论在 body 里（成功顺手把工具写进 tool_cache）
curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/mcp/servers/$MCP/test | jq .
#  → `{ok:true, tools:[…]}`；每个工具含 **6 个契约键**（name/title/description/inputSchema/
#     annotations/hasOutputSchema），缺失的一律投影成 `null`，`inputSchema` **原样透传**（转换属 P0-2-6）。

# ⑳-c 看工具清单（读侧，**纯读缓存、绝不联网** —— "真拉"是 `?refresh=1`，见 ㉒）
curl -sS --noproxy '*' -b "$COOKIE" $BASE/api/mcp/servers/$MCP/tools | jq .
#  → 裸 `{tools, fetchedAt, cached}`：刚 test 成功过 ⇒ `cached:true` 且 `fetchedAt` 是那一刻；
#     一次都没测过 ⇒ `tools:[]` + `fetchedAt:null`（"拉过但零工具"与"从没拉过"**是两件事**）。
#     ⚠️ 不传 `refresh` 时这条请求**一个上游请求都不会发**（P0-2-5 起有 `?refresh=1` 作对照，见 ㉒-b）。

# ⑳-d 失败**也是 200**：把 endpointUrl 改到一个**没在监听**的端口再测
#     ⚠️ 别用 `http://127.0.0.1:1/mcp`（也别用 7/9）—— 它们属 fetch 规范的 **bad port**，`undici` 在
#        **发包之前**就拒掉（原因链是 `fetch failed ← bad port`），根本走不到 TCP，验不到"连接被拒绝"的翻译
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' -d '{"endpointUrl":"http://127.0.0.1:65000/mcp"}' | jq .
curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/mcp/servers/$MCP/test | jq .
#  → 仍 **HTTP 200**，body 是 `{ok:false, error:"…可读原因…"}`（**不是** 4xx/5xx —— `ok:false` 是一条
#     "这个 server 现在通不通"的**信息**，映射成 502 会让界面把"一个可用结论"渲染成"一个错误"）；
#     ⚠️ 而且这次 `tool_cache` **一个字节都没动**（缓存只在成功时刷新）。只有 id 不存在才是 404
#     （那是"请求本身的问题"）。

# ⑳-e 改注册信息（`endpointUrl` / `credentialSchema` / `authType` 任一变了）⇒ **清工具缓存**
#     （"改了 endpoint、工具列表还是旧 server 的"就是这条漏了）；只改 `name` 不动 slug、**也不清缓存**
#     （name 不参与连通，清了只会让用户白等一次重拉）；`endpointUrl` 只收 http/https；
#     改 `authType:"OAUTH"` ⇒ **400 + 文案指向 P1**（OAuth 属 P1，不是本批）

# ⑳-e′ 改**凭据模板** ⇒ 回包里多一个 `credentialSchemaImpact`（P0-2-3）—— 它**只提示、什么都不删**：
#       ⚠️ PATCH 的响应从 P0-2-2 的**裸 item** 变成了 `{server, credentialSchemaImpact}` ⇒ 取 id/字段要多一层 `.data.server.*`
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' \
  -d '{"credentialSchema":[{"key":"X-User-Token","label":"个人令牌","type":"string","inject":"HEADER"},
                            {"key":"tenant_id","label":"租户","type":"string","inject":"QUERY"}]}' | jq '.data.credentialSchemaImpact'
#  → 第一次（库里原本没有模板）⇒ `{removedKeys:[], addedKeys:["X-User-Token","tenant_id"], retargetedKeys:[], affectedCredentials:0}`
#  再看删一个参数的效果：
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' \
  -d '{"credentialSchema":[{"key":"X-User-Token","label":"个人令牌","type":"string","inject":"HEADER"}]}' | jq '.data.credentialSchemaImpact'
#  → `removedKeys:["tenant_id"]`（如实报出"哪些参数被删了"，用户据此去「我的凭据」里自己清理）
#  ⚠️ 两条要记住：① `affectedCredentials` 从 **P0-2-4 起是一个真数**（= `values_enc` 里含 `removedKeys`
#     的**已存凭据条数**，全库口径）：P0-2-3 时它恒 `null`（表还没建、答不出来 ⇒ 宁可留白也不填 0），
#     现在答得出来了就必须答 —— 按 ㉑ 给某台 server 填过凭据后再删参数，这个数会变成 1；
#     ② 只改 `label`（文案）⇒ 提示是 `null`，但**工具缓存照清**（这是两个判据，同一份输入两个结论是对的）。
#  模板的 `key` 还有三条硬约束（写错在**保存时**就 400，字段级 path 精确到 `body.credentialSchema.<i>.key`）：
#     · HEADER ⇒ 必须是合法 HTTP 头名，且不得占用平台自己要发的 `accept`/`content-type`/`content-length`/
#       `host`/`mcp-session-id`/`mcp-protocol-version`（占用 `accept` 会让"回 JSON 还是回 SSE"谈不成）；
#     · QUERY  ⇒ 不得含 `&` / `=`；
#     · BODY   ⇒ 不得用 JSON-RPC 的保留键 `jsonrpc`/`id`/`method`/`params`；
#     · 同一模板内 `key` **不得重复**。

# ⑳-f 列表（分页口径同 `/api/users`、`/api/knowledge-bases`）
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers?limit=100" | jq '.data | {total, n:(.items|length)}'

# ⑳-g 删除 → `{id,name}`；⚠️ **被 Agent 绑定**时删不掉（409，文案含"N 个"与"解绑"）
curl -sS --noproxy '*' -b "$COOKIE" -X DELETE $BASE/api/mcp/servers/$MCP | jq .
#  ⚠️ 想让后面的步骤"有东西可查"就**别现在删**（同 ⑧⑪⑭-f⑮-f 那四条 ⚠️）

# ⑳-h ⚠️ 历史上的自动版（`pnpm verify:mcp-servers`）已随脚本一起移除（2026-09-24）——
#      上面的手工步骤就是全部；下面 ㉑ 的凭据与 ㉒ 的工具发现也是同一口径。
#      ⚠️ 本段起，**假上游也不再是仓库里的夹具文件**，而是 ⑳-⓪ 那段内联命令（它删过一次，
#         上一版 README 的 ⑳-⓪ 因此指向了一个不存在的路径 —— 已修）。

# ═══════════════════════════════════════════════════════════════════════════════
# ㉑ 我的凭据：每用户每 server 一份（P0-2-4）—— 工具闭环第 4 步：模板定好后，每个使用者填自己的令牌
#     ⚠️ 与 ⑳ 是**两族权限**：`/api/mcp/servers/**` 是**公开可见的共享资源**（建/看全员可用，
#        ⚠️ **P0-2-12 起改/删只有注册者或 ADMIN**）；`/api/mcp/credentials/**` 只能动**自己的那一份**
#        （`user_id` 收窄，**ADMIN 也没有后门**）。
#        路径里只有 `:serverId`（没有凭据行 id）⇒ "删别人的凭据"这件事**连入口都没有**。
#     ⚠️ **本节的 $COOKIE 是 admin 的 jar**（①步登的就是它）⇒ 本节里"注册者"= admin，
#        所以下面的 PATCH/DELETE 都是 200。想看 403 得用 B 去动它 —— **㉑-k** 就是这一条。
#     前置：承接 ⑳（已有一台 server）；另需**第二个账号**（ADMIN 在 /admin/users 建一个 MEMBER 即可）
#        —— 下面用 $MEMBER_USER / $MEMBER_PASS 指代它。
# ═══════════════════════════════════════════════════════════════════════════════

# ㉑-⓪ 先把模板改成"要两个参数"（一个 required、一个可选），方便看合并与清空
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' \
  -d '{"credentialSchema":[{"key":"X-User-Token","label":"个人令牌","type":"string","inject":"HEADER","required":true},
                            {"key":"tenant_id","label":"租户","type":"string","inject":"QUERY"}]}' \
  | jq '.data.credentialSchema | length'

# ㉑-a 看"未配置清单"（A 账号视角）—— 响应**两面一起给**：items（每台 server × 我）+ unconfigured（置顶提示用）
curl -sS --noproxy '*' -b "$COOKIE" $BASE/api/mcp/credentials \
  | jq '{unconfigured:[.data.unconfigured[]|{s:.serverName, miss:.missingKeys}]}'
#  → 你刚改过模板的那台 server 出现在 unconfigured 里，missingKeys:["X-User-Token"]（= required 且我没值）

# ㉑-b 只填**一个** key
curl -sS --noproxy '*' -b "$COOKIE" -X PUT $BASE/api/mcp/credentials/$MCP \
  -H 'content-type: application/json' \
  -d '{"values":{"X-User-Token":"my-secret-token-A"}}' \
  | jq '{fields:[.data.fields[]|{key,hasValue}], missingKeys:.data.missingKeys, configured:.data.configured}'
#  → X-User-Token 的 hasValue:true；missingKeys 空、configured:true（**模板里只有它是 required**）
#  ⚠️ 全程**看不到值**（连掩码都没有）—— 与 Provider Key 的 `apiKeyPreview` 刻意不同：
#     那是管理员配的一份、掩码用来"确认没配错"；这是你自己的令牌，下发掩码收益为零。

# ㉑-c 再填另一个 key ⇒ **合并语义**（只动提交里出现的 key，没提交的逐字保留）
curl -sS --noproxy '*' -b "$COOKIE" -X PUT $BASE/api/mcp/credentials/$MCP \
  -H 'content-type: application/json' -d '{"values":{"tenant_id":"t-42"}}' \
  | jq '[.data.fields[]|{key,hasValue}]'
#  → **两个都是 true**。这就是"不可回填的字段只能合并"：值不下发 ⇒ 整体替换会把它**静默清空**。
#  ⚠️ 别拿"密文有没有变"当判据：合并会**重新加密 ⇒ iv 全换**，比密文必假红 —— 要看的是**另一个 key 还在不在**。

# ㉑-d 空串 = **清空该 key**（不是存一个空值 —— 存空密文会让"已配置"永远为真）
curl -sS --noproxy '*' -b "$COOKIE" -X PUT $BASE/api/mcp/credentials/$MCP \
  -H 'content-type: application/json' -d '{"values":{"tenant_id":""}}' \
  | jq '[.data.fields[]|{key,hasValue}], .data.updatedAt'
#  → tenant_id 的 hasValue 变 false；⚠️ 把**所有** key 都清掉 ⇒ **整行消失**（`updatedAt` 回 null）
#     —— 后面 ㉑-j 要看到"受影响 1 条"，就别把 X-User-Token 也清掉。

# ㉑-e 三层取证之①·响应层：**明文 / 密文前缀 / 列名**一个都不该出现
curl -sS --noproxy '*' -b "$COOKIE" $BASE/api/mcp/credentials | grep -c 'my-secret-token-A'  # → 0
curl -sS --noproxy '*' -b "$COOKIE" $BASE/api/mcp/credentials | grep -c 'v1\.'               # → 0
curl -sS --noproxy '*' -b "$COOKIE" $BASE/api/mcp/credentials | grep -c 'values_enc'         # → 0

# ㉑-f 三层取证之②·存储层：库里那一段是密文（借容器的 psql，本机不必装）
docker exec -i doubulea-postgres psql -U doubulea -d doubulea -c \
  "select user_id, jsonb_pretty(values_enc) from mcp_credentials where server_id='$MCP';"
#  → 形如 {"X-User-Token": "v1.<iv>.<tag>.<ct>"}（明文一个字符都不该出现）

# ㉑-g 换 B 账号登录 ⇒ B 看到的是"未配置"（A 填了不影响 B）
curl -sS --noproxy '*' -c /tmp/b.jar -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"username\":\"$MEMBER_USER\",\"password\":\"$MEMBER_PASS\"}" | jq '.data.user.role'
curl -sS --noproxy '*' -b /tmp/b.jar $BASE/api/mcp/credentials \
  | jq '[.data.items[]|select(.serverId=="'"$MCP"'")|{configured,missingKeys}]'
#  → configured:false + missingKeys 里有 required 的那个（**同一台 server、两份互不影响的凭据**）
#  ⚠️ "凭据**没有管理员后门**"这条在本次跑法里是**反过来**看到的：本节的 $COOKIE（= A）**就是 admin**
#     （①步登的），而 B 只是一个 MEMBER ⇒ B 看到 configured:false 就已经证明了"管理员填过的东西
#     对别人一个字节都不生效"。想更直白地看"ADMIN 也没有后门"，再建一个**第三个**账号（或直接看
#     B 的行：A 是 admin 也读不到 B 的密文 —— ㉑-h 那次"粘密文"就是这条的反证）。

# ㉑-h 三层取证之③·绑定层：把 A 的密文**粘到 B 的行**上，读接口要**降级**（不是 500）
docker exec -i doubulea-postgres psql -U doubulea -d doubulea -c \
  "update mcp_credentials b set values_enc = a.values_enc from mcp_credentials a where a.server_id='$MCP' and b.server_id='$MCP' and a.user_id <> b.user_id;"
curl -sS --noproxy '*' -b /tmp/b.jar $BASE/api/mcp/credentials | jq '.code'    # → 0（**没有 500**）
curl -sS --noproxy '*' -b /tmp/b.jar $BASE/api/mcp/credentials \
  | jq '[.data.items[]|select(.serverId=="'"$MCP"'")|.fields[]|{key,hasValue}]'
#  → hasValue 全 false：AAD 含 serverId+userId+key ⇒ 粘过来的密文**解不开**，该参数退回"未配置"
#    服务端此时会打一条 warn（**只记 key 名、不记值**）—— 与"主密钥换过 / 密文坏了"是同一条降级路径。

# ㉑-i 删除：配过 ⇒ `{serverId, serverName}`；再删一次 ⇒ **404**（不是幂等 200 —— 删的是"我的那一份"）
curl -sS --noproxy '*' -b /tmp/b.jar -X DELETE $BASE/api/mcp/credentials/$MCP | jq '.data'
curl -sS --noproxy '*' -b /tmp/b.jar -X DELETE $BASE/api/mcp/credentials/$MCP | jq '{code,msg}'

# ㉑-j 回头改模板：删掉一个参数 ⇒ `affectedCredentials` 是**真数**（P0-2-3 时它恒 `null`）
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' \
  -d '{"credentialSchema":[{"key":"tenant_id","label":"租户","type":"string","inject":"QUERY"}]}' \
  | jq '.data.credentialSchemaImpact'
#  → `removedKeys:["X-User-Token"]` + `affectedCredentials:1`（= `values_enc` 里含该 key 的行数，全库口径）
#  ⚠️ 它**只提示、什么都不删**：A 的那条值还在库里（只是 `fields` 里不再出现 —— 它已不会被注入）。

# ㉑-k ⭐ **【所属人 · 权限】P0-2-12**：B（MEMBER）去**改/删 A 建的 server** ⇒ **403**；
#       ⚠️ 顺序是 **404 → 403 → 409** ⇒ 无权限的人看到的**不是**"被几个智能体绑着"（那条文案本身是信息泄露面）
#       ⚠️ 但**测试 / 工具列表不判权限**（那是"使用"不是编辑）—— B 照样能点、只是用的是 **A 的凭据**
curl -sS --noproxy '*' -b /tmp/b.jar -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' -d '{"name":"B改的"}' | jq '{code,msg}'    # → 403 + 「…注册者或管理员…」
curl -sS --noproxy '*' -b /tmp/b.jar -X DELETE $BASE/api/mcp/servers/$MCP | jq '{code,msg}'   # → 403（**不是** 409）
curl -sS -o /dev/null -w '%{http_code}\n' --noproxy '*' -b /tmp/b.jar -X DELETE \
  $BASE/api/mcp/servers/00000000-0000-7000-8000-000000000000                        # → 404（守门：403 不是被 404 冒充的，
                                                                                    #    所以上面必须是**真实存在**的 id）
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' -d '{"name":"A改的"}' | jq '.data.server.name'  # → "A改的"（**A 自己 200** —— 别顺手改成 requireAdmin）
#  ⚠️ 还要看一眼 **B 点测试**：它**不报 403**，而是用 **A 的凭据**去连。
#     ⚠️ 此刻模板已没有 `required` 参数（㉑-j 改成只剩 tenant_id）⇒ 直接 `ok:true`；
#     "**所属人没配齐必填凭据** ⇒ `ok:false` + 文案含「所属人尚未配置」+ **上游零请求**"那一条
#     在「浏览器端测 · MCP」的**【所属人】组 ⑤**里验（那里建的是**新** server，还没填凭据）。
curl -sS --noproxy '*' -b /tmp/b.jar -X POST $BASE/api/mcp/servers/$MCP/test | jq '{ok}'      # → {ok:true}（**主语是 A，不是 B**）

# ═══════════════════════════════════════════════════════════════════════════════
# ㉒ 工具发现与缓存（P0-2-5）—— 工具闭环第 5 步：工具列表有了**两种取法**（读缓存 / 真拉），
#     而"拉不到时答什么"被分成了**三个出口**（这一批最值钱的一条判据）
#     前置：承接 ⑳（假上游在 ⑳-⓪ 那个终端里跑着、$MCP 是那台 server 的 id）
#     ⚠️ **本段大部分步骤要盯着 ⑳-⓪ 那个终端数 `#` 的增量** —— 那是"到底联没联网"的唯一取证方式
#        （记账口径见 ⑳-⓪ 末尾：一次"连接 + 拉列表"固定 3 条，握手后的 GET 不计入）
# ═══════════════════════════════════════════════════════════════════════════════

# ㉒-a `?refresh=1` = **真拉一次并落库**（不是"读缓存"）
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers/$MCP/tools?refresh=1" \
  | jq '{n:(.data.tools|length), fetchedAt:.data.fetchedAt, cached:.data.cached}'
#  → `n:2`、`cached:false`、`fetchedAt` 是**刚刚**；假上游那边应多出 **3 条**（initialize / initialized / tools-list）
#  ⚠️ `cached:false` 的含义是"**这份不是从缓存列读的**"（本次真拉）—— 与 ⑳-c 的 `cached:true` 对照着看

# ㉒-b **【门槛①】缓存命中时上游零请求** —— 先看一眼那个终端现在是第几条，然后：
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers/$MCP/tools" | jq '.data.cached'
#  → `true`。⚠️ **假上游那边一行都不该多** —— 这就是"纯读缓存、绝不联网"的**全部**证据。
#    只断言"响应里有工具"是验不出这条的（一个每次都真拉的实现照样给得出工具）。
#  ⚠️ 顺带：不传 refresh 时 `status` 也不会变 —— 这条路径**只读不写**。

# ㉒-c **【门槛④前半】拉不到、但缓存还在 ⇒ 200 回缓存**（⚠️ **关键是别动 endpoint**）
#     —— 去 ⑳-⓪ 那个终端按 **Ctrl-C**，把假上游停掉（缓存列**不受影响**；改 endpoint 才会清缓存，
#        那测的就不是这一条了）
curl -sS -o /tmp/tools.json -w '%{http_code}\n' --noproxy '*' -b "$COOKIE" \
  "$BASE/api/mcp/servers/$MCP/tools?refresh=1"
jq '{n:(.data.tools|length), fetchedAt:.data.fetchedAt, cached:.data.cached}' /tmp/tools.json
#  → **200**（不是 502！），`n:2`、`cached:true`、**`fetchedAt` 与 ㉒-a 那个逐字相同**
#    ⚠️ 这三条一起才是铁证：**200 且工具还在且时间戳没动** = "回退到了上一次成功的那份"。
#      （`cached:true` + 偏旧的 `fetchedAt` 就是"你看到的不是刚拉的"**全部**信号 ——
#        契约里**刻意没有** warning 字段，真正的失败原因在服务端日志里）
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers?limit=100" \
  | jq "[.data.items[]|select(.id==\"$MCP\")|.status]"   # → ["ERROR"]（status 记的是**最近一次尝试的结论**）

# ㉒-d 让上游活过来（**新端口**）⇒ 把 endpoint 改过去 ⇒ 缓存**被清**（因为 endpoint 真的变了）
#    ⚠️ 重新跑 ⑳-⓪ 那段，把新打印的地址重新 export 成 $MCPURL（`listen(0)` ⇒ 端口每次都不同）
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' -d '{"endpointUrl":"'"$MCPURL"'"}' \
  | jq '.data.server | {toolCount, status}'          # → `{toolCount:0, status:"UNKNOWN"}`（缓存已清）
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers/$MCP/tools?refresh=1" >/dev/null   # 拉回来

# ㉒-e **【门槛④后半】拉不到、缓存也空 ⇒ 502**（⚠️ **这一步会清掉缓存，所以放在最后**）
docker exec -i doubulea-postgres psql -U doubulea -d doubulea -c \
  "update mcp_servers set tool_cache = null, status = 'UNKNOWN' where id = '$MCP';"
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers/$MCP/tools" | jq .   # 纯读 ⇒ 确认真的空了
#  停掉上游（Ctrl-C），再 refresh：
curl -sS -o /tmp/tools2.json -w '%{http_code}\n' --noproxy '*' -b "$COOKIE" \
  "$BASE/api/mcp/servers/$MCP/tools?refresh=1"
jq '{code, msg}' /tmp/tools2.json
#  → **502** + 统一信封（`code:"UPSTREAM_ERROR"`、msg 以"无法获取 MCP server 的工具列表："开头、后面跟着可读原因）。
#    ⚠️ **它绝不能是"200 + 空数组"** —— 空数组会被读成"这个 server 没有工具"，
#       用户于是跑去上游找一个**其实不存在**的配置问题。契约里 `{tools,fetchedAt,cached}` **没有**放"失败"的位置，
#       所以给不出就是 502；这与 `POST /:id/test` **恒 200** 不矛盾（那个形状**有** `{ok:false,error}`）。

# ㉒-f `refresh` 是**白名单**：拼错 ⇒ 400（不是"静默不刷新"）
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers/$MCP/tools?refresh=yes" \
  | jq '{code, fields:.data.fields}'
#  → 400 + `fields[0].path == "querystring.refresh"`、msg「refresh 只接受 1 / 0 / true / false」
#  ⚠️ 两条**反例**解释为什么它必须收窄（都属"看起来工作了"的假象）：
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers/$MCP/tools?refresh=0" | jq '.data.cached'  # → true
#    ① `?refresh=0` **不是** 400、也**不**刷新（`cached:true`）—— 若用 `z.coerce.boolean()`，
#       `Boolean('0') === true` 会让它变成"要刷新"，而**零症状**（用户以为关掉了，其实每次都联网）；
#    ② 放宽成"任意字符串"的话 `?refresh=yes` 会静默等于"不刷新" —— 点了刷新却看到旧列表。

# ㉒-g **【门槛③】缓存的失效判据 = "真的变了"**（P0-2-2 已落，这里顺带看一眼三行）
#     前置：上游活着（重启 ⑳-⓪ 并重新 export $MCPURL）+ 缓存已拉回来：
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers/$MCP/tools?refresh=1" | jq '.data.cached'  # → false
#  ① 只改 `name` ⇒ **不清**（名字不参与连通，清了只会让人白等一次重拉）
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' -d '{"name":"改个名试试"}' | jq '.data.server | {name, slug, toolCount}'
#  → `name` 变了、**`toolCount` 还是 2**（没清）、`slug` 逐字不变
#  ② **原样**提交（`endpointUrl` 与库里逐字相同）⇒ **同样不清** —— 这一条是"键序无关比较"的守门：
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' -d '{"endpointUrl":"'"$MCPURL"'"}' | jq '.data.server.toolCount'
#  → **2**（不是 0）。⚠️ 若这里看到 0，就是 `sameJson` 失效了：PG 的 `jsonb` 会**重排对象键**，
#     逐字比较会把"没改"判成"改了" ⇒ 症状是"每次保存工具数都归零"（P0-2-2 的坑预判 4）。
#  ③ 改一个**真的不同**的值 ⇒ 清（`toolCount` 归 0、`status` 回 `UNKNOWN`）：
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH $BASE/api/mcp/servers/$MCP \
  -H 'content-type: application/json' -d '{"endpointUrl":"http://127.0.0.1:65000/mcp"}' \
  | jq '.data.server | {toolCount, status}'   # → `{toolCount:0, status:"UNKNOWN"}`
#  ⚠️ 记得改回来（`-d '{"endpointUrl":"'"$MCPURL"'"}'`）再继续 —— 否则后面每步都不通。

# ㉒-h **【门槛⑤】`slug` 的稳定性**：改名**不影响**工具名
curl -sS --noproxy '*' -b "$COOKIE" $BASE/api/mcp/servers/$MCP | jq '.data | {name, slug}'
#  → `slug` 与 ⑳ 注册时那一个逐字相同（`PATCH` 的 body 里根本没有 `slug` 这个字段）。
#    ✅ **`mcp_{slug}_{toolName}` 那个"拼出来的名字"已于 P0-2-8 接线**（`toOpenAiTools` 在编排循环里
#       被真的用上了）—— 但它**不对应任何端点**，只能在两处看到：① 发给上游的报文（假 LLM 会打印
#       `首个工具=…`）；② 落库的 `content.tool_calls[].toolName`。两边都在 ㉓ 里验。

# ㉓ 工具调用闭环（P0-2-8）—— 工具闭环的**整条链**第一次跑通：
#    LLM 流式吐 `tool_calls`（分片）⇒ 后端累积 ⇒ 映射到 MCP 工具 ⇒ 取凭据（这里 authType=NONE，跳过）
#    ⇒ 执行 `tools/call` ⇒ 卡片 `RUNNING`→`SUCCESS` ⇒ 结果回填 ⇒ **续流** ⇒ `tool_calls` 落进助手消息。
#    ⚠️ **本批没有界面**（`/mcp` 页仍是占位页）⇒ 这一整节都是**命令行**档；`tool_call` 事件是 SSE 帧，
#       `curl -N` 就能逐帧看到（前端 `ToolCard` 渲染同一份数据属 P0-2-11）。
#    ⚠️ **危险判定（P0-2-9）与"确认"（P0-2-10）都已落地** ⇒ 本节调的是**安全**工具（`echo`/`boom`
#       声明了 `readOnlyHint:true`）故**不弹确认**；危险工具（下面那个 `purge`）走 ㉔ 那一节。
#    前置：承接 ⑳（有一台 server）或**直接照这段新建一台**；另需要一个**假 LLM 上游**（下面 ㉓-⓪ 一起起）。

# ㉓-⓪ 另开一个终端：**同时**起"假 MCP server + 假 LLM"两个上游，前台常驻（Ctrl-C 收工）
#      ⚠️ 同样是**内联**的（仓库里不放夹具文件，见 ⑳-⓪ 的说明）。它打印 `MCPURL=` 与 `LLMURL=`（抄下来）。
#      假 MCP 除了 `tools/list` 还实现了 `tools/call`；假 LLM 按"用户那句话里的关键词"决定行为：
#        · 普通话        ⇒ 先吐一个 `tool_calls`（`arguments` **故意拆成两片**）⇒ 拿到工具结果后**续流收尾**（门槛 1）
#        · 含 `boom`     ⇒ 去调那个**自己报错**的工具 ⇒ 卡片 `ERROR`（门槛 2）
#        · 含 `loop`     ⇒ **每轮都接着要工具**（直到后端把 `tools` 撤掉）⇒ 验 10 轮上限（门槛 3）
#        · 含 `purge`    ⇒ 去调那个**危险工具** ⇒ **先弹确认**（P0-2-10 起，㉔ 那一节验）
#      ⚠️ 假 LLM 判"该给正文了"用的是"**上一条就是工具结果**"（不是"历史里出现过工具结果"）——
#        后端每轮都发**完整历史**，用后者会让"第二次对话"永远不再要工具（㉓-g 与 ㉔-a/㉔-b 全都被静默跳过，
#        而那三节看起来只是"没反应"）。**这条是 P0-2-10 写 ㉔ 时发现并修掉的**，见下面那行注释。
#      ⚠️ **三个工具的 `annotations` 是刻意的**（`02` §9.9 真值表的两种输入，P0-2-10 起才有可观测差别）：
#        `echo` / `boom` 声明 `readOnlyHint:true` ⇒ 判为**安全** ⇒ 直接执行（㉓ 这一节因此**不弹确认**）；
#        `purge` **什么注解都不声明** ⇒ 读不出「只读」⇒ 判为**危险** ⇒ 先挂起问用户。**这不是 bug**。
#        换句话说：**如果你把 `annotations` 那几行删掉，㉓ 整节都会变成"每调一次工具先弹一次确认"**。
node --input-type=module -e '
const http = await import("node:http");
let mcpN = 0, llmN = 0;
const mcp = http.createServer(async (req, res) => {
  if (req.method !== "POST") { console.log(`[假MCP] ${req.method}（不计入）`); res.writeHead(200).end(); return; }
  let body = ""; for await (const c of req) body += c;
  const msg = body === "" ? null : JSON.parse(body);
  mcpN += 1; console.log(`[假MCP] #${mcpN} ${msg?.method ?? "(无 method)"}`);
  if (msg === null || msg.id === undefined) { res.writeHead(202).end(); return; }
  const result =
    msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.0.0" } }
    : msg.method === "tools/list" ? { tools: [
        { name: "echo", description: "原样回显传入的 text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
        { name: "boom", description: "故意失败（验「工具失败错误可见」）", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
        { name: "purge", description: "会改数据（验确认流：先问、后执行）", inputSchema: { type: "object", properties: { target: { type: "string" } } } } ] }
    : msg.method === "tools/call"
      ? (msg.params?.name === "boom"
          ? { isError: true, content: [ { type: "text", text: "工具自己报错：boom 永远失败" } ] }
          : { content: [ { type: "text", text: msg.params?.name + " <- " + JSON.stringify(msg.params?.arguments ?? {}) } ] })
      : {};
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});
const llm = http.createServer(async (req, res) => {
  if (!req.url.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  let body = ""; for await (const c of req) body += c;
  const p = JSON.parse(body || "{}");
  const msgs = p.messages ?? [];
  const tools = p.tools ?? [];
  const lastUser = String([...msgs].reverse().find((m) => m.role === "user")?.content ?? "");
  // ⚠️ 判据是"**上一条就是工具结果**"（这一轮已经回填过了 ⇒ 该给正文了），**不是**"历史里出现过工具结果"：
  //    后端每轮都把**完整历史**发过来（含前几轮的工具结果），用后者的话第二次对话就永远不再要工具了
  //    —— ㉓-g（boom）与 ㉔-a/㉔-b（purge）**都是"新建一轮"**，全会被静默跳过。
  const sawToolResult = msgs[msgs.length - 1]?.role === "tool";
  const wantBoom = lastUser.includes("boom"), wantLoop = lastUser.includes("loop");
  const wantPurge = lastUser.includes("purge");
  const pick = (wantPurge ? tools.find((t) => t.function.name.endsWith("purge"))
    : wantBoom ? tools.find((t) => t.function.name.endsWith("boom")) : tools[0])?.function?.name;
  // 要工具的三个条件：这一轮确实下发了 tools、选得出一个、且（**这一轮**还没回填过结果 或 说话人要求 loop）
  const shouldCall = pick !== undefined && (wantLoop || !sawToolResult);
  llmN += 1;
  console.log(`[假LLM] #${llmN} stream=${p.stream === true} 已回填=${sawToolResult} 下发工具数=${tools.length} 首个工具=${pick ?? "(无)"} ⇒ ${shouldCall ? "要工具" : "给正文"}`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: p.model };
  if (shouldCall) {
    const full = pick.endsWith("purge") ? "{\"target\":\"日志\"}" : pick.endsWith("boom") ? "{}" : "{\"text\":\"你好\"}";
    const cut = Math.max(1, Math.floor(full.length / 2));            // 故意拆两片 ⇒ 验「分片累积」
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: pick, arguments: full.slice(0, cut) } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: full.slice(cut) } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    for (const t of ["我已按需调用工具，", "现在给出最终回答：", "这是一段普通的流式回答。"]) {
      send({ ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  res.write("data: [DONE]\n\n"); res.end();
});
mcp.listen(0, "127.0.0.1", () => console.log("MCPURL=http://127.0.0.1:" + mcp.address().port + "/mcp"));
llm.listen(0, "127.0.0.1", () => console.log("LLMURL=http://127.0.0.1:" + llm.address().port + "/v1"));
'
#  → 两行：`MCPURL=http://127.0.0.1:<p1>/mcp`、`LLMURL=http://127.0.0.1:<p2>/v1`
#  ⚠️ 记账口径（与 ⑳-⓪ 同）：一次成功的"连接 + tools/list"固定 **3 条** POST；
#     每次工具调用是**额外一条** `tools/call`（㉓-e 的"恰 1 条"、㉓-g 的"恰 10 条"都数它）。

# ㉓-a 注册这台 server（name 用 ASCII ⇒ slug 可预测，工具名就是 `mcp_fakemcp_echo` / `mcp_fakemcp_boom`）
#      ⚠️ 纯中文名会被 `slugifyServerName` 整串折空 ⇒ 回落 `server`（工具名变 `mcp_server_*`）——
#        不影响本节（假 LLM 自动挑 `tools[0]`），但想手对名字就起个 ASCII 名。
MCP2=$(curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/mcp/servers \
  -H 'content-type: application/json' \
  -d '{"name":"fakemcp","endpointUrl":"'"$MCPURL"'","authType":"NONE"}' \
  | tee /tmp/mcp2.json | jq -r '.data.server.id')
jq '.data.server | {id, name, slug, status}' /tmp/mcp2.json ; echo "MCP2=$MCP2"
# ㉓-a′ 刷一次工具缓存（编排循环只读 `tool_cache` ⇒ **必须先成功拉过一次**，否则下发给模型的工具数是 0）
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/mcp/servers/$MCP2/tools?refresh=1" \
  | jq '.data | {tools: [.tools[].name], cached}'
#  → 三个工具 `echo` / `boom` / `purge`、`cached:false`（这是**真拉**；假上游 # 里多 3 条）

# ㉓-b 建一个指向假 LLM 的 Provider（Key 给个占位串即可 —— 假上游不看鉴权头）
#      🔑 baseUrl 就是 `$LLMURL`（它已经带 `/v1`，别再拼一遍）
PROVIDER2=$(curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/model-providers \
  -H 'content-type: application/json' \
  -d '{"name":"假LLM","baseUrl":"'"$LLMURL"'","type":"CHAT","apiKey":"sk-fake"}' \
  | tee /tmp/prov2.json | jq -r '.data.id')
MODEL2=$(curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/models \
  -H 'content-type: application/json' \
  -d "{\"providerId\":\"$PROVIDER2\",\"modelName\":\"fake-chat\",\"label\":\"假模型\",\"type\":\"CHAT\"}" \
  | tee /tmp/model2.json | jq -r '.data.id')
echo "PROVIDER2=$PROVIDER2 MODEL2=$MODEL2"
#  → `protocol` 缺省即 `OPENAI_COMPAT`（假 LLM 走 `/chat/completions`，正好对上）

# ㉓-c 建一个 ChatBot 并**同时**绑模型 + 绑这台 MCP server
AGENT2=$(curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/agents \
  -H 'content-type: application/json' \
  -d "{\"name\":\"工具闭环验机\",\"type\":\"CHATBOT\",\"modelId\":\"$MODEL2\"}" \
  | tee /tmp/agent2.json | jq -r '.data.id')
curl -sS --noproxy '*' -b "$COOKIE" -X PUT $BASE/api/agents/$AGENT2/components \
  -H 'content-type: application/json' \
  -d "{\"components\":[{\"componentType\":\"MCP\",\"refId\":\"$MCP2\"}]}" \
  | jq '.data | {id, components}'
echo "AGENT2=$AGENT2"
#  → `components` 里出现 `{componentType:"MCP", refId:"…"}`（P0-1-23 的绑定在 P0-2-2 起**接回了**存在性校验，
#    不再是"含 MCP 一律 400"）

# ㉓-d 建会话
CONV2=$(curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/conversations \
  -H 'content-type: application/json' -d "{\"agentId\":\"$AGENT2\"}" \
  | tee /tmp/conv2.json | jq -r '.data.id')
echo "CONV2=$CONV2"

# ㉓-e **【门槛 1 + 5】一次工具调用 + 卡片状态流转 + 结果回填续流**
curl -N -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/conversations/$CONV2/chat \
  -H 'content-type: application/json' -d '{"content":"帮我用工具查一下"}'
#  → 帧序（`curl -N` 逐帧到）：
#      event: tool_call  data: {"callId":"call_1","toolName":"mcp_fakemcp_echo","serverName":"fakemcp","kind":"MCP","status":"RUNNING","inputSummary":"{\"text\":\"你好\"}"}
#      event: tool_call  data: {…同 callId…,"status":"SUCCESS","output":"echo <- {\"text\":\"你好\"}"}
#      event: delta      data: {"text":"我已按需调用工具，"…}   ← **续流**：结果回填后又长出来了
#      event: done       data: {"finishReason":"COMPLETE","messageId":"…","usage":{…}}
#     ⚠️ **同一 `callId` 推了两次**（RUNNING → SUCCESS）—— 前端按 `callId` **upsert**（门槛 5）；
#        `inputSummary` 是**给用户看的摘要**（截断 200、像凭据的参数名遮值），不是完整入参。
#     ⚠️ 帧里**没有 `arguments`** —— 完整入参**只进库**（㉓-f 那边能看到），卡片只给 `inputSummary`。
#     ⚠️ 假上游那边这一轮应出现 **恰好 1 条** `tools/call`（+ 握手/列表那 3 条老账）。
#     ⚠️ `arguments` 是**分两片**到达的 —— 若哪天改成"第一片就 `JSON.parse`"，这里会变成
#        `inputSummary:"{}"` 且 `output:"echo <- {}"`，**不报错**（这就是坑预判 1 要守的东西）。

# ㉓-f **【门槛 1 后半】落库**：`tool_calls` 进了助手消息的 `content`（**与 `GET /messages` 读回一致**）
curl -sS --noproxy '*' -b "$COOKIE" "$BASE/api/conversations/$CONV2/messages" \
  | jq '.data.items[] | select(.role=="ASSISTANT") | {text: .content.text, tool_calls: .content.tool_calls}'
#  → 助手那条的 `content.tool_calls[]` 是**完整记录**（含 `arguments` 原样串、`status`、`output`、`serverName`）；
#    它**原样透出**（读取端刻意不用 `messageContentSchema` 过滤 ⇒ 不会把 `tool_calls` 静默剥掉）。

# ㉓-g **【门槛 2】工具自身报错 ⇒ 卡片 ERROR，但这一轮不失败**
curl -N -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/conversations/$CONV2/chat \
  -H 'content-type: application/json' -d '{"content":"boom 一下"}'
#  → `tool_call` 卡 `status:ERROR`（`output` 含"工具自己报错：boom 永远失败"），**随后仍有 `delta`**：
#    错误文本被回填给模型 ⇒ 它自己决定怎么说。**别期待整轮 `error` 帧** —— 那才是错的形态
#    （用户会只看到一张错误卡、拿不到任何解释）。
#    ⚠️ 对照：**中断**（工具执行中按 ⑯-c 停止）是**真的停下来** —— 那是唯一"工具失败要中断整轮"的情形。

# ㉓-h **【门槛 3】10 轮上限**（`loop` 让假 LLM 每轮都接着要工具）
curl -N -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/conversations/$CONV2/chat \
  -H 'content-type: application/json' -d '{"content":"loop 到上限"}'
#  → 前端会看到**连续 10 组** `tool_call{RUNNING→SUCCESS}`，然后**忽然不再要工具**、直接给正文、
#    `done{finishReason:"COMPLETE"}` 收尾。
#  → 取证：假上游那个终端里 `tools/call` 的**计数恰好 +10**（第 11 轮那次请求里**没有 `tools` 字段** ——
#    假 LLM 的 `下发工具数=0` 那行就是它）。⚠️ 判据是"**已执行了几轮**"而不是"要了几次"：
#    后端是**当轮就把 `tools` 撤掉**再注一句提示，**不是**等模型第 11 次要了再拒。
#    ⚠️ 若模型在被撤掉工具后**仍**硬吐一个工具名 → 后端不再执行、记一条 warn 直接收尾（防死循环）。

# ㉓-i **【门槛 4】工具执行中按停止**：在 ㉓-e 的流还没收尾时（假上游紧接着回）不易掐点，
#    改在 ㉓-h 的 long 流里另开终端按 ⑯-c
#  → 收到 `done{finishReason:"STOPPED"}`、**已生成部分照常落库**（同 ⑰-d 的口径）；
#    `McpAbortError` 是**唯一**能让工具循环真的停下来的错误（其余失败都只是那一条工具失败）。

# ㉔ 确认流（P0-2-10）—— **危险工具先问后执行**（HITL，`01` §3.6 / `02` §9.10）
#    承接 ㉓（同一台假上游、同一个 AGENT2）⇒ **不用重起任何东西**。
#    验的是四件事：① 危险工具在用户点头**之前**绝不发 `tools/call`；② 点取消 ⇒ 工具没执行、
#    但**这一轮继续**（模型拿到"未执行"的结果照样给出正文）；③ 不点 ⇒ 等满
#    `MCP_CONFIRM_TIMEOUT_SEC`（默认 120s）按取消；④ 重复点 / 迟到点 / 别人的会话 ⇒ **200 但不生效**。
#    ⚠️ **本批仍没有界面**（确认卡是 P0-2-11）⇒ 这一节是**命令行**档：`confirm` 是 SSE 帧，
#      应答要靠 `POST /:id/confirm` 手打 —— 所以**必须开着两个终端**。

# ㉔-a **【门槛 1 + 2】挂起 → 取消 → 工具没执行、流程继续（含"两个确认不串台"）**
#    终端 A（起流，`curl -N` 会一直挂着 —— 这就是"挂起"）：
curl -N -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/conversations/$CONV2/chat \
  -H 'content-type: application/json' -d '{"content":"帮我 purge 一下"}'
#  → 帧序：先 `event: confirm`
#      data: {"confirmId":"<一串 uuid>","source":"PLATFORM","toolName":"mcp_fakemcp_purge","inputSummary":"{\"target\":\"日志\"}","expiresAt":"…"}
#    然后**就停在这里等**（只有 `ping` 在继续）。⚠️ **这一帧之前不该出现任何 `tool_call{RUNNING}`** ——
#    卡片排在确认之后就没意义了（"先问、后发运行中"）。

#    终端 B：先看 `/active` —— 挂起是否**可观测**（断线重连的客户端就靠这个知道"有个提问在等我"）
curl -sS --noproxy '*' -b "$COOKIE" $BASE/api/conversations/$CONV2/active | jq '.data'
#  → `{"streaming":true,…,"pendingConfirmId":"<与上面 confirmId 逐字相同>"}`

#    终端 B：**取消**（把上面抄下来的 confirmId 填进去，注意带引号）
CID='<粘贴 confirmId>'
curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/conversations/$CONV2/confirm \
  -H 'content-type: application/json' -d '{"confirmId":"'"$CID"'","accepted":false}' | jq .
#  → `{"code":0,…,"data":{"id":"…","confirmId":"…","accepted":false,"applied":true}}`
#    ⚠️ `applied:true` = 有一个人在等这个 id 并**真的收到了**（这与 payload 里的 `accepted` 是两件事）

#  → 终端 A 紧接着吐出：
#      event: tool_call  data: {…,"status":"ERROR","inputSummary":"{\"target\":\"日志\"}","output":"工具调用未执行：用户已取消本次操作。请不要重试…"}
#      event: delta      data: {"text":"…"}      ← **流程继续**：模型拿到"未执行"照样续流
#      event: done       data: {"finishReason":"COMPLETE",…}
#    ⚠️ **只有一张 ERROR 卡、没有 RUNNING 卡**（`callId` 相同 ⇒ 前端 upsert 只显示最终态）。
#    ⚠️ **取证点（槛 1）**：假上游那个终端里 `tools/call` 的计数**不涨**（purge **一次都没发出去**）。
#       假 MCP 只该多出"握手那 3 条"（这一次的懒连接），或一条都不多（连接已复用）。

# ㉔-b **【门槛 1 的另一半】确认 ⇒ 才真的执行**
#    终端 A 再发一次同样的请求，终端 B 这次 `accepted:true`
curl -N -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/conversations/$CONV2/chat \
  -H 'content-type: application/json' -d '{"content":"再 purge 一下"}'
#    （终端 B：`-d '{"confirmId":"'"$CID"'","accepted":true}'`，CID 用这一轮新拿到的那一个）
#  → 终端 A：`confirm` ⇒ 挂起 ⇒ 应答后 `tool_call{RUNNING}` → `tool_call{SUCCESS, output:"purge <- {\"target\":\"日志\"}"}`
#    ⇒ `delta` ⇒ `done{COMPLETE}`。**这一次假上游的 `tools/call` 计数 +1**（真的执行了）。
#    ⚠️ **这一节同时是"两个确认不串台"的断言**（`06` P0-2-10 坑预判 2 要的那条）：这一轮的
#       `confirmId` 与 ㉔-a **必须是两个不同的值**，且这张卡要**停住**等应答 —— 若它"一闪而过"
#       （`confirm` 帧刚到就自己没了），说明上一轮的应答被这一轮消费掉了（判据 = 应答槽按 id 匹配）。
#       ⚠️ 换 `CID` 是最容易漏的一步：**用上一轮的旧 id 打这一轮** ⇒ `applied:false`、卡会一直挂到超时。

# ㉔-c **【门槛 4】幂等：同一张卡的重复点击 / 迟到点击 / 别人的会话**
#    ① 用**已经用过**的那个 CID（上一轮早结束了）再打一次 ⇒ **200 但 `applied:false`**
curl -sS --noproxy '*' -b "$COOKIE" -X POST $BASE/api/conversations/$CONV2/confirm \
  -H 'content-type: application/json' -d '{"confirmId":"'"$CID"'","accepted":true}' | jq '.data'
#  → `{"…","applied":false}` —— 不是一个 4xx。理由：用户看到卡片没消失就会**再点一次**，
#    那是正常操作而不是错误；同理"这一轮已经按超时走完了，用户此刻才点"也是常态。
#    ⚠️ **绝不能变成第二次执行**（"重复确认导致工具跑两遍"是这一步最危险的退化）。
# ② **没有待答确认时**也一样（会话此刻空闲）⇒ `applied:false`
# ③ **别人的会话 / 不存在的会话** ⇒ 统一信封 **404**（与其余会话端点同族，不是 403）
# ④ `confirmId` 不是非空字符串 / `accepted` 不是布尔 ⇒ **400** + `data.fields[]`
#    分别指到 `body.confirmId` / `body.accepted`（顶层 `msg` 恒「请求参数校验失败」）

# ㉔-d **【门槛 3】超时按取消** —— 这条**必须**把等待上限调小，别真等 120s：
#    ① 停掉后端，用 2 秒的上限重启（`infra/.env` 里也可以改 `MCP_CONFIRM_TIMEOUT_SEC`）
#       ⚠️ 端口见 `infra/.env`（本仓是 13000）；`dev:backend` 是 tsx watch，Ctrl-C 即退
MCP_CONFIRM_TIMEOUT_SEC=2 pnpm dev:backend
#    ② 外面重跑 ㉔-a 的**起流**那一条，**什么都不答**（也不要动 `$CID`）
#  → 约 2 秒后终端 A 自己吐出 `tool_call{ERROR, output:"工具调用未确认：等待确认超时…"}`，
#    随后 `delta` + `done{COMPLETE}` —— **超时按取消，且流程继续**（`02` §5.2 原文）。
#    ⚠️ 回填给模型的那句话与 ㉔-a 的**刻意不同**（"超时" vs "你取消了"）：前者是"没人应答"、
#       后者是"用户的决定"，合成一句用户就读不出自己那一按到底生效了没有。
#    ⚠️ **门槛 5 顺带在这里看**：这 2 秒里 `ping` 照发、`/active` 全程 `streaming:true`
#       （心跳是无条件的、锁跟着心跳续期 ⇒ 挂起**不会**让锁过期）。
#    ③ 验完把上限改回来（不带环境变量重起，或把 `.env` 改回 120）

# ㉔-e **【挂起期间按停止】** 在 ㉔-a 的挂起里（还没答），另开终端按 ⑯-c 打 `/stop`
#  → 收到 `done{finishReason:"STOPPED"}`（**不是**等满 120s 之后才动）⇒ `awaitConfirm` 被 `signal`
#    打断、抛 `ChatStoppedError`，按"本轮被中断"收尾（同 ㉓-i 的口径）。
#    ⚠️ 若这里变成"点了停止要等 2 分钟才停"，就是坑预判 5 说的那条退化。
```

> ⚠️ **㉓ / ㉔ 的已知边界（别当 bug）**：① **危险判定（P0-2-9）与确认流（P0-2-10）都已落地** ⇒
> `readOnlyHint:true` 的工具直接执行，**判为危险的工具（含"什么注解都不声明"的）一律先问**
> —— ㉓ 那三个工具里 `purge` 就是这种，㉔ 专门验它；
> ② **一轮里多个 `tool_calls` 按顺序执行**（不并行）⇒ 一次只会有一张确认卡（挂起也是串行的）；
> ③ **`/confirm` 是幂等的**（`applied:false` 是 200，不是错误）；**别人的会话一律 404**；
> ④ 工具结果有**截断上限**（8000 字符，给模型的那份与
> 给卡片看的那份**是同一份**）；⑤ `tool_call.inputSummary` 的"凭据形状遮值"是**尽力而为**、
> 不是安全边界（真正的保证是**凭据从不下发给模型**）；⑥ `/mcp` 页面前端仍是**占位页** ⇒
> `tool_call` 卡片与**确认卡**的**可视化**属 P0-2-11（本节看到的是 SSE 原帧）；
> ⑦ **`expiresAt` 是服务端算的截止时刻**（前端倒计时只读它，不自己另起一个 120s）；
> ⑧ **服务端反向 elicitation**（`tools/call` 途中的 `elicitation/create`）走**同一个** `confirm` 帧与
> 同一个应答端点，只有 `source` 不同（`SERVER` vs `PLATFORM`）—— 假上游**不发** elicitation，
> 所以这一半在 ㉔ 里验不到（要真上游；契约与映射见 `docs/02` §9.10）。

**已知边界（别当 bug）**：① 接口现在是七组：`/api/auth/*`、`/api/users`（仅 ADMIN）、模型池
（`/api/model-providers`、`/api/models` 仅 ADMIN + `/api/models/available` 全员 + P0-1-12 新增的
`GET /api/model-providers/:id/remote-models` 仅 ADMIN）、**知识库 `/api/knowledge-bases`（P0-1-15，
登录即可，不是 ADMIN；P0-1-16 加了它下面的 `POST .../documents` 上传、P0-1-19 加了
`reupload`/`retry`/`DELETE`、P0-1-20 加了 `POST .../search`）**、**智能体 `/api/agents`（P0-1-22，
登录即可"建与看"，编/删收窄到创建者 + ADMIN；P0-1-23 补齐第六条路由 `PUT .../components`）**、
**会话 `/api/conversations/*`（P0-1-25，**仅创建者本人** —— 连 ADMIN 也没有后门，别人的会话一律 404；P0-1-26 加了 `POST /:id/chat`（SSE）与 `POST /:id/stop`；P0-1-28 加了 `GET /:id/messages` 消息历史）**、**MCP server `/api/mcp/servers`（P0-2-2，**建/看登录即可 + 改/删按行判定（⚠️ P0-2-12 收窄，原"权限第五族 = 登录即可"已作废）** —— 与智能体同族；五条业务路由 + `POST /:id/test` 恒 200 的连通测试；**P0-2-5 起 `GET /:id/tools` 有两种取法** —— 不传 `refresh` 纯读缓存、`?refresh=1` 真拉并落库；**P0-2-12 起测试与列表用「所属人」的凭据连上游**）**。
**"MEMBER 能用的业务接口"现在有四处**：`/api/models/available`、整个 `/api/knowledge-bases/*`、
`/api/agents` 的列表/详情/创建、以及**整个 `/api/mcp/servers/*`（P0-2-2）** —— 权限口径**刻意各不相同**（模型池全程 ADMIN；
知识库**没有 owner 列**故登录即可读写；**MCP server 有 `created_by` 列故与智能体同族** —— 建/看/测试/调用全员可用、
**改/删 = 注册者 + ADMIN**（⚠️ **P0-2-12 收窄**：原文写的是"MCP server 与知识库同族、`created_by` 只作留痕、任何登录用户都能改/删" —— **已作废**）；
智能体有 `created_by` 列故编删按行判定；
**会话有 `user_id` 列故仅本人**）。**会话现在能"说话"、历史也能原样拉回来了**：
`POST /:id/chat`（P0-1-26）是 SSE 流，真正的编排循环（检索 → LLM 流式 → `citations` → 落库）
在 **P0-1-27** 落地；**`GET /:id/messages`（P0-1-28）** 就是"刷新页面重新画出整个对话页"的那**一个**请求
（游标分页 + `content` 原样透出，连 `citations` 引用卡都在），手工跑法见 ⑱。
**P0-1-29 把包 F 的五步串成一遍**（跨 B→C→D→E→F 五个包：建号 → 建库传 3 篇 PDF → 建 ChatBot 绑库 →
带引用回答 → 停止 → 刷新恢复 → 并发冲突 → 超长会话 → 首字 < 3s → 全程无手工干预数据），
自动版 `pnpm verify:chat-package`、手工版见 ⑲。
⚠️ 但**浏览器里仍是 P0-1-1 的占位页** —— 界面渲染属 **P0-1-32~34**，现在要看只能走 ⑯⑰⑱ 的 curl。
照抄邻居必错，本仓已因此踩过两次"顺手加 `requireAdmin`"。
**会话 / 对话专项边界（P0-1-25 起；P0-1-26 补 SSE 出口；P0-1-27 补编排循环；P0-1-28 补消息历史；**P0-1-29 包收口 ✅ 5/5**）**：
· **四类失败、两个出口**（分界线是**主语**，见 `docs/02` §4.5 ⑧）——"请求 / 目标"的问题
（401 / 400 / 404 / 只读 409 / 424）走 **JSON 信封**；"**这一轮生成**"的问题（**并发冲突 `CONFLICT`**、
**并发闸满 `BUSY`**、锁丢失）走**流内 `error{code}` 单帧**（HTTP **200**）⇒ **收到 200 不等于成功了**，
要读事件；反过来前端也不该把 `CONFLICT` 当"请求被拒"去弹全局错误条（它属对话区，见 `03` §五 的"消息流内错误卡"）。
· **停止 ≠ 丢弃**：`POST /:id/stop` 之后那**半条回答照常落库**（`done.messageId` 非空），紧接着**直接追问**即可
（追问不用重来）；只有"一个字都没吐就停"时才没有助手消息（此时 `messageId` 是 `null`）。**中断与上游故障都会落库**，
**唯一不落库的例外是锁丢失**（那时可能已有另一条流在写同一份历史）。
· **落库单位是"一轮问答"** ⇒ 被前置闸门拒掉的请求（Agent 被软删 / `BUSY` / 404）**一个字都不落**；
但在**绑了知识库**的 Agent 上，"开流后被拒 / 空回答"这一轮**仍会留下一条"正文空 + 带引用卡"的助手消息**
（检索跑在 LLM 之前，引用卡是真产出的）—— 这不是脏数据，而是"这一轮真的发生过"，**别当 bug**。
· **`/active` 的 `streaming` 是派生的**（Redis 键在 ⇒ `true`），值坏**逐字段降级、永不 500**；
不是自己的会话一律 **404**（而不是回 `{streaming:false}` —— 那会让"会话被删了"看起来像"当前没在生成"）。
· **`GET /:id/messages` 刻意没有 `total`**（`messages` 是 14 个分区的按月分区表，数一次要在每个分区上各跑一遍），
分页靠 `hasMore` + `nextCursor`；游标是**严格更早**（上一页的游标那条不会在下一页重复出现）；
`beforeId` 给到**别的会话的 id 或一个非 UUID** 会 **400**（不是"当成没有游标"静默回第一页）。
· **`usage_records` 表属 P1** ⇒ `done.usage` 只是**透传计量、不落表**；本版本**不做 token 级裁剪**（只按轮数截断，
因为库里没有可用的 tokenizer —— 按字符估算等于"假保护"）。
· **`POST /:id/confirm`（HITL 确认）已于 P0-2-10 落地**（`02` §4.5 的九条路由**至此无缺口**）：
危险工具在用户点头之前**绝不发 `tools/call`**；取消 / 超时都**按"未执行"回填且这一轮继续**；
应答**幂等**（重复点 / 迟到点 ⇒ 200 + `applied:false`，别人的会话一律 404）—— 手工跑法见 ㉔。
**MCP 凭据专项边界（P0-2-4）**：· 权限是**第四族 = 仅本人**（`/api/mcp/credentials/**` 只能读写**自己的那一份**，**ADMIN 也没有后门**）——
它与 `/api/mcp/servers/**` **同一个前缀却是两族**（那边是"登录即可、人人可改"），**别照抄**。
· **`PUT` 是合并语义**（只动提交里出现的 key，没提交的逐字保留）：与 P0-1 的 `components`（整体替换）**刻意相反**，
分辨方式只有一句 —— **不可回填的字段只能合并**（值不下发 ⇒ 前端没得回填 ⇒ 整体替换会把用户没填的 key 静默清空）。
· **空串 = 清空该 key**（不是存空值）；**清到一个不剩 ⇒ 整行删掉**；**`DELETE` 没配过 ⇒ 404**（删的是"我的那一份"）。
· ⚠️ **值有进无出** —— 响应里只有 `key` + `hasValue`，**连掩码都没有**（与 Provider Key 的 `apiKeyPreview` 刻意不同）；
日志只写键名与真假（`values_enc` 已在 `LOG_REDACT_PATHS` 里）。
· ⚠️ **绑定层会降级而不是 500**：密文被粘到别的 `(server,user,key)` 上 ⇒ 解密失败 ⇒ 该参数**退回"未配置"**、
服务端打一条只带键名的 warn（主密钥轮换、密文损坏走的是同一条路）。
· `/mcp/credentials` 的**前端仍是占位页**（属 P0-2-11）—— 现在要看只能用 ㉑ 的 curl。
**MCP server 专项边界（P0-2-2；P0-2-3 补模板的深度校验与"变更影响"提示；P0-2-5 补工具列表的两种取法与"拉不到"的三个出口；⚠️ P0-2-12 改过权限口径与探测主语）**：· ⚠️⚠️ **权限在 P0-2-12（2026-09-24）改过一次** —— 原文是"**第五族 = 登录即可**（`created_by` 只作留痕、
不参与判定）⇒ **任何登录用户都能改/删别人注册的 server**，这是 `01` 决策 22 的直接推论、**不是 bug**"。
**现在不是了**：`created_by` 升为**权限判据**（= 所属人）⇒ **改 / 删 = 注册者 + ADMIN**（与智能体同族，判据 `shared#canEditMcpServer`），
**建 / 看 / 测试 / 调用仍全员可用**；**403 而不是 404**（server 是公开可见资源，藏 id 没意义），顺序 **404 → 403 → 409**。
· 凭据那族（`/api/mcp/credentials`，第四族）的收窄仍在 `user_id` 上、**与本节是两个判据**。· **连通测试恒 HTTP 200** —— `ok:false` 是一条结论
（"这个 server 现在通不通"）而非错误，只有 **id 不存在才 404**；**失败时工具缓存一个字节都不动**（只在成功时刷）。
· **注册不强制连通**（上游抖动不该变成"建不了 server"），响应里那次 `test` 只是 best-effort 结论；
⚠️ **新建后第一次 `test.ok` 通常是 `false`**（所属人还没填凭据）—— **预期行为**。
· ⚠️ **`endpoint_url` 是 SSRF 面** —— 任何登录用户都能让后端去连**任意 http/https 地址**（含内网地址与云元数据端点）；
P0 **只校验 scheme**（拒 `file:`/`gopher:` 之类），**不做内网黑名单 / 端口白名单 / DNS 重绑定防护** ——
那属 **P1 安全加固**，本阶段是**已知且刻意**的边界。· ⚠️ **`POST /:id/test` 与 `GET /:id/tools?refresh=1` 用的是「所属人」的凭据**（⚠️ **P0-2-12 改过**：
原文是"**不带任何用户凭据**、'注册者视角'、配上凭据也没用"—— 那句**已作废**），
于是 `tool_cache` 仍是**每个 server 一份、全员共享**的，但主语**唯一确定** = `mcp_servers.created_by`
（⇒ 不存在"谁先点过测试、别人的列表就是谁的视角"的**串用户**）。⚠️ 而**调用工具**（`tools/call`）用的是**调用者自己**的凭据 ——
"**测试/列表看所属人，调用看自己**"这两句要一起读，缺一句就会配错地方。
· ⚠️ **所属人没配齐必填凭据 ⇒ 探测连一个上游请求都不发**（`ok:false` + 文案点名「所属人尚未配置」）——
这是刻意的：发出去只会拿到一句 401，而那句话会把人引向"我的令牌错了"（实际是**根本没带令牌**）。
· ⚠️ **没有"转移所属人"的入口**（属 P1）：`created_by` 建完就定了；**注册者被停用 ⇒ 这台 server 的测试与工具列表就废了**，
平台没有兜底（这也是"测试这条路刻意不判权限"的另一半理由：至少别人还能点一下、拿到那句"所属人尚未配置"）。
· 有些 server 的 `tools/list` 也要求鉴权且**所属人那份凭据本身就无效/过期** ⇒ 那时会如实报出
**「工具列表需要鉴权（…请让所属人到「我的凭据」页确认…）」**，**不是坏了** ——
⚠️ 这句的主语是**所属人**：当前登录的人自己配了也**不影响**这条路径（他改的是自己那份）。
· ⚠️ **`?refresh=1` 有三个出口，分界线是"我们还能不能答出这个问题"**（P0-2-5）：拉到 ⇒ `cached:false`；
**拉不到但有缓存** ⇒ **200** + `cached:true`（`fetchedAt` 明显偏旧，这就是"不是刚拉的"的全部信号）；
**拉不到且缓存也空** ⇒ **502**。⚠️ 第三种**不能**是"200 + 空数组" —— 那会被读成"这个 server 没有工具"，
用户于是去上游找一个**其实不存在**的配置问题。它与 `POST /:id/test` **恒 200** 不矛盾：
那个形状里**有** `{ok:false,error}` 这个放结论的位置，`{tools,fetchedAt,cached}` **没有**。
· ⚠️ `refresh` 只接受 **`1`/`0`/`true`/`false`**，**拼错就 400**（如 `?refresh=yes`）——
刻意不用 `z.coerce.boolean()`：`Boolean('0') === true` 会让 `?refresh=0` 变成"要刷新"，而这是**零症状**的。
· ⚠️ **`PATCH` 的回包在 P0-2-3 变过一次**：从**裸 item** 改成 **`{server, credentialSchemaImpact}`**
（`POST /` 的 `{server,test}` 同族）⇒ 旧的 `.data.id` 要写成 `.data.server.id`；`credentialSchemaImpact`
**只提示、绝不自动清理**已填的凭据（值没了是不可逆的，而用户只是临时改错模板），
`affectedCredentials` 从 **P0-2-4 起是全库的**真数**（= `values_enc` 里含 `removedKeys` 的行数；P0-2-3 时恒 `null`）。
② 浏览器里的登录页/强制改密跳转是 **P0-1-30** 的事，本里程碑只到命令行；
**文档上传专项边界（P0-1-16）**：本批能验的是"进门校验"与"解析器本身"（`pnpm verify:documents`
的 A/C/D 组真跑四个夹具文件）；`.doc` 是刻意拒收（提示另存为 `.docx`），不是没做完；
**异步流水线专项边界（P0-1-17 起；P0-1-18 补 ④⑤、P0-1-19 补 ⑥⑦）**：八步齐全后 `READY` 的语义
才是**"可检索"**（`chunks` 表有这篇的行、每行都有向量、`chunk_count` 与之一致）；
**检索（P0-1-20）与列表/下载（P0-1-21）都已落地** ⇒ 建了哪些文档、每篇什么状态、内容对不对，
用 ⑫⑬ 的 curl 就能全程看清，不必再查库（`psql` 仍是排查时的旁证）；
**列表/下载专项边界（P0-1-21）**：排序是 `createdAt desc`（**最新在前**，与 `/api/users` 等相反）；
**库不存在回 404 而不是空列表**（"库没了"与"库里没文档"是两件事）；
**下载成功时不是 JSON**（是字节流，失败才是信封），`Content-Type` 按扩展名唯一确定、
`Content-Disposition` 用 RFC 5986/5987 双写（中文名靠 `filename*`）；
**"行还在但对象丢了"是 404 + 另一句文案**且不动数据库 —— 遇到它请重新上传该文档；
**智能体专项边界（P0-1-22 起；P0-1-23 补组件绑定写侧；P0-1-24 包收口 3/3）**：
· **组件绑定**：写侧（`PUT /api/agents/:id/components`）已在 **P0-1-23** 落地 —— **整体替换**（全量提交），
回显 `{componentType, refId}`、**刻意不带目标名**（前端从各自的列表端点映射名字）；
⚠️ **本阶段只支持 `KNOWLEDGE`**：提交里含 `MCP` 会拿到 **400**「MCP 服务器功能尚未开放（P0-2 才提供注册与绑定）」
—— `mcp_servers` 表要到 P0-2 才建、也没有 server 列表端点，**不可能**选出一个真实 server，
放行只会留下修不好的孤儿绑定（P0-2 建表后接回，接口形态不变）。这是**预期行为**；
· **整体替换的三条反直觉处**（都是刻意的，见 `docs/02` §4.4「契约增量 · Agent」⑨）：
省略 `components` 是 **400 而不是清空**（清空要显式传 `[]`）；引用了不存在的知识库时**旧绑定一条都不动**
（校验排在删除之前）；重复提交同一份（哪怕换顺序）**什么都不写**（幂等）；
· **它不会改智能体的 `updated_at`** ⇒ 首页列表顺序不跳（"解绑一个库"与"编辑智能体"是两件事）；
· `POST /api/agents/:id/copy` 是 **P1**（404 不是坏了）；`GET /api/agents/:id/conversations` 归 **P0-1-25**（已落地）；
· **删除是软删**：`DELETE` 之后**详情/编辑/再删/改组件绑定一律 404**（不是 403、也不是"还能改回来"）——
留一个"看起来还能改"的页面等于诱导用户去改一条作废记录。会话**不删**、只转 `FINISHED` 只读保留；
✅ **"只读"现在两个方向都能亲眼看见**（P0-1-26 补齐）：**读得到**（会话列表仍返回、`status=FINISHED`）
**且写不进去**（对同一会话打 `POST /api/conversations/:id/chat` → **409**，见下面 ⑯ 的手工端测）；
P0-1-24 的包级验收当时只能在 **DB 层**取证，那条 ⚠️ 已收掉；
· **被软删的智能体不再出现在列表里**，而它的历史会话仍在 —— 这是"业务留痕不允许随 Agent 消失"
（`conversations` 的外键全是 `RESTRICT`）；
· **软删的智能体仍占模型的引用计数**（`ModelItem.agentCount` 刻意不按 `deletedAt` 过滤）⇒
"删了智能体为什么模型还删不掉"是**预期行为**（它要的是 `ON DELETE RESTRICT`）；
· **改类型不行**：`type` 可传但不可改（不同值 409、**传同值 200**，因为前端是整表单提交）；
· **绑定的模型事后被停用不影响改名**：只有**换绑**才重新校验可用性 —— 否则连改名字都会撞 409，
会表现成"这个智能体改不动了"。此时列表/详情靠 **`modelAvailable: false`** 提示；
· **名称不查重**（`agents` 上没有 `name` 唯一约束）：同名的两个智能体靠 id 区分，这是刻意的 ——
需要唯一性时应当**先加约束再改代码**，而不是在服务层造一条"看起来唯一、并发下不唯一"的规则；
**检索专项边界（P0-1-20）**：
· **全文路只适合短查询** —— 它是 `content LIKE '%词%'` 的**字面子串**匹配，自然语言长问句（哪怕截断到
64 字符）几乎不可能连续出现在正文里，`mode=FULLTEXT` 因此可能返回空。**这是预期行为**（长问句请用
`HYBRID`/`VECTOR`），不是索引坏了 —— 索引本身由 `pnpm verify:knowledge` 的 EXPLAIN 断言守着；
· **手工跑 ⑫ 需要配好 `EMBEDDING_*`**（要算 query 向量）：本机 `.env` 三项为空时 `HYBRID` 会
**降级为纯全文检索并给 warning**（不报 500），`mode=VECTOR` 则明确报 500；想看完整三模式，
直接跑 `pnpm verify:retrieval`（脚本自起假上游，零配置）；
· **库里没有向量就搜不到**（空库 / 全失败 / 正在 `PARSING`）⇒ `items: []` 是"真的没有"，不报错；
· **换了 embedding 模型**（库快照的 `embedding_model` ≠ 当前 provider）时：`HYBRID` 跳过向量路并告警、
`VECTOR` 回 **409**（"请等待重建完成"）—— 这是 `子方案①` §八 的降级路径，P0 只到"探测 + 告警"，
真正的重新向量化（`chunks_v2` 换表）是 P1；
· 返回的 `snippet` **不加工、不加省略号**（省略号由前端按需加）—— 这样它一定是原文的子串，可逐字核对；
· `rrfScore` 的数值只有配上同时返回的 `rrfK` 才可比（不同库的 `rrfK` 可以不同）；
worker 是**进程内**的（`PIPELINE_CONCURRENCY=2`，不是独立进程）—— 所以 worker 崩了后端一起崩，
"失败可重试"就是为 List 队列**没有 ack**（worker 崩在中途任务就丢了）兜底的；
**⚠️ 手动端测前必须先配好 embedding**（P0-1-19 起流水线真的会调它，而本机 `infra/.env` 的三项是空的）——
不配的话每篇文档都会在 ⑥ 变成 `FAILED`（`error_msg` 是「文本向量化失败（已重试 2 次）…」）；
**内容门槛（P0-1-18 起）**：有效字符 < `EMPTY_TEXT_THRESHOLD`（默认 50）的文档会直接判 `FAILED`
（「疑似扫描件或空白文档」）—— 扫描件终于不再"假装 READY"，但**太短的正常文档也会被拦**
（一张只有标题的 txt、一个 20 字的 docx）；这是刻意的一致性取舍（"内容太少没法检索"），
要改就调那个环境变量，别改代码；
**覆盖重建的"检索空窗"是刻意的**（`子方案①` §七）：重建时旧 chunk **立即**清掉、新内容重建完才回来，
窗口 = 一次流水线耗时 —— 期间该文档搜不到，**不报错**。所以列表页必须把 `PARSING` 显式显示成
「更新中，暂不参与检索」（这条已写进 P0-1-21 的坑预判，是**必做**项而非常规提示）；
**分块与检索参数改了不会自动重建**：`chunkSize`/`chunkOverlap`/`retrievalConfig` 只对**之后**处理
的文档生效（`子方案①` §十一 的刻意取舍），已入库的文档要手动触发重建；
**`retry` 对 `READY` 回 409**（没有东西可重试），它**不是**"重新跑一遍"的入口 —— 想换内容请用覆盖重建；
③ **LLM client 目前没有对外调用入口**（`chat()` / `chatStream()` 是给 F 包编排用的），
所以"模型通不通"这一层现在还只能用 `remote-models` 探一下（P1 的 `POST /api/models/:id/test` 未做）；
④ **embedding 同样没有对外端点**（入库/检索是 D 包的事），上面 ⑥ 的两条自检能告诉你"配置齐不齐、
就绪没就绪"；**local 模式的推理还跑不了**（`LOCAL_EMBEDDING_RUNTIME_MODULE` 为空 =
`docs/06` §七 待决事项 2 未关闭），要试就先走 `EMBEDDING_MODE=api`；
⑤ **端测完请复位**（走查会把 admin 的密码改掉、也会往模型池留下你建的 Provider，删掉即可）：
`SEED_RESET_PASSWORD=1 pnpm db:seed` 把两个种子账号打回首登态并恢复成你指定的密码。

> 想一条命令跑完上面全部 + 六条门槛的自动版：`pnpm verify:e2e`（它自己起进程、自己造号、跑完删净）；
> LLM client 那部分（含假上游）的自动版：`pnpm verify:llm`；
> embedding 双模式（含 stub 推理运行时，**不需要起 docker**）：`pnpm verify:embedding`；
> 知识库数据层（只连 PG，**不需要 Redis**）：`pnpm verify:knowledge`；
> 知识库 CRUD（含"删库时 S3 原文件真的消失"，所以要 MinIO）：`pnpm verify:knowledge-bases`；
> 文档上传（四道前置校验 + 四格式解析 + 按库判重 + 删库双清，同样要 MinIO）：`pnpm verify:documents`；
> 异步流水线（队列语义 + 状态机 + 幂等四道 + 并发闸门 + 失败重试 + 入队原子性 + 扫描件与分块，同样要 MinIO）：
> `pnpm verify:pipeline`；**入库之后**的形态（chunk 落库/向量/id 版本位/覆盖重建/内容未变化/重试/删除）：
> `pnpm verify:ingest`；**检索**（三模式 + 六列分数 + 与独立 SQL 等价 + RRF 反算 + 引用片段 + 降级路径）：
> `pnpm verify:retrieval`；分块策略、三条新端点与**检索的纯函数规则**都在 `pnpm verify:app` 里
> （不需要任何依赖，可进 CI）。

> 进程支持 SIGINT/SIGTERM 优雅退出：**先停 worker**（等手上的任务收尾，最多 5s）→ 停止接流 →
> 关闭 PG/Redis 连接 → flush 日志 → 退出（10s 兜底强退）。
