# myRAG RAG 全链路升级

## What This Is

myRAG 是一个基于 Next.js + Supabase 的 AI 聊天产品，核心是从用户自己的知识库里检索内容来回答问题（RAG），同时支持多模型、语音、WhatsApp、云盘同步和多模态生成。

这个项目把它的 RAG 流程从"纯向量检索 + 启发式加分"升级为六层都有成熟方案的流程：① 数据（解析与切块）② 查询（改写与分解）③ 召回（Embedding + 向量库/混合检索）④ 排序与上下文 ⑤ 生成（引用与防幻觉）⑥ 评估。每一步改动都要用评估数据证明有效。

## Core Value

用户问知识库里有答案的问题，能拿到正确、带准确引用的回答；问知识库里没有答案的问题，系统明确说不知道，不硬编。并且这两点都能用评估分数证明，而不是凭感觉。

## Requirements

### Validated

- ✓ 文档上传与解析：LlamaParse（Markdown 输出，遇到表格/图片自动切换模式），按段落或字符切块并带重叠 — existing
- ✓ Nango（Google Drive、Notion、Dropbox）和网页爬虫同步进知识库，按标题/段落语义切块，带日期和财务元数据 — existing
- ✓ 图片入库：GPT-4o 生成图片描述后向量化，检索到的图片以 `source_images` 显示在回答上方 — existing
- ✓ Supabase pgvector 向量检索（`text-embedding-3-small`，1536 维，HNSW），按 user_id / organization_id 做工作区隔离 — existing
- ✓ 按查询类型（日期、财务、精确数据）调整相似度阈值和加分，结果太少时降低阈值重试 — existing
- ✓ 四种 RAG 模式（strict / balanced / flexible / bypass）；strict 模式没有上下文时直接返回"信息不可用" — existing
- ✓ 开启 webSearch 时 strict 模式可以使用 Exa 网页搜索结果 — existing
- ✓ 回答按文档名标注来源，来源、网页搜索结果和 `source_images` 在流式输出和消息保存中保留 — existing
- ✓ 语音路径：结合对话历史改写查询，向量召回后用本地 BM25 混合重排 — existing
- ✓ 嵌入式聊天组件走同一套检索 — existing
- ✓ 单租户和多租户两种部署模式，Supabase RLS — existing
- ✓ Config UI（端口 3333）管理环境变量、模型列表和 RAG 提示词 — existing

### Active

**⑥ 评估（最先做，作为基线）**
- [ ] Python 侧车服务（与 `voice-agent/`、`baileys-whatsapp/` 并列的新子目录），带共享密钥鉴权
- [ ] golden set：50–200 条标准问答，覆盖中文、英文、意大利语，以及多轮指代、复合问题、精确词、表格、扫描件、库里没有答案的问题。由 Claude 按真实文档起草并加一部分 Ragas 生成的题，用户逐条审核
- [ ] DeepEval + Ragas 评估套件：召回 Recall@k、MRR；生成 Faithfulness、Answer Relevance、Context Recall；无答案问题的拒答率
- [ ] 跑出当前系统的评估基线，再按基线定各指标的提升目标
- [ ] CI（新增 `.github/workflows`）用 DeepEval 卡住质量回归；修好或删掉 `npm run test-rag`

**① 数据层**
- [ ] 上传文档时可逐个选择文档类型：财务/会计报表、合同/法律、发票/收据、产品/技术文档、扫描件/图片（默认类型由管理员在后台设定：整个租户一个默认值，可按来源分别设定，也可选“自动识别”；用户上传时可改）。类型决定该文档的解析、切块和元数据策略，并写进 chunk 元数据，检索时可按类型过滤
- [ ] Docling（在侧车里，用 HybridChunker 在每个切块里重复表头）作为 LlamaParse 之外的可切换解析器；LlamaParse 失败或未配置时自动退到 Docling
- [ ] 所有上传路径的 chunk 统一带元数据：来源、文档类型、文档日期、版本、内容 hash、页码或章节、语言
- [ ] 按内容 hash 去重；同一文档的新版本替换旧版本

