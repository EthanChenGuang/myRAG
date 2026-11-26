# 意大利语单语医疗 RAG：推荐配置重新评估

调研日期：2026-11-26。范围变化：只支持意大利语提问 + 意大利语文档（约 790 份 AIFA RCP/FI，395 个产品，100 个成分，约 1100 万 token），不再需要中文/英文跨语言检索。
本文是对《意大利语医疗RAG最佳方案.md》的补充，不重复其中仍然成立的部分（QRD 章节切块、父子块、元数据过滤、仿制药去重、先微调重排器）。

每条结论都标了 **[证据]**（有公开数字）或 **[推断]**（我的判断，需要自己的评估证实）。

---

## 结论（先看这里）

1. **Qwen3-Embedding-8B 继续做主力，但地位从"明显首选"降为"待挑战的现任"。** 原来选它的两个理由里，"跨语言"这一条已经不存在；剩下的理由是：它在意大利语通用检索上确实在第一梯队 [证据]，便宜，已经接好。但在意大利语上它比 0.4B 级小模型只高约 1 分，比 BGE-M3 高约 5 分 [证据]，而且这些都是通用领域分数，没有任何意大利语医疗检索的公开对比 [证据：没找到]。
2. **不加"未微调的 BioBIT/MedBIT"评估臂。** 只做过 MLM 的编码器直接拿来检索，分数接近随机 [证据，英语]。这一臂的结果事先就能确定，不值得花时间。
3. **"微调后的 BioBIT/MedBIT 双塔"可以作为一个评估臂，但排在最后，并且要过门。** 没有任何公开结果显示它能赢强通用嵌入器 [证据：没找到]。其他语言的证据说明：收益来自"领域内对比训练数据"，不是来自"领域 MLM 预训练" [证据]。所以真要做，必须同时用同一份数据微调一个通用小模型（multilingual-e5-base 或 BGE-M3）做对照，否则分不清功劳是谁的。
4. **单语之后最该加强的是词法腿，不是换嵌入器。** 带意大利语分析器的 BM25 在意大利语长文档检索上赢了所有稠密模型 [证据]。现在查询和文档同语言，词法腿不再依赖翻译，价值上升。
5. **最早、最便宜的实验**：用开发集的约 100 道意大利语题，在内存里（不进 Supabase）跑 4 个冻结检索器——意大利语词干 BM25、text-embedding-3-small、Qwen3-8B、一个本地小模型（BGE-M3）——比较"正确文档命中率"和 Recall@10/@50。成本不到 1 美元，半天能做完，它直接决定后面的臂要不要做。
6. **新发现的硬约束：Supabase 免费版 500 MB 放不下 Qwen3 2048 维 halfvec 加索引，更放不下两个 profile 同时在线** [推断，需实测]。线上应该用 1024 维 halfvec；多臂对比放到离线做。

---

## 1. 意大利语稠密检索：公开评估有什么

### 找到的 [证据]

**(a) 最有用的一份：Dadas 等，arXiv 2609.12913（2026-09），7 个意大利语检索任务的 nDCG@10 平均值。**
任务：Belebele-ita、MKQA/MFAQ-it、WebFAQ-ita、Wikipedia 多语检索-it、MLDR-it、SQuAD-it、WikipediaQA-ita。全部是通用领域，没有医疗。

| 模型 | 参数量 | 意大利语 nDCG@10 |
| --- | --- | --- |
| BGE-Multilingual-Gemma2 | 约 9B | 74.54 |
| Inf-Retriever-v1 | 约 7B | 74.36 |
| Pplx-Embed-v1-4b | 4B | 73.11 |
| **Qwen3-Embedding-8B** | 8B | **72.59** |
| Qwen3-Embedding-4B | 4B | 72.05 |
| EuroDense-435M（论文作者自己的模型） | 0.4B | 71.43 |
| Voyage-4-Nano | — | 70.49 |
| BGE-M3（稠密） | 0.57B | 67.98 |
| Multilingual-E5-Large | 0.56B | 66.72 |
| Qwen3-Embedding-0.6B | 0.6B | 63.98 |

