# Embedding models and rerankers for Italian medical/pharmaceutical RAG (AIFA RCP/FI, cross-lingual it/zh/en queries)

Research date: 2026-11-26. Corpus assumed: ~800 AIFA documents, ~11M tokens. Many figures below come from vendor pages or third-party aggregators; this is flagged per item. No source found gives Italian-medical retrieval scores for the large multilingual embedders, so the final pick has to be confirmed on our own Italian AIFA eval set.

## 1. How do the candidate embedding models compare on multilingual/Italian and medical retrieval?

### Takeaway
On the published multilingual numbers, Qwen3-Embedding-8B (open, Apache 2.0) is the strongest model we can use: MMTEB mean 70.58 / retrieval 70.88, and #1 on the RTEB beta (which includes healthcare tasks) as of Nov 2026. voyage-4-large is the strongest commercial API on Voyage's own RTEB comparison and ranks near the top of RTEB. Neither has a published Italian-medical score, so the plan is to use Qwen3-Embedding-8B as the primary and voyage-4-large as the comparison, and settle it with an in-house eval on AIFA RCP questions.

### Cited Findings
- MMTEB, Qwen3 Embedding technical report Table 2 (arXiv 2506.05176v3, June 2025), Mean(Task) / Retrieval: Qwen3-Embedding-8B 70.58 / 70.88; Qwen3-Embedding-4B 69.45 / 69.60; Qwen3-Embedding-0.6B 64.33 / 64.64; Gemini Embedding 68.37 / 67.71; multilingual-e5-large-instruct 63.22 / 57.12; Cohere embed-multilingual-v3.0 61.12 / 59.16; BGE-M3 (dense) 59.56 / 54.60; OpenAI text-embedding-3-large 58.93 / 59.27 — [Qwen3 Embedding report](https://arxiv.org/html/2506.05176v3)
- Qwen3-Embedding models are released under Apache 2.0 (commercial use allowed). Default dimensions: 1024 (0.6B), 2560 (4B), 4096 (8B); MRL (Matryoshka) supported — [Qwen3 Embedding report](https://arxiv.org/html/2506.05176v3)
- The 8B model was #1 on the MTEB multilingual leaderboard as of 2025-06-05 (score 70.58) — [Qwen3-Embedding GitHub](https://github.com/QwenLM/Qwen3-Embedding)
- RTEB beta snapshot of 2026-11-23 (secondary blog that reads the MTEB leaderboard; RTEB has 30 retrieval tasks including healthcare): #1 Qwen3-Embedding-8B (30/30 tasks, mean nDCG@10 0.6937); #2 voyage-4-large at 2048 dims with evolved prompts (only 16/30 tasks); #3 Nemotron-3-Embed-8B; #5 Octen-Embedding-8B; #7 Cohere embed-v5.0-pro (17/30, public tasks only); #9 voyage-4-large at 1024 dims (29/30); #11 Qwen3-Embedding-4B; #17 voyage-4; #18 gemini-embedding-001; #31 jina-embeddings-v5-text-small; #46 text-embedding-3-large; #62 BGE-M3; #64 text-embedding-3-small; #126 Qwen3-Embedding-0.6B (20/30). Ranks mix complete and incomplete entries — [maximem.ai, Best Embedding Models 2026](https://www.maximem.ai/blog/best-embedding-models-2026) (secondary source; check against the live leaderboard)
- Same snapshot, MTEB Multilingual v2: harrier-oss-v1-27b (Microsoft) #1, mean 0.7427, retrieval 0.7827; Qwen3-Embedding-8B #4, mean 0.7058; gemini-embedding-001 #5; Qwen3-Embedding-4B #6 — [maximem.ai](https://www.maximem.ai/blog/best-embedding-models-2026). Another leaderboard snapshot (2026-11-01) also has Harrier-OSS v1 27B first (MTEB avg 74.27, retrieval 78.27) — [modelmenu.dev MTEB](https://modelmenu.dev/benchmarks/mteb). Harrier's license and Italian results were not checked.
- Voyage 4 launch post (dated 2026-01-15), RTEB average over 29 datasets, NDCG@10: voyage-4-large beats voyage-4 by 1.87%, voyage-4-lite by 4.80%, Gemini Embedding 001 by 3.87%, Cohere Embed v4 by 8.20% and OpenAI v3-large by 14.05%. The post evaluates a medical domain but its per-domain numbers are only in charts. No multilingual table and no Qwen comparison. voyage-4-large is a mixture-of-experts model; voyage-4-nano is open-weight under Apache 2.0 — [Voyage AI blog](https://blog.voyageai.com/2026/01/15/voyage-4/) (vendor benchmark)
- OpenRouter lists voyage-4-large with a release date of 2026-07-27, which conflicts with the January 2026 blog date (possibly a dated snapshot) — [OpenRouter voyage-4-large](https://openrouter.ai/voyageai/voyage-4-large-20260727)
- jina-embeddings-v4 (3.8B, from Qwen2.5-VL-3B): MMTEB 66.49, MTEB-en 55.97, single-vector and multi-vector outputs, 2048 dims truncatable to 128. License is contested: the Jina model page says Qwen Research License (non-commercial); the HF card mentions CC BY-NC 4.0. Either way, commercial self-hosting needs a Jina license — [Jina model page](https://jina.ai/en-US/models/jina-embeddings-v4/); [HF card](https://huggingface.co/jinaai/jina-embeddings-v4)
- Cohere Embed 5 (Pro/Fast) became generally available around 2026-09-30 to 10-08 (sources differ). Cohere's own numbers on ViDoRe V3 (visual documents): Pro 85.8, Fast 84.5, voyage-4-large 83.7, Gemini Embedding 2 83.2, Embed 4 77. No multilingual score table found — [MarkTechPost](https://www.marktechpost.com/2026/10/01/cohere-releases-embed-5/?noamp=mobile); [eesel.ai](https://www.eesel.ai/blog/cohere-embed-5) (vendor numbers, reported through secondary coverage)
- Google Gemini Embedding 2 is reported GA in April 2026 at $0.20/MTok for text — [awesomeagents.ai pricing (June 2026)](https://awesomeagents.ai/pricing/embedding-models-pricing/) (aggregator, unverified)
- English–Italian IR study (Oro, Granata, Ruffolo, 2025; Italian on SQuAD-it and DICE, medical only in English on NFCorpus): multilingual models compete with language-specific ones; Cohere embed-multilingual-v3.0 had the best nDCG@10, 0.90 in English and 0.86 in Italian. It predates Qwen3 and Voyage 4 — [Preprints.org 202502.2143](https://www.preprints.org/manuscript/202502.2143) (full text not retrieved, 403; numbers from the search snippet)
- No benchmark or leaderboard reports medical-only retrieval scores for these models; RTEB has healthcare tasks but only domain averages are reported — [maximem.ai](https://www.maximem.ai/blog/best-embedding-models-2026); [R2MED (English medical reasoning retrieval)](https://arxiv.org/pdf/2505.14558)

### Inferences
- Primary: Qwen3-Embedding-8B. It leads every public multilingual and retrieval board we found, it is Apache 2.0, it is cheap through OpenRouter ($0.01/MTok, see section 6), and it can be self-hosted in the sidecar later. The app already has 1024/2048 halfvec profiles for it.
- Comparison: voyage-4-large. It is the strongest closed API in the vendor and RTEB evidence, the app already has profiles for it, and it is a different model family (MoE, separate training data), which makes the comparison informative. The 200M free tokens cover the whole 11M-token corpus many times over.
- Low priority or exclude: BGE-M3 dense (MMTEB retrieval 54.60, RTEB #62); text-embedding-3-small (RTEB #64; it is the current baseline profile and should stay only as the regression baseline); multilingual-e5-large-instruct (57.12); jina-v4 (license); voyage-law-2 and voyage-finance-2 (wrong domain).
- Optional third arm: gemini-embedding-001 or Cohere Embed 5 Pro, only if the Qwen-vs-Voyage gap is unclear. It would need a new profile.

### Gaps
- No published Italian-only or Italian-medical retrieval score exists for Qwen3, Voyage 4, Gemini, Cohere v5 or Jina v5. The MTEB leaderboard's per-language filter (ita) was not queried directly.
- Voyage's per-domain medical chart values were not extractable.
- The license and practicality (27B) of Harrier-OSS were not checked, nor was Nemotron-3-Embed-8B's license.
- jina-embeddings-v5 license and multilingual scores were not found.

## 2. Are there Italian-specific or Italian biomedical models or benchmarks, and what did PharmaQA.IT use?

### Takeaway
Italian biomedical encoders exist (BioBIT, MedBIT, MedBIT-r3-plus, about 110M BERT-base), but they are MLM encoders, not trained retrievers. No evidence shows them competing with large multilingual embedders for retrieval, so they are not worth a profile. PharmaQA.IT (EACL 2026, built on AIFA RCPs) is directly relevant as an eval set: it used multilingual E5 for retrieval and found that larger chunks (512 with 128 overlap) gave the best hit@10, 0.615.

### Cited Findings
- PharmaQA.IT: 861 extractive QA pairs over 497 AIFA RCP documents. Code Apache 2.0, dataset for research use, RCPs are public AIFA texts — [PharmaQA.IT GitHub](https://github.com/KamyarZeinalipour/PharmaQA.IT); [ACL Anthology 2026.eacl-industry.70](https://aclanthology.org/2026.eacl-industry.70/)
- PharmaQA.IT retrieval used multilingual E5 embeddings. hit@10 by chunk size–overlap: 64–16: 0.436; 128–32: 0.511; 256–64: 0.580; 512–128: 0.615 (units not stated, probably tokens) — [PharmaQA.IT GitHub](https://github.com/KamyarZeinalipour/PharmaQA.IT)
- PharmaQA.IT best generators at 512–128: Mistral-Small-24B ROUGE-L F1 0.656 (best open-weight); GPT-4.1 ROUGE-L 0.636, EM 0.367 (best closed). Open models approach closed performance — [PharmaQA.IT GitHub](https://github.com/KamyarZeinalipour/PharmaQA.IT); [ACL Anthology](https://aclanthology.org/2026.eacl-industry.70/)
- IMB (Italian Medical Benchmark, CLiC-it 2025): includes IMB-MCQA with 25,862 specialty-exam multiple-choice questions. Its RAG component uses all-MiniLM-L6-v2 + FAISS with no retriever comparison, so it gives no evidence on retrievers — [IMB, ACL Anthology CLiC-it 2025](https://aclanthology.org/2025.clicit-1.93.pdf); [CEUR-WS Vol-4112](https://ceur-ws.org/Vol-4112/92_main_long.pdf)
- MedBench-IT (CLiC-it 2025) evaluates LLMs on Italian medical entrance exams, not retrieval — [MedBench-IT](https://aclanthology.org/2025.clicit-1.55.pdf)
- BioBIT: Italian BERT further pretrained on machine-translated PubMed abstracts. MedBIT / MedBIT-r3-plus add medical textbooks and web health text, about 110M parameters (IVN-RIN / bmi-labmedinfo) — [bioBIT HF](https://huggingface.co/IVN-RIN/bioBIT/blob/main/README.md); [MedBIT-r3-plus HF](https://huggingface.co/IVN-RIN/medBIT-r3-plus); [MedBIT HF](https://huggingface.co/bmi-labmedinfo/medBIT)
- The only sentence-level wrapper found is the Spark NLP `sent_medbit_pipeline` (BertSentenceEmbeddings over MedBIT, no contrastive retrieval training) — [Spark NLP](https://sparknlp.org/2025/02/01/sent_medbit_pipeline_it.html)
- A 2023 paper (BioVec-Ita, CEUR Vol-3478) notes the scarcity of Italian biomedical NLP resources — [CEUR-WS Vol-3478 paper82](https://ceur-ws.org/Vol-3478/paper82.pdf)

### Inferences
- PharmaQA.IT is the best public seed for our eval: same document type (AIFA RCP), Italian questions, extractive gold spans. Its 861 questions could be imported as an Italian golden set after checking the license (research use; confirm it allows internal evaluation in a commercial product). Chinese and English versions could be made by translation for the cross-lingual tests.
- PharmaQA.IT's 0.615 hit@10 with multilingual-e5 is a weak baseline. A stronger embedder plus a reranker should beat it clearly, and that is a measurable target.
- The monotonic gain with larger chunks suggests that RCP sections (e.g. 4.2 Posologia, 4.3 Controindicazioni) work better as larger, section-aware chunks. Testing 512–1024-token section chunks with parent-child (already in Phase 4) is justified.
- MedBIT-class encoders are not trained for retrieval, cannot embed Chinese or English queries in a shared space, and have a 512-token limit. Exclude them.

### Gaps
- The PharmaQA.IT paper's full text (exact chunk units, which multilingual E5 variant, whether a reranker was tried) was not retrieved.
- PharmaER.IT (entity recognition on the same corpus) was not researched.
- No EVALITA task on Italian medical retrieval was found.

## 3. Cross-lingual retrieval (zh/en query → Italian document): which models handle it best?

### Takeaway
There is no published zh→it or en→it medical retrieval benchmark. The indirect evidence (MMTEB, whose multilingual retrieval includes cross-lingual tasks; the Qwen3 family's strong Chinese results; small informal zh↔en tests) favours Qwen3-Embedding-8B and the large API models over BGE-M3 and e5. Cross-lingual quality must be measured directly by translating the Italian golden questions into Chinese and English.

### Cited Findings
- Informal benchmark of 10 models, zh↔en cross-lingual round: Qwen3-VL-2B 0.988 vs BGE-M3 0.940 (methodology unclear, anecdotal) — [DEV Community 2026 benchmark](https://dev.to/chen_zhang_bac430bc7f6b95/which-embedding-model-should-you-actually-use-in-2026-i-benchmarked-10-models-to-find-out-58bc)
- SemEval-2025 Task 7 (cross-lingual fact-checked claim retrieval): BGE-M3 beat LaBSE, but the authors say multilingual encoders still have room to improve cross-language alignment — [MultiMind, arXiv 2512.20950](https://arxiv.org/pdf/2512.20950)
- Qwen3-Reranker strongly outperforms bge-reranker-v2-m3 on CMTEB-R (Chinese retrieval) and MMTEB-R: Qwen3-Reranker-8B 77.45 / 72.94 vs bge-reranker-v2-m3 72.16 / 58.36 — [Qwen3 Embedding report](https://arxiv.org/html/2506.05176v3)
- A 2026 paper evaluates retrievers on cross-lingual BrowseComp-Plus, but its results were not retrieved — [arXiv 2606.15345](https://arxiv.org/pdf/2606.15345)

### Inferences
- Run the cross-lingual test as three query sets over the same Italian corpus (it, zh, en), and report the gap from the Italian baseline per model. Accept a model only if zh→it recall@10 is within a fixed margin of it→it.
- If the embedder's zh→it gap is large, the cheap fix is query translation into Italian (the voice and chat query-rewrite stage already exists) before embedding, keeping the original query as a second leg fused by RRF. Lexical/BM25 legs only help for Italian or translated queries, not for raw Chinese queries.
- Rerankers can recover cross-lingual misses. A multilingual cross-encoder (Qwen3-Reranker, Cohere, Voyage) sees query and document together, which typically helps cross-language matching more than a bi-encoder does. This is an inference, not measured on our data.

### Gaps
- No source measures zh→it or en→it on medical or regulatory text for any model.
- MMTEB's per-language-pair breakdown (e.g. any it-paired bitext or cross-lingual retrieval tasks) was not extracted.

## 4. Matryoshka truncation and halfvec: quality loss at 1024 vs 2048 vs 4096

### Takeaway
The available evidence says truncating Qwen3-Embedding-8B from 4096 to 2048 is almost free (SciFact 0.784 → 0.783). 1024 probably costs about 1–2 points, but there is no direct published 1024 figure. halfvec costs ≤ about 1 recall point vs float32 in pgvector tests. Since HNSW on halfvec allows 4000 dims, 2048 halfvec is a safe default for Qwen3-8B; 1024 is worth testing for cost and latency.

### Cited Findings
- Qwen3-Embedding-8B on SciFact NDCG@10: 4096 dims 0.784; 2048 dims 0.783; 256 dims 0.752 (no 1024 column). vLLM needs `--hf-overrides '{"is_matryoshka": true}'` to accept a `dimensions` parameter — [AWS Neuron vLLM recipe](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/vllm-neuron/docs/model-recipes/qwen3-embedding-8b.html); [vLLM issue 20899](https://github.com/vllm-project/vllm/issues/20899)
- A hosted provider says dimensions below 256 are unsupported for Qwen3-Embedding-8B and advises evaluating the dimension on representative data — [mittwald docs](https://developer.mittwald.de/docs/v2/platform/aihosting/models/qwen3-embedding-8b/)
- voyage-4 models support 2048/1024/512/256 dims and float32, int8, uint8 and binary output. Voyage gives no numeric loss per dimension in the launch post — [Voyage AI blog](https://blog.voyageai.com/2026/01/15/voyage-4/)
- RTEB snapshot: voyage-4-large at 2048 dims with evolved prompts ranks #2 (16/30 tasks) vs #9 at the 1024 default (29/30 tasks). The setups differ (prompts, task coverage), so this does not isolate the dimension effect — [maximem.ai](https://www.maximem.ai/blog/best-embedding-models-2026)
- pgvector halfvec vs vector: Supabase (1536-d, pgvector 0.7.0) recall 0.945 vs 0.945 at ef_search=40, and 0.819 vs 0.809 at ef_search=10 — [Supabase pgvector 0.7.0](https://supabase.com/blog/pgvector-0-7-0); Neon found equivalent recall and latency with about 50% storage savings — [Neon](https://neon.com/blog/dont-use-vector-use-halvec-instead-and-save-50-of-your-storage-cost); pgvector issue #326 mostly identical, worst case 0.939 vs 0.933 (gist-960) — [pgvector #326](https://github.com/pgvector/pgvector/issues/326)

### Inferences
- Storage is not a constraint at our scale. 11M tokens in ~512-token chunks is roughly 20–25k chunks (my estimate). At 2048-d halfvec that is about 4 KB per vector, roughly 100 MB total. So choose the dimension on quality, not size: test Qwen3-8B at 2048 halfvec (primary) vs 1024 halfvec, and voyage-4-large at 2048 vs 1024.
- Keep the higher ef_search (≥ 40). The halfvec gap only showed at very low ef_search.

### Gaps
- No direct 1024-vs-4096 number for Qwen3-Embedding-8B on any multilingual or Italian task.
- No numbers for Voyage's dimension and quantization loss.

## 5. Rerankers: multilingual quality, latency, cost, self-hosting

### Takeaway
Qwen3-Reranker-4B or 8B is the strongest published open (Apache 2.0) multilingual reranker on MMTEB-R (72.74 / 72.94 vs bge-reranker-v2-m3 58.36), but it needs a GPU sidecar. For an API-only setup, Voyage rerank-2.5 (about $0.05/MTok) is cheap at our volume. Cohere Rerank 4 Pro ($2.50/1k searches) is the established alternative and is already wired in as `RAG_RERANKER=cohere`. The Jina v3 / v3.5 rerankers are non-commercial (CC-BY-NC).

### Cited Findings
- Qwen3 report Table 4 (reranking the top 100 from Qwen3-Embedding-0.6B), columns MTEB-R / CMTEB-R / MMTEB-R / MLDR: retriever alone 61.82 / 71.02 / 64.64 / 50.26; Jina-multilingual-reranker-v2-base 58.22 / 63.37 / 63.73 / 39.66; gte-multilingual-reranker-base 59.51 / 74.08 / 59.44 / 66.33; bge-reranker-v2-m3 57.03 / 72.16 / 58.36 / 59.51; Qwen3-Reranker-0.6B 65.80 / 71.31 / 66.36 / 67.28; Qwen3-Reranker-4B 69.76 / 75.94 / 72.74 / 69.97; Qwen3-Reranker-8B 69.02 / 77.45 / 72.94 / 70.19. Apache 2.0 — [Qwen3 Embedding report](https://arxiv.org/html/2506.05176v3); [Qwen blog](https://qwenlm.github.io/blog/qwen3-embedding)
  - Note: in this table bge-reranker-v2-m3 scores below the retriever it reranks on MTEB-R and MMTEB-R, which is a vendor-run result. Treat it with caution.
- jina-reranker-v3 (0.6B listwise): BEIR 61.94, MIRACL 66.50 (card) or 66.83 (launch table); in the same vendor table bge-reranker-v2-m3 has BEIR 56.51 and MIRACL 69.32, ahead of jina v3 on multilingual MIRACL. jina-reranker-v3.5: BEIR 63.20, MIRACL 74.11, 1.22–1.56× faster than v3. Both are CC-BY-NC-4.0 (non-commercial) — [Jina v3 launch](https://jina.ai/news/jina-reranker-v3-0-6b-listwise-reranker-for-sota-multilingual-retrieval/); [Jina v3.5 page](https://jina.ai/models/jina-reranker-v3.5/)
- Cohere Rerank 4.0 Pro and Fast: Azure public preview since 2025-12-11 at $2.50 (Pro) and $2.00 (Fast) per 1k search units; OpenRouter $0.0025/search (Pro) and $0.002 (Fast); 100+ languages; 32K context per document. Pro targets precision, Fast targets latency. No independent multilingual benchmark found — [Microsoft Tech Community](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/-/4477076); [Vercel AI Gateway](https://vercel.com/ai-gateway/models/rerank-v4-pro); [OpenRouter](https://openrouter.ai/cohere/rerank-4-pro); [Oracle OCI docs](https://docs.oracle.com/iaas/Content/generative-ai/cohere-rerank-4-0.htm)
- Voyage rerank-2.5 and rerank-2.5-lite: instruction-following, 32K context, multilingual; aggregator prices about $0.05/MTok (2.5) and $0.02/MTok (2.5-lite). No official price page retrieved — [MongoDB blog](https://mongodb.com/company/blog/product-release-announcements/rerank-2-5-and-rerank-2-5-lite-instruction-following-rerankers); [Vercel](https://vercel.com/ai-gateway/models/rerank-2.5); [OpenRouter rerank-2.5-lite](https://openrouter.ai/models/voyageai/rerank-2.5-lite-20260727)
- Voyage-4 launch post comparisons with Cohere Rerank v4.0 Pro appear in aggregator listings without clear model attribution; not relied on — [search note; aggregator listings]

### Inferences
- Cost per 1,000 queries (my calculation; assumes 50 candidates × ~500 tokens + query, about 25k tokens per query): Voyage rerank-2.5 ≈ $1.25; rerank-2.5-lite ≈ $0.50; Cohere Rerank 4 Pro ≈ $2.50 (per search unit; one search unit covers up to 100 documents, so 50 candidates of 500 tokens ≈ 1 unit — verify chunk-size rules); Cohere 4 Fast ≈ $2.00. Self-hosted Qwen3-Reranker: GPU time only.
- Recommendation: (1) start with an API reranker for chat. Add Voyage rerank-2.5 if adding a provider is acceptable (the app has `RAG_RERANKER=voyage` and `RAG_RERANK_VOYAGE_MODEL_BY_LANG` already), compared head-to-head with Cohere Rerank 4 Pro (`cohere`). (2) For voice (`RAG_RERANK_TIER_VOICE=fast`), use rerank-2.5-lite or Cohere 4 Fast. (3) Evaluate Qwen3-Reranker-4B in the sidecar as the open, self-hosted option. It has the best published multilingual and Chinese scores and is the natural pair for the Qwen3 embedder.
- Drop bge-reranker-v2-m3 as a primary (weaker in Qwen's table, mixed in Jina's), and jina-reranker v3/v3.5 for commercial use (non-commercial license).

### Gaps
- No Italian- or medical-specific reranker benchmark found.
- No measured latency figures for any reranker (API p50/p95 or self-hosted Qwen3-Reranker on a specific GPU).
- Cohere's own Rerank 4 benchmark post and Voyage's official rerank pricing page were not retrieved.
- Search for "rerank-v4" beyond 4.0 Pro/Fast found nothing newer.

## 6. Pricing per 1M tokens (late 2026) and self-hosting hardware

### Takeaway
Embedding the whole ~11M-token corpus costs between about $0.11 (Qwen3-8B on OpenRouter) and $1.65 (gemini-embedding-001), so ingestion cost does not decide the choice. Query-side embedding cost is also negligible. Self-hosting Qwen3-8B needs about 16 GB of GPU memory for weights in bf16 (4B ≈ 8 GB, 0.6B ≈ 1.2 GB).

### Cited Findings
- Qwen3-Embedding-8B on OpenRouter: $0.01/MTok (Nebius, DeepInfra), $0.04 (SiliconFlow) — [OpenRouter Qwen3-Embedding-8B](https://openrouter.ai/qwen/qwen3-embedding-8b)
- voyage-4-large: $0.12/MTok, first 200M tokens free per account, Batch API 33% cheaper; 32K-token input; 2048/1024/512/256 dims — [OpenRouter voyage-4-large](https://openrouter.ai/voyageai/voyage-4-large); [Voyage AI blog](https://blog.voyageai.com/2026/01/15/voyage-4/)
- Vendor prices as of 2026-11-23 per 1M tokens: voyage-4-lite $0.02; text-embedding-3-small $0.02; Cohere Embed 5 Fast $0.08; voyage-4 $0.06; voyage-4-large $0.12; Cohere embed-v5.0-pro $0.12; text-embedding-3-large $0.13; gemini-embedding-001 $0.15 ($0.075 batch); gemini-embedding-2 $0.20 ($0.10 batch) — [maximem.ai](https://www.maximem.ai/blog/best-embedding-models-2026) (secondary source); Cohere Embed 5 Pro and Fast prices are confirmed by [HPCwire](https://www.hpcwire.com/aiwire/2026/10/01/cohere-releases-embed-5-with-pro-and-fast-tiers-for-enterprise-ai/) and [eesel.ai](https://www.eesel.ai/blog/cohere-embed-5)
- Cohere Embed v4 is no longer listed with a per-token price on Cohere's price page (last listed $0.10/MTok) — [kunalganglani.com](https://www.kunalganglani.com/embedding-prices/embed-v4)
- Rough bf16 weight memory: about 16 GB (8B), 8 GB (4B), 1.2 GB (0.6B), before activations and batching; 32K-token inputs add activation memory — [maximem.ai](https://www.maximem.ai/blog/best-embedding-models-2026) (arithmetic estimate)
- Reranker prices: see section 5.

### Inferences
- Full-corpus embedding cost (my calculation, 11M tokens, ignoring chunk overlap of about 25%): Qwen3-8B $0.11–0.44; voyage-4-large $1.32 (covered by the free 200M tokens); Cohere Embed 5 Pro $1.32; text-embedding-3-large $1.43; gemini-embedding-001 $1.65. Re-embedding for each chunking or dimension variant in the eval is affordable.
- Self-hosting Qwen3-Embedding-8B and Qwen3-Reranker-4B together fits on one 24–48 GB GPU (L4 24 GB is tight for both with batching; L40S 48 GB or A100 is comfortable). This is an inference from parameter counts, not measured. The 0.6B models run on CPU or small GPUs but rank much lower (RTEB #126 for the embedder).
- OpenRouter routes Qwen3-8B to third-party hosts (Nebius, DeepInfra, SiliconFlow). For a multi-tenant deployment, check their data-retention terms; for single-tenant medical text that is public (AIFA documents), the risk is lower.

### Gaps
- Official Voyage, Google and Cohere price pages were not fetched directly; prices come from OpenRouter, Vercel and aggregators.
- No measured throughput or latency for self-hosted Qwen3-Embedding-8B or Qwen3-Reranker on a specific GPU.
