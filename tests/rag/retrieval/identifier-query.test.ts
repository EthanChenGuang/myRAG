import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/rag/identifiers/patterns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/identifiers/patterns')>()),
  loadTenantIdentifierPatterns: async () => ({ expressions: [new RegExp('\\b[A-Z]{2}-[A-Z]{3}-[A-Z]{3}\\b', 'gu')] }),
}));
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import {
  contentIdentifierNorms,
  digitLookalikeMatches,
  foldDigitLookalikes,
  queryIdentifierEntries,
  resolveQueryIdentifiers,
} from '@/lib/rag/retrieval/identifiers';
import { mintScope } from '@/lib/rag/tenant/scope';

const scope = mintScope('single', null, null);

/** A synthetic tenant pattern of the shape the fixture tenant uses: two, three and three capitals joined by hyphens, case-sensitive. */
const LETTER_CODE = new RegExp('\\b[A-Z]{2}-[A-Z]{3}-[A-Z]{3}\\b', 'u');

function respond(response: RpcResponse): RpcRequest {
  const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected) };
  return request;
}

/** rag_identifier_resolve answers the stored forms in `stored`; rag_identifier_candidates answers `candidates[p_norm]`. */
function tenantRpc(stored: string[], candidates: Record<string, Array<{ raw: string; norm: string }>> = {}, calls: string[] = []): RpcClient {
  return {
    rpc(fn, args) {
      calls.push(fn);
      if (fn === 'rag_identifier_resolve') {
        const asked = (args.p_norm as string[]) ?? [];
        return respond({ data: asked.filter((norm) => stored.includes(norm)).map((norm) => ({ norm })), error: null });
      }
      return respond({ data: candidates[String(args.p_norm)] ?? [], error: null });
    },
  };
}

function failingRpc(): RpcClient {
  return { rpc: () => respond({ data: null, error: { code: '42501', message: 'permission denied' } }) };
}

const options = (client: RpcClient) => ({ client, signal: new AbortController().signal });

describe('queryIdentifierEntries on the D-32 question shapes', () => {
  it.each([
    ['Which place does entry QJ4817RM denote?', 'qj4817rm'],
    ['Which place does entry qj7392 denote?', 'qj7392'],
    ['Which place does entry ＱＪ－５６－０８－ＴＮ denote?', 'qj5608tn'],
    ['篇目 WX6253HB 铭刻哪处？', 'wx6253hb'],
    ['篇目 ＷＸ－２７－９３－ＰＣ 铭刻哪处？', 'wx2793pc'],
    ['Quale luogo segna la voce kz9061?', 'kz9061'],
    ['Quale luogo segna la voce KZ-3585-DF?', 'kz3585df'],
  ])('reads the built-in identifier of %s', (query, norm) => {
    expect(queryIdentifierEntries(query, []).map((entry) => entry.norm)).toEqual([norm]);
  });

  it.each([
    ['Which place does entry qj.Xuv.qor denote?', 'qj.Xuv.qor', 'qjxuvqor'],
    ['篇目 wx.Yem.git 铭刻哪处？', 'wx.Yem.git', 'wxyemgit'],
    ['Quale luogo segna la voce kz.Owa.fud?', 'kz.Owa.fud', 'kzowafud'],
  ])('reads a case and separator variant of a tenant-pattern identifier in %s', (query, raw, norm) => {
    expect(queryIdentifierEntries(query, [LETTER_CODE])).toEqual([{ raw, norm, variant: true }]);
  });

  it('reads a literal tenant-pattern match as a plain entry', () => {
    expect(queryIdentifierEntries('Which place does entry QJ-XUV-QOR denote?', [LETTER_CODE])).toEqual([{ raw: 'QJ-XUV-QOR', norm: 'qjxuvqor' }]);
  });

  it('adds no variant without tenant patterns, and none for separated words that fit no pattern', () => {
    expect(queryIdentifierEntries('Which place does entry qj.Xuv.qor denote?', [])).toEqual([]);
    expect(queryIdentifierEntries('Is the e.g. note in the U.S. office or the pre-sale list?', [LETTER_CODE])).toEqual([]);
  });

  it('keeps a variant entry only when the tenant has it', async () => {
    const query = 'Which place does entry qj.Xuv.qor denote?';
    const held = await resolveQueryIdentifiers(scope, query, [LETTER_CODE], options(tenantRpc(['qjxuvqor'])));
    expect(held).toEqual({ asked: [{ raw: 'qj.Xuv.qor', norm: 'qjxuvqor', variant: true }], found: ['qjxuvqor'], missing: [] });
    const absent = await resolveQueryIdentifiers(scope, query, [LETTER_CODE], options(tenantRpc([])));
    expect(absent).toEqual({ asked: [], found: [], missing: [] });
  });

  it('still reports a missing built-in identifier as missing', async () => {
    const out = await resolveQueryIdentifiers(scope, 'Which place does entry QJ-4818-RM denote?', [], options(tenantRpc(['qj4817rm'])));
    expect(out.missing).toEqual(['qj4818rm']);
    expect(out.found).toEqual([]);
  });
});

describe('digit look-alikes (OCR damage inside a number)', () => {
  it('folds o, i and l only between two digits', () => {
    expect(foldDigitLookalikes('gvms2o240057')).toBe('gvms20240057');
    expect(foldDigitLookalikes('ab3l5')).toBe('ab315');
    expect(foldDigitLookalikes('ab1i')).toBe('ab1i');
    expect(foldDigitLookalikes('aboc')).toBe('aboc');
    expect(foldDigitLookalikes('qjxuvqor')).toBe('qjxuvqor');
  });

  it('maps a missing form to the one stored form that differs only by a look-alike', async () => {
    const client = tenantRpc([], { gvms20240057: [{ raw: 'GV-MS-2O24-0057', norm: 'gvms2o240057' }, { raw: 'GV-MS-2024-0058', norm: 'gvms20240058' }] });
    const out = await digitLookalikeMatches(scope, ['gvms20240057'], options(client));
    expect([...out]).toEqual([['gvms20240057', 'gvms2o240057']]);
  });

  it('maps nothing for an ordinary near-miss, for two look-alike candidates, or when the call fails', async () => {
    const nearMiss = tenantRpc([], { kz3585df: [{ raw: 'KZ-3584-DF', norm: 'kz3584df' }] });
    expect((await digitLookalikeMatches(scope, ['kz3585df'], options(nearMiss))).size).toBe(0);
    const ambiguous = tenantRpc([], {
      ab111: [
        { raw: 'AB-1L1', norm: 'ab1l1' },
        { raw: 'AB-1I1', norm: 'ab1i1' },
      ],
    });
    expect((await digitLookalikeMatches(scope, ['ab111'], options(ambiguous))).size).toBe(0);
    expect((await digitLookalikeMatches(scope, ['gvms20240057'], options(failingRpc()))).size).toBe(0);
  });
});

describe('contentIdentifierNorms (D-32 eval traces)', () => {
  it('reads each content with the built-in rule and the tenant patterns, in order', async () => {
    const out = await contentIdentifierNorms(scope, ['## QJ-XUV-QOR Entry QJ-XUV-QOR marks a vault.', 'Entry QJ-4817-RM.', 'No code here.']);
    expect(out).toEqual([['qjxuvqor'], ['qj4817rm'], []]);
    expect(await contentIdentifierNorms(scope, [])).toEqual([]);
  });
});
