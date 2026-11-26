import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { identifierSuggestionMessage } from '@/lib/rag/generation/messages';
import { normalizeIdentifier } from '@/lib/rag/ids/normalize';
import { guardNearMisses, identifierSuggestions, MAX_IDENTIFIER_SUGGESTIONS } from '@/lib/rag/retrieval/identifiers';
import { mintScope } from '@/lib/rag/tenant/scope';

interface VectorCase {
  id: string;
  asked: string;
  other: string;
  asked_norm: string;
  other_norm: string;
  near_miss: boolean;
}

const VECTORS = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../fixtures/identifiers/near-miss-vectors.json'), 'utf8')) as { cases: VectorCase[] }
).cases;

const scope = mintScope('single', null, null);
const content = (item: { content: string }) => item.content;

/** One built-in identifier match: no whitespace and at least one digit (the guard reads candidates with the ingestion extractor). */
function builtInSingle(spelling: string): boolean {
  return /^[\p{L}\p{N}._/-]+$/u.test(spelling.normalize('NFKC')) && /\d/u.test(spelling.normalize('NFKC'));
}

function rpcReturning(byNorm: Record<string, Array<{ raw: string; norm: string }>>, calls: Array<Record<string, unknown>>): RpcClient {
  return {
    rpc(fn, args) {
      calls.push({ fn, ...args });
      const response: RpcResponse = { data: byNorm[String(args.p_norm)] ?? [], error: null };
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected) };
      return request;
    },
  };
}

function rpcFailing(): RpcClient {
  return {
    rpc() {
      const response: RpcResponse = { data: null, error: { code: '42501', message: 'permission denied' } };
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected) };
      return request;
    },
  };
}

