'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readMembers(value: unknown): GroupMember[] {
  if (!Array.isArray(value)) return [];
  const members: GroupMember[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (typeof row.userId !== 'string' || members.some((m) => m.userId === row.userId)) continue;
    members.push({ userId: row.userId, displayName: optionalText(row.displayName), email: optionalText(row.email), addedAt: optionalText(row.addedAt) });
  }
  return members;
}

export function readCandidates(value: unknown): MemberCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: MemberCandidate[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (typeof row.userId !== 'string' || candidates.some((c) => c.userId === row.userId)) continue;
    candidates.push({ userId: row.userId, displayName: optionalText(row.displayName), email: optionalText(row.email), already: row.already === true });
  }
  return candidates;
}

/** Name, else e-mail, else the bare id in font-mono (UI-SPEC UI Considerations: partial). */
export function memberLabel(member: { userId: string; displayName: string | null; email: string | null }): { text: string; mono: boolean } {
  const name = member.displayName?.trim();
  if (name) return { text: name, mono: false };
  const email = member.email?.trim();
  if (email) return { text: email, mono: false };
  return { text: member.userId, mono: true };
}

export interface MemberSearchState { query: string; searching: boolean; results: MemberCandidate[]; resultsFor: string | null; failed: boolean }
export type MemberSearchAction =
  | { type: 'query'; value: string }
  | { type: 'start'; query: string }
  | { type: 'results'; query: string; candidates: MemberCandidate[] }
  | { type: 'failed'; query: string }
  | { type: 'reset' };
export const MEMBER_SEARCH_INITIAL: MemberSearchState = { query: '', searching: false, results: [], resultsFor: null, failed: false };

export function shouldSearchMembers(query: string): boolean {
  return query.trim().length >= MEMBER_SEARCH_MIN;
}

export function memberSearchReducer(state: MemberSearchState, action: MemberSearchAction): MemberSearchState {
  switch (action.type) {
    case 'query':
      return shouldSearchMembers(action.value)
        ? { ...state, query: action.value }
        : { ...MEMBER_SEARCH_INITIAL, query: action.value };
    case 'start':
      return action.query === state.query ? { ...state, searching: true, failed: false } : state;
    case 'results':
      if (action.query !== state.query) return state;
      return { ...state, searching: false, failed: false, results: action.candidates.slice(0, MEMBER_SEARCH_MAX), resultsFor: action.query };
    case 'failed':
      return action.query === state.query ? { ...state, searching: false, failed: true } : state;
    case 'reset':
      return MEMBER_SEARCH_INITIAL;
  }
}

export interface MemberSearchView { message: string | null; spinner: boolean; results: MemberCandidate[] }

export function deriveMemberSearch(state: MemberSearchState, language: string): MemberSearchView {
  if (!shouldSearchMembers(state.query)) {
    return { message: state.query.length > 0 ? accessGroupText('members.searchHint', language) : null, spinner: false, results: [] };
  }
  if (state.searching) return { message: accessGroupText('members.searching', language), spinner: true, results: state.results };
  if (state.failed) {
    return {
      message: accessGroupText('groups.unavailable', language, { reload: accessGroupText('action.reloadGroups', language) }),
      spinner: false,
      results: state.results,
    };
  }
  if (state.resultsFor !== null && state.results.length === 0) {
    return { message: accessGroupText('members.noMatch', language, { query: state.resultsFor.trim() }), spinner: false, results: [] };
  }
  return { message: null, spinner: false, results: state.results };
}

export interface GroupImpact { onlyCount: number; sharedCount: number; memberCount: number; mappingCount: number }

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function readImpact(value: unknown): GroupImpact | null {
  const row = asRecord(value);
  const onlyCount = count(row.onlyCount);
  const sharedCount = count(row.sharedCount);
  const memberCount = count(row.memberCount);
  if (onlyCount === null || sharedCount === null || memberCount === null) return null;
  return { onlyCount, sharedCount, memberCount, mappingCount: count(row.mappingCount) ?? 0 };
}