同一论文的"意大利语专用模型"表（表 12）：Multilingual-E5-Large-ita 平均 62.99，其余基于意大利语 BERT 的模型（nickprock 的 sentence-bert-base-italian-xxl、mmarco-bert-base-italian、BERTino 系列、意大利语 SPLADE）平均只有 **26.8–54.8**。也就是说，现有的意大利语专用小模型在通用检索上明显弱于多语言大模型。注意：EuroDense 的数字是作者自测；OpenAI 和 Voyage-4-large 不在表里。

**(b) MTEB 分语言审计（AACL 2026 short 28）。** 只有两个意大利语任务（Belebele、Wikipedia），而且已经接近饱和：Qwen3-8B 96.0、Qwen3-4B 93.9、mE5-large 93.8、BGE-M3 91.9、Qwen3-0.6B 91.1。论文的主要发现对我们有用：MTEB 多语言总分和单语言排名经常不一致（中位"成对颠倒率"33%），有的模型总分高但在意大利语上崩溃（nemotron-8b 意大利语只有 37.6）。**所以不能拿多语言总榜替意大利语做决定。**

**(c) ItColBERT 论文（arXiv 2609.26856），4 个意大利语基准，含 BM25。**

| 模型 | MLDR-it nDCG@10 | mMARCO-it MRR@10 | MIRACL-ita | SQuAD-ita |
| --- | --- | --- | --- | --- |
| BM25（意大利语分析器） | **0.485** | 0.572 | 0.552 | 0.826 |
| BGE-M3 稠密 | 0.453 | 0.781 | 0.757 | 0.825 |
| multilingual-e5-large | 0.431 | 0.824 | 0.765 | 0.851 |
| ItColBERT（135M，后期交互） | 0.401 | 0.720 | 0.719 | 0.903 |
| Italian ModernBERT + MNRL（135M 稠密） | 0.302 | 0.508 | 0.542 | 0.558 |

要点：在长文档（MLDR-it）上 BM25 赢了所有稠密模型；在短问答上稠密模型明显更好。没有 Qwen3。

**(d) 其他较弱的证据。**
- CLiC-it 2024（Noviello & Tamburini）：MIRACL-it 上 mE5-large nDCG@10 74.7–76.2，多语言 MiniLM/mpnet 类只有 47–58；在意大利语数据上微调的 Minerva-1B 嵌入器（60.7–64.0）不如 mE5。
- ESG 英意基准（arXiv 2609.15434，312 条意大利语、每条只有 3 个候选文档）：分数全部饱和（0.92–0.97），text-embedding-3-large 0.9745、Qwen3-0.6B 0.9717、Qwen3-4B 0.9704、BGE-M3 0.9634、text-embedding-3-small 0.9611。区分度太低，只能说明"都不差"。
- Cirillo 等（arXiv 2605.23618）：合成意大利语 RAG 语料上，mE5-large 与 Google Embeddings 2 只差 0.003 nDCG；mE5-large 在普通 CPU 上查询延迟约 31 ms。
- PharmaQA.IT（唯一的意大利语 RCP 基准）：检索只用了 multilingual-e5-base 一个模型，没有比较任何嵌入器，也没用 BioBIT/MedBIT。

### 没找到的 [证据：空白]

- 任何把 Qwen3、mE5、BGE-M3、意大利语 sentence-transformers、BioBIT/MedBIT 放在一起的**意大利语医疗**检索评估。
- BioBIT/MedBIT 做检索的任何分数。Hugging Face 上没有基于它们的 sentence-transformers 检索模型（搜索 biobit/medbit 的句向量模型结果为空或无关）。
- Voyage-4-large、Cohere、Gemini 的意大利语检索独立分数。

### 许可证

| 模型 | 许可证 | 备注 |
| --- | --- | --- |
| Qwen3-Embedding / Reranker | Apache 2.0 | 可商用 |
| multilingual-e5-*、BGE-M3 | MIT | 可商用，可本地跑 |
| EuroDense-435M（OPI-PIB） | Gemma 许可 | 有使用条款，商用前要读条款 |
| nickprock/mmarco-bert-base-italian-uncased | MIT | 训练数据是 mMARCO（MS MARCO 原始条款为非商业研究） |
| albertobarnabo/bge-m3-italian、bge-reranker-v2-m3-italian | MIT / Apache 2.0 | 同上，训练数据来自 mMARCO |
| ItColBERT | Apache 2.0 | |
| **IVN-RIN BioBIT / MedBIT / MedBIT-r3-plus** | **模型卡没有声明许可证** | 商用前必须问作者；这本身是一个风险 |
| PharmaQA.IT 数据集 | HF 卡片没写明许可证，访问需申请 | 用前确认 |

