# 用章节结构和药品元数据驯服 AIFA 语料

**结论先行：** 对这批约 800 份 AIFA RCP/FI（395 个产品、100 个活性成分、约 1100 万 token），最稳妥的起点配置是：**Qwen3-Embedding-8B 截断到 2048 维、以 halfvec 存储做主嵌入**（voyage-4-large 2048 维做对照，text-embedding-3-small 只保留为回归基线）；**按 QRD 编号章节切块**，子块约 300 token 带确定性标题前缀，父块是完整的 4.x 子章节；**每个块都带产品、AIC、成分、规格、MAH、章节号元数据**，指名产品时做硬过滤，章节和文档类型只做软加权，同成分仿制药的重复段落在融合后折叠；**稠密腿 + 意大利语词法腿 + 精确实体腿用 RRF 融合**，再交给多语言重排器（先比较已接入的 Cohere Rerank 4 Pro 和 Voyage rerank-2.5，开源选项是 Qwen3-Reranker-4B）。微调排在最后：先做零成本的冻结基线；如果还差，先微调重排器，只有在第一阶段召回确实是瓶颈时才微调嵌入器。这个判断的根据是：公开文献里**没有任何一个大模型有意大利语医疗检索分数**，在这个语料上，最大的失败模式不是“段落找错”，而是“在近乎相同的仿制药之间文档找错”，而它主要靠元数据和去重解决，而不是靠换嵌入模型。≥95% 的答案准确率能不能做到，目前没有公开证据可以预测：唯一同类基准 PharmaQA.IT 即使把检索限制在正确的那一份 RCP 内，hit@10 也只有 0.615。所以下文的配置是一组要用评估来证实的假设，报告最后给出证实它的评估计划，包括题量的计算。

## 公开榜单把 Qwen3-Embedding-8B 推到首位，但意大利语医疗没有分数

