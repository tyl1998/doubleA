# 子方案 — 图片 OCR 质量与图片"含义"理解

> 上游基准：`docs/02-后端设计.md`（§4.6 文档上传/处理）、`docs/子方案/知识库流水线.md`（§4-1 解析、§三 流水线 ③·补 图片 OCR、§4-3 embedding、§五 空文本检测）。
> 定位：对**图片处理链路**的质量修复与增强，不改变流水线八步骨架。
> ⚠️ **2026-10-08 变更**：原三选一"图片处理方式"（`NONE`/`OCR`/`MULTIMODAL`）已**重构为"识别方式三选一（`NONE`/`OCR`/`LLM`，互斥）+ 图片向量化独立开关"**（见 §十一）；本文中出现的旧名 `OCR`/`MULTIMODAL` 请按 §十一 的对应关系理解。图片描述模型由"全局 env"改为**知识库级**配置（§十 待决 2 已改判）。
> ⚠️ 本文是**方案（先落纸、后实现）**。下方"实测证据"是一次受控实验的原始结论，用作验收基线。

---

## 一、问题与实测证据

用户反馈：**`OCR` 模式识别出来是乱码，且识别不到图片本身含义。**

受控实验（可复现，见 §七）：用 CoreText 渲染一张**已知文字**的清晰图片 → 先用 Apple Vision OCR 确认图片真值 → 再喂给本项目所用的 tesseract.js。

图片真值：`报销制度 差旅标准 北京 500 元`

| tesseract 语言配置 | 识别结果 | 结论 |
|----|----|----|
| `chi_sim` | `报 色 制度 于 旅 标准 北京 200 元` | 中文可用但有错字/数字错，**当前最优** |
| `eng+chi_sim` / `['eng','chi_sim']` | `i $H HE 于 旅 标准 北京 S00 元` | **中文被英文模型带崩** |
| `chi_sim+eng`（**当前默认**） | `报 色 制度 于 旅 标准 北京 200 元`（伴随 `Failed loading language`） | eng 侧加载失败 → 侥幸退化成纯 chi_sim，**脆弱** |
| `eng` | `i $H HE ZhikdrE Jb S00 JT` | 中文全崩 |

三条根因：

1. **混用 `eng` 会显著拉低中文识别**：英文模型抢占前几个字，中文退化成 latin 乱码。当前默认 `chi_sim+eng` 只是因 eng 加载失败而"碰巧可用"，环境一变（eng 加载成功）即崩。
2. **没有任何图像预处理**：`pipeline/ocr.ts` 把原始图片字节直接交给 tesseract。扫描件/照片（低分辨率、光照不均、倾斜、噪声）会直接崩成乱码。
3. **tesseract 对中文只是"够用"**：连干净渲染图都有错字（`报销`→`报色`、`500`→`200`），不能期望它达到 Apple Vision 的水准。
4. **OCR 天然不认"含义"**：图表/流程图/截图的"含义"不在文字里，任何 OCR 都取不到 —— 这一半是能力边界，不是缺陷。

---

## 二、目标与非目标

**目标**
- 让 `OCR` 模式在**中文为主 + 中英混排**的文档上产出**确定、可复现、不因语言加载顺序而崩**的结果。
- 让**扫描件/照片**类图片有可用的识别质量（预处理 + 参数）。
- 明确"图片含义"的独立实现路径（VLM 描述），与 OCR 解耦。

**非目标**
- 不追求达到商业 OCR（Apple Vision / 云 OCR）的精度。
- 不改变"图片向量化"的语义（图片→向量；描述文字另由「图片含义识别」开关决定，二者独立）。
- 不做"持久化图片 + 回答时喂原图"（前一轮已评估为产品级改动，暂缓）。

---

## 三、方案总览（三条轨道，独立可交付）

| 轨道 | 内容 | 解决 | 优先级 |
|----|----|----|----|
| **轨道一 · OCR 质量修复** | 语言策略 + 图像预处理 + tesseract 参数 | "乱码" | P1（建议先做） |
| **轨道二 · VLM 图片描述** | 用 vision 对话模型生成图片描述写入块内容 | "识别含义" | P1（按需） |
| **轨道三 · 多模态图片可读性** | `MULTIMODAL` 时顺带 OCR，把文字写进 `content` | "多模态块只有图注、读不到" | P2 |

