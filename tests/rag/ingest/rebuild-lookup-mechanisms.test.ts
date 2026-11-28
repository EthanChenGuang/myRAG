import { describe, expect, test } from 'vitest';
import { getSettingsClassification, ingestionKeysOf } from '@/lib/rag/ingest/fingerprint';
import { countImpact, MECHANISM_COMMANDS, REBUILD_MECHANISMS, startOf } from '@/lib/rag/ingest/fingerprint/impact';
import { isRebuildableMechanism, planRebuild, REBUILDABLE_MECHANISMS, type RebuildTarget } from '@/lib/rag/ingest/rebuild/plan';

const LOOKUP_SWITCHES: Record<string, string> = {
  RAG_TABLE_LOOKUP: 'reindex_tables',
  RAG_IDENTIFIER_INDEX: 'reindex_identifiers',
  RAG_DUP_CLUSTERS: 'recluster',
};

const PREVIOUS_MECHANISMS = new Set(['reparse', 'rechunk', 'relex', 'reembed', 'recaption', 'retranslate', 'rescan']);

const A = 'u:00000000-0000-4000-8000-0000000000a1';
const B = 's:default';
const documents: RebuildTarget[] = [
  { documentId: '00000000-0000-4000-8000-000000000001', tenantKey: A, docType: 'general' },
  { documentId: '00000000-0000-4000-8000-000000000002', tenantKey: B, docType: 'general' },
  { documentId: '00000000-0000-4000-8000-000000000003', tenantKey: A, docType: 'contract_legal' },
];
const options = { ingestAsync: true, settingsHash: 'a'.repeat(64) };

describe('lookup index and duplicate cluster rebuild mechanisms', () => {
  test('each of the three switches is classified with its own mechanism, not reparse', () => {
    for (const [name, mechanism] of Object.entries(LOOKUP_SWITCHES)) {
      expect(ingestionKeysOf({ [name]: 'true' })).toEqual([{ name, mechanism }]);
    }
  });

  test('changing one of the three switches proposes only its own mechanism', () => {
    for (const [name, mechanism] of Object.entries(LOOKUP_SWITCHES)) {
      const counts = countImpact([], { [name]: 'true' });
      expect(counts.mechanisms).toEqual([mechanism]);
      expect(counts.affected.has('reparse')).toBe(false);
    }
    const all = countImpact([], Object.fromEntries(Object.keys(LOOKUP_SWITCHES).map((name) => [name, 'true'])));
    expect(all.mechanisms).toEqual(['reindex_tables', 'reindex_identifiers', 'recluster']);
  });

  test('other switches keep their mechanisms', () => {
    expect(countImpact([], { RAG_SUPPORTED_LANGUAGES: 'en' }).mechanisms).toEqual(['reparse']);
    expect(countImpact([], { RAG_TABLE_HEADER_REPEAT: 'profile' }).mechanisms).toEqual(['rechunk']);
    expect(countImpact([], { RAG_LEXICAL_DICTIONARY: 'true' }).mechanisms).toEqual(['relex']);
    expect(countImpact([], { RAG_CAPTION_LANGUAGE: 'document' }).mechanisms).toEqual(['recaption']);
    expect(countImpact([], { RAG_TABLE_LOOKUP: 'true', RAG_SUPPORTED_LANGUAGES: 'en' }).mechanisms).toEqual(['reparse', 'reindex_tables']);
    for (const entry of getSettingsClassification().entries) {
      if (entry.side === 'query' || entry.name in LOOKUP_SWITCHES) continue;
      expect(PREVIOUS_MECHANISMS.has(entry.mechanism), entry.name).toBe(true);
    }
  });

  test('the three mechanisms are listed, rebuildable and started from the command line', () => {
    expect(REBUILD_MECHANISMS).toEqual(['reparse', 'rechunk', 'relex', 'reembed', 'recaption', 'retranslate', 'reindex_tables', 'reindex_identifiers', 'recluster', 'rescan']);
    expect([...REBUILDABLE_MECHANISMS]).toEqual(['reparse', 'rechunk', 'relex', 'reembed', 'recaption', 'retranslate', 'reindex_tables', 'reindex_identifiers', 'recluster']);
    for (const mechanism of Object.values(LOOKUP_SWITCHES)) {
      expect(isRebuildableMechanism(mechanism)).toBe(true);
      expect(startOf(mechanism as never, true)).toBe('cli');
      expect(startOf(mechanism as never, false)).toBe('cli');
    }
    expect((MECHANISM_COMMANDS as Record<string, string>).reindex_tables).toBe('npm run rag:table-rows');
    expect((MECHANISM_COMMANDS as Record<string, string>).reindex_identifiers).toBe('npm run rag:identifiers');
    expect((MECHANISM_COMMANDS as Record<string, string>).recluster).toBe('npm run rag:dup-clusters');
  });

  test('the plan runs the dedicated backfill per tenant and never a re-parse', () => {
    const expected: Record<string, string> = {
      reindex_tables: 'npm run rag:table-rows --',
      reindex_identifiers: 'npm run rag:identifiers --',
      recluster: 'npm run rag:dup-clusters --',
    };
    for (const [mechanism, prefix] of Object.entries(expected)) {
      const built = planRebuild(mechanism as never, { documents, withoutFingerprint: 0 }, options);
      expect(built).toEqual({
        kind: 'command',
        mechanism,
        activation: 'none',
        affected: 3,
        commands: [`${prefix} --tenant ${B}`, `${prefix} --tenant ${A}`],
      });
      expect(planRebuild(mechanism as never, { documents: [], withoutFingerprint: 0 }, options)).toEqual({ kind: 'nothing', mechanism, affected: 0 });
    }
  });
});