**② 查询层**
- [ ] 文字聊天结合对话历史改写查询（LlamaIndex condense-question 的做法）
- [ ] 多查询改写 + 倒数排名融合（LlamaIndex `QueryFusionRetriever` 的做法）和 HyDE（LlamaIndex `HyDEQueryTransform` 的做法）
- [ ] 复合问题拆成子问题（LlamaIndex `SubQuestionQueryEngine` 的做法），只生成子问题，不让它合成答案
- [ ] 每项能力有开关和延迟预算；由路由按查询类型决定启用哪些；HyDE 默认关闭，语音路径不用 HyDE、多查询和分解
- [ ] 查询层有两套可切换实现，在 Config UI 里选择（`RAG_QUERY_FRAMEWORK=llamaindex|langchain`）：LlamaIndex 为首选和默认，在 TypeScript 里按 LlamaIndex 的算法和提示词实现；LangChain 为备选，用 `@langchain/classic`（history-aware retriever、MultiQueryRetriever、HyDE、RRF 融合、分解提示词），限制在一个适配器模块里，把我们自己的检索管道包装成 retriever，租户隔离和后端仍由 `src/lib/rag/` 负责。两套都在评估里对比。结构化输出用 Pydantic 定义的 schema（TS 端 Zod）

**③ 召回层**
- [ ] 可切换的 Embedding provider：Qwen3-Embedding-8B（第三方托管推理 API）和 Voyage-4-large；保留现有 OpenAI 模型可选
- [ ] 重新向量化脚本：分批、可断点续跑、可回滚（扩展 `scripts/rag/reprocess-documents.js`）
- [ ] 三个可切换的检索后端：pgvector（长期保留，默认）、Weaviate、Qdrant
- [ ] 三个后端都做混合检索（BM25/全文检索 + 向量，先过滤再检索），支持按日期范围、来源、文档、文档类型过滤
- [ ] Supabase 仍是文档、权限、租户的唯一数据源；向量从 Supabase 同步到 Weaviate/Qdrant（增、删、改、重新向量化都同步），检索按 user_id / organization_id 隔离，不能跨租户

**④ 排序与上下文层**
- [ ] 可切换 reranker：Cohere Rerank 5 和 Voyage rerank-3，接在混合检索之后
- [ ] 重排前多召回、重排后降低 Top-k（数字由评估决定）
- [ ] 最相关内容放在上下文开头或结尾；上下文压缩
- [ ] 用重排分数阈值决定是否拒答

**⑤ 生成层**
- [ ] 当前模型是 Claude 时，直连 Anthropic API 并启用 Citations，逐句标注引用的 chunk（新增 `ANTHROPIC_API_KEY`）
- [ ] 其他模型保留提示词引用，改为要求标注 chunk ID
- [ ] 所有模型的 RAG 回答做 HHEM 幻觉检测：HHEM-2.3 只有 Vectara 托管 API（侧车代理调用，需显式开启，因为回答和 chunk 会发给 Vectara）；它支持中文和英文，不支持意大利语，意大利语回答记为"未检测"；没有 Vectara key 时，英文回答用开源 HHEM-2.1-Open 在侧车本地跑。分数写进日志和消息元数据，前端用三态标记（已核实 / 可能不可靠 / 未检测）；这一期不拦截
- [ ] 非 Claude 路径用结构化输出给出引用列表；Claude 路径不能同时用 Citations 和结构化输出（会返回 HTTP 400），结构化输出只用在查询分解、文档类型识别等辅助调用上

**收尾**
- [ ] 全量回归评估，定稿默认配置（包括默认检索后端、Embedding、reranker）
- [ ] 所有新 provider 和开关可在 Config UI 配置；更新 `AGENTS.md` 和相关文档

### Out of Scope