---

## 2. 意大利语生物医学 BERT 能不能当检索器

**不微调：不行。[证据，英语]** MedTEB 基准（arXiv 2507.19407）里，没做过对比训练的领域模型检索 nDCG@10 是：Bio-ClinicalBERT 0.05、ClinicalBERT 0.06、BlueBERT 0.07、BiomedBERT 0.13；做过对比训练的通用模型是 0.33–0.41（E5-base 0.33、BGE-base 0.38、GTE-base 0.41）。BioBIT/MedBIT 同样只做过 MLM+NSP，下游评估只有 NER、抽取式问答、关系抽取。可以确定它们直接做检索会同样差。

**微调后：没有直接证据，间接证据指向"能明显变好，但功劳主要在对比训练数据"。**

- [证据] MedTEB 里最好的医疗模型 MedTE（0.45）是从**通用**模型 GTE-base 出发、用约 200 万医疗文本对做对比训练得到的，不是从生物医学 BERT 出发。
- [证据] JMIR Med Inform 2026（e99639）用匹配对照得出：领域编码器与检索模型之间的差距，更可能来自训练目标（是否做过检索训练），而不是训练领域；同组另一篇（e94241）里 BioBERT、ClinicalBERT 做临床检索不如通用嵌入。作者自己说明这是相关性，不是因果。
- [证据] 德语临床（JMIR 2026，e82997）：在 40 万份医院文档生成的约 1100 万合成问答对上微调 multilingual-e5-large，mAP@100 从 0.14 升到 0.27（BGE-M3 为 0.11）。说明**领域内合成数据微调对通用多语言模型很有效**。数据量是我们的几十倍。
- [证据] 法语法律（COLING 2025，arXiv 2409.01357）：零样本时 BM25 最强（R@10 0.367），BGE-M3 稠密 0.325；用 1500 条领域内问题微调一个 CamemBERT 级的单向量模型后达到 0.558。但论文没有在同样数据上微调 BGE-M3/mE5，所以**不能证明"小的单语模型微调后赢过大的多语言模型微调后"**。同一论文还发现：模型在领域内微调后，再和 BM25 融合大多反而变差（约 70% 的组合低于其中一方）。
- [证据] 意大利语：把意大利语 BERT/ModernBERT 用 mMARCO-it 做 MNRL 训练得到的模型（nickprock 系列），在通用任务上远低于 mE5/BGE-M3（见上表：0.30–0.56 对 0.43–0.85）。说明"意大利语小模型 + 机器翻译的 MS MARCO"这条路本身不足以追上多语言大模型。
- [证据，上一份报告已有] 在已经很强的嵌入器上再做合成数据微调，收益从 0 到很大不等，强基座常常没有提升。

**[推断]** 把这些合起来：
- 微调 MedBIT 很可能比未微调的通用小模型在我们的语料上好，因为它见过领域内数据。
- 但它是否能赢冻结的 Qwen3-8B，没有证据；它是否能赢"同样数据微调的 mE5-base/BGE-M3"，现有证据偏向不能（通用检索预训练带来的排序能力，110M 的 MLM 模型要从约 4 万条合成对里从头学）。
- 领域 MLM 预训练可能的真实好处是分词：MedBIT 的词表见过更多医学词，药名和医学术语被切得不那么碎。这一点没有检索上的数字，只是合理猜测。

**512 token 上限**：对约 300 token 的子块加标题前缀够用（BERT 分词对药名会切得更碎，按 1.2–1.4 倍估算仍在 512 内）。父块和整张表不做嵌入，不受影响。超过 512 的会被静默截断，入库时要统计截断比例。[推断]

---

## 3. 其他只做意大利语时值得考虑的选项

