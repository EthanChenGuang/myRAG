import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const AGENTS = fs.readFileSync(path.resolve(__dirname, '../../AGENTS.md'), 'utf8');

describe('AGENTS.md reflects the Phase 2 behaviour', () => {
  test.each([
    'verified `empty` retrieval status',
    'is never reported as "information not available"',
    '`@/lib/rag`',
    '`SUPABASE_SERVICE_ROLE_KEY`',
    '`RAG_EMBED_TENANT`',
    '`RAG_VOICE_TOKEN_SECRET`',
    '`myrag-voice-<random>`',
    'operator\'s MCP account is admin-only',
    'A Supabase session is required for image/video/3D generation',
    'owner-or-admin',
  ])('mentions %s', (fragment) => {
    expect(AGENTS).toContain(fragment);
  });

  test('keeps the strict-mode and web search behaviour lines', () => {
    expect(AGENTS).toContain('"information not available" response');
    expect(AGENTS).toContain('Exa-powered web search');
    expect(AGENTS).toContain('`source_images`');
  });
});

describe('AGENTS.md reflects the Phase 5.1 prompt-injection defense', () => {
  test.each([
    '`RAG_CONTEXT_TAGGING=false`',
    '`RAG_INJECTION_CHECK=off`',
    '`RAG_INJECTION_PROMPT_GUARD=false`',
    '`RAG_INJECTION_LAKERA=false`',
    '`RAG_INJECTION_LAKERA_MULTI_TENANT_ACK=false`',
    '`RAG_TOOL_RESULT_GUARD=off`',
    '`NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST=false`',
    'Off reproduces the pre-5.1 chat byte for byte.',
    'Recommended configuration for the Phase 7 regression: `RAG_CONTEXT_TAGGING=true`, `RAG_INJECTION_CHECK=drop`, rules only',
    'eval/config/phase51-comparison.json',
    'Listing `injection_check` in `RAG_DISABLED_STAGES` disables the check even while `RAG_INJECTION_CHECK` is on; the app logs one `[RAG Config]` warning.',
    '`LAKERA_GUARD_BASE_URL` selects the region',
    'it covers en and it only (no zh)',
    'deploy the app first, then the agent',
    'Tool results (Exa web search, approved MCP results) are data, not instructions',
    'auto-approval is suspended for any turn whose context held flagged content',
    'it is inlined at build time, so it takes effect only after a rebuild',
    'strict "information not available", the webSearch strict path with Exa and `source_images` are unchanged',
  ])('mentions %s', (fragment) => {
    expect(AGENTS).toContain(fragment);
  });
});

describe('AGENTS.md reflects the Phase 3.1.1 domain embedding bindings', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));

  test.each([
    '`RAG_DOMAIN_EMBEDDINGS=off`',
    '`npm run rag:embedding -- bindings`',
    'binding',
    'additive',
    'real items',
    'stale',
    'scoped re-embed',
  ])('section 6 mentions %s', (fragment) => {
    expect(section6).toContain(fragment);
  });

  test('the fold sentence names Phase 3.1.1', () => {
    expect(AGENTS).toContain('Phase 3.1.1 (0440–0442)');
  });
});

describe('AGENTS.md reflects the Phase 4.1 retrieval-defaults outcome', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));
  const section14 = AGENTS.slice(AGENTS.indexOf('## 14. Behaviour to Preserve'), AGENTS.indexOf('## 15. Quality Checklist'));

  test.each([
    '`RAG_RERANKER=auto`',
    '`RAG_REFUSAL_FLOOR=similarity`',
    '`RAG_PIPELINE=legacy`',
    'eval/decisions/04.1-retrieval-defaults.md',
    'until the supported languages are chosen',
    '`languages_not_configured`',
    'sends query and candidate text to Cohere',
  ])('section 6 mentions %s', (fragment) => {
    expect(section6).toContain(fragment);
  });

  test('section 14 names the legacy relevance rule without a single global threshold', () => {
    expect(section14).toContain('`RAG_REFUSAL_FLOOR=legacy_rule`');
    expect(section14).not.toContain('the refusal threshold');
  });
});

