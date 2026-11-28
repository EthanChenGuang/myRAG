import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { VersionScope } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { versionLabelLine } from '@/lib/rag/context/version-label';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { CitationLabeler, RunRetrievalInput } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runContextStages } from '@/lib/rag/v2/stages/context';
import { hit } from '../fusion/helpers';

const scope = mintScope('single', null, null);
const VERSIONS_RPC = 'rag_document_versions';
const DOMAIN_WORDS = /hotel|travel|leave|salary|restaurant|vpn|password|reimburs|branch|invoice/i;

describe('versionLabelLine (D-13, D-44)', () => {
  const superseded = { version: 1, isCurrent: false, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' };
  const current = { version: 2, isCurrent: true, effectiveFrom: '2026-04-01', effectiveTo: null };

  it('writes one English line with the version number, both dates and the superseded marker', () => {
    const line = versionLabelLine(superseded, 'en');
    expect(line).not.toContain('\n');
    expect(line).toContain('1');
    expect(line).toContain('2026-01-01');
    expect(line).toContain('2026-03-31');
    expect(line.toLowerCase()).toContain('superseded');
  });

  it('marks a current version as current', () => {
    const line = versionLabelLine(current, 'en');
    expect(line.toLowerCase()).toContain('current');
    expect(line).toContain('2026-04-01');
    expect(line.toLowerCase()).not.toContain('superseded');
  });

  it('translates zh and it, and falls back to English for an unknown language', () => {
    const en = versionLabelLine(superseded, 'en');
    const zh = versionLabelLine(superseded, 'zh');
    const it_ = versionLabelLine(superseded, 'it');
    expect(zh).not.toBe(en);
    expect(it_).not.toBe(en);
    expect(zh).toContain('2026-03-31');
    expect(it_).toContain('2026-03-31');
    expect(versionLabelLine(superseded, 'xx')).toBe(en);
    expect(versionLabelLine(superseded, null)).toBe(en);
  });

  it('leaves out the date parts that are missing', () => {
    const none = versionLabelLine({ version: 3, isCurrent: false, effectiveFrom: null, effectiveTo: null }, 'en');
    expect(none).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(none).toContain('3');
    const fromOnly = versionLabelLine({ version: 3, isCurrent: true, effectiveFrom: '2026-02-01', effectiveTo: null }, 'it');
    expect(fromOnly).toContain('2026-02-01');
    const toOnly = versionLabelLine({ version: 3, isCurrent: false, effectiveFrom: null, effectiveTo: '2026-02-28' }, 'zh');
    expect(toOnly).toContain('2026-02-28');
  });

  it('contains no domain word in any language', () => {
    for (const language of ['en', 'zh', 'it']) {
      for (const info of [superseded, current]) expect(versionLabelLine(info, language)).not.toMatch(DOMAIN_WORDS);
    }
  });
});

interface VersionRow {
  document_id: string;
  lineage_id: string;
  version: number;
  is_current: boolean;
  effective_from: string | null;
  effective_to: string | null;
}

const LINEAGE = '00000000-0000-4000-8000-0000000000aa';
const OLD_DOC = '00000000-0000-4000-8000-000000000001';
const NEW_DOC = '00000000-0000-4000-8000-000000000002';
const ROWS: VersionRow[] = [
  { document_id: OLD_DOC, lineage_id: LINEAGE, version: 1, is_current: false, effective_from: '2026-01-01', effective_to: '2026-03-31' },
  { document_id: NEW_DOC, lineage_id: LINEAGE, version: 2, is_current: true, effective_from: null, effective_to: null },
];

function versionsRpc(calls: Array<Record<string, unknown>>, behaviour: { fail?: boolean } = {}): RpcClient {
  return {
    rpc(fn, args): RpcRequest {
      if (fn === VERSIONS_RPC) calls.push((args ?? {}) as Record<string, unknown>);
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          const response: RpcResponse =
            fn !== VERSIONS_RPC
              ? { data: [], error: null }
              : behaviour.fail
                ? { data: null, error: { message: 'boom', code: 'XX000' } }
                : { data: ROWS.filter((row) => ((args as { p_document_ids?: string[] })?.p_document_ids ?? []).includes(row.document_id)), error: null };
          return Promise.resolve(response).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
}

function config(): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2' });
}

function fused(): FusedHit[] {
  const specs = [
    { chunkId: 'new-1', documentId: NEW_DOC, content: 'The synthetic threshold is nine units.', isCurrent: true, version: 2 },
    { chunkId: 'old-1', documentId: OLD_DOC, content: 'The synthetic threshold is seven units.', isCurrent: false, version: 1 },
  ];
  return specs.map((spec, index) => ({
    hit: hit(spec.chunkId, {
      rank: index + 1,
      documentId: spec.documentId,
      chunkIndex: 0,
      content: spec.content,
      similarity: spec.isCurrent ? 0.8 : null,
      isCurrent: spec.isCurrent,
      documentVersion: spec.version,
      document: { filename: 'shared-name.md', createdAt: '2026-01-02T00:00:00Z', metadata: {}, contentPreview: '' },
    }),
    score: 1 / (60 + index + 1),
    ranks: { [spec.isCurrent ? 'dense:0' : 'lexical:0']: 1 },
  }));
}

async function runContext(options: { versionScope?: VersionScope; labeler?: CitationLabeler; fail?: boolean; tagging?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const rpc = versionsRpc(calls, { fail: options.fail });
  setRagDepsForTests({ adminClient: () => ({ rpc: rpc.rpc.bind(rpc) }) as never });
  const cfg = config();
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const input: RunRetrievalInput = {
    scope,
    query: 'synthetic threshold units',
    profile: 'chat',
    signal: new AbortController().signal,
    ...(options.labeler ? { citationLabeler: options.labeler } : {}),
  };
  const out = await runContextStages({
    input,
    config: cfg,
    profile: 'chat',
    params: { ...effectiveRetrievalParams('chat', cfg, null), final_top_k: 20 },
    fusedHits: fused(),
    referenced: null,
    signal: new AbortController().signal,
    collector,
    ...(options.versionScope ? { versionScope: options.versionScope } : {}),
    queryLanguage: 'en',
    ...(options.tagging
      ? {
          security: {
            contextTagging: true,
            injectionCheck: 'off',
            promptGuard: false,
            lakera: false,
            lakeraApiKey: null,
            lakeraBaseUrl: '',
            lakeraMultiTenantAck: false,
            toolResultGuard: 'off',
            anyNonDefault: true,
            warnings: [],
          },
        }
      : {}),
  });
  return { out, calls, assemble: collector.stages().find((row) => row.name === 'assemble') };
}

const aliasLabeler: CitationLabeler = (block, ordinal) => ({ alias: `S${ordinal}`, header: `[S${ordinal}] ${block.title}`, text: block.text });

describe('version labels in the v2 context (D-13)', () => {
  beforeEach(() => {
    resetRagDepsForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetRagDepsForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('scope all: the superseded entry starts with its label line and the current one carries a current line; one batched lookup', async () => {
    const { out, calls, assemble } = await runContext({ versionScope: 'all' });
    const context = out.assembly?.context ?? '';
    const oldLine = versionLabelLine({ version: 1, isCurrent: false, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' }, 'en');
    const newLine = versionLabelLine({ version: 2, isCurrent: true, effectiveFrom: null, effectiveTo: null }, 'en');
    expect(context).toContain(`${oldLine}\nThe synthetic threshold is seven units.`);
    expect(context).toContain(`${newLine}\nThe synthetic threshold is nine units.`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ p_tenant_key: 's:default', p_document_ids: [NEW_DOC, OLD_DOC].sort() });
    expect(assemble?.status).toBe('ok');
  });

  it('two versions that share a filename are two document sections', async () => {
    const { out } = await runContext({ versionScope: { from: '2026-01-01' } });
    const context = out.assembly?.context ?? '';
    expect(context.match(/--- Document: shared-name\.md \(1 relevant chunks\) ---/g)).toHaveLength(2);
  });

  it('with a citation labeler the line precedes the label header, and block text stays the chunk text', async () => {
    const { out } = await runContext({ versionScope: 'all', labeler: aliasLabeler });
    const context = out.assembly?.context ?? '';
    const oldLine = versionLabelLine({ version: 1, isCurrent: false, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' }, 'en');
    expect(context).toMatch(new RegExp(`${oldLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\[S\\d\\] shared-name\\.md\\nThe synthetic threshold is seven units\\.`));
    for (const block of out.assembly?.blocks ?? []) expect(block.text.startsWith('The synthetic threshold')).toBe(true);
  });

  it('with context tagging the line is the doc header', async () => {
    const { out } = await runContext({ versionScope: 'all', tagging: true });
    const oldLine = versionLabelLine({ version: 1, isCurrent: false, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' }, 'en');
    expect(out.assembly?.context ?? '').toContain(oldLine);
  });

  it('scope current: no lookup, no line, no version fields on sources', async () => {
    const plain = await runContext();
    const current = await runContext({ versionScope: 'current' });
    expect(plain.calls).toHaveLength(0);
    expect(current.calls).toHaveLength(0);
    expect(current.out.assembly?.context).toBe(plain.out.assembly?.context);
    expect(plain.out.assembly?.context ?? '').not.toMatch(/superseded/i);
    for (const doc of plain.out.assembly?.usedDocuments ?? []) {
      for (const key of ['version', 'isCurrent', 'effectiveFrom', 'effectiveTo']) expect(key in doc).toBe(false);
    }
  });

  it('scope all: used documents carry version, isCurrent and the document\'s own effective dates (null when absent)', async () => {
    const { out } = await runContext({ versionScope: 'all' });
    const byId = new Map((out.assembly?.usedDocuments ?? []).map((doc) => [doc.id, doc]));
    expect(byId.get(OLD_DOC)).toMatchObject({ version: 1, isCurrent: false, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' });
    expect(byId.get(NEW_DOC)).toMatchObject({ version: 2, isCurrent: true, effectiveFrom: null, effectiveTo: null });
  });

  it('a failing lookup skips the labels, degrades assemble with a fixed code and still returns the context', async () => {
    const plain = await runContext();
    const { out, assemble } = await runContext({ versionScope: 'all', fail: true });
    expect(out.assembly?.context).toBe(plain.out.assembly?.context);
    expect(assemble?.status).toBe('degraded');
    expect(assemble?.detail).toBe('version_labels_unavailable');
    for (const doc of out.assembly?.usedDocuments ?? []) expect('version' in doc).toBe(false);
  });

  it('v2 blocks carry documentVersion from the hit', async () => {
    const { out } = await runContext();
    const versions = new Map((out.assembly?.blocks ?? []).map((block) => [block.documentId, block.documentVersion]));
    expect(versions.get(OLD_DOC)).toBe(1);
    expect(versions.get(NEW_DOC)).toBe(2);
  });
});