export type DeletePhase = 'counting' | 'counted' | 'unavailable' | 'deleting';
export interface DeleteDialogState { phase: DeletePhase; impact: GroupImpact | null }
export type DeleteDialogAction =
  | { type: 'count' }
  | { type: 'counted'; impact: GroupImpact }
  | { type: 'countFailed' }
  | { type: 'delete' }
  | { type: 'deleteFailed' };
export const DELETE_DIALOG_INITIAL: DeleteDialogState = { phase: 'counting', impact: null };

/** D-18: the group can be deleted only with the count on screen; a stale count goes back to counting. */
export function deleteDialogReducer(state: DeleteDialogState, action: DeleteDialogAction): DeleteDialogState {
  switch (action.type) {
    case 'count':
      return DELETE_DIALOG_INITIAL;
    case 'counted':
      return { phase: 'counted', impact: action.impact };
    case 'countFailed':
      return { phase: 'unavailable', impact: null };
    case 'delete':
      return state.phase === 'counted' && state.impact ? { ...state, phase: 'deleting' } : state;
    case 'deleteFailed':
      return state.impact ? { ...state, phase: 'counted' } : DELETE_DIALOG_INITIAL;
  }
}

export interface DeleteDialogView { title: string; message: string | null; lines: string[]; canDelete: boolean; countAgain: boolean; busy: boolean }