describe('AGENTS.md reflects Phase 3.2 language support and ingestion hardening', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));
  const section14 = AGENTS.slice(AGENTS.indexOf('## 14. Behaviour to Preserve'), AGENTS.indexOf('## 15. Quality Checklist'));
  const section16 = AGENTS.slice(AGENTS.indexOf('## 16. Handy Scripts'), AGENTS.indexOf('## 17. Supplementary Documentation'));

  test.each([
    '### Language support and ingestion hardening (Phase 3.2)',
    '`RAG_SUPPORTED_LANGUAGES=`',
    '`RAG_PRIMARY_LANGUAGE=`',
    '`getLanguageSettings()`',
    'config/rag/validate-language-settings.cjs',
    '`languages_not_configured`',
    'config/rag/language-packs.json',
    'scripts/ci/language-literal-allowlist.json',
    '`RAG_LANGUAGE_AWARE_INGEST=off`',
    '`RAG_TABLE_HEADER_REPEAT=always`',
    '`RAG_TABLE_ROW_SERIALIZATION=false`',
    '`RAG_CAPTION_LANGUAGE=en`',
    '`RAG_BGE_M3_SERVING=hosted`',
    '`RAG_DOC_TRANSLATION=off`',
    '`RAG_DOC_TRANSLATION_MODEL=`',
    '`RAG_HIDDEN_TEXT_CHECK=off`',
    '`RAG_INGEST_LINK_CHECK=off`',
    '`RAG_OUTPUT_LINK_ALLOWLIST=`',
    '`RAG_UPLOAD_APPROVAL=off`',
    '`RAG_SCOPE_TAGS=false`',
    '`RAG_SCOPE_TAG_SUGGEST=false`',
    '`RAG_SUPERSESSION_DETECT=off`',
    '`RAG_EFFECTIVE_DATES=false`',
    '`RAG_EFFECTIVE_DATE_LLM_EXTRACT=false`',
    'npm run rag:fingerprint',
    'npm run rag:rebuild -- start --mechanism',
    'npm run rag:translate',
    'npm run rag:reembed -- --recaption',
    'eval/decisions/03.2-table-header-default.json',
    '`upload_approval_requires_unified_pipeline`',
    '`clean`, `hidden_found` or `not_checked`',
    'Migrations 0801–0822',
    're-run the whole 08xx block',
  ])('section 6 mentions %s', (fragment) => {
    expect(section6).toContain(fragment);
  });

  test('every Phase 3.2 switch default in the guide matches src/lib/env.ts', () => {
    const envSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/env.ts'), 'utf8');
    const block = section6.slice(section6.indexOf('(Phase 3.2)'), section6.indexOf('### Hybrid retrieval (Phase 4)'));
    const defaults = block
      .split('\n')
      .filter((line) => line.startsWith('- Languages:') || line.startsWith('- Other switches'))
      .join('\n');
    const stated = [...defaults.matchAll(/`(RAG_[A-Z0-9_]+)=([^`]*)`/g)];
    expect(stated.length).toBeGreaterThanOrEqual(18);
    for (const [, name, value] of stated) {
      const match = envSource.match(new RegExp(`${name}: process\\.env\\.${name} \\|\\| '([^']*)'`));
      if (!match) continue;
      expect(`${name}=${match[1]}`).toBe(`${name}=${value}`);
    }
  });

  test('the fold sentence lists the 08xx block as not folded, and sections 14 and 16 are current', () => {
    expect(AGENTS).toContain('Phase 3.2 (0801–0822)');
    expect(section14).toContain('Phase 3.2 is additive');
    for (const command of ['rag:fingerprint', 'rag:rebuild', 'rag:translate', 'rag:reembed -- --recaption']) expect(section16).toContain(command);
  });
});

