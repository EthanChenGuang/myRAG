# Query rewrite gate (LAT-03) — locked spec

Status: locked by the user on 2026-11-23. Phase 6 must implement this as `src/lib/rag/query/rewrite-gate.ts` (native TypeScript, no LLM call, < 1 ms per query), used by the QRY-05 router to decide which transforms run.

The user's four rules and the minimum-length rule are mandatory. The rules added below (R5–R12) are recommended additions. All rules work in Chinese, English and Italian.

## Output

The gate returns every rule that fired, not just the first one, so the router can run more than one transform. The original query is always retrieved as well (QRY-05).

```ts
type Lang = 'zh' | 'en' | 'it';
type Transform =
  | 'condense_history'   // QRY-01  rewrite with conversation history
  | 'normalize_dates'    // deterministic, no LLM: relative time → absolute date range
  | 'decompose'          // QRY-04  sub-questions
  | 'expand'             // QRY-02  multi-query (HyDE only if switched on, never in voice)
  | 'translate';         // XLG-01  query language ≠ knowledge-base language

interface GateResult {
  rewrite: boolean;            // true if any LLM transform is needed
  transforms: Transform[];
  reasons: string[];           // stable rule IDs, e.g. "R1_PRONOUN" (logged in the trace)
  lang: Lang;
  protectedTokens: string[];   // must appear verbatim in every rewritten query
  skipRetrieval?: boolean;     // R12 small talk
}

function needsRewrite(q: string, ctx: { hasHistory: boolean; kbLang?: Lang; now: Date }): GateResult;
```

## Rules

### User rules (mandatory)

**R1. Pronouns and references** → `condense_history`. Applies only when there is history.

- zh: 它, 这个, 那个, 这些, 那些, 他们, 上面, 刚才, 前面说的, 该
- en: it, its, this, that, these, those, they, them, their, above, previous, earlier, the former, the latter, the same
- it: esso, essa, questo, questa, questi, queste, quello, quella, quelli, quelle, loro, sopra, precedente, prima, suddetto, stesso, lo stesso, ne

**R2. Relative time** → `normalize_dates`. This uses deterministic date arithmetic from `ctx.now`, so it needs no LLM. It also adds a date filter (DATA-08).

- zh: 去年, 今年, 前年, 上个月, 这个月, 本月, 上周, 本周, 最近, 昨天, 今天, 上季度, 本季度, 近N天/月/年
- en: last year, this year, the year before last, last month, this month, last week, this week, recently, lately, yesterday, today, last quarter, this quarter, past N days/months/years
- it: l'anno scorso, quest'anno, due anni fa, il mese scorso, questo mese, la settimana scorsa, questa settimana, di recente, recentemente, ieri, oggi, lo scorso trimestre, questo trimestre, negli ultimi N giorni/mesi/anni

**R3. Comparison or several objects** → `decompose`.

- zh: 和, 与, 跟, 哪个, 对比, 比较, 区别, 差异, 不同, 优劣
- en: vs, versus, compare, comparison, difference, differences, which is better, which one, or, between … and
- it: vs, rispetto a, confronta, confronto, differenza, differenze, quale è meglio, quale, oppure, tra … e
- Caveat: 和, 与, 跟, "and" and "e" also appear in plain questions. A false positive only costs one decomposition call, and the decomposer may return the original question unchanged.

**R4. Exact codes** (error codes, model numbers, IDs). These are never rewritten, so the LLM cannot alter them.

- The user's pattern `[A-Z]+[_-][A-Z0-9_-]+|\b[A-Z]{2,}\d+\b`, plus the R7 tokens, is added to `protectedTokens`.
- If the query contains a code and is complete (it meets the minimum length and has no R1 trigger), the gate returns no rewrite ("含精确编号，直接检索").
- Fix to the original logic: in the original code, a code blocked the history rewrite. A follow-up such as "那个 ERR_TIMEOUT 怎么修？" with history must still be condensed. Here the code goes into `protectedTokens`, and the condense step must keep it verbatim.

**R0. Too short** → `expand`. "Too short" means fewer than 6 characters in Chinese, or fewer than 3 words in English or Italian. Length is counted per language because a Chinese character carries more than an English or Italian letter.

### Added rules (recommended)

**R5. Elliptical follow-up** → `condense_history`. Applies only with history. These questions name no subject at all.

- zh: 那…呢, …呢？, 还有呢, 然后呢, 为什么, 怎么做
- en: what about, how about, and for, and the, why, how come
- it: e per, e il, e la, che ne dici di, perché, come mai

