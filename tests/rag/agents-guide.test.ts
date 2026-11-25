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