describe('AGENTS.md reflects the Phase 5.1.1 feedback loop', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));
  const start = section6.indexOf('### Feedback loop (Phase 5.1.1)');
  const subsection = start === -1 ? '' : section6.slice(start, section6.indexOf('\n### ', start + 1) === -1 ? undefined : section6.indexOf('\n### ', start + 1));

  test('section 6 has the Feedback loop subsection', () => {
    expect(start).toBeGreaterThan(-1);
  });

  test.each([
    '`RAG_RETRIEVAL_LOG=off`',
    '`RAG_RETRIEVAL_LOG_RETENTION_DAYS=30`',
    '`RAG_REFUSAL_FEEDBACK=false`',
    '`RAG_EMBED_FEEDBACK=false`',
    '`RAG_EMBED_FEEDBACK_SECRET=`',
    '`RAG_SOURCE_OPEN_SIGNAL=false`',
    '`RAG_DOMAIN_EXPERT_REVIEW=false`',
    'no answer, chunk or document text',
    'The language columns hold codes only',
    'only in `masked_query` mode',
    'opt out',
    'cascade',
    'Nobody is implicitly an expert in multi-tenant mode',
    'npm run rag:feedback-loop -- mine',
    'npm run rag:feedback-loop -- purge',
    'python -m rag_eval.review_queue promote-db',
    'python -m rag_eval.feedback_exports',
    'python -m rag_eval.failure_report',
    'python -m rag_eval.weekly_report',
    'python -m rag_eval.ship_check',
    'eval/config/gate-population.json',
    'requires a passing ship check',
    '`TrainingPair`',
    '`held_out` pairs never train',
    'confirmed hard negatives are the ones an expert rejected',
    'eval/config/phase5.1.1-comparison.json',
  ])('the subsection mentions %s', (fragment) => {
    expect(subsection).toContain(fragment);
  });

  test('every switch default in the subsection defaults line matches src/lib/env.ts', () => {
    const envSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/env.ts'), 'utf8');
    const defaults = subsection.split('\n').find((line) => line.startsWith('- Every Phase 5.1.1 switch')) ?? '';
    const stated = [...defaults.matchAll(/`(RAG_[A-Z0-9_]+)=([^`]*)`/g)].filter(([, name]) => envSource.includes(`${name}: process.env.${name} ||`));
    expect(new Set(stated.map(([, name]) => name)).size).toBe(7);
    for (const [, name, value] of stated) {
      const match = envSource.match(new RegExp(`${name}: process\\.env\\.${name} \\|\\| '([^']*)'`));
      expect(`${name}=${match?.[1]}`).toBe(`${name}=${value}`);
    }
  });

  test('the fold sentence names Phase 5.1.1', () => {
    expect(AGENTS).toContain('Phase 5.1.1 (0531–0537)');
  });
});

describe('AGENTS.md reflects the Phase 6 query layer and semantic cache', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));
  const section14 = AGENTS.slice(AGENTS.indexOf('## 14. Behaviour to Preserve'), AGENTS.indexOf('## 15. Quality Checklist'));
  const section15 = AGENTS.slice(AGENTS.indexOf('## 15. Quality Checklist'), AGENTS.indexOf('## 16. Handy Scripts'));

  test.each([
    '`RAG_QUERY_LAYER=false`',
    '`RAG_QUERY_FRAMEWORK=llamaindex`',
    '`RAG_QUERY_VOICE_TRANSFORMS=condense_history,normalize_dates`',
    '`VOICE_SERVER_QUERY_REWRITE`',
    '`RAG_SEMANTIC_CACHE=off`',
    '`/api/rag/admin/semantic-cache`',
    '`eval/config/semantic-cache.json`',
    '`python -m rag_eval.calibrate cache`',
    '`rag_tenant_language_shares`',
    'eval/config/phase6-comparison.json',
  ])('section 6 mentions %s', (fragment) => {
    expect(section6).toContain(fragment);
  });

  test('the fold sentence names Phase 6', () => {
    expect(AGENTS).toContain('Phase 6 (0601–0603)');
  });

  test('section 14 keeps small talk, strict refusal and cache hits', () => {
    expect(section14).toContain('small talk skips retrieval only under the layer');
    expect(section14).toContain('`cache: hit`');
  });

  test('section 15 names the zod isolation check and the LangChain and query-LLM boundary', () => {
    expect(section15).toContain('node scripts/ci/check-zod-isolation.mjs');
    expect(section15).toContain('`src/lib/rag/query/langchain/`');
    expect(section15).toContain('`src/lib/rag/query/llm`');
  });
});