| 选项 | 现状 | 建议 |
| --- | --- | --- |
| **BM25 + 意大利语词干** | [证据] MLDR-it 上赢所有稠密模型；法语法律零样本也是 BM25 最强。AACL 审计提到，意大利语分词不做大小写折叠时 BM25 分数会崩到 2.1，分词细节很关键。 | **升级为必测的独立臂**，不只是融合里的一条腿。项目的词法腿用的是 Postgres `ts_rank`，没有 IDF；离线评估里同时跑一个真正的 BM25，看差多少。 |
| 学习型稀疏（SPLADE-it） | 有 nickprock/splade-bert-base-italian-xxl-uncased-cv；[证据] 意大利语 BERT 系模型在 Dadas 表 12 里整体很弱。BGE-M3-italian 的稀疏腿在短段落上 0.45–0.47，远低于稠密 0.75–0.78（作者自测）。 | 不做。Postgres 里也没有现成的稀疏倒排支持。 |
| ColBERT（ItColBERT 135M、mLateOn、jina-colbert-v2） | [证据] ItColBERT 在 mMARCO-it、MIRACL-ita 上输给 BGE-M3 和 mE5-large，只在 SQuAD-ita 上赢；mLateOn 更强但 307M。 | 不做第一阶段。pgvector 不支持多向量检索，接入成本高。 |
| 本地小稠密模型（BGE-M3、mE5-large、EuroDense-435M） | [证据] 意大利语通用任务比 Qwen3-8B 低 1–6 分；可在侧车 CPU 上跑（mE5-large 查询约 31 ms）。 | **加一个本地臂（BGE-M3，MIT）**。它同时是将来微调的基座候选。EuroDense 分数更高但要先看 Gemma 许可。 |
| 意大利语重排器 | [证据] bge-reranker-v2-m3-italian 比原版只高 0.0096 nDCG@10（mMARCO-it，作者自测）。其他意大利语交叉编码器（osiria MiniLM、nickprock STS）没有检索评估。 | 不单独设臂。继续比较 Cohere Rerank 4 Pro、Voyage rerank-2.5、Qwen3-Reranker；想要免费本地臂就用 bge-reranker-v2-m3。意大利语专用重排器没有显示出值得的收益。 |
| 生成/评判用的意大利语 LLM | [证据] PharmaQA.IT（512–128 块）：Minerva-7B F1 0.033、EuroLLM-9B 0.020；DeepSeek-Chat 0.679、Mistral-Small-24B 0.656、GPT-4.1 0.636、Llama-3.1-8B 0.618。Velvet、LLaMAntino 在这类任务上没找到数字。 | 生成和评判都用前沿通用模型，不用意大利语专用 LLM。评判模型和生成模型用不同家族，并保留 10% 人工复核。 |

---

## 4. 配置和评估计划因"只做意大利语"而变的地方

### 可以去掉

| 项 | 原方案 | 现在 |
| --- | --- | --- |
| 查询翻译 | `RAG_QUERY_TRANSLATE=true`、`RAG_LEXICAL_TRANSLATION=true` | 关闭（保持默认 false）。少一次 LLM 调用，延迟和成本都降。[推断：省几百毫秒] |
| 文档翻译兜底 | `RAG_DOC_TRANSLATION` 作为跨语言差距过大时的补救 | 不需要 |
| 三语成分对照表 | 意/英/中 | 只要意大利语，见下 |
| 三语章节关键词表 | "effetti collaterali / side effects / 副作用" | 只留意大利语 |
| 评估集里的中英文题 | 每种语言约 450–500 题，共约 1500 题 | **只要约 456 道意大利语题**（95% 附近 ±2 个百分点）。工作量降到三分之一。HANDOFF 里"跨语言 15%"的份额改给口语化/患者口吻题和同成分仿制药区分题。 |
| 跨语言验收规则 | zh→it、en→it 与 it→it 差距不超过 3 个点 | 删除 |
| 合成训练数据的三语查询 | 意/中/英各写一份 | 只写意大利语 |
| 语音跨语言 | 跳过翻译只跑稠密腿 | 语音只收意大利语；词法腿不再需要翻译，语音也可以开词法腿（只多一次本地查询）[推断] |
| 嵌入器必须多语言 | 排除 BioBIT/MedBIT 的理由之一 | 这条理由消失；但"没做过对比训练"这条仍然成立 |

