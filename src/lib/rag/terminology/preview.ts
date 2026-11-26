import { randomUUID } from 'node:crypto';
import type { TerminologyEntry, TerminologyPreviewResponse, TerminologyValidationIssue } from '@/lib/rag-eval/contracts.generated';
import { normalizeLexical, queryLexicalTokens } from '../lexical/tokenize';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { SHARED, UNAVAILABLE, callTerminologyRpc, errorsOf, layerOf, terminologyEnabledLanguages, type TerminologyAdminFailed } from './admin';
import { expandMatches, terminologyParams } from './expand';
import { loadEffectiveDictionary } from './load';
import { buildMatcher, type TermEntry } from './matcher';
import { validateEntries } from './validate';

export interface TerminologyPreviewInput {
  /** The admin the route guard verified; the SQL checks it for every layer the preview reads. */
  actorUserId: string;
  /** The minted workspace scope of that admin: the only tenant input (D-22, T-0411-34). */
  scope: TenantScope;
  /** The layer the drafts belong to: 'shared', or the workspace's tenant key. */
  layerKey: string;
  query: string;
  /** Draft entries, validated and applied in memory only. */
  drafts?: readonly TerminologyEntry[];
  signal: AbortSignal;
}

export type TerminologyPreviewResult = { ok: true; preview: TerminologyPreviewResponse } | TerminologyAdminFailed;

type Issue = TerminologyValidationIssue;

function contractEntry(entry: TermEntry): TerminologyEntry {
  return {
    id: entry.entryId,
    layer: entry.layer,
    canonical: entry.canonical,
    variants: [...entry.variants],
    language: entry.language as TerminologyEntry['language'],
    kind: entry.kind,
    mode: entry.mode,
    enabled: true,
    note: null,
    source_language: entry.sourceLanguage as TerminologyEntry['source_language'],
    target_language: entry.targetLanguage as TerminologyEntry['target_language'],
    suppresses_entry_id: null,
  };
}

function termEntry(draft: TerminologyEntry, layer: TermEntry['layer']): TermEntry {
  const variants = draft.variants ?? [];
  return {
    entryId: draft.id ?? randomUUID(),
    layer,
    canonical: draft.canonical,
    variants: [...variants],
    normalizedVariants: variants.map((variant) => normalizeLexical(variant)),
    language: draft.language,
    kind: draft.kind,
    mode: draft.mode,
    sourceLanguage: draft.source_language ?? null,
    targetLanguage: draft.target_language ?? null,
  };
}

/** D-03: the SQL checks the actor for each layer the preview reads (the shared layer, and the workspace of a multi-tenant scope). */
async function authorize(input: TerminologyPreviewInput): Promise<TerminologyAdminFailed | null> {
  const keys = new Set([SHARED, input.layerKey]);
  if (input.scope.kind !== 'single') keys.add(scopeKey(input.scope));
  for (const layerKey of keys) {
    const check = await callTerminologyRpc(
      'rag_term_list_entries',
      { p_actor: input.actorUserId, p_layer_key: layerKey, p_limit: 1, p_offset: 0, p_search: null },
      input.signal,
    );
    if (!check.ok) return check;
  }
  return null;
}

/**
 * D-22, D-24, D-32: the expansion a query gets from the scope's effective dictionary, loaded with the cache bypassed, plus the
 * validated drafts in memory. Translation pairs never match. Nothing is written, and the query is never logged.
 */
export async function previewTerminology(input: TerminologyPreviewInput): Promise<TerminologyPreviewResult> {
  const denied = await authorize(input);
  if (denied) return denied;
  if (input.scope.kind !== 'single' && input.layerKey !== SHARED && input.layerKey !== scopeKey(input.scope)) return { ok: false, reason: 'not_admin' };

  let dictionary;
  try {
    dictionary = await loadEffectiveDictionary(input.scope, { bypassCache: true, signal: input.signal });
  } catch (error) {
    console.error('[RAG Admin] terminology preview failed', { error: error instanceof Error ? error.name : 'unknown' });
    return UNAVAILABLE;
  }

  const params = terminologyParams();
  const layer = layerOf(input.layerKey);
  const drafts = (input.drafts ?? []).map((draft) => ({ ...draft, layer }));
  const draftIds = new Set(drafts.map((draft) => draft.id).filter((id): id is string => typeof id === 'string'));
  const suppressed = new Set(
    layer === 'workspace' ? drafts.map((draft) => draft.suppresses_entry_id).filter((id): id is string => typeof id === 'string') : [],
  );
  const stored = dictionary.entries.filter((entry) => !draftIds.has(entry.entryId) && !(entry.layer === 'shared' && suppressed.has(entry.entryId)));
  const sharedEntries = stored.filter((entry) => entry.layer === 'shared').map(contractEntry);

  let issues: Issue[] = [];
  if (drafts.length > 0) {
    issues = validateEntries(drafts, {
      layer,
      current: stored.filter((entry) => entry.layer === layer).map(contractEntry),
      shared: layer === 'workspace' ? sharedEntries : undefined,
      enabledLanguages: terminologyEnabledLanguages(),
      minHanChars: params.min_han_chars,
    });
    if (errorsOf(issues).length > 0) return { ok: false, reason: 'invalid', issues };
  }

  const draftEntries = drafts.filter((draft) => draft.suppresses_entry_id === null || draft.suppresses_entry_id === undefined).map((draft) => termEntry(draft, layer));
  const entries = [...stored, ...draftEntries].filter((entry) => entry.kind !== 'translation');
  const matcher = buildMatcher(entries, { minHanChars: params.min_han_chars });
  const expansion = expandMatches(input.query, matcher.match(input.query), params);

  const workspaceEntries = [...stored, ...draftEntries].filter((entry) => entry.layer === 'workspace').map(contractEntry);
  const overrides =
    workspaceEntries.length > 0
      ? validateEntries(workspaceEntries, { layer: 'workspace', current: [], shared: sharedEntries, enabledLanguages: terminologyEnabledLanguages(), minHanChars: params.min_han_chars })
          .filter((issue) => issue.code === 'override')
          .map((issue) => ({ ...issue, row: null }))
      : [];

  return {
    ok: true,
    preview: {
      matches: expansion.matches,
      original_tokens: queryLexicalTokens(input.query),
      expansion_tokens: expansion.tokens,
      capped: expansion.capped,
      overrides,
      issues: issues.filter((issue) => issue.code !== 'override'),
      version: dictionary.version,
    },
  };
}