describe('AGENTS.md reflects Phase 6.1 (embedding fine-tuning)', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));

  test.each([
    '### Embedding fine-tuning (Phase 6.1)',
    '`RAG_FINETUNE=off`',
    '`ft-a-1024`',
    '`ft-b-1024`',
    '`npm run rag:finetune -- ',
    '`npm run rag:embedding -- ft-consent',
    'python -m rag_eval.finetune ',
    'prune',
    '06.1-19',
  ])('section 6 mentions %s', (fragment) => {
    expect(section6).toContain(fragment);
  });

  test('the fold sentence names Phase 6.1', () => {
    expect(AGENTS).toContain('Phase 6.1 (0651–0654)');
  });
});

describe('AGENTS.md reflects Phase 5.2 (grounded answers and output safety)', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));
  const section11 = AGENTS.slice(AGENTS.indexOf('## 11. WhatsApp Integration'), AGENTS.indexOf('## 12. Payments & Auth'));
  const section14 = AGENTS.slice(AGENTS.indexOf('## 14. Behaviour to Preserve'), AGENTS.indexOf('## 15. Quality Checklist'));
  const start = section6.indexOf('### Grounded answers and output safety (Phase 5.2)');
  const next = start === -1 ? -1 : section6.indexOf('\n### ', start + 1);
  const subsection = start === -1 ? '' : section6.slice(start, next === -1 ? undefined : next);
  const SWITCHES = [
    'RAG_REGISTRY_TEXTS',
    'RAG_PARTIAL_ANSWER_RULE',
    'RAG_CONTEXT_RELEVANCE_RULE',
    'RAG_CITATION_PER_SENTENCE',
    'RAG_CLAIM_CHECK',
    'RAG_GROUNDEDNESS_LLM_JUDGE',
    'RAG_GROUNDEDNESS_JUDGE_MODEL',
    'RAG_MAX_OUTPUT_TOKENS',
    'RAG_OUTPUT_GUARD',
    'RAG_VERSION_LABELS',
    'RAG_SECURITY_EVENTS',
    'RAG_UPLOADER_ALERT_THRESHOLD',
    'RAG_UPLOADER_ALERT_WINDOW_HOURS',
    'RAG_UPLOADER_HOLD',
  ];

  test('section 6 has the Phase 5.2 subsection', () => {
    expect(start).toBeGreaterThan(-1);
  });

  test('the defaults line states the fourteen switches with the defaults of src/lib/env.ts', () => {
    const envSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/env.ts'), 'utf8');
    const defaults = subsection.split('\n').find((line) => line.startsWith('- Every Phase 5.2 switch')) ?? '';
    const stated = new Map([...defaults.matchAll(/`(RAG_[A-Z0-9_]+)=([^`]*)`/g)].map(([, name, value]) => [name, value]));
    for (const name of SWITCHES) {
      const match = envSource.match(new RegExp(`${name}: process\\.env\\.${name} \\|\\| '([^']*)'`));
      expect(match, name).not.toBeNull();
      expect(`${name}=${stated.get(name)}`).toBe(`${name}=${match?.[1]}`);
    }
  });

  test.each([
    'Migrations 0940–0945',
    'not folded',
    're-run 0410',
    'python -m rag_eval.sweep output-cap',
    'python -m rag_eval.calibrate groundedness-judge',
    'eval/config/phase52-comparison.json',
    '`%%NO_ANSWER_IN_CONTEXT%%`',
    'The judge sends the answer and its context blocks to',
  ])('the subsection mentions %s', (fragment) => {
    expect(subsection).toContain(fragment);
  });

  test('section 11 names WhatsApp filtering and the Baileys link previews', () => {
    expect(section11).toContain('`RAG_OUTPUT_GUARD`');
    expect(section11).toContain('link preview');
  });

  test('section 14 keeps the strict refusal uncut in the question language with every Phase 5.2 switch on', () => {
    expect(section14).toContain('Phase 5.2 is additive');
    expect(section14).toContain('never cut');
  });
});