describe('guardNearMisses (D-31, D-51)', () => {
  it('drops a one-edit neighbour of a 6-character form that does not carry the asked one', () => {
    const items = [{ id: 'near', content: 'Entry QX4472 holds a note.' }];
    const out = guardNearMisses(items, ['qx4471'], { contentOf: content });
    expect(out.kept).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  it('keeps a candidate carrying both the asked identifier and a neighbour', () => {
    const items = [{ id: 'both', content: 'Entry QX4471 replaces QX4472.' }];
    const out = guardNearMisses(items, ['qx4471'], { contentOf: content });
    expect(out.kept.map((item) => item.id)).toEqual(['both']);
    expect(out.dropped).toBe(0);
  });

  it('drops a two-edit neighbour only for asked forms longer than 6', () => {
    const long = guardNearMisses([{ id: 'n', content: 'Code ZR7B-30926 entry.' }], ['zr7b30915'], { contentOf: content });
    expect(long.dropped).toBe(1);
    const short = guardNearMisses([{ id: 'n', content: 'Code QX4482 entry.' }], ['qx4471'], { contentOf: content });
    expect(short.dropped).toBe(0);
  });

  it('counts separator-only and case-only variants as the asked identifier', () => {
    const items = [
      { id: 'sep', content: 'Entry qx_4471 is here.' },
      { id: 'case', content: 'Entry Qx.4471 is here.' },
    ];
    const out = guardNearMisses(items, ['qx4471'], { contentOf: content });
    expect(out.kept.map((item) => item.id)).toEqual(['sep', 'case']);
  });

  it('keeps a candidate with no identifiers and an unrelated identifier', () => {
    const items = [
      { id: 'none', content: 'A plain note without any code.' },
      { id: 'other', content: 'Entry LM9902 is unrelated.' },
    ];
    const out = guardNearMisses(items, ['qx4471'], { contentOf: content });
    expect(out.kept.map((item) => item.id)).toEqual(['none', 'other']);
    expect(out.dropped).toBe(0);
  });

  it('applies tenant patterns to candidate content', () => {
    const pattern = /\bKelvoran-[A-Za-z]{4}\b/giu;
    const items = [{ id: 'near', content: 'The kelvoran-task register.' }];
    expect(guardNearMisses(items, ['kelvorantusk'], { contentOf: content }).dropped).toBe(0);
    expect(guardNearMisses(items, ['kelvorantusk'], { contentOf: content, patterns: [pattern] }).dropped).toBe(1);
  });

  it('matches the shared near-miss vectors for every single built-in spelling', () => {
    let checked = 0;
    for (const vector of VECTORS) {
      if (!builtInSingle(vector.other) || vector.asked_norm === '') continue;
      const out = guardNearMisses([{ id: vector.id, content: `Entry ${vector.other} note.` }], [vector.asked_norm], { contentOf: content });
      expect({ id: vector.id, dropped: out.dropped === 1 }, `${vector.asked} / ${vector.other}`).toEqual({ id: vector.id, dropped: vector.near_miss });
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('with no asked identifier keeps every candidate', () => {
    const items = [{ id: 'near', content: 'Entry QX4472.' }];
    expect(guardNearMisses(items, [], { contentOf: content })).toEqual({ kept: items, dropped: 0 });
  });
});

describe('identifierSuggestions (D-31, D-51)', () => {
  it('ranks candidates by distance then raw spelling and returns at most 3 raw spellings', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = rpcReturning(
      {
        qx4471: [
          { raw: 'QX-4482', norm: 'qx4482' },
          { raw: 'QX-4472', norm: 'qx4472' },
          { raw: 'QX-4470', norm: 'qx4470' },
          { raw: 'QX-447', norm: 'qx447' },
          { raw: 'qx-4473', norm: 'qx4473' },
        ],
      },
      calls,
    );
    const out = await identifierSuggestions(scope, ['qx4471'], { client, signal: new AbortController().signal });
    expect(out).toEqual(['QX-447', 'QX-4470', 'QX-4472']);
    expect(out.length).toBeLessThanOrEqual(MAX_IDENTIFIER_SUGGESTIONS);
    expect(calls).toEqual([expect.objectContaining({ fn: 'rag_identifier_candidates', p_tenant_key: 's:default', p_norm: 'qx4471' })]);
  });

  it('merges several missing identifiers without duplicates and never suggests an asked form', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = rpcReturning(
      {
        qx4471: [{ raw: 'QX-4472', norm: 'qx4472' }],
        qx4473: [{ raw: 'QX-4472', norm: 'qx4472' }, { raw: 'QX-4471', norm: 'qx4471' }],
      },
      calls,
    );
    const out = await identifierSuggestions(scope, ['qx4471', 'qx4473'], { client, signal: new AbortController().signal });
    expect(out).toEqual(['QX-4472']);
  });

  it('returns none on an RPC failure or with no missing identifier', async () => {
    expect(await identifierSuggestions(scope, ['qx4471'], { client: rpcFailing(), signal: new AbortController().signal })).toEqual([]);
    const calls: Array<Record<string, unknown>> = [];
    expect(await identifierSuggestions(scope, [], { client: rpcReturning({}, calls), signal: new AbortController().signal })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('identifierSuggestionMessage (D-31)', () => {
  it('renders a localized sentence with the spellings, English for other languages, nothing for no suggestions', () => {
    const suggestions = ['QX-4472', 'QX-4470'];
    const en = identifierSuggestionMessage('en', suggestions);
    const zh = identifierSuggestionMessage('zh', suggestions);
    const it = identifierSuggestionMessage('it', suggestions);
    for (const text of [en, zh, it]) {
      expect(text).toContain('QX-4472');
      expect(text).toContain('QX-4470');
    }
    expect(new Set([en, zh, it]).size).toBe(3);
    expect(identifierSuggestionMessage('fr', suggestions)).toBe(en);
    expect(identifierSuggestionMessage('en', [])).toBe('');
    expect(identifierSuggestionMessage('en', undefined)).toBe('');
  });

  it('keeps suggestions as plain text: markup and control characters are removed', () => {
    const text = identifierSuggestionMessage('en', ['QX<b>-4472\u200b']);
    expect(text).not.toMatch(/[<>\u200b]/u);
    expect(text).toContain('QXb-4472');
  });

  it('normalization of a suggestion line stays the identifier normalization', () => {
    expect(normalizeIdentifier('QX-4472')).toBe('qx4472');
  });
});
