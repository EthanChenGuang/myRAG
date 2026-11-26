# Chunking strategy for RAG over Italian AIFA regulatory drug documents (RCP / FI)

Scope: about 800 AIFA PDFs (RCP following the EU QRD template, sections 1–11 with 4.x/5.x/6.x subsections; FI patient leaflets with their own QRD headings), averaging 15 pages, with a text layer. Research done 2026-11-26. A count of 18 tool calls; several questions remain partly open (see Gaps).

## 1. Structure-aware vs fixed-size vs recursive vs semantic chunking: what the evidence shows, and typical sizes and overlaps

### Takeaway
No independent benchmark shows that semantic or LLM chunking beats simple chunking consistently; the best size depends on the dataset and query type, and 256–1024 tokens (or page/section units) is the range that wins in most studies. For documents with strong headings (financial reports, regulatory documents), structure/element-based chunking matches or beats fixed-size chunking on answer accuracy with fewer chunks. For RCPs the natural recommendation is to split by QRD section with a token cap (about 400–800 tokens) and a fixed-size fallback inside long sections. That recommendation is an inference: no study tested it on SmPCs.

### Cited Findings
- **Element-based chunking (financial reports, Unstructured, vendor-authored):** FinanceBench (141 questions, 80 reports), multi-qa-mpnet embedder, top-10, GPT-4. Manual Q&A accuracy: fixed 128 tokens 35.46%, 256 tokens 36.88%, 512 tokens 48.23%. Element-based "Chipper" chunks reached 53.19% (Keywords and Prefix & Table Description variants) and 51.77% (Summary). Element chunking produced 20,843 chunks, against 16,046 at 512 tokens and 64,058 at 128 tokens. Page-retrieval accuracy for single Chipper strategies (46–67%) was lower than fixed 128/256 (72–73%), so the gain shows up in answers rather than in page hit rate. The authors are from Unstructured Technologies, the vendor of the element parser. — [Jimeno Yepes et al. 2024, arXiv 2402.05131](https://arxiv.org/html/2402.05131v3)
- **NVIDIA chunking study (vendor, 2024–2025):** Token chunks of 128 to 2048 with 15% overlap; 15% beat 10% and 20% on FinanceBench at 1024 tokens (not a full grid). Page-level chunking had the best average accuracy (0.648, lowest std 0.107); token strategies ranged 0.603–0.645. Section-level chunking (layout headings) was below page-level on average and slightly better only on FinanceBench. Per dataset: FinanceBench best at 1024 tokens (0.579), Earnings at 512 (0.681), KG-RAG page-level (0.520; 128 tokens gave the lowest result, 0.421); 2048 tokens fell below 1024 (FinanceBench 0.506). Recommendations: factoid queries → page-level or 256–512 tokens; analytical queries → page-level or 1024. Pipeline: llama-3.2-nv-embedqa-1b-v2 with reranker, top-k 10; tables and charts extracted as separate entities. — [NVIDIA developer blog](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/)
- **Chroma research (vendor, independent of chunker vendors):** text-embedding-3-large, 5 retrieved chunks. Recall: RecursiveCharacterTextSplitter at 400 tokens with no overlap 89.5%; 800/400 overlap (OpenAI default) 85.4% with the lowest precision and IoU (1.5); 200 tokens with no overlap 88.1% recall and the best precision among simple splitters (7.0). ClusterSemanticChunker at 400 reached 91.3%, LLMSemanticChunker 91.9%. Kamradt semantic chunking 83.6% (worse than plain recursive). Overlap reduces IoU. With the weaker all-MiniLM-L6-v2, overlap helped recall (82.4% with 250/125 vs 77.1% with none). — [Chroma, Evaluating Chunking](https://www.trychroma.com/research/evaluating-chunking)
- **Vectara (NAACL Findings 2025, vendor-authored):** Semantic chunking's gains are task-dependent and usually too small to justify its compute cost. With strong embeddings the chunking strategy mattered less than expected; Vectara uses fixed-size chunking in its product. — [Qu, Tu, Bao, arXiv 2410.13070](https://arxiv.org/html/2410.13070v1); [ACL Anthology](https://aclanthology.org/2025.findings-naacl.114); [Vectara blog](https://www.vectara.com/blog/is-semantic-chunking-worth-the-computational-cost)
- **Independent multi-objective study (Aug/Nov 2026, Univ. Passau group):** Eight chunking methods, two corpora, three embedders. Expensive chunking methods rarely give consistent retrieval gains over simple ones. The best method depends on the embedder, dataset, corpus size and metric. Methods with similar quality differ greatly in indexing and latency cost. Method names and numbers were not on the abstract page. — [Caspari et al., arXiv 2608.16586](https://arxiv.org/abs/2608.16586)
- **Clinical decision support (independent, academic, small):** Four pipelines that differed only in chunking; Gemini 1.0 Pro. Adaptive (topic-boundary-aligned) chunking reached 87% accuracy against 50% for fixed-size (p = 0.001), with 93% relevance. A later paper calls the range of methods tested limited. — [Gomez-Cabello et al., Bioengineering 2025, PMC12649634](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12649634/); critique in [arXiv 2606.00881](https://www.alphaxiv.org/abs/2606.00881)
- **Hospital document retrieval:** Chunking and embedding choices significantly affect retrieval in domain-specific RAG; recursive chunking keeps context but gives variable-length segments. — [SHTI 2025](https://journals.sagepub.com/doi/10.3233/SHTI251383)
- **Regulatory documents (general):** Static chunking with generic embeddings often fails to preserve semantic structure in regulatory text. — [arXiv 2601.17826](https://arxiv.org/pdf/2601.17826)

### Inferences
- RCP sections are short, self-contained units with standardized titles. That is the case where structure chunking has an edge (the Unstructured result) without the cost of semantic or LLM chunking (Chroma, Vectara, Passau).
- Suggested default: one chunk per QRD subsection (4.1, 4.2, 4.3 …). Split any section longer than about 600–800 tokens recursively (paragraph, then sentence) into pieces of about 300–500 tokens with 10–15% overlap. Merge very short sections (for example 4.7 or 6.1) only within the same parent heading, never across 4.x boundaries.
- Avoid the 800/400 default and very small chunks (128 tokens or fewer) for this corpus. Both underperformed in the Chroma, NVIDIA and PharmaQA.IT results.
- Under this repository's v2 stage graph, chunking choice should be tested as a chunking profile (`npm run rag:rechunk`, `python -m rag_eval.sweep chunking`) rather than adopted on literature alone.

### Gaps
- No study compares QRD-section chunking against fixed-size chunking on SmPCs or RCPs.
- The Passau study's per-method numbers and the Bioengineering study's sample size were not checked in full text.

## 2. How Italian drug-document RAG studies, and SmPC/EPAR/FDA label studies, chunk

### Takeaway
PharmaQA.IT, the only Italian RCP RAG benchmark found, uses plain fixed-size token chunks with overlap and no section awareness. Among its tested settings, the largest, 512 tokens with 128 overlap, was best for retrieval (hit@10 0.615) and QA. Its retrieval is within the single gold RCP rather than across a corpus, so it underestimates the cross-document difficulty of an 800-document index. FDA label benchmarks split by label section headers, but none compares chunkers.

### Cited Findings
- **PharmaQA.IT (EACL 2026 Industry, pp. 937–947; Zeinalipour, Zugarini, Zanollo, Rigutini):** 861 extractive QA pairs over AIFA RCPs taken from PharmaER.IT. Pages were selected from 1,077 leaflets, keeping documents of at least 10 pages. Questions were generated on page images by Qwen3-VL-235B-A22B and validated by experts. They cover indications, contraindications, dosage, warnings, interactions and pharmacological properties. RCPs average 15,149.6 tokens (median 13,153; range 3,992–78,809; Llama-3 tokenizer). — [ACL Anthology 2026.eacl-industry.70](https://aclanthology.org/2026.eacl-industry.70/); [PDF](https://aclanthology.org/2026.eacl-industry.70.pdf)
- **PharmaQA.IT chunking:** Fixed token chunks with overlap (CHUNK_TOKENS, CHUNK_OVERLAP) of [64,16], [128,32], [256,64] and [512,128]. Each chunk is labelled [Chunk N]. Dense retrieval uses multilingual-e5-base (cosine) with k = 10, and chunks are concatenated in document order. Only the RCP that holds the gold answer is chunked and searched. — [PDF §4.3](https://aclanthology.org/2026.eacl-industry.70.pdf)
- **PharmaQA.IT results:** Retrieval hit@10 rose with chunk size: 0.436 (64–16), 0.511 (128–32), 0.580 (256–64), 0.615 (512–128). For most strong models QA rose with chunk size too: Mistral-Small-24B F1 0.417 → 0.656 (EM 0.253 → 0.433), Llama-3.1-8B F1 0.475 → 0.618. Some models degraded with larger chunks (EuroLLM-9B F1 0.366 → 0.020, Minerva-7B, DeepSeek-7B), which the authors put down to long-context and JSON-format difficulty. Best API at 512–128: deepseek-chat F1 0.679 / EM 0.432; GPT-4.1 F1 0.636 / EM 0.367. Limitations the authors state: one retriever, no long-context or alternative retrievers, text-only (tables and figures ignored), no FI leaflets, no multi-hop or unanswerable questions. Even with retrieval restricted to one document, 38.5% of questions missed the gold span in the top 10 at the best setting. — [PDF §4.6, Tables 2–4, §6](https://aclanthology.org/2026.eacl-industry.70.pdf)
- **PharmaER.IT (expert.ai):** Italian NER dataset built from AIFA leaflets. GOLD set of 67 leaflets, SILVER set of 2,138 sampled from about 8,567 more; BIO tags (drug names, diseases, etc.); Apache-2.0. It is an NER resource with no RAG or chunking experiments; it is the source corpus for PharmaQA.IT. — [CEUR-WS Vol-4112 paper](https://ceur-ws.org/Vol-4112/109_main_long.pdf); [Hugging Face card](https://huggingface.co/datasets/expertai/PharmaER.IT/blob/main/README.md?code=true)
- **SmPC IDMP extraction (Frontiers in Medicine 2025):** RAG with embedding search beat rule-based retrieval. The best embedding model varied by type of information; BERT-F1 reached 0.98 for the medicinal product section; Claude 3.5 Sonnet beat Gemini 1.5 Flash. The abstract does not give chunking details. — [Frontiers in Medicine 10.3389/fmed.2025.1598979](https://www.frontiersin.org/journals/medicine/articles/10.3389/fmed.2025.1598979/full)
- **PlaceboBench (EMA SmPC corpus):** Retrieval results are presented as section-level chunks grouped by product. — [Hugging Face PlaceboBench](https://huggingface.co/datasets/blue-guardrails/PlaceboBench/viewer/default/train)
- **FDARxBench (FDA labels):** Each label is split into section-level passages using subheaders as delimiters. Metadata per chunk: section title, LOINC section code, chunk indices at document and section level, and drug-level metadata for provenance and citations. — [arXiv 2603.19539](https://arxiv.org/html/2603.19539v1)
- **AskFDALabel:** Evaluated at section level (476 labeling sections) and whole-document level (200 labels). — [Drug Safety 2025](https://link.springer.com/article/10.1007/s40264-025-01520-1); [PMC12098182](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12098182/)
- **Immunogenicity RAG over DailyMed package inserts:** The retriever's effectiveness limited RAG performance. — [SUNY Buffalo](https://researchconnect.buffalo.edu/en/publications/retrieval-augmented-generation-rag-for-natural-language-querying-/)
- **QRD template:** EMA's annotated QRD product-information template fixes the SmPC and PL section structure and headings that AIFA RCP/FI follow. — [EMA QRD annotated template v10.3](https://www.ema.europa.eu/en/documents/template-form/qrd-product-information-annotated-template-english-version-103_en.pdf); [AIFA RCP and FI page](https://www.aifa.gov.it/en/riassunto-caratteristiche-e-foglio-illustrativo)

### Inferences
- PharmaQA.IT is a good Italian eval set for this project (Hugging Face `VillanovaAI/PharmaQA.IT`, linked from the PDF). Its 512–128 result is a floor, not a ceiling: section-aware chunks and a stronger embedder than multilingual-e5-base were never tested.
- In an 800-document index the main extra failure mode is wrong-document retrieval, not wrong-span retrieval. Product, strength and section metadata, together with filters, matter more there than in PharmaQA.IT's single-document setup.
- The FDA practice of section chunks plus section-code metadata carries over directly: store QRD section numbers (`4.2`) and normalized section IDs as chunk metadata.

### Gaps
- No published study evaluates section-aware versus fixed chunking on Italian RCP/FI or on EMA EPARs.
- The PharmaQA.IT Hugging Face dataset was not inspected (license, availability).
- No FI (patient leaflet) RAG study was found.

## 3. Parent–child retrieval, contextual chunk headers, Anthropic Contextual Retrieval, late chunking

### Takeaway
Adding document- and section-level context to each chunk has the strongest published evidence. Anthropic's vendor result reports 35% fewer retrieval failures (49% with BM25, 67% with a reranker). Late chunking gives smaller, independent gains of about 3% relative nDCG and helps most with small chunks. For RCPs, a deterministic header (product + strength + manufacturer + section path) covers much of what an LLM-generated context adds, at no cost. That last point is an inference.

### Cited Findings
- **Anthropic Contextual Retrieval (vendor, Sept 2024):** Measured as top-20 retrieval failure rate (1 − recall@20, baseline 5.7%). Contextual embeddings cut failures by 35% (5.7 → 3.7%); adding contextual BM25 by 49% (→ 2.9%); adding reranking by 67% (→ 1.9%). A 50–100-token context generated by Claude 3 Haiku is prepended before embedding and BM25 indexing. With prompt caching the one-time cost is about $1.02 per million document tokens (800-token chunks, 8k-token docs). Top-20 chunks beat 5 or 10. For knowledge bases under about 200k tokens, skip RAG and put everything in the prompt. — [Anthropic](https://www.anthropic.com/news/contextual-retrieval)
- **Unstructured "Prefix & Table Description" chunks** (element chunks with a prefix and generated table descriptions) gave the best ROUGE/BLEU among single strategies (0.514 / 0.400) and 53.19% manual accuracy. — [arXiv 2402.05131](https://arxiv.org/html/2402.05131v3)
- **Late chunking (Jina AI, vendor-authored; v3 July 2025):** Embed the whole document with a long-context model and pool per chunk afterwards. On BEIR (SciFact, NFCorpus, FiQA, TREC-COVID), average nDCG@10 rose from 52.2 to 54.0 for fixed 256-token chunks; relative gains were 3.46% (fixed), 3.63% (sentence) and 2.70% (semantic). Largest gain was NFCorpus with jina-v2-small (23.5 → 30.0); TREC-COVID with jina-v3 rose 73.0 → 77.2; nomic was flat on some sets. It helps most with small chunks; with large chunks naive chunking sometimes wins on reading-comprehension tasks; it is useless when surrounding text is unrelated (needle tasks). — [Günther et al., arXiv 2409.04701](https://arxiv.org/html/2409.04701v3)
- **FDARxBench** keeps section and document chunk indices, which lets a system expand from a section passage to its neighbours or parent. — [arXiv 2603.19539](https://arxiv.org/html/2603.19539v1)
- **PharmaQA.IT:** Larger chunks help by "exposing more of the RCP and facilitating evidence aggregation", which is the motivation for small-to-big expansion. — [PDF](https://aclanthology.org/2026.eacl-industry.70.pdf)

### Inferences
- Recommended design: child chunks of about 200–400 tokens for embedding (precision; Chroma's 200–400 range); the full QRD subsection (e.g. all of 4.4) as the parent returned to the LLM (PharmaQA.IT's finding that bigger context helps answers). This maps onto the repo's `RAG_PARENT_CHILD` switch.
- Prepend a deterministic header to every child before embedding and BM25 indexing, for example `[Paracetamolo Krka 500 mg compresse | RCP | 4.2 Posologia e modo di somministrazione > Popolazione pediatrica]`. Header style and field order are suggestions, not tested. LLM contextualization (Anthropic style) is a later add-on: about $1/M tokens, and 800 docs × 15k tokens ≈ 12M tokens ≈ $12 at the quoted Haiku pricing (estimate from Anthropic's figure; current model prices differ).
- Late chunking requires a long-context embedder that exposes token embeddings (Jina-style). That rules it out for API embedders, including the OpenRouter Qwen3 embeddings used in this repo. Deterministic headers give a similar benefit for this corpus.

### Gaps
- No independent replication of Anthropic's 35/49/67% figures on medical or Italian text was found.
- There is no evidence on whether LLM-generated context adds anything over deterministic headers for highly templated documents.

## 4. Tables (4.8 adverse-reaction tables, posology tables): extraction and representation

### Takeaway
Parser choice matters more than chunk policy for tables: Docling scores well on table fidelity, PyMuPDF poorly. The evidence on whole-table versus row-wise representation is split. Row-level chunks with repeated headers won in one retrieval study; whole-table chunks won in another. For 4.8 SOC × frequency tables a hybrid is the safest choice (inference): keep the whole table as the parent, and index row-level children serialized as "SOC | frequency | reaction" with the section header.

### Cited Findings
- **OpenDataLoader benchmark:** Docling 0.882 overall / 0.887 table fidelity; Marker 0.861 / 0.808; Unstructured hi_res 0.841 / 0.588. PyMuPDF was not run there for AGPL licence reasons. — [opendataloader-bench](https://github.com/opendataloader-project/opendataloader-bench)
- **pdf-parser-benchmark (TEDS on table structure):** pdfplumber 93.4%, pymupdf4llm 84.8%, Docling 84.5%. Scores swing strongly by document type, for example pypdfium2 at 98.8% on legal documents vs 49.9% on invoices. — [pdf-parser-benchmark](https://github.com/applied-artificial-intelligence/pdf-parser-benchmark)
- **Academic comparison (2024):** PyMuPDF and pypdfium were best for text extraction; rule-based table extraction (including PyMuPDF) had substantial recall limitations. — [Adhikari & Agarwal, arXiv 2410.09871](https://arxiv.org/html/2410.09871v2)
- **Table representations (Ericsson, 3GPP specs):** 16 representations tested. Row-level chunks beat table-level chunks; best was row-level with the header repeated in each row and a pipe separator. — [arXiv 2408.17008](https://arxiv.org/pdf/2408.17008)
- **Contrary result (Turkish RAG, 2026):** Docling's structure chunking improved table-question accuracy by 17.0 points over fixed-length and 8.7 over semantic chunking, because it retrieves whole tables rather than fragments. — [arXiv 2608.26192](https://arxiv.org/pdf/2608.26192)
- **Serialization:** Converting rows into natural-language statements gave stronger retrieval than key-value serialization (industrial materials data, master's thesis). — [Chalmers thesis](https://odr.chalmers.se/bitstreams/3fb3afe8-5572-4fc8-bd41-d0e4debafcc5/download)
- **Unstructured:** Generated table descriptions as chunk prefixes produced the best single-strategy ROUGE/BLEU. — [arXiv 2402.05131](https://arxiv.org/html/2402.05131v3)
- **NVIDIA:** Tables and charts extracted as separate entities rather than chunked as running text. — [NVIDIA blog](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/)
- **PharmaQA.IT** ignores table content and lists multimodal QA over tables and figures as future work, so no Italian RCP table evidence exists. — [PDF §6](https://aclanthology.org/2026.eacl-industry.70.pdf)

### Inferences
- 4.8 tables are usually small (SOC rows × frequency columns), often tens of rows, and a whole table frequently fits in 500–1500 tokens. Index row-level children (header and SOC repeated, for example "4.8 Effetti indesiderati | Patologie del sistema nervoso | Comune (≥1/100, <1/10) | cefalea, capogiro") for precise retrieval, and return the whole table as the parent.
- Rendering the table in Markdown for the LLM keeps the frequency column semantics.
- Many 4.8 sections are prose lists rather than real tables in AIFA PDFs. The parser must handle both forms.

### Gaps
- No benchmark tests table extraction on Italian SmPC PDFs specifically; table-fidelity figures come from mixed corpora.
- There is no evidence on frequency-category questions ("quanto è frequente X?") over row vs whole-table representations.

## 5. Near-duplicate documents (generics sharing most text)

### Takeaway
No published study on separating near-duplicate SmPCs was found. Best practice therefore rests on inference from adjacent work: per-chunk product metadata and filters (as in FDARxBench), product/strength/manufacturer headers in the embedded text, and result diversification or dedup at query time.

### Cited Findings
- FDARxBench attaches drug-level metadata to every section chunk for provenance and citation tracking. — [arXiv 2603.19539](https://arxiv.org/html/2603.19539v1)
- PlaceboBench groups retrieved SmPC chunks by product. — [Hugging Face PlaceboBench](https://huggingface.co/datasets/blue-guardrails/PlaceboBench/viewer/default/train)
- Contextual prefixes (document-identifying context) reduce retrieval failures in Anthropic's test, the mechanism that distinguishes otherwise identical chunks. — [Anthropic](https://www.anthropic.com/news/contextual-retrieval)
- PharmaER.IT sampled 2,138 of about 8,567 leaflets, showing how large the AIFA corpus (and its redundancy) is. — [Hugging Face card](https://huggingface.co/datasets/expertai/PharmaER.IT/blob/main/README.md?code=true)

### Inferences
- Without headers, the 4.x text of two generics of the same active ingredient embeds almost identically. Top-k then fills with copies, crowding out other sections, and the answer may cite the wrong manufacturer or strength.
- Recommended measures:
  - Extract structured metadata from sections 1–3 and 7–8 (name, strength, pharmaceutical form, MAH, AIC number, active ingredient) and store it on every chunk.
  - Put product, strength and MAH in the chunk header.
  - Apply metadata filters when the query names a product (exact-ID lookup, which maps to `RAG_EXACT_ID_LOOKUP`).
  - Collapse results with a content hash per section (identical normalized section text → one hit listing all products) or use MMR at query time.
  - Group by active ingredient when the query is generic.
- The repo's `content_hash_dedup` stage works at document level. Section-level hashing would be a new extension (inference about this codebase, not verified).

### Gaps
- No study, vendor or academic, measures near-duplicate interference in drug-label RAG.
- No data were found on how much text AIFA generics share.

## 6. Parsing tools for Italian PDFs and detection of "4.2 Posologia"-style headings

### Takeaway
Docling is the best-supported open-source choice for layout and tables. PyMuPDF and pdfplumber are fast and accurate for text, and pdfplumber is strong on table structure. No source measures heading-detection reliability on Italian SmPCs. Because QRD headings are numbered and fixed, a regex/whitelist pass over the text layer (inference) is likely more reliable than any ML layout model for assigning section IDs.

### Cited Findings
- Docling leads overall and on table fidelity in OpenDataLoader bench (0.882 / 0.887). Marker 0.861 / 0.808; Unstructured hi_res 0.841 / 0.588. — [opendataloader-bench](https://github.com/opendataloader-project/opendataloader-bench)
- pdfplumber leads TEDS table structure (93.4%), ahead of pymupdf4llm (84.8%) and Docling (84.5%); results vary widely by document type. — [pdf-parser-benchmark](https://github.com/applied-artificial-intelligence/pdf-parser-benchmark)
- PyMuPDF/pypdfium are best at plain text extraction but weak at rule-based tables. — [arXiv 2410.09871](https://arxiv.org/html/2410.09871v2)
- Another 2025 benchmark of PDF parsers exists. — [harningle PDF parsers benchmark](https://harningle.github.io/2025/06/11/pdf-parsers-a-benchmark.html) (not read in detail)
- Blog claims of 97.9% Docling cell accuracy and pdfmux parity are unsourced or self-reported. — [DEV Community](https://dev.to/nameetp/pdfmux-vs-llamaparse-vs-docling-vs-unstructured-which-pdf-extractor-for-rag-in-2026-3agj)
- NVIDIA uses nemoretriever-parse for section-level chunks. Its section-level chunking underperformed page-level on average, which may partly reflect heading-detection quality (the blog does not say). — [NVIDIA blog](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/)
- The QRD template defines exact section numbers and titles, which AIFA documents follow in Italian translation. — [EMA QRD template](https://www.ema.europa.eu/en/documents/template-form/qrd-product-information-annotated-template-english-version-103_en.pdf); [AIFA](https://www.aifa.gov.it/en/presentazione-traduzioni-rcp-fi-etichette)

### Inferences
- Recommended pipeline:
  - Extract text and tables with Docling (already in this repo's sidecar).
  - Assign sections with a deterministic matcher. It takes the Italian QRD heading list (for example `^4\.2\.?\s+Posologia e modo di somministrazione`) and tolerates bold-only headings, line breaks inside headings, missing dots, and "4.2." vs "4.2" variants.
  - Then build the section tree and validate it: monotone numbering, all mandatory RCP sections 1–11 present. Flag documents that fail for review.
  - FI leaflets use QRD numbered headings 1–6 ("1. Che cos'è X e a cosa serve", "2. Cosa deve sapere prima di prendere X", …) plus subheadings that are not numbered; they need their own whitelist.
- Heading-level hierarchy from ML layout models is often unreliable, so do not depend on it. The numbering itself gives the hierarchy.
- Measure on a sample: share of documents with all expected sections detected, and how often 4.8 tables are fully recovered.

### Gaps
- No source reports heading-detection accuracy on SmPC/RCP PDFs for any parser, and none evaluates Italian-specific parsing.
- The Italian QRD template headings were not fetched; the exact Italian strings should come from the official Italian QRD template on the EMA site.
- Marker and LlamaParse were not checked on numbered regulatory headings.