三轨不互相依赖，可按需单独排期。**命名口径**见 §九（旧 `IMAGE_MODE_LABELS`）与 §十一（现行 `IMAGE_RECOGNITION_LABELS` + `IMAGE_VECTORIZE_LABEL`）。

> 另附两条**由真实样例得出**的结论（各自独立、可先落纸后实现）：**§五·补**（图表多低清、VLM 会幻觉，须"低清不上 VLM + 原图优先"）、**§六·补**（`.doc` 常是 HTML/MIME 导出件，应按内容嗅探而非按扩展名拒绝）。

---

## 四、轨道一 · OCR 质量修复

### T1 语言策略（先做，最小改动、收益确定）

现状：`config.ts` 的 `OCR_LANGS` 默认 `chi_sim+eng`，拆成数组传给 `createWorker`。

实测表明 tesseract.js v7 **多语言混用会互相劣化**，故：

- **默认改为 `chi_sim`**（中文为主；`chi_sim` 对常见英文与数字仍可识别）。
- `OCR_LANGS` 保留为可覆盖配置；**在注释里点名"不要随意与 `eng` 混用（会劣化中文）"**。
- 提供**多语言规避策略**（P2，可选）：`OCR_MULTIPASS`（默认关）—— 对同一图片**分两次**分别用 `chi_sim` / `eng` 识别，按 `data.confidence`（或逐词置信度）择优/合并，避开 tesseract 的多语言混用缺陷。

> 取舍：单语默认会牺牲"纯英文文档"的识别率；但当前库里以中文为主，且 `chi_sim` 对英文并非不可用。若确需纯英文场景，用户可把 `OCR_LANGS` 设为 `eng`。

### T2 图像预处理（收益最大，针对扫描件/照片）

在 `recognizeImage` **之前**加一步纯 JS 预处理，链路：`灰度化 → 对比度拉伸/Otsu 二值化 → 小图放大到目标 DPI → 轻量去噪`。

关键约束：**预处理需要像素**，而当前 `ParsedImage.data` 是**编码后的字节**（PNG/JPEG）：

- **PDF 提取的图**：在 `parse/pdf.ts#pageImages` 里像素仍是**原始缓冲**（`encodePngRaw` 之前），**在这里预处理成本最低、价值最高**（扫描件正是这条路径）。
- **独立上传的 PNG**：纯 JS 解码（自带极简解码或引 `pngjs`，无原生依赖）。
- **独立上传的 JPEG / MD 外链图**：tesseract 自带解码；如需预处理，需引纯 JS 解码器（`jpeg-js`）—— 列为待决（§十）。

参数：目标最小边长或 `user_defined_dpi`（T3）、二值化阈值策略（Otsu 自适应，不写死）。

### T3 tesseract 参数

通过 `worker.setParameters()` 设定：

| 参数 | 值 | 理由 |
|----|----|----|
| `user_defined_dpi` | `300` | 缺省 DPI 会让 tesseract 按 96 缩放导致小字崩 |
| `preserve_interword_spaces` | `1` | 保留词间空格（对表格/对齐文本更友好） |
| `tessedit_pageseg_mode` | `6`（整页单栏，默认） | 扫描整页常用 6/4；稀疏文本用 11 —— 作为可配项 |

> 参数化还是写死：建议 `user_defined_dpi` / `preserve_interword_spaces` 写死（无争议），`tessedit_pageseg_mode` 作为 env 可配（不同文档形态最优值不同）。

---

## 五、轨道二 · VLM 图片描述（"识别含义"的正解）

OCR 取不到"含义"，只有 vision 能。方案：

