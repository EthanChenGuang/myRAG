import { create } from 'zustand';

/** One group as the caller may see it: id and name only, never a key (D-06, D-29). */
export interface AccessGroupOption {
  id: string;
  name: string;
}

/** The caller's answer of GET /api/rag/access-groups/mine (UI-SPEC 8.1). With the switch off only `enabled: false` is known. */
export interface AccessGroupsMine {
  enabled: boolean;
  personal: boolean;
  isAdmin: boolean;
  ownGroups: AccessGroupOption[];
  assignableGroups: AccessGroupOption[];
}

export type AccessGroupsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export const ACCESS_GROUPS_OFF: AccessGroupsMine = {
  enabled: false,
  personal: false,
  isAdmin: false,
  ownGroups: [],
  assignableGroups: [],
};

export const ACCESS_GROUPS_MINE_PATH = '/api/rag/access-groups/mine';
export const ACCESS_GROUPS_TIMEOUT_MS = 15_000;

type MineFetch = (url: string, init: { signal: AbortSignal; cache: RequestCache }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

interface AccessGroupsState {
  mine: AccessGroupsMine;
  status: AccessGroupsLoadStatus;
  error: string | null;
  /** The workspace the answer belongs to (`personal` or an organization id); a load for another workspace replaces it. */
  workspace: string | null;
  load: (organizationId: string | null, fetcher?: MineFetch) => Promise<void>;
  reset: () => void;
}

function groupList(value: unknown): AccessGroupOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const groups: AccessGroupOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, name } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || seen.has(id)) continue;
    seen.add(id);
    groups.push({ id, name });
  }
  return groups;
}

/** Reads the mine answer; anything malformed, or the switch off, is the off answer (the app renders as today). */
export function readAccessGroupsMine(body: unknown): AccessGroupsMine {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ACCESS_GROUPS_OFF;
  const record = body as Record<string, unknown>;
  if (record.enabled !== true) return ACCESS_GROUPS_OFF;
  return {
    enabled: true,
    personal: record.personal === true,
    isAdmin: record.isAdmin === true,
    ownGroups: groupList(record.ownGroups),
    assignableGroups: groupList(record.assignableGroups),
  };
}

export function accessGroupsMineUrl(organizationId: string | null): string {
  return organizationId ? `${ACCESS_GROUPS_MINE_PATH}?organizationId=${encodeURIComponent(organizationId)}` : ACCESS_GROUPS_MINE_PATH;
}

const defaultFetch: MineFetch = (url, init) => fetch(url, init);

let loadSeq = 0;

export const useAccessGroupsStore = create<AccessGroupsState>()((set) => ({
  mine: ACCESS_GROUPS_OFF,
  status: 'idle',
  error: null,
  workspace: null,
  load: async (organizationId, fetcher = defaultFetch) => {
    const seq = ++loadSeq;
    const workspace = organizationId ?? 'personal';
    set((state) => ({
      status: 'loading',
      error: null,
      workspace,
      mine: state.workspace === workspace ? state.mine : ACCESS_GROUPS_OFF,
    }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACCESS_GROUPS_TIMEOUT_MS);
    try {
      const response = await fetcher(accessGroupsMineUrl(organizationId), { signal: controller.signal, cache: 'no-store' });
      if (seq !== loadSeq) return;
      if (!response.ok) {
        set({ status: 'error', error: `access_groups_mine_${response.status}`, mine: ACCESS_GROUPS_OFF });
        return;
      }
      const body: unknown = await response.json();
      if (seq !== loadSeq) return;
      set({ status: 'ready', error: null, mine: readAccessGroupsMine(body) });
    } catch (error) {
      if (seq !== loadSeq) return;
      const aborted = error instanceof Error && error.name === 'AbortError';
      set({ status: 'error', error: aborted ? 'access_groups_mine_timeout' : 'access_groups_mine_network', mine: ACCESS_GROUPS_OFF });
    } finally {
      clearTimeout(timer);
    }
  },
  reset: () => {
    loadSeq += 1;
    set({ mine: ACCESS_GROUPS_OFF, status: 'idle', error: null, workspace: null });
  },
}));
