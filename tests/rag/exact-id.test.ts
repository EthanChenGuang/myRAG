import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { RagEnvInput } from '@/lib/rag/config';
import { legacyRank } from '@/lib/rag/legacy/enhanced-retrieval';
import { identifierLexicalLookupForms, lexicalTokens } from '@/lib/rag/lexical/tokenize';
import { exactIdLookup, extractExactIds, mergeExactCandidates, type ExactIdRow } from '@/lib/rag/retrieval/exact-id';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Candidate } from '@/lib/rag/types';
import { fakeEmbedder, installDeps, rows, uninstallDeps, type FakeRow } from './helpers/pipeline-fakes';

const values = (query: string) => extractExactIds(query).map((token) => `${token.kind}:${token.value}`);

describe('extractExactIds (D-28)', () => {
  it('reads an invoice number from a Chinese, English and Italian question', () => {
    expect(extractExactIds('发票 FT-2025-00417 的金额是多少')).toEqual([{ value: 'FT-2025-00417', kind: 'invoice' }]);
    expect(extractExactIds('What is the total of invoice FT-2025-00417?')).toEqual([{ value: 'FT-2025-00417', kind: 'invoice' }]);
    expect(extractExactIds("Qual è l'importo della fattura FT/2025/00417?")).toEqual([{ value: 'FT/2025/00417', kind: 'invoice' }]);
  });

  it('reads a valid Partita IVA and a valid EU VAT number, with their schemes', () => {
    expect(extractExactIds('P.IVA 99999999990')).toEqual([{ value: '99999999990', kind: 'tax_id', scheme: 'it_iva' }]);
    expect(extractExactIds('IT99999999990')).toEqual([{ value: 'IT99999999990', kind: 'tax_id', scheme: 'eu_vat' }]);
    expect(extractExactIds('USCC 91000000MA0000000N')).toEqual([{ value: '91000000MA0000000N', kind: 'tax_id', scheme: 'cn_uscc' }]);
  });

  it('reads a tax id written with spaces or dots as its normalised form', () => {
    expect(values('Who is VAT 999 999 999 90?')).toEqual(['tax_id:99999999990']);
    expect(values('IT 999.999.999.90')).toEqual(['tax_id:IT99999999990']);
  });

  it('does not take a checksum-invalid 11-digit number for a tax id', () => {
    expect(extractExactIds('P.IVA 99999999991')).toEqual([]);
    expect(extractExactIds('IT99999999991')).toEqual([{ value: 'IT99999999991', kind: 'model' }]);
  });

  it('reads a model-number token', () => {
    expect(extractExactIds('型号 LV-77-0192 的保修')).toEqual([{ value: 'LV-77-0192', kind: 'model' }]);
    expect(extractExactIds('How long is the warranty of XR-500B?')).toEqual([{ value: 'XR-500B', kind: 'model' }]);
  });

  it('gives no tokens for plain questions, dates, years and amounts', () => {
    for (const query of [
      'What is the refund policy?',
      '今天的天气怎么样',
      'Quanto costa il servizio nel 2025?',
      'What happened on 2025-03-15?',
      'The total was 1,200.50 euro',
      'ERR_TIMEOUT happens often',
      '',
    ]) {
      expect(extractExactIds(query), query).toEqual([]);
    }
  });

  it('takes a digits-only invoice number only when the question speaks of an invoice', () => {
    expect(values('invoice 20250417 total')).toEqual(['invoice:20250417']);
    expect(values('fattura n. 03/2025')).toEqual(['invoice:03/2025']);
    expect(values('total of 20250417')).toEqual([]);
    expect(values('invoice dated 2025-03-15')).toEqual([]);
  });

  it('applies NFKC first and keeps each token once, in query order', () => {
    expect(values('发票 ＦＴ－２０２５－００４１７ 和 ft-2025-00417 以及 LV-77-0192')).toEqual([
      'invoice:FT-2025-00417',
      'invoice:LV-77-0192',
    ]);
  });

  it('caps the number of tokens and stays linear on hostile text', () => {
    const many = Array.from({ length: 40 }, (_, index) => `AB-${1000 + index}`).join(' ');
    expect(extractExactIds(many).length).toBeLessThanOrEqual(8);
    const started = Date.now();
    expect(extractExactIds('a1-'.repeat(200000)).length).toBeLessThanOrEqual(8);
    expect(extractExactIds('1 '.repeat(200000)).length).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

const EXACT_RPC = 'rag_exact_id_documents';
const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const INVOICE_QUESTION = 'What is the total of invoice FT-2025-00417?';

function candidate(id: string, finalScore: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    chunk_id: id,
    document_id: `doc-of-${id}`,
    content: `body of ${id}`,
    similarity: 0.8,
    metadata: { page: 1 },
    temporal_score: 0,
    financial_score: 0,
    final_score: finalScore,
    match_reason: 'similarity: 0.800',
    ...overrides,
  };
}

function exactRow(id: string, overrides: Partial<ExactIdRow> = {}): ExactIdRow {
  return {
    chunk_id: id,
    document_id: `doc-of-${id}`,
    content: `invoice body of ${id}`,
    metadata: { chunk_kind: 'invoice_header' },
    matched_field: 'invoice_number',
    ...overrides,
  };
}

interface RoutedCall {
  fn: string;
  args: Record<string, unknown>;
}

function routedRpc(options: { vector?: FakeRow[]; exact?: ExactIdRow[]; exactError?: { message: string; code?: string }; exactDelayMs?: number }) {
  const calls: RoutedCall[] = [];
  const client: RpcClient = {
    rpc(fn, args): RpcRequest {
      let signal: AbortSignal | undefined;
      const respond = (): RpcResponse => {
        if (fn === EXACT_RPC) return options.exactError ? { data: null, error: options.exactError } : { data: options.exact ?? [], error: null };
        return { data: options.vector ?? [], error: null };
      };
      const request: RpcRequest = {
        abortSignal(next) {
          signal = next;
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, args });
          const delay = fn === EXACT_RPC ? (options.exactDelayMs ?? 0) : 0;
          const settled = new Promise<RpcResponse>((resolve) => {
            const timer = setTimeout(() => resolve(respond()), delay);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve({ data: null, error: { message: 'aborted' } });
              },
              { once: true },
            );
          });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls, exactCalls: () => calls.filter((call) => call.fn === EXACT_RPC) };
}

describe('mergeExactCandidates', () => {
  it('puts the exact chunks first with match_reason exact_id and keeps the vector order after them', () => {
    const merged = mergeExactCandidates([candidate('v1', 0.9), candidate('v2', 0.8)], [exactRow('e1')], 25);
    expect(merged.map((item) => item.chunk_id)).toEqual(['e1', 'v1', 'v2']);
    expect(merged[0]).toMatchObject({ match_reason: 'exact_id', document_id: 'doc-of-e1', content: 'invoice body of e1', similarity: 1 });
    expect(merged[1]?.match_reason).toBe('similarity: 0.800');
  });

  it('lists a chunk found by both routes once, as an exact match, keeping what the vector route knew', () => {
    const merged = mergeExactCandidates([candidate('v1', 0.9), candidate('both', 0.7, { metadata: { page: 7 } })], [exactRow('both')], 25);
    expect(merged.map((item) => item.chunk_id)).toEqual(['both', 'v1']);
    expect(merged[0]).toMatchObject({ match_reason: 'exact_id', metadata: { page: 7 } });
  });

  it('scores exact chunks at least as high as every vector chunk, so the legacy ranking keeps them first', () => {
    const merged = mergeExactCandidates([candidate('v1', 1.4), candidate('v2', 0.6)], [exactRow('e1'), exactRow('e2')], 25);
    expect(legacyRank(merged, null as never).map((item) => item.chunk_id)).toEqual(['e1', 'e2', 'v1', 'v2']);
  });

  it('never grows the list past the caller limit unless the exact chunks alone exceed it', () => {
    const vector = Array.from({ length: 5 }, (_, index) => candidate(`v${index}`, 0.9 - index / 100));
    expect(mergeExactCandidates(vector, [exactRow('e1'), exactRow('e2')], 5).map((item) => item.chunk_id)).toEqual(['e1', 'e2', 'v0', 'v1', 'v2']);
    expect(mergeExactCandidates(vector, [exactRow('e1'), exactRow('e2')], 1).map((item) => item.chunk_id)).toEqual(['e1', 'e2']);
  });

  it('returns the vector list unchanged for no exact rows', () => {
    const vector = [candidate('v1', 0.9)];
    expect(mergeExactCandidates(vector, [], 25)).toEqual(vector);
  });
});

describe('exactIdLookup', () => {
  const scope = mintScope('org', USER_ID, ORG_ID);

  it('sends the tenant key of the scope, the tokens as one array and a limit, and nothing else', async () => {
    const rpc = routedRpc({ exact: [exactRow('e1')] });
    const found = await exactIdLookup(scope, extractExactIds("x'; DROP TABLE documents; -- 发票 FT-2025-00417 IT99999999990"), {
      client: rpc.client,
      signal: new AbortController().signal,
    });
    expect(found.map((row) => row.chunk_id)).toEqual(['e1']);
    const [call] = rpc.exactCalls();
    expect(Object.keys(call?.args ?? {}).sort()).toEqual(['p_limit', 'p_tenant_key', 'p_tokens']);
    expect(call?.args.p_tenant_key).toBe(`o:${ORG_ID}`);
    expect(call?.args.p_tokens).toEqual([
      'FT-2025-00417',
      'ft-2025-00417',
      'ft202500417',
      'IT99999999990',
      'it99999999990',
      '99999999990',
    ]);
    expect(call?.args.p_limit).toBe(10);
  });

  it('looks an Italian VAT number up with and without its IT prefix, whichever way it was asked', async () => {
    const bare = routedRpc({});
    await exactIdLookup(scope, extractExactIds('P.IVA 99999999990'), { client: bare.client, signal: new AbortController().signal });
    expect(bare.exactCalls()[0]?.args.p_tokens).toEqual(['99999999990', 'IT99999999990']);
    const other = routedRpc({});
    await exactIdLookup(scope, extractExactIds('VAT BE0000000097'), { client: other.client, signal: new AbortController().signal });
    expect(other.exactCalls()[0]?.args.p_tokens).toEqual(['BE0000000097', 'be0000000097']);
  });

  it('sends whole and joined v2 forms for a model number but not code parts', async () => {
    const rpc = routedRpc({});
    await exactIdLookup(scope, extractExactIds('XR-2000 保修多久'), { client: rpc.client, signal: new AbortController().signal });
    expect(rpc.exactCalls()[0]?.args.p_tokens).toEqual(['XR-2000', 'xr-2000', 'xr2000']);
    expect(rpc.exactCalls()[0]?.args.p_tokens).not.toContain('xr');
    expect(rpc.exactCalls()[0]?.args.p_tokens).not.toContain('2000');
  });

  it('lookup forms match v1 and v2 lexical_text for the same model number', () => {
    const query = 'XR-2000';
    const v1Style = lexicalTokens(`Model ${query} warranty`);
    const v2Style = lexicalTokens(`model ${query.toLowerCase()} warranty`);
    const forms = identifierLexicalLookupForms(query);
    expect(v1Style.some((t) => forms.map((f) => f.toLowerCase()).includes(t.toLowerCase()) || t === query)).toBe(true);
    expect(v2Style.filter((t) => t === query.toLowerCase() || forms.includes(t)).length).toBeGreaterThan(0);
  });

  it('makes no call for no tokens and throws on a backend error', async () => {
    const quiet = routedRpc({});
    expect(await exactIdLookup(scope, [], { client: quiet.client, signal: new AbortController().signal })).toEqual([]);
    expect(quiet.calls).toEqual([]);
    const failing = routedRpc({ exactError: { message: 'boom', code: 'XX000' } });
    await expect(exactIdLookup(scope, extractExactIds(INVOICE_QUESTION), { client: failing.client, signal: new AbortController().signal })).rejects.toThrow(
      /rag_exact_id_documents/,
    );
  });

  it('refuses a scope that was not minted', async () => {
    const rpc = routedRpc({});
    await expect(
      exactIdLookup({ kind: 'org', userId: null, organizationId: ORG_ID } as never, extractExactIds(INVOICE_QUESTION), {
        client: rpc.client,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/unminted/);
    expect(rpc.calls).toEqual([]);
  });
});

describe('the exact_id_lookup stage in runRetrieval', () => {
  const scope = mintScope('single', null, null);

  function install(options: Parameters<typeof routedRpc>[0], env: RagEnvInput) {
    const rpc = routedRpc(options);
    installDeps({ searchRpc: rpc.client, embedder: fakeEmbedder().embedder, ragEnv: () => env });
    return rpc;
  }

  const run = (query = INVOICE_QUESTION) => runRetrieval({ scope, query, profile: 'eval', signal: new AbortController().signal });

  beforeEach(() => uninstallDeps());
  afterEach(() => uninstallDeps());

  it('with the switch off the stage is not run or recorded, even for a question that holds an invoice number', async () => {
    const rpc = install({ vector: rows(3), exact: [exactRow('e1')] }, {});
    const result = await run();
    expect(rpc.exactCalls()).toEqual([]);
    expect(result.stages.map((stage) => stage.name)).toEqual(['analyze', 'embed', 'search', 'legacy_rank', 'post_filter', 'assemble']);
    expect(result.candidates.map((item) => item.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
    expect(result.status).toBe('ok');
  });

  it('an invalid switch value is off', async () => {
    const rpc = install({ vector: rows(3), exact: [exactRow('e1')] }, { RAG_EXACT_ID_LOOKUP: 'yes' });
    const result = await run();
    expect(rpc.exactCalls()).toEqual([]);
    expect(result.stages.some((stage) => stage.name === 'exact_id_lookup')).toBe(false);
  });

  it('with the switch on the stage runs between search and legacy_rank and puts the exact chunk first', async () => {
    const rpc = install({ vector: rows(3), exact: [exactRow('chunk-2'), exactRow('e1')] }, { RAG_EXACT_ID_LOOKUP: 'true' });
    const result = await run();
    expect(result.stages.map((stage) => [stage.name, stage.status])).toEqual([
      ['analyze', 'ok'],
      ['embed', 'ok'],
      ['search', 'ok'],
      ['exact_id_lookup', 'ok'],
      ['legacy_rank', 'ok'],
      ['post_filter', 'ok'],
      ['assemble', 'ok'],
    ]);
    expect(result.candidates.map((item) => [item.chunk_id, item.match_reason])).toEqual([
      ['chunk-2', 'exact_id'],
      ['e1', 'exact_id'],
      ['chunk-1', 'similarity: 0.900'],
      ['chunk-3', 'similarity: 0.800'],
    ]);
    expect(rpc.exactCalls()).toHaveLength(1);
    expect(rpc.exactCalls()[0]?.args).toMatchObject({
      p_tenant_key: 's:default',
      p_tokens: expect.arrayContaining(['FT-2025-00417']),
    });
    expect(result.status).toBe('ok');
    expect(result.stages.find((stage) => stage.name === 'exact_id_lookup')).toMatchObject({ candidates_in: 3, candidates_out: 2 });
  });

  it('records the stage as ok without a call for a question with no identifier', async () => {
    const rpc = install({ vector: rows(3), exact: [exactRow('e1')] }, { RAG_EXACT_ID_LOOKUP: 'true' });
    const result = await run('tell me about the onboarding process');
    expect(rpc.exactCalls()).toEqual([]);
    expect(result.stages.find((stage) => stage.name === 'exact_id_lookup')).toMatchObject({ status: 'ok', candidates_out: 0 });
    expect(result.candidates.map((item) => item.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });

  it('a failing lookup is skipped, the result is degraded and the vector results are intact', async () => {
    install({ vector: rows(3), exactError: { message: 'boom', code: 'XX000' } }, { RAG_EXACT_ID_LOOKUP: 'true' });
    const result = await run();
    expect(result.status).toBe('degraded');
    expect(result.reason).toBe('exact_id_lookup_failed');
    expect(result.stages.find((stage) => stage.name === 'exact_id_lookup')).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(result.candidates.map((item) => item.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });

  it('a slow lookup is skipped at its timeout and the result is degraded', async () => {
    install({ vector: rows(3), exact: [exactRow('e1')], exactDelayMs: 400 }, { RAG_EXACT_ID_LOOKUP: 'true', RAG_STAGE_TIMEOUTS: 'exact_id_lookup=25' });
    const result = await run();
    expect(result.status).toBe('degraded');
    expect(result.reason).toBe('exact_id_lookup_timeout');
    expect(result.candidates.map((item) => item.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });

  it('RAG_DISABLED_STAGES turns the stage off for good: recorded as disabled, no call', async () => {
    const rpc = install({ vector: rows(3), exact: [exactRow('e1')] }, { RAG_EXACT_ID_LOOKUP: 'true', RAG_DISABLED_STAGES: 'exact_id_lookup' });
    const result = await run();
    expect(rpc.exactCalls()).toEqual([]);
    expect(result.stages.find((stage) => stage.name === 'exact_id_lookup')).toMatchObject({ status: 'disabled' });
    expect(result.candidates.map((item) => item.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });

  it('an exact chunk survives the post filter and reaches the assembled documents even when no vector chunk is found', async () => {
    install({ vector: [], exact: [exactRow('e1')] }, { RAG_EXACT_ID_LOOKUP: 'true' });
    const result = await run();
    expect(result.candidates.map((item) => item.chunk_id)).toEqual(['e1']);
    expect(result.relevantChunks.map((item) => item.chunk_id)).toEqual(['e1']);
    expect(result.status).toBe('ok');
  });

  it('chat and embed profiles run the stage, media and voice do not', async () => {
    for (const profile of ['chat', 'embed'] as const) {
      const rpc = install({ vector: rows(2), exact: [exactRow('e1')] }, { RAG_EXACT_ID_LOOKUP: 'true' });
      await runRetrieval({ scope, query: INVOICE_QUESTION, profile, signal: new AbortController().signal });
      expect(rpc.exactCalls(), profile).toHaveLength(1);
      uninstallDeps();
    }
    for (const profile of ['media', 'voice'] as const) {
      const rpc = install({ vector: rows(2), exact: [exactRow('e1')] }, { RAG_EXACT_ID_LOOKUP: 'true' });
      await runRetrieval({ scope, query: INVOICE_QUESTION, profile, signal: new AbortController().signal });
      expect(rpc.exactCalls(), profile).toEqual([]);
      uninstallDeps();
    }
  });
});