- 流水线新增阶段 `describe-images`（文档**识别方式选「大模型识别（LLM）」**时启用）：把图片交给**一个 vision 对话模型**，prompt 要求"用中文描述这张图的类型与要点，含图中关键文字"。
- 描述文本写入该图片对应的块 `content`（多模态块：图注 + 描述；OCR 块可额外追加描述）。
- **模型来源**（2026-10-08 修订）：**知识库级**选「图片描述模型」（`knowledge_bases.caption_model_id`，模型池里 `supportsVision=true` 的对话模型），且文档**识别方式选「大模型识别（LLM）」**；两者缺一则本阶段 no-op。
- **成本/延迟**：每次图片一次 vision 调用，受 `IMAGE_MAX_COUNT` 上限约束；失败降级为"只保留图注/OCR 文本"，不使文档 FAILED。
- **输出长度不设上限（2026-10-08 修正）**：`describeImageWithTarget` **不再传 `maxTokens`**（原为常量 `CAPTION_MAX_TOKENS = 800`，已删除）。`max_tokens` 是"输出预算"，而**思考类模型的推理 token 也从这里扣** —— 实测真实样例（`2026-09+URP-广发积分兑换券核销.doc` 的 3 张时序图，`mimo-v2.6-flash`）在 800 下**三张全部 `finishReason: 'length'`**：半截 JSON 被 `parseCaptionReply` 降级成"整段当 summary"写库、或思考吃光预算后 `text` 为空**直接判失败不产出**（6.3「拉取广发账单并对账时序图」即此）。**输出长度应交给模型/上游默认**，平台不替用户设上限（成本另行计量）；故 `chat()` 仅传 `temperature: 0`。（Anthropic 协议仍有 `max_tokens` 必填的兜底 4096，属协议差异、非本项限制。）
- 复用现成设施：`llm/client.ts#chat`（非流式）+ `LlmTarget.supportsVision`（P1-4 附件直读已用）。

> 与 OCR 的关系：**互补而非替代**。文字密集的文档用 OCR（本地、免费）；图形/截图用 VLM（有成本）。两者可同时开启。

---

## 五·补、流程图 / 结构图怎么处理（轨道二的专门化）

**核心事实**：流程图的语义 = **节点文字（框里的字）+ 边（顺序 / 分支 / 条件）**。OCR 只拿得到节点、**边全丢**，所以流程图不能用 OCR —— 必须把"图"转译成**结构化文字表示**。

**目标表示**（二选一不够，建议两者都存）：

- **Mermaid**（`flowchart TD; A[提交]-->B{金额>500?}; B--是-->C[经理审批]`）：紧凑、大模型能顺着逻辑读、前端可渲染 —— 精确形态。
- **自然语言摘要 + 步骤/分支列表**：检索友好（问"审批流程是什么"能命中）。

**按来源分三档**：