- 每层第三名的方案（Reducto、DSPy、Gemini Embedding、Elasticsearch/OpenSearch、Qwen3-Reranker、Galileo Luna-2）— 用户只选每层前两名（Langfuse 后来被选为耗时追踪工具，见 Key Decisions）
- 下线 pgvector — 用户要求长期保留，与 Weaviate、Qdrant 并存
- 自己部署 GPU 跑 Qwen3-Embedding-8B — 用户选择第三方托管推理
- 根据 HHEM 分数拦截回答 — 这一期只记录和提示
- 所有 RAG 回答强制走 Claude — 只在当前模型是 Claude 时启用 Citations
- `.planning/codebase/CONCERNS.md` 里已有的安全问题（未鉴权的 admin/config 路由、Polar 签名校验、connector_config 的 RLS）— 单独处理；但本项目新加的接口必须从一开始就有鉴权

## Context

- **技术栈**：Next.js App Router + React 19 + TypeScript，Vercel AI SDK 6，OpenRouter 接多厂商模型；Supabase（PostgreSQL + pgvector HNSW、存储、认证）。详见 `.planning/codebase/STACK.md`。
- **现有检索代码**：主聊天路径 `src/app/api/chat/route.ts`（约 4500 行）只调用 `src/lib/enhanced-rag-retrieval.ts` 的 `enhancedRetrieveChunks`。`bm25-scorer.ts`、`adaptive-retrieval.ts`、`retrieval-strategies.ts`、`optimized-search.ts`、`query-enhancer-local.ts`、`reranker-local.ts` 已存在但主路径没用，`ARCHITECTURE.md` 把它们列为重复的检索模块。升级时要么复用，要么清理，不能再多一套并行实现。
- **检索入口有三处**：文字聊天、嵌入式聊天（`src/app/api/embed/chat/route.ts`）、语音（`src/app/api/internal/voice-rag/route.ts`）。新流程要统一到一个检索模块，三处共用。
- **入库路径有两条**：`src/app/api/process-document/route.ts`（聊天和 Config UI 上传）和 `src/lib/document-processor.ts`（Nango、爬虫、图片），元数据和切块策略不一致。
- **语言**：知识库是中文、英文、意大利语，用户可能跨语言提问。Embedding、reranker、HHEM 都要确认支持这三种语言。
- **没有测试和 CI**：根应用没有测试文件，仓库没有 `.github/workflows`。`next.config.js` 设了 `ignoreBuildErrors: true`。
- **子服务先例**：`voice-agent/`、`baileys-whatsapp/` 是独立部署的子目录服务，Python 侧车按同样方式组织和部署。
- **provider 切换先例**：项目已有 `USE_REPLICATE_PROVIDER`、`USE_FAL_PROVIDER` 这类 env 开关，新 provider 沿用这种写法。

## Constraints

