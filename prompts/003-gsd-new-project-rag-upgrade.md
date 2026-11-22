# myRAG RAG 全链路升级：补齐六层缺失能力

这是一个已有代码库（brownfield）的项目。先读 `.planning/codebase/` 里的 7 份代码地图和 `AGENTS.md`，再开始提问和规划。

## 目标

把 myRAG 的 RAG 流程从"纯向量检索 + 启发式加分"升级为六层都有成熟方案的流程，并且每一步改动都能用评估数据证明有效。

六层是：① 数据层（解析与切块）② 查询层（改写与分解）③ 召回层（Embedding + 向量库/混合检索）④ 排序与上下文层 ⑤ 生成层（引用与防幻觉）⑥ 评估层。

## 现状（已在代码里核实）

主聊天路径是 `src/app/api/chat/route.ts`，它只调用 `enhancedRetrieveChunks`（`src/lib/enhanced-rag-retrieval.ts`）。

- **① 数据层**
  - 聊天上传走 LlamaParse（`src/app/api/process-document/route.ts`），输出 Markdown，遇到表格或图片自动切换解析模式。切块默认 768 字符、重叠 416。
  - Nango 和爬虫来源走 `src/lib/document-processor.ts` + `src/lib/semantic-chunker.ts`，按标题和段落切块。
  - 每个 chunk 前面加了 `Document: <文件名>. Chunk N of M.` 前缀。
  - 缺失：没有版本和去重（没有内容 hash、没有版本字段）。主上传路径的 chunk 没有日期、来源类型等元数据；`temporal-metadata-extractor` 只在 Nango/爬虫路径上用。
- **② 查询层**
  - 文字聊天直接用最后一条用户消息原文去检索，没有结合对话历史改写，没有查询分解，没有 HyDE。
  - 只有语音路径做了结合历史的改写（`voice-agent/src/voice_agent.ts`）。
  - `src/lib/query-enhancer-local.ts` 和 `src/lib/thinking-rag-enhancer.ts` 里的 `enhanceQueryWithReasoning` 已存在，但没被调用。
- **③ 召回层**
  - 只用 Supabase pgvector 余弦检索（`match_documents_by_workspace`、`match_document_chunks`），Embedding 是 `text-embedding-3-small`（1536 维）。
  - SQL 里只按租户/工作区过滤，日期只是加分不是过滤。
  - BM25（`src/lib/bm25-scorer.ts`）、混合检索（`src/lib/adaptive-retrieval.ts`、`src/lib/retrieval-strategies.ts`）、关键词 SQL 函数 `search_chunks_by_keywords` 都写了但主路径没用。
- **④ 排序与上下文层**
  - 用启发式加分排序（日期 +0.2/+0.1，财务 +0.15），Top-k 最多 25（`RAG_FINAL_RESULT_COUNT`），相似度 > 0.65 才放进上下文。
  - 没有 reranker。`src/lib/reranker-local.ts` 的 BM25 重排只在语音路径用。
  - 没有上下文压缩，没有把最相关内容放在开头或结尾。
- **⑤ 生成层**
  - `src/lib/rag-mode.ts` 有 strict / balanced / flexible / bypass 四种模式。strict 模式下没有上下文就直接返回"信息不可用"。
  - 提示词要求按文档名引用（`**Source:** [文档名]`），不是按 chunk ID。
  - 没有幻觉检测，没有结构化输出。
- **⑥ 评估层**
  - 完全没有：没有标准答案集，没有 Recall@k、Faithfulness 等指标，没有 CI。
  - `npm run test-rag` 指向的 `scripts/test-rag-system.js` 不存在。

## 每层采用的方案（已定，不要换）

规则：每层取排名前两名。功能互补的两个一起用；功能相同的两个做成可切换的 provider，用 env 选择。切换写法沿用项目现有的 `USE_*_PROVIDER` 模式。

### ① 数据层：LlamaParse + Docling
- LlamaParse 保留为默认解析器。
- 新增 Docling：放在 Python 侧车服务里，使用 HybridChunker（每个切块里重复表头）。
- 两者用 env 切换。LlamaParse 失败或没配置 key 时，自动退到 Docling。
- 同时补上技术缺口：
  - 每个 chunk 带元数据：来源、文档日期、版本、内容 hash、页码或章节。
  - 按内容 hash 去重。
  - 同一文档的新版本替换旧版本，不能新旧混在一起。
  - 所有上传路径用同一套元数据。

### ② 查询层：LlamaIndex + LangChain
- 用 LangChain 的能力：
  - 结合对话历史改写查询（`create_history_aware_retriever` 的做法）。
  - 多查询改写（`MultiQueryRetriever`）。
  - HyDE。
- 用 LlamaIndex 的能力：
  - 子问题分解（`SubQuestionQueryEngine`）。
  - 多路查询结果融合（`QueryFusionRetriever` 的倒数排名融合）。
- 优先用 TypeScript 版本（LangChain.js、LlamaIndex.TS），放在主应用里。某个能力在 TS 版本里没有时，研究阶段决定是放进 Python 侧车，还是在 TS 里按同样算法实现，并记录理由。
- 每项能力都要有开关，并且有延迟预算（见下方约束）。

### ③A Embedding：Qwen3-Embedding-8B + Voyage-4-large
- 两者做成可切换的 provider。
- Qwen3 通过第三方托管推理 API 调用，不自己管 GPU。
- 提供重新向量化脚本：可分批、可断点续跑、可回滚。扩展现有的 `scripts/rag/reprocess-documents.js`。
- 研究阶段确认两者的向量维度、输入长度上限和计费。