1. **原生结构（最优，零成本）**：
   - MD 里的 ` ```mermaid ` 代码块 —— **当前 md 解析器已把它收成一个文本块**，天然就是结构化文本，无需图片处理。
   - docx 的 SmartArt / 形状是 DrawingML，**mammoth 不解析其结构**（只当图形）；要拿到结构需自定义 OOXML 解析，成本高。
   - 矢量 PDF 里由线段+文本框画的流程图，理论上可按图元重建，实际不可靠、不做。
2. **VLM 转译（主力）**：vision 模型直接看图，输出 Mermaid + 步骤说明 + 节点标签。简单/中等流程图可靠；**复杂、嵌套、手绘会漏边或编错**。
3. **OCR（仅兜底）**：只取节点标签，用于关键词召回；单独用无意义。

**统一做法（并入轨道二）**：`describe-images` 阶段用**图表感知的 prompt**，让模型返回结构化 JSON：

```
{ "kind": "flowchart|chart|diagram|photo|text", "mermaid": "...", "summary": "...", "labels": ["..."] }
```

- `kind=flowchart` ⇒ 优先产出 Mermaid；`kind=chart` ⇒ 输出"数据表/趋势描述"；`kind=photo` ⇒ 纯描述。
- 块 `content` = `summary` + Mermaid；`chunks.meta` 记 `imageKind`（便于检索过滤/前端区分渲染）。
- 检索与引用消费 `content`（Mermaid + 摘要都进向量与全文路）；前端可选渲染 Mermaid 卡片。

**可靠性边界（必须写清）**：

- VLM 对流程图是"**描述**"，不是"权威结构"：复杂图可能错边/漏节点。故**始终保留 `labels[]`** 作关键词兜底，且不要把 Mermaid 当可执行真相。
- 若产品需要"**回看原图核对**"，那就回到"持久化图片（C）"—— 前一轮已评估为产品级改动，暂缓。

### 实证：导出件里的图常是**低清缩略图**，VLM 会一本正经地幻觉（2026-10，真实样例）

- 在一份 Confluence 导出件里抽出 3 张内嵌 PNG，分辨率仅 `293×250 / 293×250 / 422×250`；
- **Apple Vision（可靠）几乎读不出任何文字**（空白/乱码）；
- 而 VLM 却给出**非常详尽、非常自信的时序图**，内容全是 **UAF/SFU/LBE 网络流控**、**EHR/PACS/EMR 医学影像**等，与原文（广发积分券核销）**毫不相关** → **判定为幻觉**。

**由此追加两条硬约束**：

1. **低清图不交给 VLM**：短边过小 / 缩放后仍无法被可靠 OCR 识别的图，标记 `unreliable`，**只留引用、不产出图结构**（宁缺毋滥，幻觉比缺失更坏）。
2. ~~**优先取高清原图**：HTML/MIME 导出件通常保留远程原图地址（`data-image-src` → 内网 Confluence 附件 URL，需鉴权）；有源就取源，别用导出内嵌的缩略图。~~ ❌ **不做（2026-10-08 定案，P1-12）**：`data-image-src` 指向的是**需鉴权的内网 Confluence 附件 URL**，取源要额外接一套内网鉴权/代理，收益不抵复杂度；本批只做"把导出件里**自带**的图（data URI / MIME part / 明文 http(s)）取出来"。若将来确有"低清缩略图导致识别不可用"的现实诉求，再单独立项。

---

## 六、轨道三 · 多模态图片可读性（P2，可选）

`MULTIMODAL` 块的 `content` 目前只有图注 `[图片] <上一段>`。最小增强：在 `MULTIMODAL` 模式下**顺带本地 OCR**，把识别文字并入 `content`（图片仍用于多模态向量）。

- 复用轨道一的 OCR 链路；不改存储、不改检索契约、不改回答链路。
- 效果：多模态块在检索/引用里**至少可读出图上文字**，向量仍保留视觉语义。

---

## 六·补、输入格式 —— 「`.doc`」常是 HTML/MIME 导出件（按内容嗅探）

**实测（2026-10，真实样例 `2026-09+URP-广发积分兑换券核销.doc`）**：

- 文件头是 `Subject: Exported From Confluence` + `multipart/related` —— 它是 **Confluence 导出的 MHTML**，**不是 OLE2 二进制**；文本抽取正常（约 8.3k 字，正文/表格/接口定义齐全）。
- 存量 `.doc` 里这类"**HTML/MIME 导出件**"占比很高（Confluence、Word「另存为网页」、邮件导出……），**扩展名不可信**。
- 结论：**扩展名 `doc` ≠ OLE2 二进制**。当前 `detectFormat` 一见 `.doc` 就直接拒（`parse/index.ts:256`），会把这类本可解析的文件误杀；而 `word-extractor` 之类只读 OLE2，对它也无效。

> 这是**新需求**，不属于图片 OCR 三条轨道，但与本文件的"格式理解"强相关，故记录在此。
> ✅ **2026-10-08 P1-12 落地**：已按下方方案实现（`parse/index.ts#sniffLegacyDoc` + 新解析器 `parse/html.ts`），并**顺带补齐了 `<img>` 抽图**（data URI / MHTML 同包 `image/*` part / 远程 http(s)）。**本批只吃"内容其实是 HTML/MIME"这一类**；真 OLE2 的 `word-extractor` / LibreOffice 取舍（§十 待决 5）**仍未做**——真 OLE2/RTF 仍拒并提示"另存为 .docx"。详见 `06` §五·补 P1-12。

**方案：上传/解析时按*内容*嗅探，而非按扩展名**（与现有"文件头魔数"纪律一致，只是把 `.doc` 从"见到就拒"改成"看内容再决定"）：

| 嗅探到的内容 | 处理 |
|----|----|
| `multipart/related` / MIME 头 | 当作 **MHTML**：解出 `text/html` part → 按 HTML 抽文本（与现有 HTML/MD 链路同族） |
| HTML（`<!doctype` / `<html`） | 按 HTML 抽文本（`mammoth` 或轻量 HTML→text） |
| OLE2（`D0CF11E0A1B11AE1` 起头，→ `parse/index.ts:154` 的签名表已能识别） | 真 `.doc`：`word-extractor`（纯 JS，**仅扁平文本**，当文本级格式）或 LibreOffice headless 转 docx（**有结构**） |

- 提示文案相应细分：网页导出件 → "将按网页文本解析"；真 OLE2 → "请另存为 `.docx`"。