在可用的多语言证据里，Qwen3-Embedding-8B 在每个公开榜单上都排在前列。Qwen3 技术报告的 MMTEB 表中，**8B 的均值是 70.58、检索是 70.88**，高于 Gemini Embedding（68.37 / 67.71）、multilingual-e5-large-instruct（63.22 / 57.12）、BGE-M3 稠密（59.56 / 54.60）和 OpenAI text-embedding-3-large（58.93 / 59.27）。它以 Apache 2.0 发布，支持 Matryoshka 截断（[Qwen3 Embedding report](https://arxiv.org/html/2506.05176v3)）。在包含医疗任务的 RTEB beta 上，一份 2026-11-23 的二手快照显示 **Qwen3-Embedding-8B 第 1（30/30 任务，平均 nDCG@10 0.6937）**，voyage-4-large 在 2048 维加进化提示时排第 2（只覆盖 16/30 任务），默认 1024 维排第 9；text-embedding-3-small 只排第 64，BGE-M3 第 62（[maximem.ai](https://www.maximem.ai/blog/best-embedding-models-2026)）。Voyage 自己的 RTEB 对比称 voyage-4-large 比 OpenAI v3-large 高 14.05%、比 Cohere Embed v4 高 8.20%，但这是厂商数据，也没有与 Qwen 对比（[Voyage AI blog](https://blog.voyageai.com/2026/01/15/voyage-4/)）。MTEB 多语言 v2 上微软的 harrier-oss-v1-27b 排第一（均值 0.7427），但它的许可证、意大利语表现和 27B 的部署成本都没核实，不宜作为首选（[maximem.ai](https://www.maximem.ai/blog/best-embedding-models-2026)）。

关键的空白必须说清：**没有任何来源给出 Qwen3、Voyage 4、Gemini 或 Cohere v5 的意大利语或意大利语医疗检索分数**，也没有 zh→it、en→it 的医疗检索基准。唯一专门针对意大利语的英意检索研究，在 Qwen3 和 Voyage 4 之前发布，结论是 Cohere embed-multilingual-v3.0 最好（意大利语 nDCG@10 0.86）（[Preprints.org 202502.2143](https://www.preprints.org/manuscript/202502.2143)）。意大利语生物医学编码器 BioBIT、MedBIT 是约 110M 的 MLM 模型，没做过对比式检索训练，不能把中英文查询映射到同一空间，可以直接排除（[MedBIT-r3-plus HF](https://huggingface.co/IVN-RIN/medBIT-r3-plus)）。所以选型逻辑是：主力用 Qwen3-8B，是因为它证据最强、最便宜，而且项目里已有 halfvec profile；对照用 voyage-4-large，是因为它是不同的模型家族（MoE、独立训练数据），比较才有信息量；最终谁胜出由自己的 AIFA 测试集决定。成本不是决定因素：嵌入全部语料，Qwen3-8B 在 OpenRouter 上约 $0.11–0.44（$0.01–0.04/MTok），voyage-4-large 约 $1.32，而且在 2 亿免费 token 之内（[OpenRouter Qwen3-Embedding-8B](https://openrouter.ai/qwen/qwen3-embedding-8b)；[OpenRouter voyage-4-large](https://openrouter.ai/voyageai/voyage-4-large)）。需要注意的是，OpenRouter 会把 Qwen3 路由到 Nebius、DeepInfra 等第三方；AIFA 文本本身是公开的，但多租户部署时要核对这些托管方的数据留存条款。

维度和存储格式几乎不影响质量。Qwen3-Embedding-8B 在 SciFact 上 **4096 维 0.784、2048 维 0.783、256 维 0.752**；1024 维没有直接数字，推测损失约 1–2 分（[AWS Neuron vLLM recipe](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/vllm-neuron/docs/model-recipes/qwen3-embedding-8b.html)）。pgvector 的 halfvec 与 float32 在 ef_search=40 时召回相同（0.945 对 0.945），只在 ef_search=10 时有约 1 个点的差距（[Supabase pgvector 0.7.0](https://supabase.com/blog/pgvector-0-7-0)）。在这个规模下，2048 维 halfvec 每个向量约 4 KB，几万个块合计只有一两百 MB，所以**默认 2048 halfvec、ef_search ≥ 40**，1024 维只作为延迟和成本的对照臂。

重排器方面，Qwen3 报告的 MMTEB-R 表里，**Qwen3-Reranker-4B/8B 为 72.74 / 72.94，bge-reranker-v2-m3 只有 58.36**，后者甚至低于它所重排的检索器本身（厂商自测，需谨慎）（[Qwen3 Embedding report](https://arxiv.org/html/2506.05176v3)）。jina-reranker v3/v3.5 是 CC-BY-NC，商用排除（[Jina v3.5 page](https://jina.ai/models/jina-reranker-v3.5/)）。API 路线里，Cohere Rerank 4 Pro 约 $2.50/千次搜索，已经接入为 `RAG_RERANKER=cohere`（[OpenRouter](https://openrouter.ai/cohere/rerank-4-pro)）；Voyage rerank-2.5 约 $0.05/MTok，按 50 个候选、每个约 500 token 估算，每千次查询约 $1.25（[Vercel](https://vercel.com/ai-gateway/models/rerank-2.5)）。还要注意，cohere-rerank-3.5 自 2026-08-01 起已被自动路由到 rerank-4-fast，分数分布会变，任何基于旧分数的拒答阈值都要重新校准（[Pinecone](https://docs.pinecone.io/models/cohere-rerank-3.5.md)）。目前没有任何重排器在意大利语或医疗领域的基准，也没有实测延迟数据。

## QRD 编号章节是现成的切块边界

关于切块，可靠的证据给出一个朴素的结论：**语义切块或 LLM 切块并不稳定地优于简单切块**，最优块大小因数据集而异，大多落在 256–1024 token 或“页/章节”这一级。Chroma 的测试中，400 token 无重叠的递归切分召回 89.5%，800/400 的 OpenAI 默认只有 85.4%，精度也最低（[Chroma](https://www.trychroma.com/research/evaluating-chunking)）。Vectara 在 NAACL 2025 的论文认为语义切块的收益通常不值它的计算成本（[arXiv 2410.13070](https://arxiv.org/html/2410.13070v1)），Passau 团队 2026 年的多目标研究也发现，昂贵的切块方法很少带来一致的收益（[arXiv 2608.16586](https://arxiv.org/abs/2608.16586)）。但对于标题结构很强的文档，基于元素/结构的切块在答案准确率上胜出：FinanceBench 上元素切块达到 **53.19%，固定 512 token 是 48.23%，128 token 只有 35.46%**，而且块数更少（[arXiv 2402.05131](https://arxiv.org/html/2402.05131v3)）。RCP 遵循 EMA QRD 模板，章节编号和标题固定（[EMA QRD template](https://www.ema.europa.eu/en/documents/template-form/qrd-product-information-annotated-template-english-version-103_en.pdf)），正是结构切块最有优势、又不需要付语义切块成本的情况。

唯一的意大利 RCP 基准 PharmaQA.IT（EACL 2026，861 个抽取式问答对）用的是 multilingual-e5-base 和固定 token 块，**hit@10 随块变大单调上升：64–16 为 0.436，128–32 为 0.511，256–64 为 0.580，512–128 为 0.615**；多数强模型的问答分数也随块变大而上升（Mistral-Small-24B 的 F1 从 0.417 升到 0.656）（[PharmaQA.IT PDF](https://aclanthology.org/2026.eacl-industry.70.pdf)）。这个结果有两层含义。第一，生成端需要足够大的上下文，支持“小块检索、大块返回”的父子设计。第二，它是**下限而不是上限**：检索只在包含答案的那一份 RCP 内进行，在 800 份文档的索引里难度只会更高；同时它没测过章节感知切块、更强的嵌入器、表格和 FI。

由此推出的设计如下。父块是一个完整的 QRD 子章节（例如整段 4.4），子块约 200–400 token；超过 600–800 token 的章节按段落再按句子递归切分，重叠 10–15%；很短的章节（如 4.7、6.1）只在同一父标题内合并，绝不跨 4.x 边界。每个子块在嵌入和建词法索引之前，都加一个**确定性标题前缀**，例如 `[Paracetamolo Krka 500 mg compresse | RCP | 4.2 Posologia e modo di somministrazione > Popolazione pediatrica]`。Anthropic 的 Contextual Retrieval 在前置 50–100 token 上下文后，top-20 检索失败率降低 35%，加上 BM25 降低 49%，再加重排降低 67%（[Anthropic](https://www.anthropic.com/news/contextual-retrieval)）。对高度模板化的 RCP，确定性前缀能以零成本拿到其中大部分收益（这是推断）；LLM 生成上下文作为后续可选项，全语料约 $12。late chunking 需要能暴露 token 级向量的长上下文嵌入器，与 API 托管的 Qwen3 不兼容，不考虑（[arXiv 2409.04701](https://arxiv.org/html/2409.04701v3)）。

表格（4.8 不良反应 SOC × 频率表、剂量表）的证据互相矛盾：3GPP 规范上，**带重复表头、用竖线分隔的行级块**最好（[arXiv 2408.17008](https://arxiv.org/pdf/2408.17008)）；而土耳其语研究中，Docling 的结构切块检索整张表，比固定长度切块高 17.0 分（[arXiv 2608.26192](https://arxiv.org/pdf/2608.26192)）。折中方案两者兼顾：整张表以 Markdown 形式作为父块返回，行级子块序列化为 `4.8 Effetti indesiderati | Patologie del sistema nervoso | Comune (≥1/100, <1/10) | cefalea, capogiro` 用于检索。仓库已有 `RAG_TABLE_HEADER_REPEAT` 和 `RAG_TABLE_ROW_SERIALIZATION` 两个开关（见 `src/lib/env.ts`），可以直接做成切块 profile 的变体。很多 AIFA 的 4.8 节其实是散文式列表而不是真表格，解析器两种形式都要处理。

解析工具方面，Docling 在 OpenDataLoader 基准上总分 0.882、表格保真度 0.887，领先 Marker 和 Unstructured（[opendataloader-bench](https://github.com/opendataloader-project/opendataloader-bench)），侧车里已经有 Docling 镜像（`RAG_PARSER=docling`）；pdfplumber 的 TEDS 表格结构得分 93.4%，可以作为表格兜底（[pdf-parser-benchmark](https://github.com/applied-artificial-intelligence/pdf-parser-benchmark)）。章节归属不要依赖 ML 版面模型的标题层级，而是用 **QRD 意大利语标题白名单加正则**（容忍“4.2.”/“4.2”、加粗标题、标题内换行），再按编号单调、1–11 节齐全做校验，不合格的文档标记人工复核。FI 用另一套白名单（编号 1–6 加无编号小标题）。还有一个必须做的清洗步骤：实测 AIFA RCP 每页都有页脚 “Documento reso disponibile da AIFA il dd/mm/yyyy” 和固定免责声明，斜向水印 “Agenzia Italiana del Farmaco” 在 pdftotext 输出里会碎成 “Fa”“rm”“aco” 插进正文（[AIFA stampati API](https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/1136/farmaci/590/stampati?ts=RCP)）。不清掉，它们会变成词法索引和向量里的高频噪声，还会把句子从中间截断。

## 元数据比嵌入模型更能区分 395 个产品

395 个产品只对应 100 个活性成分，意味着同一分子的大量仿制药 RCP 除了名称、MAH、辅料和 AIC 号以外几乎逐字相同。没有元数据控制时，像 “dose massima di amlodipina” 这样的查询会把 top-k 填满十份相同的 4.2 段落，答案还可能引用错误的厂家或规格。**没有任何已发表研究量化过药品说明书 RAG 里的近重复干扰**，所以以下设计是工程推断，要用评估验证；但同类基准的做法一致：FDARxBench 给每个章节块挂上章节标题、LOINC 章节码和药品级元数据（[arXiv 2603.19539](https://arxiv.org/html/2603.19539v1)），PlaceboBench 按产品对 SmPC 块分组（[PlaceboBench](https://huggingface.co/datasets/blue-guardrails/PlaceboBench/viewer/default/train)）。

元数据的主来源是 AIFA 开放数据 `confezioni_fornitura.csv`（CC BY 4.0，可商用但须署名）。它每行一个包装（9 位 AIC = 6 位 `COD_FARMACO` + 3 位 `COD_CONFEZIONE`），列有 `DENOMINAZIONE`、`DESCRIZIONE`（规格和剂型嵌在里面）、`CODICE_DITTA`/`RAGIONE_SOCIALE`、`TIPO_PROCEDURA`、`FORMA`（意大利语标准术语）、`CODICE_ATC`（5 级）、`PA_ASSOCIATI`（意大利语成分名，复方用 “/” 连接）、`FORNITURA`，以及直接的 `LINK_RCP`/`LINK_FI`。RCP/FI 按 `COD_FARMACO` 发布，不按包装（[AIFA confezioni_fornitura.csv](https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv)；[AIFA open data](https://www.aifa.gov.it/open-data)）。修订日期不在 CSV 里，要从 RCP 第 10 节 “Data di revisione del testo”（只有月和年）和页脚日期解析。可互换仿制药的等效组代码来自 Class A/H 清单（[AIFA Classe A CSV](https://www.aifa.gov.it/documents/20142/3815901/Classe_A_per_principio_attivo_31-05-2026.csv)）。

| 层级 | 字段 | 来源 | 用法 |
| --- | --- | --- | --- |
| 文档 | `cod_farmaco`、`aic_list[]`、`product_name`、`mah_name`、`codice_ditta` | CSV + RCP §8 | 硬过滤（指名产品/AIC 时），走 `RAG_EXACT_ID_LOOKUP` |
| 文档 | `ingredients_it[]`、`ingredients_inn_en[]`、`ingredients_zh[]`、`salt` | `PA_ASSOCIATI` + 人工整理的 100 成分对照表 | 指名成分时做数组重叠硬过滤；跨语言词法扩展 |
| 文档 | `atc5` 及派生 `atc1..atc4` | `CODICE_ATC` 前缀 | 药物类别查询的过滤或加权 |
| 文档 | `strengths[]`（规范化，如 `1mg_ml`）、`forms_it[]`、`routes[]` | `DESCRIZIONE` + RCP §1–2、§4.2 | 只做软加权（用户常把规格说错） |
| 文档 | `doc_type`（RCP/FI）、`procedure_type`、`supply_regime`、`equivalence_group` | CSV、Class A/H 清单 | `doc_type` 软加权（患者口吻偏 FI） |
| 文档 | `revision_date`、`published_by_aifa_date`、`file_hash` | RCP §10、页脚 | 版本与增量更新 |
| 块 | `qrd_section`（如 `4.8`）、`qrd_section_title`、`qrd_parent`、`page_start/end`、`chunk_index` | 章节解析器 | 章节软加权、父子扩展、引用定位 |
| 块 | 反规范化的 `product_name`、`ingredients_inn_en`、`strengths`、`atc5`；`dup_group_key`、`section_content_hash` | 上述字段 + 归一化文本哈希 | 单次 RPC 内过滤；仿制药重复折叠 |

过滤策略的关键是区分“置信度高的精确命中”和“可能说错的属性”。查询指名了某个品牌或 AIC 时，限定到对应的 `cod_farmaco`；只指名成分时，按 `ingredients_inn_en` 做数组重叠过滤，这是安全的，因为别的分子的说明书永远不会是答案。规格、剂型、MAH、章节和文档类型一律只做软加权（作为额外的 RRF 列表或乘性加分）。原因是硬过滤一旦落空，strict 模式会把一个有答案的问题错误地回答成“信息不可用”，直接计入准确率损失。章节路由用一个小的三语关键词表做软加权（“effetti collaterali/side effects/副作用”→ RCP 4.8 / FI §4，“gravidanza/怀孕”→ 4.6，“posologia/剂量”→ 4.2，“controindicazioni”→ 4.3，“interazioni”→ 4.5）。融合之后，对 `(dup_group_key, section_content_hash)` 相同的结果只保留最好的一条，引用里注明“相同文本也见于：……”。这样 top-k 留给不同章节的证据，而不是同一段的十份拷贝。仓库现有的 `content_hash_dedup` 是文档级的，章节级哈希折叠需要新增。

## 词法腿缺的是意大利语词干，而不是 Postgres 配置

研究笔记建议在 Postgres 里建 `italian` + `unaccent` 的自定义文本检索配置（[PostgreSQL unaccent](https://www.postgresql.org/docs/current/unaccent.html)），参照 Supabase 的 RRF 参考实现（k=50，每条腿可加权）（[Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search)）。但核对代码后，这条建议需要修正：myRAG 的词法腿刻意绕开 Postgres 文本解析器。`supabase/migrations/0401_lexical_index.sql` 用应用端生成的逐字 token 构建 tsvector，分词全在 `src/lib/rag/lexical/tokenize.ts` 里完成。这个分词器已经做了 NFKC 规范化、去重音、意大利语省略冠词剥离（l'、dell'）、意/英/中停用词、代码类 token 保留（ATC、AIC 原样和去分隔符两种形式），以及中文双字切分，**唯独没有意大利语词干还原**。所以正确的改法是在应用端分词器里加 Snowball 意大利语词干：把 `LEXICAL_VERSION` 升到 3，同时保留未词干化的表面形式，供药名、INN 精确匹配；再加剂量规范化 token（“2,5 mg”→`2_5mg`，“1 mg/ml”→`1mg_ml`，注意意大利语小数逗号），然后用 `npm run rag:relex` 重建。这样中文双字切分和代码 token 的既有契约都不受影响。Postgres FTS 没有 BM25 的 IDF，在高度重复的语料上，排序最终要靠重排器纠正。

混合检索在生物医学上的证据是正面但不一致的。BM25 候选经 MedCPT 交叉编码器重排，准确率 0.86，纯稠密是 0.83（[arXiv 2505.07917](https://arxiv.org/pdf/2505.07917)）；BioRAG 报告 BM25+稠密的 RRF 在上下文召回上比朴素稠密检索高 85%（[BioNLP 2026.10](https://aclanthology.org/2026.bionlp-1.10/)）；但一项 BioASQ 研究发现，稠密基线与最佳的混合策略只差 0.005（[arXiv 2605.02520](https://arxiv.org/abs/2605.02520)）。在这个语料上，词法腿的价值主要来自精确实体：品牌名、AIC、ATC 和剂量是稠密向量最容易混淆、而 token 匹配不会错的东西。所以 `RAG_LEXICAL_SEARCH=true` 应该开，但它在融合里的权重交给 `python -m rag_eval.sweep retrieval` 去定，不要手写。

跨语言问题有两半。稠密腿直接嵌入原始的中文或英文查询，不需要翻译：CLIR 研究表明，为跨语言训练的稠密检索器稳定优于词法匹配，文档翻译带来的收益很小（[arXiv 2511.19324](https://arxiv.org/html/2511.19324v1)）。但查询和文档语言不同时，检索质量会明显下降，强制翻译查询能拿回大部分损失（[arXiv 2507.07543](https://arxiv.org/pdf/2507.07543v2)），而查询翻译本身也可能翻错（[arXiv 2504.03616](https://arxiv.org/html/2504.03616v2)）。因此推荐的做法是：稠密腿用原始查询，词法腿用翻译成意大利语的查询（项目已有 `RAG_QUERY_LAYER` / `RAG_QUERY_TRANSLATE` 和 `RAG_LEXICAL_TRANSLATION`）。翻译时要求 LLM 把不良反应译成 RCP 4.8 用的规范医学术语（“cefalea”而不只是“mal di testa”），因为 AIFA 要求 4.3、4.4、4.8 使用 MedDRA 术语（[AIFA](https://www.aifa.gov.it/presentazione-traduzioni-rcp-fi-etichette)）。MedDRA 需要订阅，且不得再分发（[MedDRA](https://en.wikipedia.org/wiki/MedDRA)），所以不要把它放进仓库。100 个成分的意/英/中名称对照表和常见不良反应的俗语/术语对照，自建、并由药师审核，成本很低。中文药名没有找到许可证清晰的免费权威来源，这是一个必须人工补的缺口。语音路径对延迟敏感，跳过翻译，只跑稠密腿和精确实体 token。

## 微调排在重排器之后，并且要过一道门

在已经很强的通用嵌入器上，领域微调的收益很小。公开结果里，几千对合成数据带来的提升从 0 到约 +26 个点的 Recall@10 不等，大的提升都出现在弱基座遇到陌生领域时：gte-large 在 FinanceBench 上从 0.293 升到 0.552，而 e5-mistral-7b 在 DocsQA 上从 0.899 到 0.899，毫无变化（[Databricks](https://www.databricks.com/blog/improving-retrieval-and-rag-embedding-model-finetuning)）。另一项研究在 8 个 BEIR 语料上做了语料专属的合成查询训练，4 个上升、4 个下降（如 FEVER 从 86.3 降到 80.0），而且已经过监督训练的模型只用对比损失时**通常会变差**（[arXiv 2505.19274](https://arxiv.org/html/2505.19274v1)）。Qwen3-Embedding 本身已经用约 1.5 亿弱监督合成对和约 1900 万监督对训练过（[Qwen3 Embedding report](https://arxiv.org/html/2506.05176)）；唯一能找到的公开 Qwen3-0.6B LoRA 对比中，冻结的基座反而略胜（0.3538 对 0.3482）（[HF model card](https://huggingface.co/BCCard/MoAI-Embedding-0.6B)）。微调嵌入器还意味着全量重嵌和自托管，与目前 OpenRouter/DeepInfra 托管的 Qwen3-8B 冲突；Cohere 的微调服务已于 2025-09-15 停止（[Cohere deprecations](https://docs.cohere.com/docs/deprecations)）。

重排器微调的性价比明显更高，也不需要动 pgvector。Hugging Face 的指南里，ModernBERT-base 在约 9.9 万条查询（每条 5 个难负例）上训练 1 个 epoch，在单张 RTX 3090 上约 30 分钟，**重排 top-30 的得分从检索器的 59.12 提到 77.14，超过现成的 bge-reranker-large（73.20）**（[HF blog](https://huggingface.co/blog/train-reranker)）。因此推荐的顺序是：先测冻结的嵌入器加现成多语言重排器；如果不够，在 80% 训练成分上生成合成查询，微调一个开源重排器（Qwen3-Reranker-0.6B/4B），通过侧车接入；只有当过滤后第一阶段的 Recall@50 仍明显低于目标时，才考虑微调嵌入器（用 LoRA，加 MatryoshkaLoss，训练后与基座做 slerp 合并）。这个顺序是推断，没有任何来源在同一份数据上直接比较过重排器微调和嵌入器微调。

合成数据的做法有成熟的模式。每个段落让 LLM 用意/中/英三种语言**原生地**写多种类型的查询（事实问题、关键词、是/否、患者口吻、临床医生口吻），不要从意大利语翻译过去（[Qwen3 Embedding report](https://arxiv.org/html/2506.05176)）。然后做往返一致性过滤：源段落不在检索 top-20 就丢弃，交叉编码器不把它排第一也丢弃（[arXiv 2505.19274](https://arxiv.org/html/2505.19274v1)）。Gecko 的经验是，约 15% 的情况下源段落其实不是最佳答案（[arXiv 2403.20327](https://arxiv.org/abs/2403.20327)），这在仿制药语料里只会更多。像“Quali sono gli effetti collaterali?”这种泛泛的查询会匹配所有说明书，必须要求查询点名药物或具体细节。难负例从同一份 RCP 的其他章节和其他成分的同一章节里挖；**同成分仿制药的近同文本绝不能当负例**，要按成分和章节元数据屏蔽，或者用“正例感知”的分数阈值（如高于正例分数 60% 的候选不作为负例）过滤（[arXiv 2407.15831](https://arxiv.org/abs/2407.15831)）。按成分做 80/20 划分正好能检验泛化，但两个划分里共有的模板化套话段落要做精确去重，防止泄漏。

## 推荐配置与证实它的评估计划

下表是可以直接落到现有开关上的起始配置。标注“新增”的项目需要写代码，其余都是已有开关或命令。

| 组件 | 推荐值 | 对照臂 / 备注 |
| --- | --- | --- |
| 管线 | `RAG_PIPELINE=v2`，`RAG_INGEST_PIPELINE=unified`，`RAG_EMBEDDING_PROFILES=on` | legacy 保留作回退 |
| 解析 | `RAG_PARSER=docling` + QRD 标题白名单正则 + 页脚和水印清洗（新增） | pdfplumber 兜底表格 |
| 切块 profile A | 父块 = QRD 子章节；子块约 300 token，重叠 10–15%，带确定性标题前缀；`RAG_PARENT_CHILD=true` | profile B：章节上限 400–800 token 的单层块，不做父子 |
| 表格 | `RAG_TABLE_HEADER_REPEAT` + `RAG_TABLE_ROW_SERIALIZATION=true`，整表作父块 | 整表单块 |
| 嵌入 | Qwen3-Embedding-8B，2048 维 halfvec，ef_search ≥ 40 | Qwen3-8B 1024；voyage-4-large 2048/1024；text-embedding-3-small 1536 作为基线 |
| 词法 | `RAG_LEXICAL_SEARCH=true`；分词器加意大利语 Snowball 词干与剂量 token（新增，`LEXICAL_VERSION` 3 + `rag:relex`） | 不加词干的 v2 分词器 |
| 跨语言 | 稠密腿用原始查询；`RAG_QUERY_LAYER=true`、`RAG_QUERY_TRANSLATE=true`、`RAG_LEXICAL_TRANSLATION=true`；三语成分对照表（新增） | 不翻译 |
| 元数据 | 上表字段；`RAG_EXACT_ID_LOOKUP=true`；成分过滤；章节/文档类型软加权；章节级重复折叠（新增） | 无过滤 |
| 融合与重排 | RRF（k≈50–60，权重由 sweep 定）→ top-50 → `RAG_RERANKER=cohere`（Rerank 4 Pro）→ 返回约 20 个块 | `voyage` rerank-2.5；侧车 Qwen3-Reranker-4B；语音用 fast 档 |
| 拒答与引用 | strict 模式；`RAG_REFUSAL_THRESHOLD` 用 `python -m rag_eval.calibrate refusal` 在重排分数上校准；`RAG_CITATIONS=true` | 未校准的相似度下限 |
| 微调 | 起初不做；过门后先做重排器 | 嵌入器 LoRA 只作最后手段 |

评估计划要先回答一个统计问题：在 95% 附近，要把准确率估计到 ±2 个百分点（95% 置信区间），需要约 **1.96² × 0.95 × 0.05 / 0.02² ≈ 456** 道题。所以测试集（20% 成分）每种查询语言至少要有约 450–500 道经过审核的题。另外从 80% 训练成分里划出约 10 个成分作开发集，用于所有 sweep 和阈值校准；测试集只在最终确认时使用一次，否则 95% 的数字会被调参过拟合抬高。题目来源有三类。第一类是 PharmaQA.IT：它只覆盖 RCP，许可是研究用途，需确认允许内部评估，而且要筛出与本语料 `cod_farmaco` 重合的题（[PharmaQA.IT GitHub](https://github.com/KamyarZeinalipour/PharmaQA.IT)）。第二类是按上述流程生成、并由药师审核的合成题。第三类是专门的困难题型：指定规格或厂家的产品题、4.8 表格频率题、同成分多仿制药题、FI 患者口吻题，以及知识库里**没有答案**的题，用来测 strict 拒答。中文和英文题由人工原生编写或审校，不只是机器翻译，以测出真实的跨语言差距。

每个配置都在 `python -m rag_eval.sweep retrieval|chunking` 里按固定顺序做配对比较，一次只改一个维度。第一步固定当前生产配置（text-embedding-3-small、legacy）作为基线。然后依次是：嵌入器与维度（4–5 臂）、切块 profile A 与 B（用 `npm run rag:rechunk` 构建）、词法腿开关与词干、元数据过滤与重复折叠、重排器（Cohere、Voyage、Qwen3），最后是拒答阈值校准。检索指标分层报告：**正确文档命中率**（对的 `cod_farmaco`，这是仿制药问题的核心指标）、正确章节命中率、金标准片段的 Recall@10/@50、nDCG@10 和 MRR。答案层报告 LLM 评判的正确率（抽 10% 由人工复核，校准评判者）、引用有效率（`invalid_citation_rate` 应为 0）、可答题的误拒率和不可答题的拒答召回率，并对照 `eval/config/latency-budgets.json` 报告 p50/p95 延迟。跨语言的验收规则是：zh→it 和 en→it 的 Recall@10 与 it→it 的差距不超过一个事先固定的门槛（建议 3 个百分点），否则加强查询翻译或启用 `RAG_DOC_TRANSLATION` 的检索用块翻译。差异用配对 bootstrap 检验。只有当最佳冻结配置的开发集 Recall@50（过滤后）已经很高、而答案准确率仍低于 95% 时，才说明瓶颈在生成或重排，此时开启重排器微调；只有当 Recall@50 本身是瓶颈时，才考虑嵌入器微调。任何微调模型都必须在测试成分上显著胜过冻结基线，并且中英文查询不能退步，才能上线。

## 结论

这个问题表面上是在问“选哪个模型”，实际上答案落在模型之外。395 个产品挤在 100 个成分上，最难的不是语义理解，而是区分几乎相同的文本属于哪个产品、哪个规格。在这一点上，AIFA 免费提供的 CSV 和 QRD 的固定编号，比任何嵌入器的榜单名次都更有价值。项目的大部分开关已经就位，真正要新写的只有几处：章节解析与清洗、意大利语词干、三语成分对照表和章节级重复折叠。

第二个启示是，95% 这个目标现在既不能宣称可达，也不能宣称不可达。同类基准最好的端到端 F1 只有约 0.68，而且是在单文档检索这个更容易的设置下（[PharmaQA.IT PDF](https://aclanthology.org/2026.eacl-industry.70.pdf)）。所以最有价值的第一笔投入，是一套约 500 题 × 3 种语言、带不可答题、开发集与测试集严格分开的评估集。没有它，模型选型、切块和微调的每一个决定，都只能回到凭感觉调参。
