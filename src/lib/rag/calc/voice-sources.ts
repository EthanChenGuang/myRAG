/**
 * Phase 5.2.1 D-76: the voice calculation's sources. The agent names context blocks by alias and chunk id; the text is read
 * here, on the server, restricted to the caller's tenant scope and to current, ready rows (D-08), so a chunk id the agent
 * supplies never reaches another tenant's text. An id outside the scope is simply absent and evaluates as an unknown source.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRagDeps } from '../deps';
import { tenantPredicate, type TenantScope } from '../tenant/scope';

export const MAX_VOICE_CALC_SOURCES = 20;

export interface VoiceCalcSource {
  alias: string;
  chunk_id: string;
}

export interface LoadVoiceCalcSourcesOptions {
  admin?: SupabaseClient | null;
  signal?: AbortSignal;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Filter {
  eq(column: string, value: unknown): Filter;
  is(column: string, value: null): Filter;
  in(column: string, values: string[]): Filter;
  abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

function current(query: unknown): Filter {
  return (query as Filter).eq('is_current', true).eq('status', 'ready');
}

/** Alias to block text for the sources inside `scope`; at most MAX_VOICE_CALC_SOURCES, one chunk read and one document read. */
export async function loadVoiceCalcSources(
  scope: TenantScope,
  sources: readonly VoiceCalcSource[],
  options: LoadVoiceCalcSourcesOptions = {},
): Promise<Map<string, string>> {
  const predicate = tenantPredicate(scope);
  const out = new Map<string, string>();
  const wanted = sources.slice(0, MAX_VOICE_CALC_SOURCES).filter((s) => UUID_RE.test(s.chunk_id));
  if (wanted.length === 0) return out;
  const admin = options.admin === undefined ? getRagDeps().adminClient() : options.admin;
  if (!admin) throw new Error('[Voice Calc] admin client unavailable');
  const signal = options.signal ?? new AbortController().signal;

  const chunkIds = [...new Set(wanted.map((s) => s.chunk_id.toLowerCase()))];
  const chunks = await current(admin.from('document_chunks').select('id,document_id,content')).in('id', chunkIds).abortSignal(signal);
  if (chunks.error) throw new Error('[Voice Calc] chunk read failed');
  const rows = ((chunks.data ?? []) as Array<{ id: string; document_id: string; content: string | null }>).filter(
    (row) => typeof row.content === 'string',
  );
  if (rows.length === 0) return out;

  const documentIds = [...new Set(rows.map((row) => row.document_id))];
  let documents = current(admin.from('documents').select('id')).in('id', documentIds);
  if (predicate.kind === 'org') documents = documents.eq('organization_id', predicate.organizationId);
  else if (predicate.kind === 'personal') documents = documents.eq('user_id', predicate.userId).is('organization_id', null);
  const docs = await documents.abortSignal(signal);
  if (docs.error) throw new Error('[Voice Calc] document read failed');
  const inScope = new Set(((docs.data ?? []) as Array<{ id: string }>).map((row) => row.id));

  const textById = new Map<string, string>();
  for (const row of rows) if (inScope.has(row.document_id)) textById.set(row.id.toLowerCase(), row.content as string);
  for (const source of wanted) {
    const text = textById.get(source.chunk_id.toLowerCase());
    if (text !== undefined && !out.has(source.alias)) out.set(source.alias, text);
  }
  return out;
}

/** D-76: the Phase 5 alias of each voice result, by position (S1..Sn); results without a chunk id get no source entry. */
export function voiceCalcSources(results: ReadonlyArray<{ chunk_id: string }>): VoiceCalcSource[] {
  const out: VoiceCalcSource[] = [];
  results.slice(0, MAX_VOICE_CALC_SOURCES).forEach((result, index) => {
    if (typeof result.chunk_id === 'string' && UUID_RE.test(result.chunk_id)) out.push({ alias: `S${index + 1}`, chunk_id: result.chunk_id });
  });
  return out;
}

const TAGGED_DOC_OPEN = /^(<doc id="c([1-9][0-9]*)"[^\n]*>)$/gm;

/** The tagged voice context with the alias label line first inside each block (the Phase 5 header position). */
export function labelTaggedVoiceContext(context: string): string {
  return context.replace(TAGGED_DOC_OPEN, (_match, open: string, n: string) => `${open}\n[S${n}]`);
}

/** The untagged voice context (the agent's own format) with the alias label before each block. */
export function labelledUntaggedVoiceContext(results: ReadonlyArray<{ document_id: string; content: string }>): string {
  return results.map((result, index) => `[S${index + 1}] [Context from document ${result.document_id}]: ${result.content}`).join('\n\n');
}