---

## 七、验收与回归基线

**受控实验脚本**（新增 dev 脚本，不依赖基础设施）：CoreText/或内置夹具渲染"已知文字"图 → 断言 tesseract 输出**不含乱码模式**且关键 token 命中。基线即 §一 的表格，验收要求：

1. 默认配置下，中文样例**不再出现整段 latin 乱码**（回归 `eng+chi_sim` 的崩法）。
2. 语言加载**无 `Failed loading language`**（当前 `chi_sim+eng` 会打印该错）。
3. 处理后（T2/T3）在**模拟降质图**（缩小 + 加噪 + 低对比度）上的关键 token 命中率**不低于当前清晰图基线**。

**兼容性**：四格式解析、分块、检索、`MULTIMODAL` 均不受影响（轨道一只动 OCR 参数与预处理）。

---

## 八、参数总表（施工依据）

| 参数 | 默认 | 形态 | 说明 |
|----|----|----|----|
| `OCR_LANGS` | `chi_sim`（原 `chi_sim+eng`） | env | 中文默认单语言；注释点名"勿随意混 `eng`" |
| `OCR_MULTIPASS` | `false` | env（P2） | 分语言各识别一次再择优，规避多语言混用缺陷 |
| `OCR_PSM` | `6` | env | tesseract `tessedit_pageseg_mode` |
| `OCR_TARGET_DPI` | `300` | env | 预处理放大目标（映射到 `user_defined_dpi`） |
| `OCR_PREPROCESS` | `true` | env | 预处理总开关（便于对照/回退） |
| ~~`IMAGE_CAPTION_MODEL_ID`~~ | ~~空（关）~~ | ~~env~~ | ⚠️ **已删除**：描述模型改为知识库级 `knowledge_bases.caption_model_id`（见 §十一）；文档侧由「图片含义识别」开关控制 |
| `IMAGE_CAPTION_MIN_PX` | `256` | env | 低清图判据（短边像素）；低于它不交给 VLM（**P1-11 新增**，见 §五·补） |
| `IMAGE_OCR_MIN_PX` | `256` | env | 低清图判据（短边像素）；识别=`OCR` 时低于它**不跑 OCR**（**2026-10-08 追加**，见 §九） |

---

## 九、已落地（本次会话）

- 命名口径：`IMAGE_MODE_LABELS` 改为 `不处理图片` / `图片转文字（OCR）` / `图片向量化（多模态，不转文字）`；`IMAGE_FILE_REQUIRES_MODE_HINT`、`MULTIMODAL_MODEL_REQUIRED_HINT`、空文本检测文案、前端帮助文案同步（`shared/src/document.ts`、`backend/src/pipeline/stages.ts`、`frontend/src/pages/knowledge/UploadDocumentModal.tsx` 等）。目的：让"多模态不产出文字"在 UI 上不再误导。

- **轨道一 · OCR 质量修复（P1-10，2026-10-08 落地）**：
  - **T1 语言策略**：`config.ts` 的 `OCR_LANGS` 默认 `chi_sim+eng` → **`chi_sim`**（注释点名勿与 `eng` 混用，见 §一 实测）。
  - **T2 图像预处理**：新增 `backend/src/pipeline/preprocess.ts`，纯 JS 链路 `灰度化 → 对比度拉伸（0.5/99.5 分位）→ 小图放大 → Otsu 二值化 → 3×3 去噪` + 极简 PNG 解码器（Node 内置 `zlib`，零新依赖）。接入点在**流水线 `ocrImagesStage` → `recognizeImage`**（按 `image/png` 判定，见改动清单里对"放解析层"的取舍）：解码不支持/异常一律**回退原图**。JPEG 等不在本批（§十 待决 1）。
  - **T3 tesseract 参数**：worker 初始化后 `setParameters({ user_defined_dpi: OCR_TARGET_DPI(300), preserve_interword_spaces:'1', tessedit_pageseg_mode: OCR_PSM(6) })`。
  - **新增 env**：`OCR_PSM`、`OCR_TARGET_DPI`、`OCR_PREPROCESS`（见 §八 参数总表）。
  - **回归基线**：`backend/scripts/ocr-regression.ts`（`pnpm --filter @doubulea/backend ocr:regression`）——默认档验语言/参数/预处理确定性；真实样例档需 `OCR_REGRESSION_FIXTURE=<已知文字的图>`。
  - ⚠️ **与其他轨道的边界**：本批**不含**轨道二（`describe-images` / VLM 描述 / `IMAGE_CAPTION_MODEL_ID`，属 P1-11）与轨道三（`MULTIMODAL` 顺带 OCR，P2）；`OCR_MULTIPASS` 也未实现（§四 T1 标其为 P2 可选）。