### 变得更重要

1. **词法腿的权重和质量。** 意大利语词干（Snowball）、省略冠词剥离、大小写和重音折叠、剂量 token（"2,5 mg"→`2_5mg`）。权重仍由 `rag_eval.sweep retrieval` 决定，不手写。保留未词干化的表面形式给药名用。
2. **意大利语同义词表（约 100 个成分，小而全）。** 品牌名 ↔ INN 意大利语名 ↔ 盐型（"amlodipina besilato"↔"amlodipina"）↔ 常见拼写变体。主来源是 AIFA `confezioni_fornitura.csv` 的 `DENOMINAZIONE` 和 `PA_ASSOCIATI`。建议保留英文 INN 作为别名（paracetamol/paracetamolo），因为医生可能直接敲英文名，成本几乎为零。[推断]
3. **俗语 ↔ 医学术语映射（意大利语内部）。** 原方案靠"翻译查询"这一步顺手把"mal di testa"规范成"cefalea"。翻译去掉后，这个规范化没人做了。两个办法：(a) 小的自建对照表做词法扩展，药师审核；(b) 把查询层保留为"意大利语→意大利语术语改写"。先做 (a)，评估集里专门放俗语题来测是否需要 (b)。MedDRA 不能放进仓库（需订阅），自建表即可。FI 本身用患者语言写，对俗语题有天然帮助。[推断]
4. **仿制药区分**仍然是头号问题，和语言无关，原方案不变。

### 成本、延迟、托管

| 方案 | 入库成本 | 查询延迟 | 托管 |
| --- | --- | --- | --- |
| Qwen3-8B（OpenRouter） | 全语料约 $0.11–0.44 | 一次外部 API 调用 | 第三方（Nebius/DeepInfra 等） |
| text-embedding-3-small | 全语料约 $0.22 | 一次外部 API 调用 | OpenAI |
| 本地 110M BERT / 0.57B BGE-M3（侧车 CPU） | 电费；110M 模型约 5 万块估计几十分钟，BGE-M3 估计几小时 [推断，未实测] | 110M 估计 10–30 ms；mE5-large 级约 31 ms [证据：Cirillo] | 自己的侧车；内存多占约 0.5–2.5 GB |

API 嵌入本来就极便宜，本地小模型**不省钱**；它的好处是没有第三方依赖、延迟稳定、可以微调。坏处是侧车多一个常驻模型。

### Supabase 免费版 500 MB [推断，必须在 dry-run 里用 `pg_total_relation_size` 实测]

按约 5 万个子块、HNSW `m=64` 估算。HNSW 索引会把向量再存一份；单个向量超过约 4 KB 时一个 8 KB 页只能放一个。

| profile | 每个向量 | 表内向量 | 加索引后估计 |
| --- | --- | --- | --- |
| Qwen3 2048 halfvec | 4.1 KB | 约 205 MB | 约 450–600 MB，**放不下** |
| Qwen3 1024 halfvec | 2.1 KB | 约 103 MB | 约 200–300 MB（HANDOFF 估计 150–200 MB） |
| OpenAI 1536 float32 | 6.1 KB | 约 307 MB | 约 600–700 MB，**放不下** |
| OpenAI 1536 halfvec | 3.1 KB | 约 154 MB | 约 350–450 MB |
| 768 halfvec（BERT-base） | 1.5 KB | 约 77 MB | 约 150–220 MB |

另外还有块文本、父块、词法 tsvector 和 GIN 索引，估计 100–150 MB。

含义：
- 线上只能放**一个** 1024 维 halfvec 级的 profile。上一份报告的"默认 2048 halfvec"在免费版上不可行，改为 **Qwen3-8B 1024 halfvec**（Qwen3 支持 Matryoshka 截断；1024 维的损失上一份报告推测为 1–2 分，没有直接数字）。
- Qwen3 + OpenAI 两个 profile 同时在库里大概率超限。多臂对比应离线做（向量存本地文件，在 Python 里算），或者按臂轮流入库，或者评估期间临时升 Pro（8 GB）。
- 更小的向量是本地小模型臂的一个实际优点。

---

