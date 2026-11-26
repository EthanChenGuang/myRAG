import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRagDepsForTests, resetRagDepsForTests } from '@/lib/rag/deps';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';
import { normalizeLexical } from '@/lib/rag/lexical/tokenize';

const settings = vi.hoisted(() => ({ languages: [] as string[] }));

vi.mock('@/lib/rag/lang/settings', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/lang/settings')>();
  return {
    ...original,
    getLanguageSettings: () => ({ configured: settings.languages.length > 0, languages: [...settings.languages], primary: settings.languages[0] ?? null, monolingual: settings.languages.length === 1 }),
  };
});

vi.mock('@/lib/rag/terminology/load', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/terminology/load')>();
  return { ...original, invalidateTerminologyCache: vi.fn() };
});

const { invalidateTerminologyCache } = await import('@/lib/rag/terminology/load');
const admin = await import('@/lib/rag/terminology/admin');

/** D-35: languages come from the registry; D-37: placeholder terms only. */
const packs = getLanguageRegistry().packs;
const HAN = packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = packs.find((pack) => pack.script === 'Latn')!.code;
const OTHER = packs.find((pack) => pack.code !== HAN && pack.code !== LATIN)?.code ?? null;

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const TENANT = `u:${ACTOR}`;
const signal = new AbortController().signal;

type Row = Record<string, unknown>;
type Outcome = { data: unknown; error: { message: string; code?: string; details?: string | null } | null };