describe('AGENTS.md reflects the Phase 4.3 document access groups', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));
  const subsection = section6.slice(section6.indexOf('### Document access groups (Phase 4.3)'), section6.indexOf('### Verified citations and groundedness (Phase 5)'));
  const ENV = fs.readFileSync(path.resolve(__dirname, '../../src/lib/env.ts'), 'utf8');

  test('section 6 has the Phase 4.3 subsection before Phase 5', () => {
    expect(section6.indexOf('### Document access groups (Phase 4.3)')).toBeGreaterThan(-1);
    expect(subsection.length).toBeGreaterThan(0);
  });

  test.each([
    '`RAG_DOC_ACCESS_GROUPS=off`',
    '`RAG_EMBED_ACCESS_GROUP=`',
    'Migrations 0920 to 0939',
    'are not folded into the setup files',
    're-run the block in order, then 0410',
    '`verifyAccessGroupsStartup`',
    '`rag_access_set_enforced`',
    '`rag_access_readiness`',
    '`/api/rag/access-groups`',
    '`scopeAccessFilter(scope)`',
    '`document_chunks.access_groups`',
    '`[RAG Access] body_group_claim_ignored`',
    '`[RAG Access] embed_group_not_found`',
    'public `chat-images` bucket',
    'changes visibility only in single-tenant mode',
    '`eval/config/runs/access-groups-on.json`',
    '`tests/rag/access/routes-access-canary.test.ts`',
    'never "information not available"',
  ])('mentions %s', (fragment) => {
    expect(subsection).toContain(fragment);
  });

  test('the documented defaults match src/lib/env.ts', () => {
    expect(ENV).toContain("RAG_DOC_ACCESS_GROUPS: process.env.RAG_DOC_ACCESS_GROUPS || 'off'");
    expect(ENV).toContain("RAG_EMBED_ACCESS_GROUP: process.env.RAG_EMBED_ACCESS_GROUP || ''");
  });

  test('the documented names exist in the code', () => {
    const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    expect(read('src/instrumentation.ts')).toContain('verifyAccessGroupsStartup');
    expect(read('src/lib/rag/index.ts')).toContain('scopeAccessFilter');
    expect(fs.existsSync(path.resolve(__dirname, '../../src/app/api/rag/access-groups/route.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve(__dirname, '../../supabase/migrations/0920_access_groups_tables.sql'))).toBe(true);
  });
});

describe('AGENTS.md reflects Phase 6.3 (source deletion sync and purge)', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));
  const start = section6.indexOf('### Source deletion sync and purge (Phase 6.3)');
  const next = section6.indexOf('\n### ', start + 1);
  const subsection = start === -1 ? '' : section6.slice(start, next === -1 ? undefined : next);
  const ENV = fs.readFileSync(path.resolve(__dirname, '../../src/lib/env.ts'), 'utf8');

  test.each([
    '`RAG_SOURCE_RECHECK=false`',
    '`RAG_SOURCE_RECONCILE_MAX_AGE_DAYS=7`',
    '`RAG_SOURCE_RECONCILE_MAX_DELETE_SHARE=0.3`',
    '`RAG_SOURCE_PURGE_DAILY_CAP=0` (0 is off: no cap)',
    '`npm run rag:source-reconcile`',
    '`POST /api/internal/rag/source-reconcile` (refused unless `RAG_SIDECAR_SECRET` is set',
    'not Vercel cron',
    'confirms within 24 hours',
    '`POST /api/rag/admin/documents/[id]/purge`',
    '`rag_purge_verify`',
    '`rag_purge_store_inventory()`',
    'always on for Weaviate and Qdrant',
    'a source-sync purge leaves none',
    'After re-running 0727, re-run 0746 and then 0747',
    'after re-running 0963, re-run 1013',
    '`rag_monitor_alerts`',
    'set `RAG_SOURCE_PURGE_DAILY_CAP=200` (the shipped default stays 0)',
    'tagged `source_purged`',
  ])('mentions %s', (fragment) => {
    expect(subsection).toContain(fragment);
  });

  test('section 9 names the SharePoint and OneDrive switch and keys', () => {
    const section9 = AGENTS.slice(AGENTS.indexOf('## 9. Cloud Connectors'), AGENTS.indexOf('## 10. MCP'));
    for (const name of ['`NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED=false`', '`NANGO_SHAREPOINT_INTEGRATION_KEY`', '`NANGO_ONEDRIVE_INTEGRATION_KEY`']) {
      expect(section9).toContain(name);
    }
  });

  test('the 4.2 and 4.4 re-run rules go through 0932 before 0936 and end with 0938', () => {
    expect(AGENTS).toContain('re-run 0932, 0936 and then 0938 (Phase 4.4) in that order: with 0938 applied, 0936 on its own stops with 55000.');
    expect(AGENTS).toContain('Never re-run 0936 alone once 0938 is applied');
    expect(AGENTS).not.toContain('after re-running 0932 or 0936, re-run what follows it in that order');
  });

  test('the documented defaults match src/lib/env.ts', () => {
    expect(ENV).toContain("RAG_SOURCE_RECHECK: process.env.RAG_SOURCE_RECHECK || 'false'");
    expect(ENV).toContain("RAG_SOURCE_PURGE_DAILY_CAP: process.env.RAG_SOURCE_PURGE_DAILY_CAP || '0'");
    expect(ENV).toContain("RAG_SOURCE_RECONCILE_MAX_AGE_DAYS: process.env.RAG_SOURCE_RECONCILE_MAX_AGE_DAYS || '7'");
  });
});