## 5. 判断与评估臂顺序

### 判断

- **保留 Qwen3-Embedding-8B 做主力**，线上维度改为 1024 halfvec。理由：意大利语通用检索第一梯队 [证据]，没有任何证据显示别的模型在意大利语医疗上更好 [证据：空白]，已经接好。它不是意大利语上的第一名（BGE-Multilingual-Gemma2、Inf-Retriever-v1 高约 2 分，Qwen3-4B 只低 0.5 分），但这些差距都小于通用基准到 AIFA 语料的迁移不确定性 [推断]。
- **text-embedding-3-small 保留为对照**（用户已批准）。公开证据里它在意大利语上只有一个饱和基准的数字（0.9611 对 Qwen3-4B 0.9704），所以这一臂确实有信息量。
- **加两个新臂：意大利语词干 BM25 单独成臂；本地 BGE-M3 稠密臂。**
- **不加未微调的 BioBIT/MedBIT 臂。**
- **微调的 MedBIT 双塔**：只在第一阶段召回是瓶颈时才做，并且和"同数据微调的 BGE-M3 或 mE5-base"成对比较。做之前先向作者确认许可证。

### 臂的顺序（每步只改一个维度，都在开发集上做，测试集只用一次）

| 步 | 臂 | 成本 | 决定什么 |
| --- | --- | --- | --- |
| 0 | 现有生产配置（text-embedding-3-small、legacy） | 0 | 基线 |
| 1 | **BM25 + 意大利语词干**，单独跑 | 很低，纯本地 | 词法腿有多强；分词器改动是否到位 |
| 2 | 冻结稠密：Qwen3-8B 1024、text-embedding-3-small、本地 BGE-M3（可选 Qwen3-8B 2048，离线看维度损失） | < $1 | 主嵌入器；Qwen3 相对小模型到底领先多少 |
| 3 | 最佳稠密 + BM25 + 精确实体，RRF；再加元数据过滤和章节级去重 | 低 | 融合权重；仿制药问题解决了多少 |
| 4 | 重排器：Cohere Rerank 4 Pro、Voyage rerank-2.5、Qwen3-Reranker（可选本地 bge-reranker-v2-m3） | 低 | 重排器；之后校准拒答阈值 |
| 5 | 门：Recall@50 已高但答案准确率不够 → 微调重排器 | 中 | — |
| 6 | 门：过滤后 Recall@50 本身是瓶颈 → 微调双塔，两臂成对：MedBIT-r3-plus + MNRL 对 BGE-M3（或 mE5-base）+ MNRL，同一份 80% 训练成分的合成意大利语查询，同样的难负例规则（同成分仿制药不当负例） | 中到高（GPU、全量重嵌、自托管） | 领域 MLM 预训练是否真的有用 |

第 6 步如果做，判定标准不变：在 20% 测试成分上显著胜过冻结基线才算数。注意法语法律研究的发现：领域内微调过的检索器再和 BM25 融合可能变差，所以微调臂要同时报告"单独"和"融合后"两个数。

### 最早的便宜实验（建议现在就做）

- 数据：从开发成分里取约 100 道意大利语题（合成后人工看一遍），每题标注正确的 `cod_farmaco`、章节和金标准片段。
- 四个检索器，全部在 Python 内存里跑，不进 Supabase：BM25（Snowball 意大利语词干 + 现有分词规则）、text-embedding-3-small、Qwen3-8B、BGE-M3。
- 指标：正确文档命中率、正确章节命中率、Recall@10、Recall@50。
- 读法：
  - 如果 BM25 单独就接近或超过稠密模型 → 词法腿优先投入，嵌入器之争不重要。
  - 如果三个稠密模型相差在噪声内 → 选最便宜、向量最小的，Qwen3-8B 不必坚持。
  - 如果所有冻结方法融合后 Recall@50 仍明显不够 → 才有理由走到第 6 步。
- 100 题的置信区间很宽（比例在 0.8 附近时约 ±8 个百分点），只能看出大差距；小差距要等完整开发集。

---

## 哪些是证据，哪些是推断（汇总）

