import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';
import { normalizeLexical } from '@/lib/rag/lexical/tokenize';
import {
  getTerminologyLexicon,
  resetTerminologyLexiconForTests,
  TerminologyUnavailableError,
} from '@/lib/rag/terminology/lexicon';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { TerminologyLexiconSchema } from '@/lib/rag-eval/contracts.generated';
import { uninstallDeps } from '../helpers/pipeline-fakes';

/** D-35: the languages come from the registry; D-37: placeholder terms only. */
const packs = getLanguageRegistry().packs;
const HAN = packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = packs.find((pack) => pack.script === 'Latn')!.code;

interface Row {
  entry_id: string;
  layer: 'shared' | 'workspace';
  canonical: string;
  variants: string[];
  language: string;
  kind: string;
  mode?: string;
  source_language?: string | null;
  target_language?: string | null;
}

let nextId = 0;
function row(layer: Row['layer'], canonical: string, variants: string[], language: string, extra: Partial<Row> = {}): Row {
  nextId += 1;
  return {
    entry_id: `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`,
    layer,
    canonical,
    variants,
    language,
    kind: 'synonym',
    ...extra,
  };
}

function dbRows(rows: Row[], versions: { shared: number; tenant: number }): Record<string, unknown>[] {
  return rows.map((value) => ({
    entry_id: value.entry_id,
    layer: value.layer,
    canonical: value.canonical,
    variants: value.variants,
    normalized_variants: value.variants.map((variant) => normalizeLexical(variant)),
    language: value.language,
    kind: value.kind,
    mode: value.mode ?? 'one_way',
    source_language: value.source_language ?? null,
    target_language: value.target_language ?? null,
    shared_version: versions.shared,
    tenant_version: versions.tenant,
  }));
}

