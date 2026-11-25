import { RetrievalBackendError, rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { selectWithinBudget, type BudgetCandidate, type BudgetOptions, type RenderEstimate } from '../context/budget';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';

const FETCH_PARENTS_RPC = 'rag_fetch_parents';
const MAX_PARENT_IDS = 200;

export interface ParentExpansion {
  id: string;
  documentId: string;
  content: string;
  tokenCount: number;
  sectionPath: string[];
}

export interface ExpandableChild {
  chunk_id: string;
  document_id: string;
  parent_id?: string | null;
}

export type Expanded<C> = C & { parent?: ParentExpansion };

export type ParentBudgetCandidate = BudgetCandidate & ExpandableChild & { parent?: ParentExpansion };

export interface ExpandParentsInput<C extends ExpandableChild> {
  survivors: C[];
  scope: TenantScope;
  admin: RpcClient | null;
  signal: AbortSignal;
  eligible?: (_child: C) => boolean;
}

export interface ExpandParentsResult<C extends ExpandableChild> {
  candidates: Array<Expanded<C>>;
  entries: Array<Expanded<C>>;
  requested: number;
  fetched: number;
}

export interface ParentSelection<C> {
  selected: C[];
  contentOverrides: Map<string, string>;
  usedTokens: number;
  parentIds: Set<string>;
  parentChunkIds: Set<string>;
}

interface ParentRow {
  id: string;
  document_id: string;
  tenant_key: string;
  is_current: boolean | null;
  section_path: string[] | null;
  content: string;
  token_count: number | null;
}

function isParentRow(value: unknown): value is ParentRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.document_id === 'string' &&
    typeof row.tenant_key === 'string' &&
    typeof row.content === 'string'
  );
}

function toExpansion(row: ParentRow): ParentExpansion {
  return {
    id: row.id,
    documentId: row.document_id,
    content: row.content,
    tokenCount: typeof row.token_count === 'number' ? row.token_count : 0,
    sectionPath: Array.isArray(row.section_path) ? row.section_path.filter((part) => typeof part === 'string') : [],
  };
}

/**
 * One tenant-scoped fetch for the distinct parents of the surviving children. A row is only attached when it belongs to
 * the scope's tenant, was asked for, is current and sits in the same document as the child pointing at it.
 */
export async function expandParents<C extends ExpandableChild>(input: ExpandParentsInput<C>): Promise<ExpandParentsResult<C>> {
  const { survivors, scope, admin, signal } = input;
  assertTenantScope(scope);
  const tenantKey = scopeKey(scope);
  const eligible = input.eligible ?? (() => true);

  const requested: string[] = [];
  const seen = new Set<string>();
  for (const survivor of survivors) {
    const parentId = survivor.parent_id;
    if (!parentId || seen.has(parentId) || !eligible(survivor)) continue;
    seen.add(parentId);
    if (requested.length < MAX_PARENT_IDS) requested.push(parentId);
  }

  if (requested.length === 0) {
    return { candidates: survivors, entries: survivors, requested: 0, fetched: 0 };
  }

  if (!admin) throw new RetrievalBackendError(FETCH_PARENTS_RPC, 'admin_unavailable');
  const response = await admin.rpc(FETCH_PARENTS_RPC, { p_tenant_key: tenantKey, p_parent_ids: requested }).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new RetrievalBackendError(FETCH_PARENTS_RPC, response.error.code ?? null);

  const asked = new Set(requested);
  const parentsById = new Map<string, ParentExpansion>();
  for (const row of rpcRows(response.data)) {
    if (!isParentRow(row)) continue;
    if (row.tenant_key !== tenantKey || row.is_current === false || !asked.has(row.id)) continue;
    parentsById.set(row.id, toExpansion(row));
  }

  const used = new Set<string>();
  const candidates = survivors.map((survivor): Expanded<C> => {
    const parentId = survivor.parent_id;
    const parent = parentId ? parentsById.get(parentId) : undefined;
    if (!parent || !eligible(survivor) || parent.documentId !== survivor.document_id) return survivor;
    used.add(parent.id);
    return { ...survivor, parent };
  });

  return { candidates, entries: collapseByParent(candidates, () => true), requested: requested.length, fetched: used.size };
}

/** One entry per used parent, at the rank of its best child; every other child stays as it is. */
export function collapseByParent<C extends ExpandableChild>(
  candidates: Array<Expanded<C>>,
  replacesChildren: (_parentId: string) => boolean,
): Array<Expanded<C>> {
  const placed = new Set<string>();
  const collapsed: Array<Expanded<C>> = [];
  for (const candidate of candidates) {
    const parent = candidate.parent;
    if (parent && replacesChildren(parent.id)) {
      if (placed.has(parent.id)) continue;
      placed.add(parent.id);
    }
    collapsed.push(candidate);
  }
  return collapsed;
}

/**
 * Budget selection in which a parent stands in for its children only while it fits whole: a parent that is dropped or
 * would be truncated hands its children back, in rank order. Parents are never cut.
 */
export function selectWithParents<C extends BudgetCandidate & ExpandableChild & { parent?: ParentExpansion }>(
  candidates: C[],
  budget: number,
  renderEstimate: RenderEstimate<C>,
  options: BudgetOptions,
): ParentSelection<C> {
  const fallback = new Set<string>();
  for (;;) {
    const replacesChildren = (parentId: string) => !fallback.has(parentId);
    const entries = collapseByParent<C>(candidates, replacesChildren).map((entry): C =>
      entry.parent && replacesChildren(entry.parent.id) ? { ...entry, content: entry.parent.content } : entry,
    );
    const result = selectWithinBudget<C>(entries, budget, renderEstimate, options);
    const selectedIds = new Set(result.selected.map((entry) => entry.chunk_id));
    const failing = entries.find(
      (entry) =>
        entry.parent !== undefined &&
        replacesChildren(entry.parent.id) &&
        (!selectedIds.has(entry.chunk_id) || result.contentOverrides.has(entry.chunk_id)),
    );
    if (failing?.parent) {
      fallback.add(failing.parent.id);
      continue;
    }

    const parentIds = new Set<string>();
    const parentChunkIds = new Set<string>();
    for (const entry of result.selected) {
      if (entry.parent && replacesChildren(entry.parent.id)) {
        parentIds.add(entry.parent.id);
        parentChunkIds.add(entry.chunk_id);
      }
    }
    return { ...result, parentIds, parentChunkIds };
  }
}