**证据（有公开数字）**
- Qwen3-8B 在 7 个意大利语通用检索任务上 72.59，属第一梯队但非第一；比 BGE-M3 高 4.6、比 mE5-large 高 5.9、比 0.4B 的 EuroDense 高 1.2。
- 现有意大利语专用小嵌入模型在通用检索上明显弱于多语言模型。
- 带意大利语分析器的 BM25 在长文档上赢稠密模型，在短问答上输。
- MLM-only 的领域编码器直接做检索接近无效（英语）。
- 领域内合成数据微调通用多语言嵌入器能大幅提升（德语临床）；领域内微调单语小模型能大幅超过零样本的 BM25 和 BGE-M3（法语法律）。
- 意大利语专用 LLM（Minerva、EuroLLM）在 RCP 问答上远不如通用强模型。
- 意大利语微调的 bge-reranker 只比原版高约 0.01。

**没有证据（空白）**
- 任何意大利语医疗检索上的嵌入器对比。
- BioBIT/MedBIT 做检索的任何结果，无论是否微调。
- "小的单语领域模型微调后"对"大的多语言模型微调后"的直接比较。

**推断（要靠自己的评估证实）**
- Qwen3-8B 在 AIFA 语料上仍然领先小模型。
- 微调 MedBIT 赢不了同数据微调的 BGE-M3。
- 数据库体积估算、本地模型的入库时间和延迟。
- 去掉翻译后需要补一个意大利语术语规范化步骤。

---

## 来源

- Dadas 等，Parameter-Efficient Retrievers for Polish and European Languages：https://arxiv.org/abs/2609.12913 ；模型 https://huggingface.co/OPI-PIB/EuroDense-435M
- Rastogi，A Reliability Audit of Aggregated MTEB Scores（AACL 2026 short）：https://aclanthology.org/2026.aacl-short.28.pdf
- ItColBERT：https://arxiv.org/abs/2609.26856 ；https://huggingface.co/enricollen/ItColBERT
- Noviello & Tamburini，Exploring Text-Embedding Retrieval Models for the Italian Language（CLiC-it 2024）：https://aclanthology.org/2024.clicit-1.73
- Benchmarking Embedding Models for ESG Data：https://arxiv.org/abs/2609.15434
- Cirillo 等，Benchmarking Google Embeddings 2 against Open-Source Models：https://arxiv.org/abs/2605.23618
- PharmaQA.IT（EACL 2026 industry）：https://aclanthology.org/2026.eacl-industry.70.pdf ；https://huggingface.co/datasets/VillanovaAI/PharmaQA.IT
- BioBIT / MedBIT：https://huggingface.co/IVN-RIN/bioBIT ；https://huggingface.co/IVN-RIN/medBIT-r3-plus ；论文 https://www.sciencedirect.com/science/article/pii/S1532046423001521
- Towards Domain Specification of Embedding Models in Medicine（MedTEB / MedTE）：https://arxiv.org/abs/2507.19407
- JMIR Med Inform 2026，训练目标对训练领域：https://medinform.jmir.org/2026/1/e99639 ；配套研究 https://medinform.jmir.org/2026/1/e94241
- Arzideh 等，Fine-Tuning Clinical Embedding Models（德语，JMIR 2026）：https://www.jmir.org/2026/1/e82997
- Know When to Fuse（法语法律混合检索，COLING 2025）：https://arxiv.org/abs/2409.01357
- 意大利语微调模型卡：https://huggingface.co/albertobarnabo/bge-m3-italian ；https://huggingface.co/albertobarnabo/bge-reranker-v2-m3-italian ；https://huggingface.co/nickprock/mmarco-bert-base-italian-uncased ；https://huggingface.co/nickprock/Italian-ModernBERT-base-embed-mmarco-mnrl
- Supabase 免费版 0.5 GB 限制：https://supabase.com/changelog/33121-relaxing-database-size-limit-on-free-plan-0-5-gb-database-size-per-project

说明：两处数字我只看到了摘要或搜索摘录，没有读到全文表格——德语临床微调（0.27 对 0.14）和 JMIR 的匹配对照研究。Dadas 表 12 里各意大利语专用模型与列的对应关系在 PDF 提取时错位，所以只引用了范围（26.8–54.8）和论文正文点名的 Multilingual-E5-Large-ita（62.99）。