- **轨道二 · VLM 图片描述（P1-11，2026-10-08 落地）** —— 补 OCR 取不到的"含义"：
  - **阶段**：新增 `pipeline/stages.ts#describeImagesStage`，位于 `parse` **之后**、`ocr-images` **之前**；仅当该库选了 `supportsVision=true` 的 CHAT 描述模型**且文档识别方式选「LLM」**时生效，否则 no-op。⚠️ 描述**总有一个落点**：未开向量化时落文本块（`ocr-images` 的触发含 `识别=LLM && !imageVectorize`）；开了向量化时由 `buildImageChunks` 并进图片块。
  - **产出**：`pipeline/caption.ts` 用图表感知 prompt 调 `llm/client.ts#chat`（多模态 content part）→ 结构化 `{kind, mermaid, summary, labels}`；未开向量化时落**文本块** `[图片含义] …`、开了向量化时由 `buildImageChunks` 并进图片块 `content` + `chunks.meta.imageKind`。
  - **低清防护（硬约束）**：`probeImageSize`（纯 JS 文件头嗅探 PNG/JPEG/GIF/BMP/WEBP）读短边，< `IMAGE_CAPTION_MIN_PX`（默认 **256**，覆盖 §五·补 实测的 `293×250` 样例）则标 `unreliable`、**不交给 VLM**（宁缺毋滥，防幻觉）。
  - **降级**：模型不可用 / 单张调用失败**只记 warn、不使文档 FAILED**（描述是可选的锦上添花）。
  - **配置**：描述模型 = 知识库级 `knowledge_bases.caption_model_id`（迁移 `20261008090000_kb_caption_model`）；env 仅 `IMAGE_CAPTION_MIN_PX`。**零新依赖**。
  - **自证基线**：`backend/scripts/caption-regression.ts`（`pnpm --filter @doubulea/backend caption:regression`，17 项：尺寸嗅探 5 格式 / 回复解析 5 场景 / 文本口径 3 项 / 配置 2 项）。
  - ⚠️ **不做**："优先取高清原图"（从 `data-image-src` 取远程内网附件源图，§五·补 2，**2026-10-08 定案不做**）；"持久化图片 + 回看原图核对"（产品级改动，暂缓）；轨道三（`MULTIMODAL` 顺带 OCR）仍为 P2。
  - 🔧 **输出不设上限（2026-10-08 修正，用户定案）**：删除常量 `CAPTION_MAX_TOKENS = 800`，`describeImageWithTarget` 改为 `chat(target, messages, { temperature: 0 })`（**不传 `maxTokens`**）。根因：`max_tokens` 是**输出预算**，思考类模型（实测 `mimo-v2.6-flash`）的推理 token 也从这里扣 ⇒ 800 下三张时序图全部 `finishReason: 'length'`（半截 JSON 被当 summary / `text` 为空判失败）。平台不替用户设输出上限，成本另行计量。回写见 `06` §五·补 P1-11 决定八、`02` §4.6。

- **`.doc` 按内容嗅探（P1-12，2026-10-08 落地）** —— 见 §六·补：
  - `parse/index.ts#detectFormat` 对 `.doc` 先按内容嗅探（`sniffLegacyDoc`：OLE2 魔数 / RTF / MIME 头 / HTML 标记 / 其它）；命中 HTML 或 MHTML 则放行、归一成解析格式 `'html'`（`ParseFormat` 新增值），交给新解析器 `pipeline/parse/html.ts`（裸 HTML + MHTML 按 boundary 取 `text/html` part、解 base64/quoted-printable；抽块与 md/docx 同族，表格网格/去标签复用 `docx#parseTableGrid`/`toPlainText`）。
  - 真 OLE2 / RTF / 其它**仍拒**并保留「请另存为 .docx 后重传」；**`html` 不是可上传扩展名**（`.doc` 仍是唯一入口）。
  - **抽图**（P1-12 补齐）：`<img>` 的 data URI / MHTML 同包 `image/*` part（`Content-Id`/`Content-Location`/相对 URL/文件名回查）/ 远程 http(s) 都取，图进 OCR/VLM/向量化链路；单张失败只跳过。⚠️ MHTML 文本 part 按 `charset` 解（Word 导出件 `charset="unicode"`=UTF-16LE，实测必须认它、否则满屏 NUL）。**不做**真 OLE2 解析（§十 待决 5）与"从 `data-image-src` 取远程高清源"（§五·补 2，**2026-10-08 定案不做**）。
  - `FormatProfile.sniffLegacyDoc` 只有知识库文档画像开；对话附件维持拒 `.doc`。**零新依赖**。
  - 自证基线：`backend/scripts/doc-sniff-regression.ts`（`pnpm --filter @doubulea/backend doc:sniff`，27 项）。

