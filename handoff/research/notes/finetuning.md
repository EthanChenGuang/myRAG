# Fine-tuning embedding models and rerankers for Italian AIFA drug documents (RCP/SmPC, patient leaflets; IT/ZH/EN queries; split 80 train / 20 test by active ingredient)

## Q1. Typical gains from fine-tuning embedders on synthetic domain queries; data sizes; base models; commercial options

### Takeaway
Published gains for supervised base-size and 7B models trained on a few thousand synthetic pairs from one corpus run from 0 to about +26 points Recall@10, or about +7 to +9% relative NDCG@10 at full dimension. The gains are largest when the base model is weak on the domain (FinanceBench) and roughly zero when it is already strong (DocsQA). Fine-tuning can also lower scores on some datasets, so held-out evaluation is required. The only head-to-head check of a public Qwen3-Embedding-0.6B LoRA fine-tune I found favoured the frozen base model.

### Cited Findings
- **Philschmid (June 2024, independent blog, English financial domain).** Base model: bge-base-en-v1.5 (109M). Data: about 6.3k synthetic question–context pairs from one NVIDIA 10-K. Loss: MNRL wrapped in MatryoshkaLoss with dims 768/512/256/128/64. Global batch 512 (32 × 16 gradient accumulation), 4 epochs, lr 2e-5, cosine schedule, warmup 0.1. NDCG@10 went from 0.7684 to 0.8254 at 768 dims (+7.4% relative) and from 0.6440 to 0.7892 at 64 dims (+22.6%). Training took about 3.5 minutes on an AWS g5.2xlarge (24 GB A10G), costing about $0.07. — [Philschmid](https://www.philschmid.de/fine-tune-embedding-model-for-rag)
- **Databricks (vendor blog; base models are open, so not a product claim).** Recall@10 after fine-tuning on synthetic data:
  - gte-large-en-v1.5 (0.4B): FinanceBench 0.293→0.552, ManufactQA 0.821→0.873, DocsQA 0.849→0.884.
  - e5-mistral-7b: FinanceBench 0.479→0.670, ManufactQA 0.836→0.913, DocsQA 0.899→0.899 (no gain).
  - OpenAI text-embedding-3-large with no fine-tuning, for reference: 0.44 / 0.895 / 0.95.
  - Training sets had about 6k, 14k and 8.7k examples. Training ran 1–3 epochs with in-batch negatives only (no hard negatives).
  - The fine-tuned gte beat reranking with voyage rerank-1 on FinanceBench and ManufactQA. Better retrieval raised RAG accuracy on FinanceBench but not on DocsQA, where retrieval was already strong.
  — [Databricks](https://www.databricks.com/blog/improving-retrieval-and-rag-embedding-model-finetuning)
- **Corpus-specific synthetic queries (arXiv 2505.19274, 2025).** Llama-3.1-8B generated up to 100k queries per corpus; training used contrastive loss plus listwise distillation from RankT5-3B. BGE-base NDCG@10 rose on TREC-COVID (78.1→82.2), FiQA (40.6→44.3), SciFact (74.1→76.2) and Touché (25.7→35.3). It fell on ArguAna (63.6→61.4), SCIDOCS (21.7→19.4), FEVER (86.3→80.0) and Climate-FEVER (31.2→25.1). For models that had already been through supervised training, contrastive loss alone usually lowered effectiveness. The authors found "no clear superiority" between synthetic and human queries. — [arXiv 2505.19274](https://arxiv.org/html/2505.19274v1)
- **SSRA (AAAI).** Training jointly on domain relevance data and synthetic data gave a reported +1.73% nDCG@10. — [AAAI](https://ojs.aaai.org/index.php/AAAI/article/download/40425/44386) (search snippet only; setup not read)
- **Data-volume sensitivity (BMRetriever Table 5, biomedical).** Cutting fine-tuning data to 10% lowered the five-task average only slightly: 410M from 0.574 to 0.562, 1B from 0.596 to 0.590. — [BMRetriever](https://arxiv.org/html/2404.18443v2)
- **Qwen3-Embedding-0.6B LoRA in the wild.** In one public model card's human-judged benchmark, the frozen base scored 0.3538 nDCG@10 and the LoRA fine-tune 0.3482. Other Qwen3-0.6B LoRA cards (BC Card finance, email domains) report no clean base-vs-fine-tune comparison. These are single-author, unreviewed cards. — [search results, HF model cards](https://huggingface.co/BCCard/MoAI-Embedding-0.6B)
- **Qwen3-Embedding base strength (vendor report).** MMTEB retrieval: 0.6B 64.64, 4B 69.60, 8B 70.88. The model already went through about 150M weakly supervised synthetic pairs plus about 19M supervised pairs, so it starts as a heavily trained retriever. — [Qwen3 Embedding report](https://arxiv.org/html/2506.05176)
- **Commercial options:**
  - **Voyage.** Voyage builds custom models through enterprise partnerships rather than a self-serve API. voyage-law-2-harvey was trained on more than 20B tokens of case law plus expert annotations. Harvey and Voyage say it returns about 25% less irrelevant material in top results than the next-best off-the-shelf models, using one third of the dimensionality. This is a vendor/customer claim with no independent benchmark. — [Harvey blog](https://www.harvey.ai/blog/harvey-partners-with-voyage-to-build-custom-legal-embeddings)
  - **Vercel model listings** say voyage-3-large outperforms Voyage's own legal and finance domain models, so general models have largely closed the gap. Treat these listings as secondary sources. — [Vercel](https://vercel.com/ai-gateway/models/voyage-3-large/about)
  - **Cohere.** Fine-tuning, including rerank, was deprecated on 15 Sept 2025, and previously fine-tuned models are no longer accessible. Whether embed fine-tuning was ever exposed is unclear. — [Cohere deprecations](https://docs.cohere.com/docs/deprecations), [Cohere rerank FT doc](https://docs.cohere.com/docs/rerank-fine-tuning)
  - **cohere-rerank-3.5** is deprecated from 1 July 2026 and auto-routed to rerank-4-fast from 1 Aug 2026, which returns different scores (thresholds need re-tuning). — [Pinecone](https://docs.pinecone.io/models/cohere-rerank-3.5.md)

### Inferences
- With Qwen3-Embedding (already used by myRAG via OpenRouter) or BGE-M3 as the starting point, expect small gains of roughly 0–5 points NDCG@10 on the held-out 20 ingredients. The double-digit gains in the literature come from weaker base models (bge-base, gte-large) on domains they handle poorly. Measure the frozen baseline first.
- About 5–10k filtered pairs is the typical size behind published gains, and the BMRetriever data shows strongly diminishing returns. 1k pairs is plausibly enough to detect whether fine-tuning helps at all.
- The cross-ingredient split is a good test for the generalisation risk in 2505.19274, where fine-tuning helped some corpora and hurt others.
- There is currently no self-serve commercial embedding fine-tuning path from Cohere. Fine-tuning would need an open model, self-hosted or on a GPU endpoint, which conflicts with the current OpenRouter-hosted embedding setup.

### Gaps
- I found no Italian-language or medical-drug-label embedding fine-tuning study with numbers.
- I did not verify current Voyage self-serve fine-tuning terms or pricing.
- I did not verify whether OpenAI offers embedding fine-tuning; to my knowledge it does not, but I have no source.
- I found no direct fine-tuning results for jina-v3, gte-multilingual or multilingual-e5.

## Q2. Training recipes: losses, hard negatives, hyperparameters, LoRA vs full fine-tuning, forgetting

### Takeaway
The standard recipe is MNRL or CachedMNRL, optionally wrapped in Matryoshka. Use the largest batch you can afford, 1–4 epochs, lr about 2e-5 for full fine-tuning of base models, and a few mined hard negatives filtered relative to the positive's score (positive-aware) to avoid false negatives. This matters especially for SmPCs, where generics of the same ingredient carry nearly identical text. Direct evidence on cross-lingual forgetting during retrieval domain adaptation is thin.

### Cited Findings
- **sentence-transformers loss guidance.**
  - MNRL (InfoNCE, in-batch negatives) is "commonly used to train the top performing embedding models".
  - CachedMNRL is "often used to increase the batch size, resulting in superior performance".
  - GISTEmbedLoss / CachedGISTEmbedLoss accept pairs or triplets, using a guide model to filter in-batch false negatives (the page lists the loss without explaining the guide mechanism).
  - MatryoshkaLoss makes embeddings truncatable "without notable losses".
  — [SBERT loss overview](https://sbert.net/docs/sentence_transformer/loss_overview.html)
- **Qwen3-Embedding recipe (vendor report).**
  - Loss: InfoNCE with K hard negatives plus in-batch queries and documents.
  - False-negative mask: drops candidates scoring more than positive + 0.1, or identical to the positive.
  - Synthetic pairs are kept only if cosine similarity is above 0.7.
  - Final model: slerp merge of several fine-tuning checkpoints. Removing merging cost about 1.8 MMTEB points on the 0.6B model (64.33→62.56); removing synthetic pretraining cost about 3.1 points.
  - Temperature, K, batch size and lr are not disclosed.
  — [Qwen3 Embedding report](https://arxiv.org/html/2506.05176)
- **NV-Retriever.** "Positive-aware" mining uses the positive's score as an anchor to remove false negatives. It is reported to speed training and improve accuracy; NV-Retriever-v1 scored 60.9 on MTEB Retrieval and was #1 in July 2024. Exact variants (TopK-PercPos etc.) were not read from the full text. — [arXiv 2407.15831](https://arxiv.org/abs/2407.15831)
- **2505.19274 settings.**
  - Hard negatives scoring above 60% of the positive's score are masked.
  - lr 2e-4, batch 4096 via GradCache, τ = 0.01.
  - Contrastive term weighted 0.1 alongside listwise distillation.
  - Contrastive-only fine-tuning of already-supervised models often hurt.
  — [arXiv 2505.19274](https://arxiv.org/html/2505.19274v1)
- **BMRetriever (biomedical) negatives and filtering.** Hard negatives were sampled from the E5-base top-100. Consistency filtering kept only queries whose source passage was in the E5-base top 3. — [BMRetriever](https://arxiv.org/html/2404.18443v2)
- **Synthetic-only hard negatives are weak.** Models trained only on LLM-generated hard negatives underperformed BM25- or cross-encoder-mined negatives. — [arXiv 2504.21015](https://arxiv.org/pdf/2504.21015v2)
- **Forgetting:**
  - Aggressive updates can make an embedder lose languages absent from fine-tuning data; the authors use parameter-efficient methods (BitFit, LoRA) to mitigate this. — [Language Models are Universal Embedders](https://arxiv.org/pdf/2310.08232)
  - In multilingual MT, LoRA did not clearly beat full fine-tuning at limiting forgetting. The model-size-to-data ratio mattered most, and cross-lingual alignment reduced forgetting. — [Liu & Niehues, MRL 2025](https://arxiv.org/abs/2510.19546v1)

### Inferences
- **Hard negatives for AIFA:**
  - Mine from (a) other sections of the same RCP and (b) the same section in other ingredients' documents.
  - Treat same-ingredient generic RCPs, whose text is near-identical, as false-negative risks. Mask them by ingredient/section metadata, or use positive-aware score thresholds, rather than using them as negatives.
- **Forgetting mitigation:**
  - Generate queries in balanced IT/ZH/EN so every query language is trained against Italian passages.
  - Mix in some general multilingual retrieval pairs, for example MIRACL-style data.
  - Prefer LoRA or a low lr with few epochs.
  - Consider slerp/linear merging of the fine-tuned weights with the base model, as Qwen3 does.
  - Always re-check a general multilingual benchmark subset after training.
- **Matryoshka** is cheap to add and helps if the 1536-dim pgvector schema or halfvec needs smaller dimensions.

### Gaps
- I found no paper that measures cross-lingual (ZH→IT) retrieval drop after domain fine-tuning of BGE-M3 or Qwen3-Embedding.
- I found no published LoRA-vs-full comparison for Qwen3-Embedding-4B retrieval fine-tuning.
- I did not confirm exact hyperparameter defaults for GISTEmbed.

## Q3. Synthetic query generation and filtering; avoiding leakage and generic queries

### Takeaway
The proven pattern is: an LLM writes several query types per passage (questions, keywords, claims), varied by persona and difficulty; queries are then filtered by round-trip consistency (the source passage must come back near the top) and/or a cross-encoder or LLM relabel of the positive. Cost is low: BMRetriever generated 500k queries for under $500.

### Cited Findings
- **Qwen3 synthetic data generation (Qwen3-32B).**
  - Each document is paired with a persona retrieved from Persona Hub (top 5 candidates).
  - Query types: keywords, acquire_knowledge, summary, yes_or_no, background.
  - Difficulty levels: high school, university, PhD.
  - Query length and language are set explicitly.
  - Synthetic pairs with cosine similarity of 0.7 or less are dropped.
  — [Qwen3 Embedding report](https://arxiv.org/html/2506.05176)
- **2505.19274 pipeline.**
  - Llama-3.1-8B, few-shot, with six query types: questions, claims, titles, keywords, zero-shot and few-shot natural search queries.
  - Queries are kept under 20 words.
  - Filter 1: drop the query if its passage is not in the retriever's top 20. Filter 2: keep it only if the cross-encoder ranks its passage first.
  - Generating 100k queries took about 1–2 hours with vLLM, and reranking about 5 hours.
  - Appendix A warns of heavy train/test overlap ("contamination") between base-model training data and BEIR.
  — [arXiv 2505.19274](https://arxiv.org/html/2505.19274v1)
- **Gecko (FRet).** An LLM generates task + query from a passage, retrieves candidates, then relabels the positive and hard negative with the same LLM. The positive changed for about 15% of examples, meaning the source passage was often not the best answer. FRet (6.6M examples) alone gave a strong zero-shot MTEB baseline. — [Gecko arXiv 2403.20327](https://arxiv.org/abs/2403.20327)
- **BMRetriever.** GPT-3.5 queries came from PubMed/Meadow passages, and GPT-4 brainstormed about 20 task types with query, positive and hard negative. Of 500k generated queries, about 420k survived round-trip filtering. Cost was under $500 (April 2024). Synthetic data was the largest single contributor among fine-tuning sources. — [BMRetriever](https://arxiv.org/html/2404.18443v2)

### Inferences
- **Generic queries.** A query like "Quali sono gli effetti collaterali?" matches every leaflet. Gecko-style relabelling, or the cross-encoder top-1 filter, removes queries whose source chunk is not uniquely best. Alternatively, require the prompt to name the drug/ingredient or a specific detail (dose, population, interaction).
- **Leakage.** Generate queries only from the 80 training ingredients' chunks, and dedupe hard negatives so no test-ingredient text enters training. Shared boilerplate sections (standard AIFA leaflet phrasing) appear in both splits, so exact-dedupe identical chunks across splits. The 2505.19274 contamination warning also applies to base models that may have seen EMA/AIFA texts.
- **Chinese and English queries.** Ask the LLM to write the question natively in each language rather than translating Italian queries, and run round-trip filtering per language.

### Gaps
- I found no published prompt set for Italian drug-label queries.
- I found no quantitative study of the "generic query" failure rate.

## Q4. Reranker fine-tuning vs embedding fine-tuning: which gives more lift for the cost?

### Takeaway
Fine-tuning a small cross-encoder on in-domain mined hard negatives yields large, well-documented gains, and is cheap (under 1 GPU-hour for about 100k queries). In Databricks' tests, embedding fine-tuning sometimes beat adding an off-the-shelf reranker. No source compares fine-tuning a reranker against fine-tuning the embedder on the same data.

### Cited Findings
- **Hugging Face reranker guide (sentence-transformers v4, independent/library blog).**
  - Setup: ModernBERT-base trained on about 99k GooAQ queries, with 5 hard negatives mined per query (top-100 range from a static embedder), giving 578k labeled pairs.
  - Loss: BCE with pos_weight 5. 1 epoch, batch 16, lr 2e-5, bf16.
  - Results, reranking the top 30: retriever only 59.12, bge-reranker-base 70.98, bge-reranker-large 73.20, fine-tuned ModernBERT-base 77.14, fine-tuned ModernBERT-large 79.42.
  - Compute: about 30 minutes (base) and under 1 hour (large) on one RTX 3090.
  - The guide warns that cross-encoders overfit quickly and that training only on hard negatives can hurt on easy cases.
  — [HF blog: train reranker](https://huggingface.co/blog/train-reranker)
- **Databricks.** Fine-tuned gte-large outperformed adding voyage rerank-1 on FinanceBench and ManufactQA; reranking gave OpenAI embeddings only marginal gains on some datasets. No numbers are published for the reranker arm. — [Databricks](https://www.databricks.com/blog/improving-retrieval-and-rag-embedding-model-finetuning)
- **Qwen3-Reranker (vendor report).** Training is supervised SFT plus model merging, with a yes/no logit-based score. MMTEB-R reranking: 0.6B 66.36, 4B 72.74, 8B 72.94. — [Qwen3 Embedding report](https://arxiv.org/html/2506.05176)
- **MedCPT.** A two-stage design: a dense retriever trained on 255M PubMed click pairs, plus a cross-encoder reranker trained on 18M pairs with retriever-mined negatives. The 330M model beat GTR-XXL (4.8B) and cpt-text-XL in zero-shot biomedical IR. — [MedCPT arXiv](https://arxiv.org/abs/2307.00589v2), [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12478430/)

### Inferences
- For myRAG, a fine-tuned reranker can be introduced without re-embedding the corpus or changing pgvector. The embedder (Qwen3 via OpenRouter) stays as is, and the reranker slots into the existing `RAG_RERANKER` switch via the sidecar.
- An embedder fine-tune forces a full re-embed and self-hosting.
- So the likely best lift-per-cost order is:
  1. Off-the-shelf multilingual reranker (bge-reranker-v2-m3 / Qwen3-Reranker).
  2. Fine-tuned reranker on mined AIFA hard negatives.
  3. Embedder fine-tune, only if Recall@50–100 of the first stage is the bottleneck.
- This ordering is an inference, not a measured result.

### Gaps
- I found no published fine-tuning numbers for bge-reranker-v2-m3 or Qwen3-Reranker on domain data.
- I found no multilingual reranker fine-tuning study.

## Q5. Compute, time and hosted options

### Takeaway
Fine-tuning at this scale is cheap. About 6k pairs on a 109M model takes minutes on a 24 GB GPU, and a 150–400M cross-encoder on about 100k queries takes 0.5–1 hour on an RTX 3090. Large-scale listwise distillation runs reach about 50 GPU-hours. I found no measured numbers for 0.6B/4B Qwen3 models on 10k pairs.

### Cited Findings
- bge-base (109M), about 6.3k pairs, 4 epochs: about 3.5 minutes on a g5.2xlarge (A10G 24 GB), about $0.07. — [Philschmid](https://www.philschmid.de/fine-tune-embedding-model-for-rag)
- ModernBERT reranker base/large on 578k labeled pairs: about 30 minutes / under 1 hour on an RTX 3090. — [HF blog](https://huggingface.co/blog/train-reranker)
- Listwise distillation with a batch of 4096 on MSMARCO-scale data: 48–60 hours per model on a single 48 GB GPU (RTX 6000 Ada / L40S). — [arXiv 2505.19274](https://arxiv.org/html/2505.19274v1)
- BMRetriever synthetic data API cost: under $500. — [BMRetriever](https://arxiv.org/html/2404.18443v2)

### Inferences
- **Rough extrapolation, not measured.** A 0.6B model on 10k pairs, 1–3 epochs at seq length 512 with CachedMNRL, plausibly takes under 1 hour on a single A100/H100 and a few hours on an L4.
- A 4B model likely needs LoRA plus gradient checkpointing on an 80 GB card, and several hours.
- Generating about 10k × 3 languages of queries with an API LLM costs on the order of tens of dollars.

### Gaps
- I did not research Modal, RunPod or HF AutoTrain pricing or capabilities; that needs a separate lookup.
- I found no measured GPU-hours for Qwen3-Embedding-0.6B/4B fine-tuning.

## Q6. Evidence for medical/biomedical retriever adaptation and Italian medical work (IMB)

### Takeaway
Biomedical adaptation clearly helps for English. BMRetriever-410M matches BGE-large, and MedCPT-330M beats a 4.8B general model. The IMB paper (Italian) did **not** fine-tune or even evaluate any retriever. Its "specialized adaptation" claim concerns small generator LLMs fine-tuned on Italian forum QA, scored on BERTScore, so it is not evidence for retriever fine-tuning.

### Cited Findings
- **BMRetriever (2024).**
  - Backbones: Pythia-410M/1B, Gemma-2B, BioMistral-7B.
  - Stage I: about 10M biomedical contrastive pretraining pairs. Stage II: about 1.4M labeled pairs plus synthetic data.
  - Average nDCG@10 over four IR tasks: 410M 0.508 (vs BGE-Large 0.511, E5-Large-v2 0.491, MedCPT 0.471); 7B 0.551 (vs E5-Mistral 0.546).
  - The 410M model beats baselines up to 11.7× larger. Pretraining helps smaller models more.
  — [BMRetriever](https://arxiv.org/html/2404.18443v2)
- **MedCPT (2023, Bioinformatics).** Trained on 255M PubMed query–article clicks (2020–2022). The 330M model set state-of-the-art results on biomedical BEIR tasks and beat GTR-XXL (4.8B). The abstract says six tasks; the PMC version says five. — [arXiv](https://arxiv.org/abs/2307.00589v2), [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12478430/), [GitHub](https://github.com/ncbi/medcpt)
- **IMB (arXiv 2510.18468, CLIC-it 2025).**
  - Data: IMB-QA (782,644 Italian patient–doctor forum conversations, 77 categories) and IMB-MCQA (25,862 specialty exam MCQs).
  - RAG used off-the-shelf all-MiniLM-L6-v2 + FAISS, top 5, over a 100k-answer KB, with gemma-2-9b-it. The paper states it "did not perform a separate retriever evaluation".
  - Fine-tuning covered generators only: Llama-3.2-1B/3B, Gemma-2-2b-it and Qwen2.5-1.5B via Unsloth, 6 epochs, lr 2.97e-4. BERTScore F1 rose (e.g. Llama-3.2-1B 0.6423→0.6976), while METEOR fell for some models.
  - No direct table backs "adaptation beats larger general models".
  — [IMB arXiv abs](https://arxiv.org/abs/2510.18468), [IMB HTML](https://arxiv.org/html/2510.18468v1)
- **Other Italian medical work** is word-level embeddings rather than retrievers: contrastive + knowledge-graph Italian medical embeddings, and Italian medical word embeddings (LREC 2024). A 2026 Salerno paper benchmarks embedders for Italian passage retrieval but is not medical. — [arXiv 2211.05035](https://arxiv.org/pdf/2211.05035), [LREC 2024](https://aclanthology.org/2024.lrec-main.824.pdf), [arXiv 2605.23618](https://arxiv.org/pdf/2605.23618)

### Inferences
- English biomedical evidence supports domain adaptation mainly for small models; the gain shrinks as general models get stronger (BMRetriever-7B is only about 0.5 points above E5-Mistral).
- For modern multilingual embedders already strong on medical text, the project's own held-out-ingredient eval is the only trustworthy evidence.
- The IMB claim should not be cited as support for retriever fine-tuning.

### Gaps
- I found no Italian medical retrieval benchmark, and no study fine-tuning a retriever on Italian SmPC/leaflet text.
- I did not read the Salerno 2026 Italian retrieval paper's numbers.
