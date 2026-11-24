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
