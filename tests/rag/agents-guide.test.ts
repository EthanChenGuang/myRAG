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
