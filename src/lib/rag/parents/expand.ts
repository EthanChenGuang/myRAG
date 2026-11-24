import type { RpcClient } from '../backend/supabase-rpc';
import type { BudgetCandidate, BudgetOptions, RenderEstimate } from '../context/budget';
import type { TenantScope } from '../tenant/scope';

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

export interface ExpandParentsInput<C extends ExpandableChild> {
  survivors: C[];
  scope: TenantScope;
  admin: RpcClient | null;
  signal: AbortSignal;
  eligible?: (child: C) => boolean;
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

export async function expandParents<C extends ExpandableChild>(input: ExpandParentsInput<C>): Promise<ExpandParentsResult<C>> {
  void input;
  return { candidates: [], entries: [], requested: 0, fetched: 0 };
}

export function collapseByParent<C extends ExpandableChild>(
  candidates: Array<Expanded<C>>,
  useParent: (parentId: string) => boolean,
): Array<Expanded<C>> {
  void useParent;
  return candidates;
}

export function selectWithParents<C extends BudgetCandidate & ExpandableChild & { parent?: ParentExpansion }>(
  candidates: C[],
  budget: number,
  renderEstimate: RenderEstimate<C>,
  options: BudgetOptions,
): ParentSelection<C> {
  void candidates;
  void budget;
  void renderEstimate;
  void options;
  return { selected: [], contentOverrides: new Map(), usedTokens: 0, parentIds: new Set(), parentChunkIds: new Set() };
}