- **配置同步**：新增的 `.env.local` 变量必须同步到 `scripts/init-env.js`、`src/lib/env.ts`、`scripts/config-server.js` 和 Config UI（`AGENTS.md` 规则）；模型列表五处同步规则照旧 — 否则配置会漂移
- **不能破坏现有行为**：strict 模式"信息不可用"、webSearch + Exa、`source_images`、`RAG_SYSTEM_PROMPT` 的 `{{context}}` 占位符、语音和嵌入式聊天路径 — 这些是已上线功能
- **多租户安全**：单租户和多租户都要支持，RLS 和租户隔离不能变弱；外部向量库必须按租户过滤 — 跨租户泄露是最严重的失败
- **可回退**：每个新组件都有开关，关掉回到当前行为 — 上线风险可控
- **证明有效**：每个阶段完成时都要和基线对比，任何一层指标明显变差就不算完成 — 防止凭感觉调参
- **延迟**：查询改写 + 检索 + 重排要有总延迟预算（研究阶段给出建议值）；语音路径预算更低，可以只启用部分步骤 — 语音对延迟敏感
- **密钥**：不提交任何密钥，测试和文档用占位值 — `AGENTS.md` 规则
- **Python 侧车**：Docling、HHEM、DeepEval、Ragas 放在 Python 侧车服务里，主应用通过 HTTP 调用 — 用户决定
- **标准输出格式用 Pydantic**：所有结构化输出都用 Pydantic v2（`pydantic>=2.14.4`，写进侧车的依赖文件）定义——侧车接口的请求和响应、golden set 条目、评估结果、LLM 结构化输出（查询分解、文档类型识别、改写、评估打分）。TypeScript 端用项目已有的 Zod 校验同一份结构，Zod schema 由 Pydantic 导出的 JSON Schema 生成，并在 CI 里检查两边一致 — 用户决定；两套手写 schema 会漂移
- **pgvector 维度**：换 Embedding 后若超过 2000 维，pgvector 的 `vector` HNSW 索引放不下，需要 `halfvec` 或降维

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 语义缓存：默认用 Supabase pgvector 表（RedisVL 风格的 check/store 接口），RedisVL SemanticCache 放侧车作为可选后端；不用 LangCache（预览期、价格未定、多一个厂商）、不用 LiteLLM/Bifrost（按整段 prompt 缓存，无法按租户失效）、不用 GPTCache（停更） | 用户要求选型（2026-11-23）；无新基础设施、适配 serverless、复用 TenantScope 和 RLS | — Pending |
| 耗时追踪用 Langfuse：每次请求一个 trace，每一步一个 span（耗时、候选数、改写规则）；异步发送、可采样、可关闭，默认遮蔽问题和 chunk 原文；Langfuse 不可用时退回结构化 `[RAG Trace]` 日志；先用 Langfuse Cloud Hobby 免费版（每月 5 万 unit，约 5000 次请求，超出靠采样），量大后改自部署，只换 `LANGFUSE_BASE_URL` 和密钥 | 用户决定（2026-11-23）；先测量再优化 | — Pending |
| 每层取排名前两名：功能互补的一起用，功能相同的做成可切换 provider | 用户要求；可切换便于用评估比较 | — Pending |
| pgvector、Weaviate、Qdrant 三个检索后端并存，pgvector 长期保留并作为默认 | 用户要求保留 pgvector；默认是否改由评估决定 | — Pending |
| Supabase 是文档、权限、租户的唯一数据源，向量同步到外部向量库 | 保住现有 RLS 和多租户模型 | — Pending |
| Docling、HHEM 代理、DeepEval、Ragas 放 Python 侧车服务 | 这些都是 Python 生态，主应用是 TS | — Pending |
| Qwen3-Embedding-8B 用第三方托管推理 | 不自己管 GPU | — Pending |
| Claude Citations 只在当前模型是 Claude 时启用，其他模型用 chunk ID 提示词引用，全部过 HHEM | 项目经 OpenRouter 支持多厂商模型 | — Pending |
| HHEM 这一期只记录和提示，不拦截 | 先观察分数分布再决定阈值 | — Pending |
| 上传时逐个选文档类型（可自动识别、可改），类型决定处理策略并写入元数据 | 用户要求在一个界面里选；不同类型需要不同解析和切块 | — Pending |
| golden set 由 Claude 按真实文档起草、用户审核，覆盖中英意三种语言 | 用户决定 | — Pending |
| 先跑基线再定具体指标目标 | 没有基线时定的数字没有依据 | — Pending |
| 查询层 LlamaIndex 为首选（默认），LangChain 为备选，在 Config UI 里切换；LlamaIndex 按其算法在 TS 里实现，LangChain 用 `@langchain/classic` 适配器 | 用户偏好 LlamaIndex，同时要保留 LangChain 作为可选；LlamaIndex.TS 没有 QueryFusionRetriever 和 HyDE，SubQuestionQueryEngine 会自己合成答案，和 Citations 冲突；`@langchain/core` 需要 zod 4，必须和应用的 zod 3 隔离 | — Pending |
| HHEM-2.3 走 Vectara 托管 API（需显式开启），意大利语记"未检测"，无 key 时英文用 HHEM-2.1-Open | HHEM-2.3 没有开源权重且不支持意大利语 | — Pending |
| Pydantic v2 作为所有结构化输出的标准格式，TS 端 Zod schema 由其 JSON Schema 生成 | 用户要求；单一数据源避免两端 schema 漂移 | — Pending |
| 评估先行：第一阶段只建评估和基线 | 之后每个改动都要能证明有效 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-22 after initialization*