- **图片低清不识别（OCR 侧扩展，2026-10-08 追加 · 用户定案）** —— 把 P1-11 的低清防护从"只护 VLM"扩展到**两种识别都护**：
  - 识别方式 = `OCR` 时，短边 < `IMAGE_OCR_MIN_PX`（新增 env，默认 256）的图**不跑本地 OCR**、标 `unreliable`；该图未开向量化时**完全不产出**（低清 OCR 只会是噪声）。
  - 阈值与 VLM 侧 `IMAGE_CAPTION_MIN_PX` **独立可调**（两种识别容错不同）；嗅探不出尺寸照常识别；**不影响图片向量化**（与识别正交）。
  - 落点：`pipeline/stages.ts#ocrImagesStage`（`probeImageSize` 判短边）；`config.ts` 新增 `IMAGE_OCR_MIN_PX` + `config.ocr.minShortSidePx`；`02` §4.6/§十一、`infra/.env.example` 同步。

---

## 十、待决事项

1. **上传的 JPEG 预处理**：是否引入纯 JS 解码器（`jpeg-js`/`pngjs`）以覆盖"独立 JPEG 上传"的预处理；还是仅覆盖 PDF 提取图与 PNG 上传（收益/依赖权衡）。
2. ~~**轨道二模型来源**：`IMAGE_CAPTION_MODEL_ID` 用全局 env，还是做成知识库级配置（更灵活、但改契约）。~~ ✅ **P1-11 定案（2026-10-08 修订）：知识库级** —— 新增 `knowledge_bases.caption_model_id`（建/改库时从模型池选 `supportsVision` 的 CHAT 模型），**删除全局 env** `IMAGE_CAPTION_MODEL_ID`。每个库可不同（见 §十一 与 `02` §4.6）。
3. **多语言文档**：`OCR_MULTIPASS` 的择优是"整图取高置信"还是"逐行合并"（后者质量更好、实现更重）。
4. **轨道三是否默认开**：多模态下顺带 OCR 会翻倍图片处理耗时，需明确开关默认值。
5. **`.doc` 内容嗅探是否纳入范围**（§六·补）：HTML/MIME 导出件按 HTML 解析是新需求；真 OLE2 的 `word-extractor`（仅文本）还是 LibreOffice（有结构）需先定取舍。🟡 **部分关闭（P1-12，2026-10-08）**：HTML/MIME 导出件已落地（按内容嗅探 + `parse/html.ts`）；**真 OLE2 仍不做解析**（仍拒并提示"另存为 .docx"），取舍待定。
6. ~~**低清图判据**：`unreliable` 的阈值（短边像素 / 缩放后 OCR 可读性）需要在实现时用样例定标。~~ ✅ **P1-11 定案：短边像素阈值为 `IMAGE_CAPTION_MIN_PX`（默认 256）**，覆盖 §五·补 实测的 `293×250` 样例（250 < 256）；纯 JS 文件头嗅探、无新依赖。若图源普遍更小，运维调大该 env 即可，无需改代码。**2026-10-08 追加**：OCR 侧用**独立**的 `IMAGE_OCR_MIN_PX`（默认同 256）—— 两种识别都跳过低清图，阈值各自可调。

---

## 十一、图片处理选项重构（识别三选一 + 向量化开关）（2026-10-08）

