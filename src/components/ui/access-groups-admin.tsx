'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { accessGroupText, type AccessGroupLabelKey } from '@/components/ui/access-group-labels';
import { cn } from '@/lib/utils';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

/** The tab is rendered only with the switch on, for owners and admins, in a team workspace (UI-SPEC 6.9, decisions 1 and 22). */
export function showAccessGroupsTab(input: { enabled: boolean; userRole: WorkspaceRole | string; isPersonal: boolean }): boolean {
  return input.enabled === true && (input.userRole === 'owner' || input.userRole === 'admin') && input.isPersonal !== true;
}

// --- Requests ---------------------------------------------------------------------------------------------------------

export const ACCESS_GROUPS_API = '/api/rag/access-groups';
export const ACCESS_ADMIN_TIMEOUT_MS = 15_000;

export type AdminResult =
  | { kind: 'ok'; status: number; body: Record<string, unknown> }
  | { kind: 'fail'; status: number; code: string | null; body: Record<string, unknown> }
  | { kind: 'network' }
  | { kind: 'timeout' };

export type AdminFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

const defaultAdminFetch: AdminFetch = (url, init) => fetch(url, init);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function accessAdminRequest(
  path: string,
  options: { method?: string; body?: unknown; fetcher?: AdminFetch } = {},
): Promise<AdminResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACCESS_ADMIN_TIMEOUT_MS);
  try {
    const response = await (options.fetcher ?? defaultAdminFetch)(`${ACCESS_GROUPS_API}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    let body: Record<string, unknown> = {};
    try {
      body = asRecord(await response.json());
    } catch {
      body = {};
    }
    if (response.ok) return { kind: 'ok', status: response.status, body };
    return { kind: 'fail', status: response.status, code: typeof body.error === 'string' ? body.error : null, body };
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError' ? { kind: 'timeout' } : { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export type FailureOutcome =
  | { type: 'notAdmin' }
  | { type: 'unavailable' }
  | { type: 'outcomeUnknown' }
  | { type: 'changed' }
  | { type: 'code'; status: number; code: string; detail: string | null };

/** One mapping of a failed call for the whole tab (UI-SPEC 8.2): 401 or 403 means the caller is no longer an admin here. */
export function failureOutcome(result: Exclude<AdminResult, { kind: 'ok' }>, write: boolean): FailureOutcome {
  if (result.kind === 'network' || result.kind === 'timeout') return write ? { type: 'outcomeUnknown' } : { type: 'unavailable' };
  if (result.status === 401 || result.status === 403) return { type: 'notAdmin' };
  if (result.status === 404) return { type: 'changed' };
  if (result.status >= 500 || !result.code) return { type: 'unavailable' };
  const details = Array.isArray(result.body.details) ? result.body.details : [];
  const first = asRecord(details[0]);
  const detail = typeof first.message === 'string' ? first.message : null;
  return { type: 'code', status: result.status, code: result.code, detail };
}

// --- Groups -----------------------------------------------------------------------------------------------------------

export interface AdminGroup {
  id: string;
  key: string;
  name: string;
  source: string;
  memberCount: number;
  documentCount: number;
}

export function readAdminGroups(value: unknown): AdminGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: AdminGroup[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const row = asRecord(item);
    if (typeof row.id !== 'string' || typeof row.name !== 'string' || seen.has(row.id)) continue;
    seen.add(row.id);
    groups.push({
      id: row.id,
      key: typeof row.key === 'string' ? row.key : '',
      name: row.name,
      source: typeof row.source === 'string' ? row.source : 'manual',
      memberCount: typeof row.memberCount === 'number' ? row.memberCount : 0,
      documentCount: typeof row.documentCount === 'number' ? row.documentCount : 0,
    });
  }
  return groups;
}

export interface GroupRowView {
  id: string;
  name: string;
  key: string;
  fromConnector: string | null;
  membersLine: string;
  documentsLine: string;
}

export function buildGroupRows(groups: readonly AdminGroup[], language: string): GroupRowView[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    key: group.key,
    fromConnector: group.source === 'connector' ? accessGroupText('group.sourceConnector', language) : null,
    membersLine: accessGroupText('group.members', language, { count: group.memberCount }),
    documentsLine: accessGroupText('group.documents', language, { count: group.documentCount }),
  }));
}

// --- New group form ---------------------------------------------------------------------------------------------------

export const GROUP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const RESERVED_GROUP_KEY = 'all';

/** Lower case, ASCII letters, digits and hyphens; a name with no ASCII letter or digit suggests nothing (UI-SPEC 6.3). */
export function suggestGroupKey(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return GROUP_KEY_PATTERN.test(slug) && slug !== RESERVED_GROUP_KEY ? slug : '';
}

export interface CreateFormState {
  name: string;
  key: string;
  keyTouched: boolean;
  serverKeyError: AccessGroupLabelKey | null;
  serverNameError: AccessGroupLabelKey | null;
  running: boolean;
}

export type CreateFormAction =
  | { type: 'name'; value: string }
  | { type: 'key'; value: string }
  | { type: 'submit' }
  | { type: 'refused'; code: string }
  | { type: 'failed' }
  | { type: 'reset' };

export const CREATE_FORM_INITIAL: CreateFormState = {
  name: '',
  key: '',
  keyTouched: false,
  serverKeyError: null,
  serverNameError: null,
  running: false,
};

const KEY_ERRORS: Record<string, AccessGroupLabelKey> = {
  group_exists: 'error.groupExists',
  invalid_key: 'form.badKey',
  reserved_key: 'form.reservedKey',
};

export function createFormReducer(state: CreateFormState, action: CreateFormAction): CreateFormState {
  switch (action.type) {
    case 'name':
      return {
        ...state,
        name: action.value,
        key: state.keyTouched ? state.key : suggestGroupKey(action.value),
        serverNameError: null,
      };
    case 'key':
      return { ...state, key: action.value, keyTouched: true, serverKeyError: null };
    case 'submit':
      return { ...state, running: true, serverKeyError: null, serverNameError: null };
    case 'refused': {
      const keyError = KEY_ERRORS[action.code] ?? null;
      return {
        ...state,
        running: false,
        serverKeyError: keyError,
        serverNameError: keyError ? null : action.code === 'invalid_name' ? 'form.needName' : null,
      };
    }
    case 'failed':
      return { ...state, running: false };
    case 'reset':
      return CREATE_FORM_INITIAL;
  }
}

export interface CreateFormView {
  nameError: AccessGroupLabelKey | null;
  keyError: AccessGroupLabelKey | null;
  findings: AccessGroupLabelKey[];
  canCreate: boolean;
  focusKey: boolean;
}

/** The browser checks of the form; the findings line names every missing or invalid field (UI-SPEC 6.3). */
export function deriveCreateForm(state: CreateFormState): CreateFormView {
  const key = state.key.trim();
  const nameError: AccessGroupLabelKey | null = state.serverNameError ?? (state.name.trim().length === 0 ? 'form.needName' : null);
  let keyError: AccessGroupLabelKey | null = state.serverKeyError;
  if (!keyError) {
    if (key === RESERVED_GROUP_KEY) keyError = 'form.reservedKey';
    else if (!GROUP_KEY_PATTERN.test(key)) keyError = 'form.badKey';
  }
  const findings = [nameError, keyError].filter((item): item is AccessGroupLabelKey => item !== null);
  return {
    nameError,
    keyError,
    findings,
    canCreate: findings.length === 0 && !state.running,
    focusKey: state.serverKeyError !== null,
  };
}

// --- Members and delete dialog ---------------------------------------------------------------------------------------

export const MEMBER_SEARCH_MIN = 2;
export const MEMBER_SEARCH_DELAY_MS = 400;
export const MEMBER_SEARCH_MAX = 20;

export interface GroupMember { userId: string; displayName: string | null; email: string | null; addedAt: string | null }
export interface MemberCandidate { userId: string; displayName: string | null; email: string | null; already: boolean }

export function readMembers(_value: unknown): GroupMember[] { return []; }
export function readCandidates(_value: unknown): MemberCandidate[] { return []; }
export function memberLabel(_member: { userId: string; displayName: string | null; email: string | null }): { text: string; mono: boolean } {
  return { text: '', mono: false };
}

export interface MemberSearchState { query: string; searching: boolean; results: MemberCandidate[]; resultsFor: string | null; failed: boolean }
export type MemberSearchAction =
  | { type: 'query'; value: string }
  | { type: 'start'; query: string }
  | { type: 'results'; query: string; candidates: MemberCandidate[] }
  | { type: 'failed'; query: string }
  | { type: 'reset' };
export const MEMBER_SEARCH_INITIAL: MemberSearchState = { query: '', searching: false, results: [], resultsFor: null, failed: false };
export function shouldSearchMembers(_query: string): boolean { return false; }
export function memberSearchReducer(state: MemberSearchState, _action: MemberSearchAction): MemberSearchState { return state; }
export interface MemberSearchView { message: string | null; spinner: boolean; results: MemberCandidate[] }
export function deriveMemberSearch(_state: MemberSearchState, _language: string): MemberSearchView {
  return { message: null, spinner: false, results: [] };
}

export interface GroupImpact { onlyCount: number; sharedCount: number; memberCount: number; mappingCount: number }
export function readImpact(_value: unknown): GroupImpact | null { return null; }
export type DeletePhase = 'counting' | 'counted' | 'unavailable' | 'deleting';
export interface DeleteDialogState { phase: DeletePhase; impact: GroupImpact | null }
export type DeleteDialogAction =
  | { type: 'count' }
  | { type: 'counted'; impact: GroupImpact }
  | { type: 'countFailed' }
  | { type: 'delete' }
  | { type: 'deleteFailed' };
export const DELETE_DIALOG_INITIAL: DeleteDialogState = { phase: 'counting', impact: null };
export function deleteDialogReducer(state: DeleteDialogState, _action: DeleteDialogAction): DeleteDialogState { return state; }
export interface DeleteDialogView { title: string; message: string | null; lines: string[]; canDelete: boolean; countAgain: boolean; busy: boolean }
export function deriveDeleteDialog(_state: DeleteDialogState, _group: string, _language: string): DeleteDialogView {
  return { title: '', message: null, lines: [], canDelete: true, countAgain: false, busy: false };
}

// --- Status region ----------------------------------------------------------------------------------------------------

export interface StatusMessage {
  tone: 'success' | 'error';
  text: string;
}

export function failureMessage(outcome: FailureOutcome, language: string): StatusMessage | null {
  switch (outcome.type) {
    case 'notAdmin':
      return null;
    case 'unavailable':
      return { tone: 'error', text: accessGroupText('groups.unavailable', language, { reload: accessGroupText('action.reloadGroups', language) }) };
    case 'outcomeUnknown':
      return { tone: 'error', text: accessGroupText('error.outcomeUnknown', language) };
    case 'changed':
      return { tone: 'error', text: accessGroupText('error.changed', language) };
    case 'code':
      return { tone: 'error', text: accessGroupText('error.invalid', language, { detail: outcome.detail ?? outcome.code }) };
  }
}

const MODAL_PRIMARY_CLASS = 'bg-[#FF6417] hover:bg-[#E55A15] text-white';
const CARD_CLASS = 'bg-[#FFF0E8] dark:bg-[#1A1A1A] rounded-lg p-5 border border-[#FFE0D0] dark:border-[#2A2A2A]';
const ROW_CLASS = 'p-3 rounded-lg bg-white dark:bg-[#2A2A2A] border border-[#FFE0D0] dark:border-[#3A3A3A]';
const MUTED_CLASS = 'text-gray-600 dark:text-gray-400';
const STATUS_CLASS: Record<StatusMessage['tone'], string> = {
  success: 'flex items-start gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200',
  error: 'flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200',
};

export const ACCESS_ADMIN_CLASSES = { MODAL_PRIMARY_CLASS, CARD_CLASS, ROW_CLASS, STATUS_CLASS } as const;

// --- Component --------------------------------------------------------------------------------------------------------

type LoadState = 'loading' | 'ready' | 'unavailable';

interface AccessGroupsAdminProps {
  organizationId: string;
  language: string;
  fetcher?: AdminFetch;
}

export function AccessGroupsAdmin({ organizationId, language, fetcher }: AccessGroupsAdminProps) {
  const text = (key: AccessGroupLabelKey, vars?: Record<string, string | number>) => accessGroupText(key, language, vars);
  const [notAdmin, setNotAdmin] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<CreateFormState>(CREATE_FORM_INITIAL);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const newGroupButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterCreate = useRef<string | null>(null);
  const loadSeq = useRef(0);

  const orgQuery = `organizationId=${encodeURIComponent(organizationId)}`;
  const request = (path: string, options: { method?: string; body?: unknown } = {}) =>
    accessAdminRequest(path, { ...options, fetcher });

  /** Applies a failure to the tab; returns true when the tab content was replaced. */
  const applyFailure = (result: Exclude<AdminResult, { kind: 'ok' }>, write: boolean): FailureOutcome => {
    const outcome = failureOutcome(result, write);
    if (outcome.type === 'notAdmin') {
      setNotAdmin(true);
      setStatus(null);
      return outcome;
    }
    setStatus(failureMessage(outcome, language));
    return outcome;
  };

  const loadGroups = async (append = false) => {
    const seq = ++loadSeq.current;
    setLoadState('loading');
    const cursor = append && nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : '';
    const result = await request(`?${orgQuery}&limit=50${cursor}`);
    if (seq !== loadSeq.current) return;
    if (result.kind !== 'ok') {
      const outcome = applyFailure(result, false);
      if (outcome.type !== 'notAdmin') setLoadState('unavailable');
      return;
    }
    const page = readAdminGroups(result.body.groups);
    setGroups((current) => (append ? [...current, ...page.filter((g) => !current.some((c) => c.id === g.id))] : page));
    setNextCursor(typeof result.body.nextCursor === 'string' ? result.body.nextCursor : null);
    setLoadState('ready');
    setHasLoaded(true);
  };

  useEffect(() => {
    setNotAdmin(false);
    setStatus(null);
    setGroups([]);
    setHasLoaded(false);
    void loadGroups();
  }, [organizationId]);

  useEffect(() => {
    if (form.serverKeyError) keyInputRef.current?.focus();
  }, [form.serverKeyError]);

  useEffect(() => {
    const id = focusAfterCreate.current;
    if (!id) return;
    const button = document.getElementById(`access-group-manage-${id}`);
    if (button) {
      button.focus();
      focusAfterCreate.current = null;
    }
  }, [groups]);

  const formView = deriveCreateForm(form);

  const closeForm = () => {
    setFormOpen(false);
    setForm(CREATE_FORM_INITIAL);
    newGroupButtonRef.current?.focus();
  };

  const createGroup = async () => {
    if (!formView.canCreate) return;
    setForm((state) => createFormReducer(state, { type: 'submit' }));
    const result = await request('', {
      method: 'POST',
      body: { organizationId, key: form.key.trim(), name: form.name.trim() },
    });
    if (result.kind === 'ok') {
      const created = asRecord(result.body.group);
      const name = typeof created.name === 'string' ? created.name : form.name.trim();
      setFormOpen(false);
      setForm(CREATE_FORM_INITIAL);
      setStatus({ tone: 'success', text: text('create.done', { group: name }) });
      focusAfterCreate.current = typeof created.id === 'string' ? created.id : null;
      await loadGroups();
      return;
    }
    const outcome = failureOutcome(result, true);
    if (outcome.type === 'code' && (KEY_ERRORS[outcome.code] || outcome.code === 'invalid_name')) {
      setForm((state) => createFormReducer(state, { type: 'refused', code: outcome.code }));
      setStatus({ tone: 'error', text: text(KEY_ERRORS[outcome.code] ?? 'form.needName') });
      return;
    }
    setForm((state) => createFormReducer(state, { type: 'failed' }));
    applyFailure(result, true);
    if (outcome.type === 'outcomeUnknown' || outcome.type === 'changed') void loadGroups();
  };

  if (notAdmin) {
    return (
      <p role="status" aria-live="polite" className={cn('text-sm', STATUS_CLASS.error)}>
        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <span>{text('error.notAdmin')}</span>
      </p>
    );
  }

  const rows = buildGroupRows(groups, language);
  const busy = loadState === 'loading';
  const formId = 'access-groups-new-form';
  const findingsId = 'access-groups-new-findings';

  return (
    <div className="space-y-6">
      <p role="status" aria-live="polite" className={cn('text-sm', status ? STATUS_CLASS[status.tone] : 'sr-only')}>
        {status && (status.tone === 'error'
          ? <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
          : <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />)}
        {status && <span className="break-words min-w-0">{status.text}</span>}
      </p>

      <section className={CARD_CLASS} aria-labelledby="access-groups-title">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <Users className="h-5 w-5 text-[#FF6417] dark:text-[#FF8A4D]" aria-hidden="true" />
          <h4 id="access-groups-title" className="text-lg font-semibold text-gray-900 dark:text-white flex-1 min-w-0">
            {text('groups.title')}
          </h4>
          {!formOpen && (
            <Button ref={newGroupButtonRef} type="button" variant="outline" size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
              {text('action.newGroup')}
            </Button>
          )}
        </div>
        <p className={cn('text-sm max-w-prose mb-4', MUTED_CLASS)}>{text('access.description')}</p>

        {formOpen && (
          <div
            id={formId}
            className={cn(ROW_CLASS, 'mb-4 grid gap-4 sm:grid-cols-2')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeForm();
              }
            }}
          >
            <div className="space-y-1">
              <label htmlFor="access-group-name" className="text-sm text-gray-900 dark:text-white">{text('form.name')}</label>
              <Input
                id="access-group-name"
                value={form.name}
                maxLength={200}
                autoFocus
                aria-invalid={form.serverNameError ? true : undefined}
                onChange={(event) => setForm((state) => createFormReducer(state, { type: 'name', value: event.target.value }))}
                onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="access-group-key" className="text-sm text-gray-900 dark:text-white">{text('form.key')}</label>
              <Input
                id="access-group-key"
                ref={keyInputRef}
                value={form.key}
                maxLength={63}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                translate="no"
                aria-invalid={form.key.length > 0 && formView.keyError ? true : undefined}
                aria-describedby="access-group-key-help"
                onChange={(event) => setForm((state) => createFormReducer(state, { type: 'key', value: event.target.value }))}
                onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
              />
              <p id="access-group-key-help" className={cn('text-xs', MUTED_CLASS)}>{text('form.keyHelp')}</p>
            </div>
            <p id={findingsId} className={cn('text-xs sm:col-span-2', formView.findings.length > 0 ? 'text-red-700 dark:text-red-300' : MUTED_CLASS)}>
              {formView.findings.map((key) => text(key)).join(' ')}
            </p>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button
                type="button"
                size="sm"
                className={MODAL_PRIMARY_CLASS}
                disabled={!formView.canCreate}
                aria-describedby={formView.findings.length > 0 ? findingsId : undefined}
                onClick={() => void createGroup()}
              >
                {form.running && <Loader2 className="h-4 w-4 mr-1 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {form.running ? text('create.running') : text('action.createGroup')}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={form.running} onClick={closeForm}>
                {text('action.closeForm')}
              </Button>
            </div>
          </div>
        )}

        {loadState === 'unavailable' && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-red-800 dark:text-red-200">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0">
              {text('groups.unavailable', { reload: text('action.reloadGroups') })}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadGroups()}>
              {text('action.reloadGroups')}
            </Button>
          </div>
        )}

        {busy && !hasLoaded ? (
          <div className={cn('flex items-center justify-center gap-2 py-8 text-sm', MUTED_CLASS)}>
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span>{text('groups.loading')}</span>
          </div>
        ) : hasLoaded && rows.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{text('groups.empty.title')}</p>
            <p className={cn('text-sm max-w-prose mx-auto mt-1', MUTED_CLASS)}>{text('groups.empty.body')}</p>
          </div>
        ) : (
          <ul
            className={cn('space-y-2', (busy || loadState === 'unavailable') && hasLoaded && 'opacity-60')}
            aria-busy={busy ? true : undefined}
          >
            {rows.map((row) => (
              <li key={row.id} className={ROW_CLASS}>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white break-words">{row.name}</p>
                    <p className={cn('text-xs flex flex-wrap gap-x-3 gap-y-1 mt-1', MUTED_CLASS)}>
                      <span className="font-mono break-all" translate="no">{row.key}</span>
                      <span className="tabular-nums">{row.membersLine}</span>
                      <span className="tabular-nums">{row.documentsLine}</span>
                      {row.fromConnector && <span>{row.fromConnector}</span>}
                    </p>
                  </div>
                  <Button
                    id={`access-group-manage-${row.id}`}
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={text('action.manageMembersAria', { group: row.name })}
                  >
                    {text('action.manageMembers')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {nextCursor && hasLoaded && (
          <div className="mt-4">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void loadGroups(true)}>
              {text('action.loadMoreGroups')}
            </Button>
          </div>
        )}

        <p className={cn('text-sm mt-4', MUTED_CLASS)}>{text('access.documentsHint')}</p>
      </section>
    </div>
  );
}