let nextId = 0;
function uuid(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`;
}

function stored(layerKey: string, canonical: string, variants: string[], extra: Row = {}): Row {
  return {
    id: uuid(),
    layer_key: layerKey,
    canonical,
    variants,
    normalized_variants: variants.map(normalizeLexical),
    language: LATIN,
    kind: 'synonym',
    mode: 'one_way',
    source_language: null,
    target_language: null,
    enabled: true,
    note: null,
    suppresses_entry_id: null,
    created_by: ACTOR,
    updated_by: ACTOR,
    created_at: '2026-11-26T10:00:00.000Z',
    updated_at: '2026-11-26T10:00:00.000Z',
    ...extra,
  };
}

interface Fake {
  layers: Record<string, { version: number; sha: string | null; rows: Row[] }>;
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  outcomes: Record<string, Outcome | ((args: Record<string, unknown>) => Outcome)>;
  listPages: number;
}

const SHA = 'a'.repeat(64);

function fakeClient(fake: Fake) {
  const respond = (outcome: Outcome) => {
    const request = {
      abortSignal: () => request,
      then: (onFulfilled: (value: Outcome) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(outcome).then(onFulfilled, onRejected),
    };
    return request;
  };
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      fake.calls.push({ fn, args });
      const configured = fake.outcomes[fn];
      if (configured) return respond(typeof configured === 'function' ? configured(args) : configured);
      if (fn === 'rag_term_list_entries') {
        fake.listPages += 1;
        const layer = fake.layers[args.p_layer_key as string] ?? { version: 0, sha: null, rows: [] };
        const offset = args.p_offset as number;
        const limit = Math.min(args.p_limit as number, 100);
        const page = layer.rows.slice(offset, offset + limit).map((row) => ({ ...row, layer_version: layer.version, total_count: layer.rows.length }));
        return respond({ data: page, error: null });
      }
      return respond({ data: [], error: null });
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        limit: () => builder,
        abortSignal: () => builder,
        then(onFulfilled: (value: Outcome) => unknown, onRejected?: (reason: unknown) => unknown) {
          if (table !== 'rag_term_layers') return Promise.reject(new Error(`unexpected table ${table}`)).then(onFulfilled, onRejected);
          const layer = fake.layers[filters.layer_key as string];
          const data = layer ? [{ layer_key: filters.layer_key, version: layer.version, entries_sha256: layer.sha }] : [];
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

let fake: Fake;

function install(): void {
  fake = { layers: { shared: { version: 3, sha: SHA, rows: [] } }, calls: [], outcomes: {}, listPages: 0 };
  setRagDepsForTests({ adminClient: () => fakeClient(fake) as never });
}

const upserts = () => fake.calls.filter((call) => call.fn === 'rag_term_upsert_entry');

function upsertReturns(entryId: string, version: number): void {
  fake.outcomes.rag_term_upsert_entry = { data: [{ entry_id: entryId, layer_version: version, entries_sha256: SHA, action: 'create' }], error: null };
}

beforeEach(() => {
  settings.languages = [HAN, LATIN];
  install();
  vi.mocked(invalidateTerminologyCache).mockClear();
});

afterEach(() => {
  resetRagDepsForTests();
});

describe('terminologyEnabledLanguages and listEntries (D-35)', () => {
  it('returns the enabled registry codes of the settings module', () => {
    expect(admin.terminologyEnabledLanguages()).toEqual([HAN, LATIN]);
    settings.languages = [];
    expect(admin.terminologyEnabledLanguages()).toEqual([]);
  });

  it('lists one page with the layer version, the total and the enabled languages', async () => {
    fake.layers.shared!.rows = [stored('shared', 'term alpha beta', ['termalpha']), stored('shared', 'term gamma delta', ['termgamma'])];
    const result = await admin.listEntries({ actorUserId: ACTOR, layerKey: 'shared', limit: 500, offset: 0, search: ' alpha ', signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(2);
    expect(result.layerVersion).toBe(3);
    expect(result.entriesSha256).toBe(SHA);
    expect(result.enabledLanguages).toEqual([HAN, LATIN]);
    expect(result.limit).toBe(100);
    expect(result.items[0]).toMatchObject({ canonical: 'term alpha beta', variants: ['termalpha'], layer_key: 'shared', kind: 'synonym' });
    expect(result.items[0]).not.toHaveProperty('normalized_variants');
    expect(fake.calls[0]).toEqual({
      fn: 'rag_term_list_entries',
      args: { p_actor: ACTOR, p_layer_key: 'shared', p_limit: 100, p_offset: 0, p_search: 'alpha' },
    });
  });

  it('reports version 0 and no hash for a layer without a row', async () => {
    const result = await admin.listEntries({ actorUserId: ACTOR, layerKey: TENANT, signal });
    expect(result).toMatchObject({ ok: true, items: [], total: 0, layerVersion: 0, entriesSha256: null });
  });
});

describe('reason mapping of the SQL error words (D-03)', () => {
  const cases: Array<[string, string]> = [
    ['not_admin', 'not_admin'],
    ['not_admin_of_layer', 'not_admin'],
    ['not_found', 'not_found'],
    ['version_conflict', 'version_conflict'],
    ['workspace_layer_unavailable', 'workspace_layer_unavailable'],
    ['limit', 'limit'],
    ['invalid_entry', 'invalid'],
    ['permission denied for function rag_term_list_entries', 'unavailable'],
    ['constructor', 'unavailable'],
  ];
  for (const [message, reason] of cases) {
    it(`maps ${message} to ${reason}`, async () => {
      fake.outcomes.rag_term_list_audit = { data: null, error: { message, code: 'P0001' } };
      const result = await admin.listAudit({ actorUserId: ACTOR, layerKey: 'shared', signal });
      expect(result).toMatchObject({ ok: false, reason });
    });
  }

  it('reads the current version from the version_conflict detail', async () => {
    fake.outcomes.rag_term_delete_entry = { data: null, error: { message: 'version_conflict', code: 'P0001', details: '{"current_version": 7}' } };
    const result = await admin.deleteEntry({ actorUserId: ACTOR, layerKey: 'shared', entryId: uuid(), expectedVersion: 3, signal });
    expect(result).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 7 });
  });

  it('answers unavailable without an admin client, and when the call throws', async () => {
    setRagDepsForTests({ adminClient: () => null });
    expect(await admin.listAudit({ actorUserId: ACTOR, layerKey: 'shared', signal })).toEqual({ ok: false, reason: 'unavailable' });
    setRagDepsForTests({
      adminClient: () =>
        ({
          rpc: () => {
            throw new Error('network');
          },
        }) as never,
    });
    expect(await admin.listAudit({ actorUserId: ACTOR, layerKey: 'shared', signal })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('never logs entry text when a call fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.outcomes.rag_term_upsert_entry = { data: null, error: { message: 'boom term alpha beta', code: 'XX000' } };
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: 'term alpha beta', variants: ['termalpha'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(JSON.stringify(error.mock.calls)).not.toContain('alpha');
    expect(String(error.mock.calls[0]?.[0])).toContain('[RAG Admin]');
    error.mockRestore();
  });
});

describe('createEntry and updateEntry (D-05, D-22, D-24, D-32)', () => {
  it('computes normalized_variants, sends no id and invalidates every tenant for a shared write', async () => {
    const id = uuid();
    upsertReturns(id, 4);
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: 'term alpha beta', variants: ['TermAlpha', 'Alpha  Beta'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result).toEqual({ ok: true, entryId: id, layerVersion: 4, entriesSha256: SHA, action: 'create', warnings: [] });
    expect(upserts()).toHaveLength(1);
    const args = upserts()[0]!.args;
    expect(args).toMatchObject({ p_actor: ACTOR, p_layer_key: 'shared', p_expected_version: 3 });
    expect(args.p_entry).toEqual({
      canonical: 'term alpha beta',
      variants: ['TermAlpha', 'Alpha  Beta'],
      normalized_variants: [normalizeLexical('TermAlpha'), normalizeLexical('Alpha  Beta')],
      language: LATIN,
      kind: 'synonym',
      mode: 'one_way',
      enabled: true,
      note: null,
      source_language: null,
      target_language: null,
    });
    expect(invalidateTerminologyCache).toHaveBeenCalledWith('all');
  });

  it('passes both languages of a translation pair and invalidates only the tenant for a workspace write', async () => {
    fake.layers[TENANT] = { version: 1, sha: SHA, rows: [] };
    upsertReturns(uuid(), 2);
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: TENANT,
      expectedVersion: 1,
      entry: { canonical: 'term alpha beta', variants: ['术语甲乙丙'], language: HAN, kind: 'translation', source_language: HAN, target_language: LATIN },
      signal,
    });
    expect(result.ok).toBe(true);
    expect(upserts()[0]!.args.p_entry).toMatchObject({ kind: 'translation', language: HAN, source_language: HAN, target_language: LATIN, mode: 'one_way' });
    expect(invalidateTerminologyCache).toHaveBeenCalledWith(TENANT);
    expect(invalidateTerminologyCache).not.toHaveBeenCalledWith('all');
  });

  it('refuses a chain with the validator issues and writes nothing', async () => {
    fake.layers.shared!.rows = [stored('shared', 'term alpha beta', ['termalpha'])];
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: 'termalpha', variants: ['voce alfa'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid');
    expect(result.issues?.map((issue) => issue.code)).toContain('chain');
    expect(upserts()).toHaveLength(0);
    expect(invalidateTerminologyCache).not.toHaveBeenCalled();
  });

  it('refuses a language that is not enabled and a pair with equal languages', async () => {
    settings.languages = [LATIN];
    const notEnabled = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: '术语甲乙丙', variants: ['术语甲'], language: HAN, kind: 'synonym' },
      signal,
    });
    expect(notEnabled).toMatchObject({ ok: false, reason: 'invalid' });
    expect(!notEnabled.ok && notEnabled.issues?.map((issue) => issue.code)).toContain('invalid_language');

    settings.languages = [HAN, LATIN];
    const equal = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: 'term alpha beta', variants: ['termalpha'], language: LATIN, kind: 'translation', source_language: LATIN, target_language: LATIN },
      signal,
    });
    expect(!equal.ok && equal.issues?.map((issue) => issue.code)).toContain('invalid_translation');
    expect(upserts()).toHaveLength(0);
  });

  it('drops a variant equal to the canonical, returns the warning and writes the rest', async () => {
    upsertReturns(uuid(), 4);
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: 'term alpha beta', variants: ['Term Alpha Beta', 'termalpha', 'TERMALPHA'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((issue) => issue.code)).toEqual(['duplicate', 'duplicate']);
    expect(upserts()[0]!.args.p_entry).toMatchObject({ variants: ['termalpha'], normalized_variants: [normalizeLexical('termalpha')] });
  });

  it('refuses an entry whose only variant is the canonical, after dropping it', async () => {
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: 'term alpha beta', variants: ['term alpha beta'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(upserts()).toHaveLength(0);
  });

  it('answers version_conflict with the current version before validating a stale write', async () => {
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 2,
      entry: { canonical: 'term alpha beta', variants: ['termalpha'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 3 });
    expect(upserts()).toHaveLength(0);
  });

  it('validates a workspace write against the shared layer and returns the override warning', async () => {
    fake.layers.shared!.rows = [stored('shared', 'term alpha beta', ['termalpha'])];
    fake.layers[TENANT] = { version: 5, sha: SHA, rows: [] };
    upsertReturns(uuid(), 6);
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: TENANT,
      expectedVersion: 5,
      entry: { canonical: 'term gamma delta', variants: ['termalpha'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((issue) => issue.code)).toContain('override');
    const listed = fake.calls.filter((call) => call.fn === 'rag_term_list_entries').map((call) => call.args.p_layer_key);
    expect(listed).toEqual(expect.arrayContaining([TENANT, 'shared']));
  });

  it('reads the shared layer again when a shared write lands while a workspace write validates', async () => {
    fake.layers.shared!.rows = [stored('shared', 'term alpha beta', ['termalpha'])];
    fake.layers[TENANT] = { version: 5, sha: SHA, rows: [] };
    upsertReturns(uuid(), 6);
    let sharedReads = 0;
    fake.outcomes.rag_term_list_entries = (args) => {
      const layer = fake.layers[args.p_layer_key as string]!;
      if (args.p_layer_key === 'shared') sharedReads += 1;
      const version = args.p_layer_key === 'shared' && sharedReads === 1 ? layer.version - 1 : layer.version;
      return { data: layer.rows.map((row) => ({ ...row, layer_version: version, total_count: layer.rows.length })), error: null };
    };
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: TENANT,
      expectedVersion: 5,
      entry: { canonical: 'term gamma delta', variants: ['termgamma'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result.ok).toBe(true);
    expect(sharedReads).toBe(2);
    expect(upserts()).toHaveLength(1);
  });

  it('reads every page of a large layer before validating', async () => {
    fake.layers.shared!.rows = Array.from({ length: 250 }, (_, index) => stored('shared', `term alpha ${index.toString(36)}x`, [`termalpha${index.toString(36)}x`]));
    upsertReturns(uuid(), 4);
    fake.layers.shared!.rows.push(stored('shared', 'term alpha beta', ['termzeta']));
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: 'term gamma delta', variants: ['termzeta'], language: LATIN, kind: 'synonym' },
      signal,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(fake.listPages).toBe(3);
  });

  it('merges a PATCH into the stored entry and sends its id', async () => {
    const current = stored('shared', 'term alpha beta', ['termalpha'], { note: 'kept note' });
    fake.layers.shared!.rows = [current];
    upsertReturns(current.id as string, 4);
    fake.outcomes.rag_term_upsert_entry = { data: [{ entry_id: current.id, layer_version: 4, entries_sha256: SHA, action: 'update' }], error: null };
    const result = await admin.updateEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      entryId: current.id as string,
      expectedVersion: 3,
      patch: { variants: ['termalpha', 'alpha beta'], enabled: false },
      signal,
    });
    expect(result).toMatchObject({ ok: true, action: 'update', layerVersion: 4 });
    expect(upserts()[0]!.args.p_entry).toMatchObject({
      id: current.id,
      canonical: 'term alpha beta',
      variants: ['termalpha', 'alpha beta'],
      enabled: false,
      note: 'kept note',
      language: LATIN,
    });
    expect(invalidateTerminologyCache).toHaveBeenCalledWith('all');
  });

  it('answers not_found for an id that is not in the layer, and for a suppression row', async () => {
    const suppression = stored(TENANT, 'term alpha beta', [], { suppresses_entry_id: uuid() });
    fake.layers[TENANT] = { version: 1, sha: SHA, rows: [suppression] };
    const unknown = await admin.updateEntry({ actorUserId: ACTOR, layerKey: TENANT, entryId: uuid(), expectedVersion: 1, patch: { enabled: false }, signal });
    expect(unknown).toEqual({ ok: false, reason: 'not_found' });
    const row = await admin.updateEntry({ actorUserId: ACTOR, layerKey: TENANT, entryId: suppression.id as string, expectedVersion: 1, patch: { enabled: false }, signal });
    expect(row).toEqual({ ok: false, reason: 'not_found' });
    expect(upserts()).toHaveLength(0);
  });

  it.runIf(OTHER !== null)('keeps a third registry language out when only two are enabled', async () => {
    const result = await admin.createEntry({
      actorUserId: ACTOR,
      layerKey: 'shared',
      expectedVersion: 3,
      entry: { canonical: 'termine alfa beta', variants: ['voce alfa'], language: OTHER!, kind: 'synonym' },
      signal,
    });
    expect(!result.ok && result.issues?.map((issue) => issue.code)).toContain('invalid_language');
  });
});

describe('deleteEntry, setSuppression, getVersions and listAudit (D-05, D-06)', () => {
  it('deletes with the expected version and invalidates every tenant for a shared entry', async () => {
    const id = uuid();
    fake.outcomes.rag_term_delete_entry = { data: [{ layer_version: 4, entries_sha256: SHA }], error: null };
    const result = await admin.deleteEntry({ actorUserId: ACTOR, layerKey: 'shared', entryId: id, expectedVersion: 3, signal });
    expect(result).toEqual({ ok: true, layerVersion: 4, entriesSha256: SHA });
    expect(fake.calls).toEqual([{ fn: 'rag_term_delete_entry', args: { p_actor: ACTOR, p_layer_key: 'shared', p_entry_id: id, p_expected_version: 3 } }]);
    expect(invalidateTerminologyCache).toHaveBeenCalledWith('all');
  });

  it('suppresses a shared entry for the tenant and invalidates that tenant', async () => {
    const id = uuid();
    fake.outcomes.rag_term_set_suppression = { data: [{ layer_version: 2, entries_sha256: SHA, suppressed: true }], error: null };
    const result = await admin.setSuppression({ actorUserId: ACTOR, layerKey: TENANT, sharedEntryId: id, suppressed: true, expectedVersion: 1, signal });
    expect(result).toEqual({ ok: true, layerVersion: 2, entriesSha256: SHA, suppressed: true });
    expect(fake.calls[0]).toEqual({
      fn: 'rag_term_set_suppression',
      args: { p_actor: ACTOR, p_layer_key: TENANT, p_shared_entry_id: id, p_suppressed: true, p_expected_version: 1 },
    });
    expect(invalidateTerminologyCache).toHaveBeenCalledWith(TENANT);
  });

  it('does not invalidate after a failed write', async () => {
    fake.outcomes.rag_term_set_suppression = { data: null, error: { message: 'not_found' } };
    const result = await admin.setSuppression({ actorUserId: ACTOR, layerKey: TENANT, sharedEntryId: uuid(), suppressed: false, expectedVersion: 1, signal });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(invalidateTerminologyCache).not.toHaveBeenCalled();
  });

  it('returns both layer versions with their hashes after the SQL check of each layer', async () => {
    fake.layers[TENANT] = { version: 9, sha: 'b'.repeat(64), rows: [] };
    const result = await admin.getVersions({ actorUserId: ACTOR, workspaceLayerKey: TENANT, signal });
    expect(result).toEqual({
      ok: true,
      shared: { layer_key: 'shared', version: 3, entries_sha256: SHA },
      workspace: { layer_key: TENANT, version: 9, entries_sha256: 'b'.repeat(64) },
    });
    expect(fake.calls.map((call) => call.args.p_layer_key)).toEqual(['shared', TENANT]);
    const single = await admin.getVersions({ actorUserId: ACTOR, workspaceLayerKey: null, signal });
    expect(single).toMatchObject({ ok: true, workspace: null });
  });

  it('refuses the versions of a layer the SQL check refuses', async () => {
    fake.outcomes.rag_term_list_entries = (args) =>
      args.p_layer_key === 'shared' ? { data: [], error: null } : { data: null, error: { message: 'not_admin_of_layer' } };
    expect(await admin.getVersions({ actorUserId: ACTOR, workspaceLayerKey: TENANT, signal })).toEqual({ ok: false, reason: 'not_admin' });
  });

  it('lists audit rows in the order the SQL returns them (newest first)', async () => {
    const entryId = uuid();
    fake.outcomes.rag_term_list_audit = {
      data: [
        { id: uuid(), layer_key: 'shared', entry_id: entryId, action: 'update', actor: ACTOR, before: { canonical: 'a' }, after: { canonical: 'b' }, layer_version: 4, created_at: '2026-11-26T11:00:00.000Z', total_count: 2 },
        { id: uuid(), layer_key: 'shared', entry_id: entryId, action: 'create', actor: ACTOR, before: null, after: { canonical: 'a' }, layer_version: '3', created_at: '2026-11-26T10:00:00.000Z', total_count: 2 },
      ],
      error: null,
    };
    const result = await admin.listAudit({ actorUserId: ACTOR, layerKey: 'shared', limit: 10, offset: 0, signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(2);
    expect(result.items.map((item) => [item.action, item.layer_version])).toEqual([
      ['update', 4],
      ['create', 3],
    ]);
    expect(fake.calls[0]!.args).toEqual({ p_actor: ACTOR, p_layer_key: 'shared', p_limit: 10, p_offset: 0 });
  });
});