### ③B 向量库与混合检索：Weaviate + Qdrant
- 两者做成可切换的检索后端。
- Supabase 仍然是文档、权限和租户的唯一数据源。向量从 Supabase 同步过去，增、删、改、重新向量化都要同步。
- 检索时必须按 `user_id` / `organization_id` 过滤，和现在 `match_documents_by_workspace` 的隔离规则完全一致。不能出现跨租户结果。
- 用各自原生的混合检索：BM25 + 向量，先过滤再检索。还要支持元数据过滤：日期范围、来源、文档。
- 切换期间保留现有 pgvector 路径作为回退，直到评估证明新后端不比它差，再下线。

### ④ 排序层：Cohere Rerank 5 + Voyage rerank-3
- 两者做成可切换的 reranker，接在混合检索之后。
- 补上技术缺口：
  - 重排前召回更多候选，重排后降低 Top-k。具体数字由评估决定，不要拍脑袋。
  - 最相关的内容放在上下文开头或结尾。
  - 上下文压缩。
  - 用重排分数阈值决定是否拒答。

### ⑤ 生成层：Anthropic Claude Citations + Vectara HHEM-2.3
- 当前聊天模型是 Claude 时，直接调用 Anthropic API 并启用 Citations：把检索到的 chunk 作为文档传入，回答逐句标注引用的 chunk。
  - 项目现在只通过 OpenRouter 调 Claude，所以要新增直连 Anthropic 的路径和 `ANTHROPIC_API_KEY`。
- 其他模型保留提示词引用，但改成要求标注 chunk ID。
- 所有模型的 RAG 回答都过 HHEM 幻觉检测（在 Python 侧车里跑）。分数写进日志和消息元数据，前端可以显示"可能不可靠"提示。这一期不拦截回答。
- 能用结构化输出的地方用结构化输出控制格式，例如引用列表。

### ⑥ 评估层：DeepEval + Ragas
- 放在 Python 侧车服务目录里，作为测试套件。
- 先建 50–200 条标准问答（golden set）：人工写的为主，Ragas 自动生成的为辅。覆盖知识库里实际出现的语言、多轮指代、复合问题、精确词（型号、ID、人名）、表格、库里没有答案的问题。
- 分层指标：
  - 召回：Recall@k、MRR。
  - 生成：Faithfulness、Answer Relevance、Context Recall。
  - 拒答：没有答案的问题，拒答率要达标。
- 新增 CI（仓库目前没有 `.github/workflows`），用 DeepEval 卡住质量回归。
- 修好或删掉 `npm run test-rag`。

## Python 侧车服务

新建一个子目录，和现有的 `voice-agent/`、`baileys-whatsapp/` 并列。用 FastAPI 或同类框架，提供 Docling 解析和 HHEM 检测接口，并带 DeepEval + Ragas 评估套件。

主应用通过 HTTP 调用它，鉴权用共享密钥。部署方式参照现有子服务的文档写法。

## 必须遵守的约束

- **`AGENTS.md` 的规则**
  - 新增 `.env.local` 变量都要同步到 `scripts/init-env.js`、`src/lib/env.ts`、`scripts/config-server.js`，以及 Config UI。所有新 provider 和开关都要能在 Config UI 里配置。
  - 模型列表的五处同步规则照旧。
  - 不提交任何密钥。
- **不能破坏的现有行为**
  - strict 模式没有上下文时返回"信息不可用"。
  - `webSearch` 开启时可以用 Exa 结果。
  - `source_images` 图片检索和显示。
  - `RAG_SYSTEM_PROMPT` 的 `{{context}}` 占位符。
  - 语音路径的检索（`src/app/api/internal/voice-rag/route.ts`）。
  - 嵌入式聊天（`src/app/api/embed/chat/route.ts`）也要用同一条新流程。
- **多租户**：单租户和多租户两种部署模式都要支持，RLS 和租户隔离不能变弱。
- **延迟**：查询改写 + 检索 + 重排的总延迟要有预算，研究阶段给出建议值。语音路径要求更低，可以只启用部分步骤。
- **可回退**：每个新组件都有开关，关掉后回到当前行为。
- **证明有效**：先跑出当前系统的评估基线。之后每个阶段完成时都要和基线对比，任何一层指标明显变差，该阶段就不算完成。

## 建议的阶段顺序

1. 评估基线：Python 侧车骨架 + golden set + DeepEval/Ragas，跑出当前系统的分数。
2. 数据层：Docling、元数据、去重和版本管理。
3. 召回层：Embedding provider + Weaviate/Qdrant 混合检索 + 同步 + 重新向量化。
4. 排序与上下文层：reranker、Top-k、上下文顺序、压缩。
5. 查询层：历史改写、多查询、HyDE、子问题分解、结果融合。
6. 生成层：Claude Citations、chunk ID 引用、HHEM、结构化输出。
7. 收尾：全量回归评估、默认配置定稿、pgvector 路径下线决策、文档更新。

## 不在本项目范围内

- 每层第三名的方案：Reducto、DSPy、Gemini Embedding、Elasticsearch/OpenSearch、Qwen3-Reranker、Galileo Luna-2、Langfuse。
- `.planning/codebase/CONCERNS.md` 里的安全问题（如未鉴权的 admin 和 config 路由）单独处理，不混进这个项目。但新加的接口（侧车服务、同步、评估）必须从一开始就有鉴权。

## 研究阶段需要先核实的事

- 各产品的当前版本、价格和可用性：Cohere Rerank 5、Voyage-4-large、Voyage rerank-3、Vectara HHEM-2.3、提供 Qwen3-Embedding-8B 的托管推理服务。
- LangChain.js 和 LlamaIndex.TS 是否有上面列出的每一项能力。
- Weaviate 和 Qdrant 的托管方式（云服务还是自托管），以及各自混合检索的融合方法。
- Anthropic Citations 和项目里 Vercel AI SDK 6 的兼容方式。