function termClient(respond: (tenantKey: string) => RpcResponse) {
  const calls: string[] = [];
  const client: RpcClient = {
    rpc(fn, args): RpcRequest {
      calls.push(`${fn}:${String(args.p_tenant_key)}`);
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve(respond(String(args.p_tenant_key))).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function install(respond: (tenantKey: string) => RpcResponse) {
  const rpc = termClient(respond);
  setRagDepsForTests({ adminClient: () => rpc.client as never });
  return rpc;
}

const orgA = mintScope('org', null, '00000000-0000-4000-8000-00000000000a');
const orgB = mintScope('org', null, '00000000-0000-4000-8000-00000000000b');

const sharedHan = row('shared', '术语甲乙丙', ['术语甲', '新版术语甲'], HAN);
const sharedLatin = row('shared', 'term alpha beta', ['termalpha', 'alpha beta'], LATIN, { kind: 'abbreviation' });
const sharedAny = row('shared', 'AB-1234-C', ['AB 1234 C'], 'any', { kind: 'identifier' });
const sharedOverridden = row('shared', 'term gamma delta', ['termgamma'], LATIN);
const workspaceWinner = row('workspace', 'term gamma', ['termgamma'], LATIN, { kind: 'alias' });
const pair = row('shared', 'term alpha beta', ['术语甲乙丙'], HAN, {
  kind: 'translation',
  source_language: HAN,
  target_language: LATIN,
});

const BASE = [sharedHan, sharedLatin, sharedAny, sharedOverridden, workspaceWinner, pair];

function respondWith(rows: Row[], versions = { shared: 4, tenant: 2 }) {
  return (): RpcResponse => ({ data: dbRows(rows, versions), error: null });
}

function terms(result: { terms: Array<{ normalized: string; language: string; kind: string }> }) {
  return result.terms.map((term) => `${term.normalized}|${term.language}|${term.kind}`);
}

describe('getTerminologyLexicon (D-33)', () => {
  let previousSwitch: string | undefined;

  beforeEach(() => {
    previousSwitch = process.env.RAG_TERMINOLOGY;
    delete process.env.RAG_TERMINOLOGY;
  });

  afterEach(() => {
    if (previousSwitch === undefined) delete process.env.RAG_TERMINOLOGY;
    else process.env.RAG_TERMINOLOGY = previousSwitch;
    uninstallDeps();
    invalidateTerminologyCache('all');
    resetTerminologyLexiconForTests();
  });

  it('projects canonicals and variants into distinct, sorted, normalized terms; the workspace entry wins a collision', async () => {
    install(respondWith(BASE));
    const result = await getTerminologyLexicon(orgA);
    const expected = [
      `${normalizeLexical('术语甲乙丙')}|${HAN}|synonym`,
      `${normalizeLexical('术语甲')}|${HAN}|synonym`,
      `${normalizeLexical('新版术语甲')}|${HAN}|synonym`,
      `${normalizeLexical('term alpha beta')}|${LATIN}|abbreviation`,
      `${normalizeLexical('termalpha')}|${LATIN}|abbreviation`,
      `${normalizeLexical('alpha beta')}|${LATIN}|abbreviation`,
      `${normalizeLexical('AB-1234-C')}|any|identifier`,
      `${normalizeLexical('AB 1234 C')}|any|identifier`,
      `${normalizeLexical('term gamma')}|${LATIN}|alias`,
      `${normalizeLexical('termgamma')}|${LATIN}|alias`,
    ];
    const sorted = [...result.terms].sort((a, b) =>
      a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : a.language < b.language ? -1 : a.language > b.language ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
    );
    expect(result.terms).toEqual(sorted);
    expect(new Set(terms(result))).toEqual(new Set(expected));
    expect(terms(result)).toHaveLength(expected.length);
    expect(terms(result)).not.toContain(`${normalizeLexical('term gamma delta')}|${LATIN}|synonym`);
    expect(terms(result)).not.toContain(`${normalizeLexical('termgamma')}|${LATIN}|synonym`);
    expect(result.translations).toEqual([]);
    expect(() => TerminologyLexiconSchema.parse(result)).not.toThrow();
  });

  it('leaves out entries the loader does not return (suppressed or disabled) and dedupes repeated terms', async () => {
    const duplicate = row('shared', 'term alpha beta', ['termalpha'], LATIN, { kind: 'abbreviation' });
    install(respondWith([sharedLatin, duplicate]));
    const result = await getTerminologyLexicon(orgA);
    expect(terms(result)).toEqual(
      [
        `${normalizeLexical('alpha beta')}|${LATIN}|abbreviation`,
        `${normalizeLexical('term alpha beta')}|${LATIN}|abbreviation`,
        `${normalizeLexical('termalpha')}|${LATIN}|abbreviation`,
      ].sort(),
    );
  });

  it('returns translation pairs only with includeTranslations', async () => {
    install(respondWith(BASE));
    const plain = await getTerminologyLexicon(orgA);
    expect(plain.terms.some((term) => term.kind === 'translation')).toBe(false);
    const withPairs = await getTerminologyLexicon(orgA, { includeTranslations: true });
    expect(withPairs.translations).toEqual([
      {
        entry_id: pair.entry_id,
        source_language: HAN,
        target_language: LATIN,
        sources: ['术语甲乙丙'],
        target: 'term alpha beta',
        target_normalized: normalizeLexical('term alpha beta'),
      },
    ]);
    expect(terms(withPairs)).toContain(`${normalizeLexical('术语甲乙丙')}|${HAN}|translation`);
    expect(terms(withPairs)).toContain(`${normalizeLexical('term alpha beta')}|${LATIN}|translation`);
    expect(terms(withPairs).filter((term) => term.endsWith('|translation'))).toHaveLength(2);
    expect(() => TerminologyLexiconSchema.parse(withPairs)).not.toThrow();
  });

  it('a workspace translation pair overrides a shared pair with the same source and languages', async () => {
    const workspacePair = row('workspace', 'term gamma delta', ['术语甲乙丙'], HAN, {
      kind: 'translation',
      source_language: HAN,
      target_language: LATIN,
    });
    install(respondWith([pair, workspacePair]));
    const result = await getTerminologyLexicon(orgA, { includeTranslations: true });
    expect(result.translations.map((value) => value.entry_id)).toEqual([workspacePair.entry_id]);
  });

  it('the languages filter keeps those languages and any; the kinds filter keeps those kinds', async () => {
    install(respondWith(BASE));
    const latin = await getTerminologyLexicon(orgA, { languages: [LATIN] });
    expect(new Set(latin.terms.map((term) => term.language))).toEqual(new Set([LATIN, 'any']));
    const han = await getTerminologyLexicon(orgA, { languages: [HAN], includeTranslations: true });
    expect(new Set(han.terms.map((term) => term.language))).toEqual(new Set([HAN, 'any']));
    expect(han.translations).toEqual([]);
    const both = await getTerminologyLexicon(orgA, { languages: [HAN, LATIN], includeTranslations: true });
    expect(both.translations).toHaveLength(1);
    const identifiers = await getTerminologyLexicon(orgA, { kinds: ['identifier'] });
    expect(new Set(identifiers.terms.map((term) => term.kind))).toEqual(new Set(['identifier']));
    const noPairs = await getTerminologyLexicon(orgA, { kinds: ['synonym'], includeTranslations: true });
    expect(noPairs.translations).toEqual([]);
    expect(new Set(noPairs.terms.map((term) => term.kind))).toEqual(new Set(['synonym']));
  });

  it('version is s<n>.w<n>; entries_sha256 is stable across input order and changes with content', async () => {
    install(respondWith(BASE, { shared: 4, tenant: 2 }));
    const first = await getTerminologyLexicon(orgA);
    expect(first.version).toBe('s4.w2');
    expect(first.entries_sha256).toMatch(/^[a-f0-9]{64}$/);

    resetTerminologyLexiconForTests();
    invalidateTerminologyCache('all');
    install(respondWith([...BASE].reverse(), { shared: 4, tenant: 2 }));
    const reordered = await getTerminologyLexicon(orgA);
    expect(reordered.entries_sha256).toBe(first.entries_sha256);

    resetTerminologyLexiconForTests();
    invalidateTerminologyCache('all');
    const changed = { ...sharedLatin, variants: ['termalphax', 'alpha beta'] };
    install(respondWith([sharedHan, changed, sharedAny, sharedOverridden, workspaceWinner, pair], { shared: 5, tenant: 2 }));
    const after = await getTerminologyLexicon(orgA);
    expect(after.version).toBe('s5.w2');
    expect(after.entries_sha256).not.toBe(first.entries_sha256);
  });

  it('single tenant without a tenant layer version reads s<n>.w0', async () => {
    install(respondWith([sharedLatin], { shared: 3, tenant: 0 }));
    const result = await getTerminologyLexicon(mintScope('single', null, null));
    expect(result.version).toBe('s3.w0');
    expect(() => TerminologyLexiconSchema.parse(result)).not.toThrow();
  });

  it('an empty dictionary reads s0.w0 with an empty projection', async () => {
    install(respondWith([], { shared: 0, tenant: 0 }));
    const result = await getTerminologyLexicon(orgA);
    expect(result).toMatchObject({ version: 's0.w0', terms: [], translations: [] });
    expect(() => TerminologyLexiconSchema.parse(result)).not.toThrow();
  });

  it('memoizes the projection per tenant key, version and options', async () => {
    const rpc = install(respondWith(BASE));
    const first = await getTerminologyLexicon(orgA, { languages: [LATIN] });
    const second = await getTerminologyLexicon(orgA, { languages: [LATIN] });
    expect(second).toBe(first);
    const otherOptions = await getTerminologyLexicon(orgA, { languages: [HAN] });
    expect(otherOptions).not.toBe(first);
    const otherTenant = await getTerminologyLexicon(orgB, { languages: [LATIN] });
    expect(otherTenant).not.toBe(first);
    expect(rpc.calls).toEqual([`rag_term_effective:${scopeKey(orgA)}`, `rag_term_effective:${scopeKey(orgB)}`]);

    invalidateTerminologyCache('all');
    install(respondWith(BASE, { shared: 5, tenant: 2 }));
    const newVersion = await getTerminologyLexicon(orgA, { languages: [LATIN] });
    expect(newVersion).not.toBe(first);
    expect(newVersion.version).toBe('s5.w2');
  });

  it('calls the loader with the scope key only, so tenants never see each other', async () => {
    const rowsByKey: Record<string, Row[]> = {
      [scopeKey(orgA)]: [row('workspace', 'term alpha beta', ['termalpha'], LATIN)],
      [scopeKey(orgB)]: [row('workspace', 'term gamma delta', ['termgamma'], LATIN)],
    };
    install((tenantKey) => ({ data: dbRows(rowsByKey[tenantKey] ?? [], { shared: 1, tenant: 1 }), error: null }));
    const a = await getTerminologyLexicon(orgA);
    const b = await getTerminologyLexicon(orgB);
    expect(terms(a)).toContain(`${normalizeLexical('termalpha')}|${LATIN}|synonym`);
    expect(terms(a)).not.toContain(`${normalizeLexical('termgamma')}|${LATIN}|synonym`);
    expect(terms(b)).toContain(`${normalizeLexical('termgamma')}|${LATIN}|synonym`);
    expect(terms(b)).not.toContain(`${normalizeLexical('termalpha')}|${LATIN}|synonym`);
    expect(a.entries_sha256).not.toBe(b.entries_sha256);
  });

  it('rejects with TerminologyUnavailableError when the load fails, and caches nothing', async () => {
    install(() => ({ data: null, error: { code: 'P0001', message: 'synthetic failure' } }));
    await expect(getTerminologyLexicon(orgA)).rejects.toBeInstanceOf(TerminologyUnavailableError);
    setRagDepsForTests({ adminClient: () => null });
    await expect(getTerminologyLexicon(orgB)).rejects.toBeInstanceOf(TerminologyUnavailableError);
    install(respondWith([sharedLatin]));
    const recovered = await getTerminologyLexicon(orgA);
    expect(recovered.terms.length).toBeGreaterThan(0);
  });

  it('reads no switch: the result is the same with RAG_TERMINOLOGY unset and false', async () => {
    install(respondWith(BASE));
    const unset = await getTerminologyLexicon(orgA, { includeTranslations: true });
    resetTerminologyLexiconForTests();
    invalidateTerminologyCache('all');
    process.env.RAG_TERMINOLOGY = 'false';
    setRagDepsForTests({ ragEnv: () => ({ RAG_TERMINOLOGY: 'false' }) as never });
    install(respondWith(BASE));
    const off = await getTerminologyLexicon(orgA, { includeTranslations: true });
    expect(off).toEqual(unset);
  });

  it('rejects anything that is not a minted TenantScope', async () => {
    install(respondWith(BASE));
    await expect(getTerminologyLexicon({ kind: 'org', userId: null, organizationId: 'x' } as unknown as TenantScope)).rejects.toThrow();
  });
});