**背景**：原三选一 `documents.image_mode`（`NONE`/`OCR`/`MULTIMODAL`）把"识别"混在一处，无法表达"只做 LLM 含义识别、不向量化"；且"是否识别"应由**上传者按文档**判断（有的图不需要识别）；再者 **VLM 看一张图本就 reads 上面的文字，叠一遍本地 OCR 是重复劳动** ⇒ OCR 与大模型识别应**互斥**。故重构为两维：

| 维度（`documents` 列 / 上传字段） | 取值 | 含义 | 落点 | 能力前置 |
|----|----|----|----|----|
| 识别方式 `imageRecognize`（`imageRecognize`）| `NONE` / `OCR` / `LLM`（**三选一、互斥**）| 不识别 / 本地 OCR / 大模型含义（VLM，轨道二）| 文本块（OCR 或 LLM）| `LLM` 需该库已选「图片描述模型」 |
| 图片向量化 `imageVectorize`（`imageVectorize`）| `true`/`false`（**独立开关**）| 图片走多模态向量 | 图片块 | 该库向量模型 `embeddingMultimodal` |

- 组合 = 3×2 = 6 种；独立图片文件需"识别≠`NONE` 或 向量化开"（全不选 = 旧 `NONE`）。
- 旧名对应：旧 `OCR` = 识别 `OCR`；旧 `MULTIMODAL` = 向量化开（识别 `NONE`）。
- 迁移 `20261008091000_document_image_options`（旧枚举→两布尔）→ `20261008092000_image_recognition_enum`（两布尔合并为 `image_recognize` 枚举）。
- 流水线：抽图 = 识别≠`NONE` 或向量化开；`describe-images` 仅识别=`LLM`；文本块阶段（`ocr-images`）触发 = `识别=OCR` 或（`识别=LLM` 且未向量化）—— 后者把描述落成文本块，开了向量化则描述由图片块承载；图片块仅向量化开（此时**保留**图片给 `chunkStage`）。
- 上传校验（服务层 `assertImageOptionsUsable`）：图片至少选一（400 `IMAGE_FILE_REQUIRES_MODE_HINT`）；向量化需多模态模型（409 `MULTIMODAL_MODEL_REQUIRED_HINT`）；识别=`LLM` 需已选描述模型（409 `IMAGE_DESCRIBE_MODEL_REQUIRED_HINT`）。

> ⚠️ 原 `IMAGE_MODE_LABELS`（"不处理图片 / 图片转文字（OCR） / 图片向量化（多模态，不转文字）"）已被 `IMAGE_RECOGNITION_LABELS`（"不识别图片 / 图片文字识别（本地 OCR） / 图片含义识别（大模型）"）+ `IMAGE_VECTORIZE_LABEL`（"图片向量化（多模态）"）取代 —— 旧的"不转文字"表述在启用含义识别后失真。

---

## 附：改动清单（实现时）

| 文件 | 改动 |
|----|----|
| `backend/src/config.ts` | `OCR_LANGS` 默认、新增 `OCR_PSM`/`OCR_TARGET_DPI`/`OCR_PREPROCESS`/`OCR_MULTIPASS`/`IMAGE_CAPTION_MIN_PX`/`IMAGE_OCR_MIN_PX`（描述模型改为知识库级，非 env） |
| `backend/src/pipeline/ocr.ts` | 预处理接入、`setParameters`（PSM/DPI/空格）、多语言策略 |
| `backend/src/pipeline/parse/pdf.ts` | 在 `encodePngRaw` 前对原始像素做预处理（扫描件路径） |
| `backend/src/pipeline/parse/image.ts` | 独立图片（PNG）预处理接入点 |
| `backend/src/pipeline/stages.ts` | 新增 `describe-images` 阶段（轨道二）；识别方式（NONE/OCR/LLM）+ 向量化开关驱动 `ocr-images`/图片块 |
| `backend/src/pipeline/chunk/index.ts` | 轨道三：多模态块 `content` 并入 OCR/描述文字 |
| `backend/src/llm/...` | 轨道二：调用 vision 模型生成描述 |
| `backend/src/pipeline/parse/index.ts` | §六·补：`.doc` 改为**按内容嗅探**（MHTML/HTML → HTML 抽文本；OLE2 → 另择解析器），不再一见 `.doc` 就拒 |
| `backend/scripts/` | OCR 回归基线脚本（§七）；caption 回归脚本（§五·补）；低清图判据样例（§十 6） |
