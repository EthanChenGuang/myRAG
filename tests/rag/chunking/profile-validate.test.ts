import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import { validateChunkingProfile } from '@/lib/rag/chunking/validate';

const activeProvider = vi.hoisted(() => ({ provider: 'openai' }));

vi.mock('@/lib/rag/embeddings/active-profile', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/embeddings/active-profile')>();
  return {
    ...original,
    getActiveProfile: vi.fn(async () => ({ ...original.LEGACY_PROFILE, provider: activeProvider.provider }) as EmbeddingProfile),
  };
});

interface CaseRow {
  input: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

interface CaseTable {
  cases: CaseRow[];
  default_context: { max_child_tokens: number; top_k: number; context_budget: number };
  error_codes: string[];
  warning_codes: string[];
}

const TABLE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../rag-sidecar/schemas/chunking-profile-cases.json'), 'utf8')) as CaseTable;

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'p-test',
  doc_type: 'general',
  child_tokens: 256,
  parent_mode: 'structure',
  parent_tokens: 1024,
  status: 'ready',
  preset: '256/1024',
  ...over,
});

beforeEach(() => {
  activeProvider.provider = 'openai';
});

describe('validateChunkingProfile parity with the Pydantic case table', () => {
  it('the table carries the cases the plan relies on', () => {
    expect(TABLE.cases.length).toBeGreaterThanOrEqual(5);
    expect(TABLE.error_codes).toEqual(['child_exceeds_embedding_input', 'parent_below_twice_child', 'parent_tokens_required']);
    expect(TABLE.warning_codes).toEqual(['ratio_outside_4_8', 'top_k_parent_over_budget']);
  });

  it.each(TABLE.cases.map((row) => [String(row.input.id), row] as const))('%s gives the errors and warnings Pydantic gives', async (_name, row) => {
    const result = await validateChunkingProfile(row.input, {
      maxChildTokens: TABLE.default_context.max_child_tokens,
      topK: TABLE.default_context.top_k,
      contextBudget: TABLE.default_context.context_budget,
    });
    expect([...result.errors].sort()).toEqual([...row.errors].sort());
    expect([...result.warnings].sort()).toEqual([...row.warnings].sort());
  });
});

describe('validateChunkingProfile context', () => {
  it('takes the child limit from the active embedding profile provider: 9000 tokens fail under openai and pass under voyage', async () => {
    const input = profile({ child_tokens: 9000, parent_mode: 'none', parent_tokens: null, preset: 'custom' });
    activeProvider.provider = 'openai';
    expect((await validateChunkingProfile(input)).errors).toEqual(['child_exceeds_embedding_input']);
    activeProvider.provider = 'voyage';
    expect((await validateChunkingProfile(input)).errors).toEqual([]);
    activeProvider.provider = 'qwen3';
    expect((await validateChunkingProfile(profile({ child_tokens: 32769, parent_mode: 'none', parent_tokens: null, preset: 'custom' }))).errors).toEqual([
      'child_exceeds_embedding_input',
    ]);
  });

  it('an explicit maxChildTokens wins over the active profile', async () => {
    const input = profile({ child_tokens: 300, parent_mode: 'none', parent_tokens: null, preset: 'custom' });
    expect((await validateChunkingProfile(input, { maxChildTokens: 200 })).errors).toEqual(['child_exceeds_embedding_input']);
    expect((await validateChunkingProfile(input, { maxChildTokens: 400 })).errors).toEqual([]);
  });

  it('warns when top-k parents exceed the context budget, with topK and the budget from the configuration by default', async () => {
    const wide = profile({ child_tokens: 256, parent_tokens: 2048, preset: '256/2048' });
    const result = await validateChunkingProfile(wide);
    expect(result.warnings).toContain('top_k_parent_over_budget');
    const narrow = await validateChunkingProfile(wide, { topK: 1, contextBudget: 6000 });
    expect(narrow.warnings).not.toContain('top_k_parent_over_budget');
  });

  it('reports a profile that does not match the shape instead of throwing', async () => {
    const result = await validateChunkingProfile({ id: 'x', doc_type: 'memo' });
    expect(result.errors).toEqual(['invalid_shape']);
    expect(result.warnings).toEqual([]);
  });

  it('a fixed parent mode without parent tokens is a hard error and the ratio checks stay quiet', async () => {
    const result = await validateChunkingProfile(profile({ parent_mode: 'fixed', parent_tokens: null, preset: 'custom' }));
    expect(result.errors).toEqual(['parent_tokens_required']);
    expect(result.warnings).toEqual([]);
  });
});