describe('AGENTS.md reflects the Phase 7 RAG pipeline guide', () => {
  test.each([
    'README_RAG_PIPELINE.md',
    'RAG_RETRIEVAL_BACKEND',
    '[Vector Sync]',
    'npm run rag:vector-sync',
    'npm run rag:reconcile',
    'rag_eval.regression',
    'rag_eval.failure_report',
    'external vector stores always filter by tenant',
  ])('mentions %s', (fragment) => {
    expect(AGENTS).toContain(fragment);
  });

  test('links the pipeline guide from the RAG pipeline section and from section 17', () => {
    const pipeline = AGENTS.slice(AGENTS.indexOf('### RAG pipeline'), AGENTS.indexOf('### Image RAG'));
    const section17 = AGENTS.slice(AGENTS.indexOf('## 17. Supplementary Documentation'));
    expect(pipeline).toContain('README_RAG_PIPELINE.md');
    expect(section17).toContain('README_RAG_PIPELINE.md');
  });
});

describe('AGENTS.md reflects the Phase 7 revision-4 workflows', () => {
  const section6 = AGENTS.slice(AGENTS.indexOf('## 6. RAG & Data Pipeline'), AGENTS.indexOf('## 7. AI Model Management'));
  const pipeline = AGENTS.slice(AGENTS.indexOf('### RAG pipeline'), AGENTS.indexOf('### Image RAG'));
  const phase44 = AGENTS.slice(AGENTS.indexOf('### True BM25 lexical scoring (Phase 4.4)'), AGENTS.indexOf('### Terminology dictionary (Phase 4.1.1)'));
  const section16 = AGENTS.slice(AGENTS.indexOf('## 16. Handy Scripts'), AGENTS.indexOf('## 17. Supplementary Documentation'));

  test.each([
    '`RAG_ROLLOUTS=false`',
    '`RAG_LANG_CONFIDENCE=mapped`',
    '`npm run rag:rollout',
    '`npm run rag:languages',
    '`npm run rag:red-team',
    '`rag_vector_sync_purge_status`',
    'disabled targets are still purged',
    '`stale_index_drop`',
    '`access_groups`',
    '`language_drop`',
    '`/api/rag/admin/language-quality`',
    '`config/rag/price-table.json`',
  ])('§6 mentions %s', (fragment) => {
    expect(pipeline).toContain(fragment);
  });

  test('each new switch states that off equals today', () => {
    const rollouts = pipeline.split('\n').find((line) => line.includes('`RAG_ROLLOUTS=false`'));
    const confidence = pipeline.split('\n').find((line) => line.includes('`RAG_LANG_CONFIDENCE=mapped`'));
    expect(rollouts).toMatch(/off (equals|reproduces) today/i);
    expect(confidence).toMatch(/default.*today/i);
  });

  test('the red-team corpus domain-neutrality rule is stated once', () => {
    expect(section6.match(/red-team corpus[^\n]*domain example strings?/gi) ?? []).toHaveLength(1);
  });

  test('the Phase 4.4 bullets carry the external-backend BM25 parameters (LEX-05)', () => {
    for (const fragment of ['Weaviate and Qdrant', '`RAG_LEXICAL_BM25_K1`', 'records its pair', 'rebuild-lexical', '--confirm', 'only reports']) {
      expect(phase44, fragment).toContain(fragment);
    }
  });

  test.each(['`npm run rag:rollout`', '`npm run rag:languages`', '`npm run rag:red-team`', 'calibrate-language-confidence.mts'])(
    '§16 lists %s',
    (command) => {
      expect(section16).toContain(command);
    },
  );

  test('§16 vector-sync row lists rebuild-lexical', () => {
    expect(section16.split('\n').find((line) => line.startsWith('| `npm run rag:vector-sync`'))).toContain('rebuild-lexical');
  });

  test('the documented commands exist in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const name of ['rag:rollout', 'rag:languages', 'rag:red-team', 'rag:vector-sync']) expect(pkg.scripts[name], name).toBeDefined();
    expect(fs.existsSync(path.resolve(__dirname, '../../eval/harness/calibrate-language-confidence.mts'))).toBe(true);
  });
});