**R6. Compound question** (several asks in one) → `decompose`.

- zh: 并且, 以及, 同时, 另外, 还有, 分别
- en: and also, as well as, additionally, respectively, plus
- it: e anche, inoltre, nonché, rispettivamente
- It also fires on two or more question marks.

**R7. Protected literals.** These are never rewritten and are added to `protectedTokens`:

- quoted text ("…", “…”, 「…」, «…»)
- URLs and e-mail addresses
- numbers with units or currency (500元, €1,200, 30%)
- explicit dates
- version strings (v2.3.1)

**R8. Language mismatch** → `translate`. Applies when the detected query language differs from `ctx.kbLang` (XLG-01). Original and translated queries are retrieved in parallel and fused with RRF. Translation must also preserve `protectedTokens`.

**R9. Keyword-only query** (no question form, for example "酒店 报销 上限" or "hotel reimbursement limit") → `expand`. Applies when the query has no question word, no question mark and no verb marker, and has two or more terms.

**R10. Vague, open question** → `expand`.

- zh: 怎么办, 有什么, 介绍一下, 说说, 讲讲
- en: tell me about, what can you, anything about, overview of
- it: parlami di, cosa sai di, panoramica di
- Not applied when R4 fired.

**R11. Long, complete question.** A question above about 30 Chinese characters or 15 words, with no R1/R2/R3/R5/R6/R8 trigger, is not rewritten. Rewriting a question that is already complete adds latency and can drift from what was asked.

**R12. Small talk or greeting** (你好, 谢谢, hi, thanks, ciao, grazie), when it is the whole query → `skipRetrieval`. No rewrite and no retrieval, and the strict-mode refusal does not fire.

## Matching rules

- Chinese terms are matched as substrings. Ambiguous single characters use patterns:
  - 该 only at the start of the query or before a noun such as 产品/文档/条款/公司/功能, so 应该 does not match.
  - 它 is matched freely.
- English and Italian terms are matched case-insensitively on word boundaries, with Italian elisions normalized (l'anno → l' anno).
- Language detection:
  - CJK characters ≥ 30% → zh.
  - Otherwise, an Italian stopword score (il, lo, la, gli, che, di, è, perché, quale, come, sono, della) above the English one (the, is, are, what, which, how, of) → it.
  - Otherwise → en.
- All word lists live in one data file (`src/lib/rag/query/rewrite-gate.lexicon.json`) keyed by language, not in branching code. The voice profile reads the same lexicon but only runs `condense_history` and `normalize_dates` (QRY-07).

## Safety checks after an LLM rewrite

- **Protected tokens.** Every rewritten or translated query must contain every protected token verbatim. A variant that drops or alters one is discarded and logged, and the original is used.
- **Variant limit.** The router keeps at most 2 variants by default (LAT-03).
- **Budget.** The gate itself must stay under 1 ms. A transform that exceeds its budget is skipped (QRY-05).

## Required tests (fixture table, zh/en/it each)

| Input | History | Expected |
|---|---|---|
| 它的保修期多久？ / How long is its warranty? / Quanto dura la sua garanzia? | yes | condense_history (R1) |
| 它的保修期多久？ | no | no condense; expand only if short |
| 去年的营收是多少？ / What was revenue last year? / Qual è stato il fatturato l'anno scorso? | — | normalize_dates (R2), date filter set |
| A 和 B 有什么区别？ / What is the difference between A and B? / Qual è la differenza tra A e B? | — | decompose (R3) |
| ERR_TIMEOUT 是什么意思？ / What does ERR_TIMEOUT mean? | no | no rewrite, protected = [ERR_TIMEOUT] (R4) |
| 那个 ERR_TIMEOUT 怎么修？ | yes | condense_history, protected = [ERR_TIMEOUT] (R1 + R4 fix) |
| 退款 / refund / rimborso | — | expand (R0) |
| 那意大利呢？ / What about Italy? / E per l'Italia? | yes | condense_history (R5) |
| What is the hotel reimbursement limit? (kbLang = zh) | — | translate (R8) |
| 酒店 报销 上限 | — | expand (R9) |
| 你好 / thanks / grazie | — | skipRetrieval (R12) |
| 我们公司员工在出差期间入住酒店时每晚可以报销的最高金额是多少 | no | no rewrite (R11) |
| 应该怎么申请？ | no | 该 does not fire R1 |