export function deriveDeleteDialog(state: DeleteDialogState, group: string, language: string): DeleteDialogView {
  const title = accessGroupText('delete.title', language, { group });
  const impact = state.impact;
  const lines = impact && (state.phase === 'counted' || state.phase === 'deleting')
    ? [
        accessGroupText('delete.docsClosed', language, { count: impact.onlyCount }),
        accessGroupText('delete.docsOther', language, { count: impact.sharedCount }),
        accessGroupText('delete.members', language, { count: impact.memberCount }),
        ...(impact.mappingCount > 0 ? [accessGroupText('delete.mappings', language, { count: impact.mappingCount })] : []),
      ]
    : [];
  return {
    title,
    message: state.phase === 'counting'
      ? accessGroupText('delete.counting', language)
      : state.phase === 'unavailable'
        ? accessGroupText('delete.countUnavailable', language)
        : null,
    lines,
    canDelete: state.phase === 'counted' && impact !== null,
    countAgain: state.phase === 'unavailable',
    busy: state.phase === 'deleting',
  };
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
  const [membersOf, setMembersOf] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string; running: boolean } | null>(null);
  const [deleting, setDeleting] = useState<AdminGroup | null>(null);

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

  const renameGroup = async (id: string, value: string) => {
    const name = value.trim();
    if (!name) return;
    setRenaming({ id, value, running: true });
    const result = await request(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: { organizationId, name } });
    if (result.kind === 'ok') {
      const updated = asRecord(result.body.group);
      setRenaming(null);
      setStatus({ tone: 'success', text: text('rename.done', { group: typeof updated.name === 'string' ? updated.name : name }) });
      void loadGroups();
      return;
    }
    const outcome = applyFailure(result, true);
    if (outcome.type === 'changed' || outcome.type === 'outcomeUnknown') {
      setRenaming(null);
      void loadGroups();
      return;
    }
    setRenaming({ id, value, running: false });
  };

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
            {rows.map((row) => {
              const group = groups.find((g) => g.id === row.id);
              const editing = renaming?.id === row.id ? renaming : null;
              const renameError = editing && editing.value.trim().length === 0;
              const regionId = `access-group-members-${row.id}`;
              return (
                <li key={row.id} className={ROW_CLASS}>
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="flex-1 min-w-0">
                      {editing ? (
                        <div
                          className="flex flex-wrap items-center gap-2"
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.stopPropagation();
                              setRenaming(null);
                            }
                          }}
                        >
                          <label htmlFor={`access-group-rename-${row.id}`} className="sr-only">{text('form.name')}</label>
                          <Input
                            id={`access-group-rename-${row.id}`}
                            value={editing.value}
                            maxLength={200}
                            autoFocus
                            className="h-9 flex-1 min-w-[10rem]"
                            aria-invalid={renameError ? true : undefined}
                            aria-describedby={renameError ? `access-group-rename-help-${row.id}` : undefined}
                            disabled={editing.running}
                            onChange={(event) => setRenaming({ ...editing, value: event.target.value })}
                            onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                          />
                          <Button
                            type="button"
                            size="sm"
                            className={MODAL_PRIMARY_CLASS}
                            disabled={editing.running || renameError === true}
                            onClick={() => void renameGroup(row.id, editing.value)}
                          >
                            {editing.running && <Loader2 className="h-4 w-4 mr-1 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                            {editing.running ? text('save.running') : text('action.saveName')}
                          </Button>
                          <Button type="button" size="sm" variant="outline" disabled={editing.running} onClick={() => setRenaming(null)}>
                            {text('action.cancelEditing')}
                          </Button>
                          {renameError && (
                            <p id={`access-group-rename-help-${row.id}`} className="w-full text-xs text-red-700 dark:text-red-300">{text('form.needName')}</p>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm font-semibold text-gray-900 dark:text-white break-words">{row.name}</p>
                      )}
                      <p className={cn('text-xs flex flex-wrap gap-x-3 gap-y-1 mt-1', MUTED_CLASS)}>
                        <span className="font-mono break-all" translate="no">{row.key}</span>
                        <span className="tabular-nums">{row.membersLine}</span>
                        <span className="tabular-nums">{row.documentsLine}</span>
                        {row.fromConnector && <span>{row.fromConnector}</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        id={`access-group-manage-${row.id}`}
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-expanded={membersOf === row.id}
                        aria-controls={membersOf === row.id ? regionId : undefined}
                        aria-label={membersOf === row.id
                          ? text('action.closeMembers')
                          : text('action.manageMembersAria', { group: row.name })}
                        onClick={() => setMembersOf((current) => (current === row.id ? null : row.id))}
                      >
                        {membersOf === row.id ? text('action.closeMembers') : text('action.manageMembers')}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                            <span className="sr-only">{text('group.actionsAria', { group: row.name })}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setRenaming({ id: row.id, value: row.name, running: false })}>
                            <Pencil className="h-4 w-4 mr-2" aria-hidden="true" />
                            {text('action.renameGroup')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => { if (group) setDeleting(group); }}
                          >
                            <Trash2 className="h-4 w-4 mr-2" aria-hidden="true" />
                            {text('action.deleteGroup')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  {membersOf === row.id && group && (
                    <MembersRegion
                      id={regionId}
                      group={group}
                      organizationId={organizationId}
                      language={language}
                      fetcher={fetcher}
                      onFailure={applyFailure}
                      onStatus={setStatus}
                      onChanged={() => void loadGroups()}
                      onClose={() => {
                        setMembersOf(null);
                        document.getElementById(`access-group-manage-${row.id}`)?.focus();
                      }}
                    />
                  )}
                </li>
              );
            })}
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

      {deleting && (
        <DeleteGroupDialog
          group={deleting}
          organizationId={organizationId}
          language={language}
          fetcher={fetcher}
          onFailure={applyFailure}
          onDone={(message) => {
            setDeleting(null);
            setMembersOf((current) => (current === deleting.id ? null : current));
            if (message) setStatus(message);
            void loadGroups();
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

interface SubViewProps {
  organizationId: string;
  language: string;
  fetcher?: AdminFetch;
  onFailure: (result: Exclude<AdminResult, { kind: 'ok' }>, write: boolean) => FailureOutcome;
}

const MEMBER_CODE_MESSAGES: Record<string, AccessGroupLabelKey> = {
  member_exists: 'error.memberExists',
  not_a_workspace_member: 'error.notWorkspaceMember',
};

function MemberName({ member }: { member: { userId: string; displayName: string | null; email: string | null } }) {
  const label = memberLabel(member);
  return label.mono
    ? <span className="font-mono text-xs break-all" translate="no">{label.text}</span>
    : <span className="break-words">{label.text}</span>;
}

function MembersRegion({
  id,
  group,
  organizationId,
  language,
  fetcher,
  onFailure,
  onStatus,
  onChanged,
  onClose,
}: SubViewProps & {
  id: string;
  group: AdminGroup;
  onStatus: (message: StatusMessage | null) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const text = (key: AccessGroupLabelKey, vars?: Record<string, string | number>) => accessGroupText(key, language, vars);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersState, setMembersState] = useState<LoadState>('loading');
  const [search, setSearch] = useState<MemberSearchState>(MEMBER_SEARCH_INITIAL);
  const [acting, setActing] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const orgQuery = `organizationId=${encodeURIComponent(organizationId)}`;
  const groupPath = `/${encodeURIComponent(group.id)}`;

  const loadMembers = async () => {
    setMembersState('loading');
    const result = await accessAdminRequest(`${groupPath}/members?${orgQuery}`, { fetcher });
    if (result.kind !== 'ok') {
      const outcome = onFailure(result, false);
      setMembersState(outcome.type === 'notAdmin' ? 'loading' : 'unavailable');
      return;
    }
    setMembers(readMembers(result.body.members));
    setMembersState('ready');
  };

  const runSearch = async (query: string) => {
    setSearch((state) => memberSearchReducer(state, { type: 'start', query }));
    const params = `${orgQuery}&groupId=${encodeURIComponent(group.id)}&q=${encodeURIComponent(query.trim())}`;
    const result = await accessAdminRequest(`/members/candidates?${params}`, { fetcher });
    if (result.kind !== 'ok') {
      const outcome = failureOutcome(result, false);
      if (outcome.type === 'notAdmin') onFailure(result, false);
      setSearch((state) => memberSearchReducer(state, { type: 'failed', query }));
      return;
    }
    setSearch((state) => memberSearchReducer(state, { type: 'results', query, candidates: readCandidates(result.body.candidates) }));
  };

  useEffect(() => {
    searchRef.current?.focus();
    void loadMembers();
  }, [group.id]);

  useEffect(() => {
    if (!shouldSearchMembers(search.query)) return;
    const query = search.query;
    const timer = setTimeout(() => void runSearch(query), MEMBER_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search.query]);

  const refreshAfterChange = () => {
    void loadMembers();
    if (shouldSearchMembers(search.query)) void runSearch(search.query);
    onChanged();
  };

  const addMember = async (candidate: MemberCandidate) => {
    const name = memberLabel(candidate).text;
    setActing(candidate.userId);
    const result = await accessAdminRequest(`${groupPath}/members`, {
      method: 'POST',
      body: { organizationId, userId: candidate.userId },
      fetcher,
    });
    setActing(null);
    if (result.kind === 'ok') {
      onStatus({ tone: 'success', text: text('member.added', { name, group: group.name }) });
      refreshAfterChange();
      return;
    }
    const outcome = failureOutcome(result, true);
    if (outcome.type === 'code' && MEMBER_CODE_MESSAGES[outcome.code]) {
      onStatus({ tone: 'error', text: text(MEMBER_CODE_MESSAGES[outcome.code]) });
      refreshAfterChange();
      return;
    }
    onFailure(result, true);
    if (outcome.type === 'changed' || outcome.type === 'outcomeUnknown') refreshAfterChange();
  };

  const removeMember = async (member: GroupMember) => {
    const name = memberLabel(member).text;
    setActing(member.userId);
    const result = await accessAdminRequest(`${groupPath}/members/${encodeURIComponent(member.userId)}?${orgQuery}`, {
      method: 'DELETE',
      fetcher,
    });
    setActing(null);
    if (result.kind === 'ok') {
      onStatus({ tone: 'success', text: text('member.removed', { name, group: group.name }) });
      refreshAfterChange();
      return;
    }
    const outcome = onFailure(result, true);
    if (outcome.type === 'changed' || outcome.type === 'outcomeUnknown') refreshAfterChange();
  };

  const view = deriveMemberSearch(search, language);
  const searchId = `${id}-search`;
  const titleId = `${id}-title`;

  return (
    <div
      id={id}
      role="region"
      aria-labelledby={titleId}
      className="mt-3 pt-3 border-t border-[#FFE0D0] dark:border-[#3A3A3A] space-y-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <h5 id={titleId} className="text-sm font-semibold text-gray-900 dark:text-white break-words">
        {text('members.title', { group: group.name })}
      </h5>

      <div className="space-y-2">
        <label htmlFor={searchId} className="sr-only">{text('members.search')}</label>
        <div className="relative">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <Input
            id={searchId}
            ref={searchRef}
            type="search"
            value={search.query}
            maxLength={200}
            placeholder={text('members.search')}
            className="pl-9"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSearch((state) => memberSearchReducer(state, { type: 'query', value: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (shouldSearchMembers(search.query)) void runSearch(search.query);
              }
            }}
          />
        </div>
        {view.message && (
          <p className={cn('flex items-center gap-2 text-xs break-words', MUTED_CLASS)}>
            {view.spinner && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            <span className="min-w-0">{view.message}</span>
          </p>
        )}
        {view.results.length > 0 && (
          <ul className="max-h-72 overflow-y-auto space-y-1" aria-busy={view.spinner ? true : undefined}>
            {view.results.map((candidate) => (
              <li key={candidate.userId} className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm text-gray-900 dark:text-white">
                <span className="min-w-0 flex-1">
                  <MemberName member={candidate} />
                </span>
                {candidate.already ? (
                  <span className={cn('text-xs', MUTED_CLASS)}>{text('members.already')}</span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={acting !== null}
                    aria-label={text('action.addMemberAria', { name: memberLabel(candidate).text })}
                    onClick={() => void addMember(candidate)}
                  >
                    {acting === candidate.userId && <Loader2 className="h-4 w-4 mr-1 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {acting === candidate.userId ? text('save.running') : text('action.addMember')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {membersState === 'loading' && members.length === 0 ? (
        <p className={cn('flex items-center gap-2 text-sm', MUTED_CLASS)}>
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span>{text('groups.loading')}</span>
        </p>
      ) : membersState === 'ready' && members.length === 0 ? (
        <p className={cn('text-sm', MUTED_CLASS)}>{text('members.empty')}</p>
      ) : (
        <ul
          className={cn('max-h-72 overflow-y-auto space-y-2', membersState !== 'ready' && 'opacity-60')}
          aria-busy={membersState === 'loading' ? true : undefined}
        >
          {members.map((member) => (
            <li key={member.userId} className={cn(ROW_CLASS, 'flex flex-wrap items-center gap-2 text-sm text-gray-900 dark:text-white')}>
              <span className="min-w-0 flex-1">
                <MemberName member={member} />
                {member.addedAt && (
                  <time dateTime={member.addedAt} className={cn('block text-xs', MUTED_CLASS)}>
                    {formatAddedAt(member.addedAt, language)}
                  </time>
                )}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={acting !== null}
                aria-label={text('action.removeMemberAria', { name: memberLabel(member).text })}
                onClick={() => void removeMember(member)}
              >
                {acting === member.userId && <Loader2 className="h-4 w-4 mr-1 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {acting === member.userId ? text('save.running') : text('action.removeMember')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {membersState === 'unavailable' && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-800 dark:text-red-200">
          <span className="flex-1 min-w-0">{text('groups.unavailable', { reload: text('action.reloadGroups') })}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadMembers()}>{text('action.reloadGroups')}</Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <p className={cn('text-xs flex-1 min-w-0', MUTED_CLASS)}>{text('groups.adminNote')}</p>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>{text('action.closeMembers')}</Button>
      </div>
    </div>
  );
}

export function formatAddedAt(value: string, language: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
  }
}

function DeleteGroupDialog({
  group,
  organizationId,
  language,
  fetcher,
  onFailure,
  onDone,
  onCancel,
}: SubViewProps & {
  group: AdminGroup;
  onDone: (message: StatusMessage | null) => void;
  onCancel: () => void;
}) {
  const text = (key: AccessGroupLabelKey, vars?: Record<string, string | number>) => accessGroupText(key, language, vars);
  const [state, setState] = useState<DeleteDialogState>(DELETE_DIALOG_INITIAL);
  const keepRef = useRef<HTMLButtonElement>(null);
  const orgQuery = `organizationId=${encodeURIComponent(organizationId)}`;
  const groupPath = `/${encodeURIComponent(group.id)}`;

  const countImpact = async () => {
    setState((current) => deleteDialogReducer(current, { type: 'count' }));
    const result = await accessAdminRequest(`${groupPath}/impact?${orgQuery}`, { fetcher });
    if (result.kind !== 'ok') {
      const outcome = failureOutcome(result, false);
      if (outcome.type === 'notAdmin' || outcome.type === 'changed') {
        onFailure(result, false);
        onDone(null);
        return;
      }
      setState((current) => deleteDialogReducer(current, { type: 'countFailed' }));
      return;
    }
    const impact = readImpact(result.body.impact);
    setState((current) => deleteDialogReducer(current, impact ? { type: 'counted', impact } : { type: 'countFailed' }));
  };

  useEffect(() => {
    void countImpact();
  }, [group.id]);

  const confirmDelete = async () => {
    if (state.phase !== 'counted' || !state.impact) return;
    const expectedCount = state.impact.onlyCount;
    setState((current) => deleteDialogReducer(current, { type: 'delete' }));
    const result = await accessAdminRequest(groupPath, { method: 'DELETE', body: { organizationId, expectedCount }, fetcher });
    if (result.kind === 'ok') {
      const fellBack = typeof result.body.fellBack === 'number' ? result.body.fellBack : expectedCount;
      onDone({ tone: 'success', text: text('delete.done', { group: group.name, count: fellBack }) });
      return;
    }
    const outcome = failureOutcome(result, true);
    if (outcome.type === 'code' && outcome.code === 'count_required') {
      void countImpact();
      return;
    }
    onFailure(result, true);
    if (outcome.type === 'notAdmin' || outcome.type === 'changed' || outcome.type === 'outcomeUnknown') {
      onDone(null);
      return;
    }
    setState((current) => deleteDialogReducer(current, { type: 'deleteFailed' }));
  };

  const view = deriveDeleteDialog(state, group.name, language);
  const bodyId = `access-group-delete-body-${group.id}`;
  const reasonId = `access-group-delete-reason-${group.id}`;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !view.busy) onCancel(); }}>
      <DialogContent
        className="max-w-md"
        aria-describedby={bodyId}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (view.busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (view.busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-words">{view.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {view.message && (
            <p id={reasonId} className={cn('flex items-center gap-2', state.phase === 'unavailable' ? 'text-red-800 dark:text-red-200' : 'text-muted-foreground')}>
              {state.phase === 'counting' && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              <span>{view.message}</span>
            </p>
          )}
          {view.lines.length > 0 && (
            <ul className="space-y-1 tabular-nums">
              {view.lines.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          <DialogDescription id={bodyId} className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span>{text('delete.body')}</span>
          </DialogDescription>
        </div>
        <DialogFooter className="gap-2">
          <Button ref={keepRef} type="button" variant="outline" disabled={view.busy} onClick={onCancel}>
            {text('action.keepGroup')}
          </Button>
          {view.countAgain && (
            <Button type="button" variant="outline" onClick={() => void countImpact()}>
              {text('action.countAgain')}
            </Button>
          )}
          <Button
            type="button"
            variant="destructive"
            disabled={!view.canDelete}
            aria-describedby={!view.canDelete && view.message ? reasonId : undefined}
            onClick={() => void confirmDelete()}
          >
            {view.busy && <Loader2 className="h-4 w-4 mr-1 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {view.busy ? text('delete.running') : text('action.deleteGroup')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