describe('AGENTS.md reflects the Phase 7 setup fold (07-31)', () => {
  test('the fold sentence names Phase 7 (0701–0707) as the part that closes the setup files', () => {
    expect(AGENTS).toContain('Phase 6.1 (0651–0654) and Phase 7 (0701–0707), which closes the file');
    expect(AGENTS).not.toContain('Phase 6.1 (0651–0654), which closes the file');
  });

  test('the fold sentence keeps the unfolded Phase 7 migrations as migrations', () => {
    expect(AGENTS).toContain('Phase 7 migrations 0708, 0709, 0720–0728 and 0740–0746 stay migrations and are not folded');
    expect(AGENTS).not.toContain('the later 07xx–10xx blocks are not folded yet');
  });
});

describe('AGENTS.md and the pipeline guide carry the quick-deferred-batch rules', () => {
  const README = fs.readFileSync(path.resolve(__dirname, '../../README_RAG_PIPELINE.md'), 'utf8');

  test('the 4.4 re-run rules name 1014 after 0902 or 0905', () => {
    expect(AGENTS).toContain('after re-running 0902 or 0905, re-run 1014');
  });

  test('the language-quality cells are documented as API only, with no UI', () => {
    expect(AGENTS).toContain('`/api/rag/admin/language-quality` is offered as an API only');
    expect(README).toContain('offered as an API only: no Config UI panel or app page calls it');
  });
});
