'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AudienceField,
  AudienceLine,
  audienceFieldNeedGroupId,
  buildAudienceView,
  deriveAudienceField,
  initAudienceField,
  type AudienceFieldDocument,
  type AudienceFieldState,
  type AudienceInput,
  type AudienceKind,
  type AudienceView,
} from '@/components/ui/access-audience';
import { accessGroupText } from '@/components/ui/access-group-labels';
import type { AccessGroupOption, AccessGroupsMine } from '@/lib/stores/access-groups-store';

export const DOCUMENTS_ACCESS_PATH = '/api/rag/access-groups/documents/access';

/** A document's access as GET /api/documents gives it (04.3-15): `restricted` for every caller, the rest for access admins only. */
export interface DocumentAccess {
  restricted: boolean;
  kind?: AudienceKind;
  groups?: AccessGroupOption[];
  peopleCount?: number;
  fallbackReason?: string | null;
  connectorManaged?: boolean;
}

export interface AccessEditDocument {
  id: string;
  name: string;
  access?: DocumentAccess;
}

function isKind(value: unknown): value is AudienceKind {
  return value === 'everyone' || value === 'groups' || value === 'uploader_only';
}

function groupsOf(value: unknown): AccessGroupOption[] {
  if (!Array.isArray(value)) return [];
  const out: AccessGroupOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, name } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) continue;
    out.push({ id, name: typeof name === 'string' ? name : '' });
  }
  return out;
}

function audienceFields(audience: Record<string, unknown>): Omit<DocumentAccess, 'restricted' | 'connectorManaged'> {
  return {
    ...(isKind(audience.kind) ? { kind: audience.kind } : {}),
    groups: groupsOf(audience.groups),
    ...(typeof audience.peopleCount === 'number' ? { peopleCount: audience.peopleCount } : {}),
    fallbackReason: typeof audience.fallbackReason === 'string' ? audience.fallbackReason : null,
  };
}

/**
 * D-09: with the switch off the server sends no `restricted` field, so the row carries no access and renders as today. A non-admin's
 * row carries the boolean only, whatever else the record holds (D-29).
 */
export function readDocumentAccess(record: unknown): DocumentAccess | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const value = record as Record<string, unknown>;
  if (typeof value.restricted !== 'boolean') return undefined;
  const access: DocumentAccess = { restricted: value.restricted };
  const audience = value.audience;
  if (audience && typeof audience === 'object' && !Array.isArray(audience)) {
    Object.assign(access, audienceFields(audience as Record<string, unknown>));
    access.connectorManaged = value.connectorManaged === true;
  }
  return access;
}

/** The new access of one changed document from the relabel answer (04.3-24 `Audience`). */
export function accessFromAudience(audience: Record<string, unknown>): DocumentAccess {
  const fields = audienceFields(audience);
  return { ...fields, restricted: fields.kind !== undefined && fields.kind !== 'everyone', connectorManaged: audience.connectorManaged === true };
}

export interface AccessControls {
  /** The Restricted mark, for every caller the server gives the flag to (a readOnly dashboard too). */
  mark: boolean;
  /** Edit access, the checkbox column and the selection bar: admins only, never in readOnly. */
  edit: boolean;
}

export function showAccessControls({ enabled, isAdmin, readOnly, personal = false }: { enabled: boolean; isAdmin: boolean; readOnly: boolean; personal?: boolean }): AccessControls {
  return { mark: enabled, edit: enabled && isAdmin && !readOnly && !personal };
}

function audienceInput(access: DocumentAccess): AudienceInput {
  return {
    restricted: access.restricted,
    ...(access.kind ? { kind: access.kind } : {}),
    groupIds: (access.groups ?? []).map((group) => group.id),
    groupNames: (access.groups ?? []).map((group) => group.name),
    ...(typeof access.peopleCount === 'number' ? { peopleCount: access.peopleCount } : {}),
    fallbackReason: access.fallbackReason ?? null,
  };
}

/** The view under a file name: null for Everyone and for a row without access (the quiet default, D-09). */
export function rowMarkView(access: DocumentAccess | undefined, isAdmin: boolean, language: string): AudienceView | null {
  if (!access) return null;
  const view = buildAudienceView(audienceInput(access), isAdmin, language);
  return view.reading === 'everyone' ? null : view;
}

export function audienceViewOf(access: DocumentAccess | undefined, isAdmin: boolean, language: string): AudienceView {
  return buildAudienceView(audienceInput(access ?? { restricted: false }), isAdmin, language);
}

function fieldDocument(access: DocumentAccess | undefined): AudienceFieldDocument {
  const kind: AudienceKind = access?.kind ?? (access?.restricted ? 'groups' : 'everyone');
  return { kind, groupIds: (access?.groups ?? []).map((group) => group.id) };
}

export function initAccessEditField(documents: readonly AccessEditDocument[]): AudienceFieldState {
  return initAudienceField(documents.map((document) => fieldDocument(document.access)));
}

export type AccessSubmit = { everyone: true } | { groupIds: string[] };

export function accessSaveBody(documentIds: readonly string[], submit: AccessSubmit, organizationId: string | null): Record<string, unknown> {
  return { ...(organizationId ? { organizationId } : {}), documentIds: [...documentIds], ...submit };
}

export type AccessSaveOutcome =
  | { kind: 'saved'; changed: number; skipped: number; notFound: number; updates: Map<string, DocumentAccess>; message: string }
  | { kind: 'error'; message: string; stayOpen: boolean; reloadGroups: boolean; reloadRows: boolean; reloadMine: boolean };

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorOutcome(message: string, flags: Partial<Omit<Extract<AccessSaveOutcome, { kind: 'error' }>, 'kind' | 'message'>>): AccessSaveOutcome {
  return { kind: 'error', message, stayOpen: false, reloadGroups: false, reloadRows: false, reloadMine: false, ...flags };
}

/** The one place that maps the relabel answer to words (UI-SPEC 8.2). */
export function readAccessSaveResponse(
  status: number | null,
  body: unknown,
  context: { documents: readonly AccessEditDocument[]; isAdmin: boolean; language: string; bulk?: boolean },
): AccessSaveOutcome {
  const { documents, isAdmin, language } = context;
  if (status === null) return errorOutcome(accessGroupText('error.outcomeUnknown', language), { reloadRows: true });
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (status >= 200 && status < 300 && record.success !== false) {
    const updates = new Map<string, DocumentAccess>();
    if (Array.isArray(record.audiences)) {
      for (const item of record.audiences) {
        if (!item || typeof item !== 'object') continue;
        const audience = item as Record<string, unknown>;
        if (typeof audience.documentId !== 'string') continue;
        updates.set(audience.documentId.toLowerCase(), accessFromAudience(audience));
      }
    }
    const changed = count(record.changed);
    const skipped = count(record.skipped);
    const notFound = count(record.notFound);
    let message: string;
    if (documents.length === 1 && context.bulk !== true) {
      const only = documents[0]!;
      const next = updates.get(only.id.toLowerCase());
      const view = audienceViewOf(next ?? only.access, isAdmin, language);
      const audience = view.reading === 'everyone' ? view.everyoneText ?? '' : view.groupsLine ?? view.label ?? '';
      message = accessGroupText('save.done', language, { file: only.name, audience }).trim();
    } else {
      message = accessGroupText('save.doneMany', language, { count: changed });
    }
    if (skipped > 0) message = `${message} ${accessGroupText('save.skipped', language, { count: skipped })}`;
    return { kind: 'saved', changed, skipped, notFound, updates, message };
  }
  const code = typeof record.error === 'string' ? record.error : '';
  if (status === 400 && code === 'unknown_group') return errorOutcome(accessGroupText('error.groupGone', language), { stayOpen: true, reloadGroups: true });
  if (status === 409 && code === 'access_managed_by_connector') return errorOutcome(accessGroupText('docs.connectorManaged', language), { reloadRows: true });
  if (status === 404) return errorOutcome(accessGroupText('error.changed', language), { reloadRows: true });
  if (status === 401 || status === 403) return errorOutcome(accessGroupText('error.notAdmin', language), { reloadMine: true, reloadRows: true });
  if (status === 400) {
    const details = Array.isArray(record.details) ? record.details : [];
    const first = details[0] && typeof details[0] === 'object' ? (details[0] as Record<string, unknown>) : null;
    const detail = first && typeof first.message === 'string' ? first.message : code || String(status);
    return errorOutcome(accessGroupText('error.invalid', language, { detail }), { stayOpen: true });
  }
  return errorOutcome(accessGroupText('error.outcomeUnknown', language), { reloadRows: true });
}

type SaveFetch = (_url: string, _init: RequestInit) => Promise<Pick<Response, 'status' | 'json'>>;

export async function saveDocumentsAccess(
  documents: readonly AccessEditDocument[],
  submit: AccessSubmit,
  options: { organizationId: string | null; isAdmin: boolean; language: string; bulk?: boolean; fetcher?: SaveFetch; signal?: AbortSignal },
): Promise<AccessSaveOutcome> {
  const fetcher: SaveFetch = options.fetcher ?? ((url, init) => fetch(url, init));
  const context = { documents, isAdmin: options.isAdmin, language: options.language, bulk: options.bulk === true };
  let response: Pick<Response, 'status' | 'json'>;
  try {
    response = await fetcher(DOCUMENTS_ACCESS_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(accessSaveBody(documents.map((document) => document.id), submit, options.organizationId)),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    return readAccessSaveResponse(null, null, context);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return readAccessSaveResponse(response.status, body, context);
}

/** Rows update in place from the relabel answer; other rows are returned unchanged. */
export function applyAccessUpdates<T extends { id: string; access?: DocumentAccess }>(rows: readonly T[], updates: ReadonlyMap<string, DocumentAccess>): T[] {
  if (updates.size === 0) return [...rows];
  return rows.map((row) => {
    const next = updates.get(row.id.toLowerCase());
    return next ? { ...row, access: next } : row;
  });
}

export interface AccessEditDialogProps {
  open: boolean;
  documents: readonly AccessEditDocument[];
  bulk: boolean;
  mine: AccessGroupsMine;
  mode: 'org' | 'single';
  organizationId: string | null;
  language: string;
  /** Called with the outcome once a save finished (or failed in a way that closes the dialog). */
  onDone: (_outcome: AccessSaveOutcome) => void;
  onCancel: () => void;
  onReloadGroups: () => void;
  /** The element focus returns to on close; the status region when it is gone. */
  returnFocus: () => HTMLElement | null;
}

const DialogDescriptionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function DialogDescriptionDiv(
  { children, ...props },
  ref,
) {
  return (
    <DialogDescription asChild>
      <div ref={ref} {...props}>
        {children}
      </div>
    </DialogDescription>
  );
});

/** The Edit access dialog for one or many documents (D-17, UI-SPEC 6.11, 9 item 7). */
export function AccessEditDialog({
  open,
  documents,
  bulk,
  mine,
  mode,
  organizationId,
  language,
  onDone,
  onCancel,
  onReloadGroups,
  returnFocus,
}: AccessEditDialogProps) {
  const [field, setField] = React.useState<AudienceFieldState>(() => initAccessEditField(documents));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const keepRef = React.useRef<HTMLButtonElement | null>(null);
  const fieldId = `access-edit-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const groups = mine.assignableGroups;
  const derived = deriveAudienceField(field, groups, language, { mode, bulk });
  const save = async () => {
    if (!derived.submit || saving) return;
    setSaving(true);
    setError(null);
    const outcome = await saveDocumentsAccess(documents, derived.submit, { organizationId, isAdmin: mine.isAdmin, language, bulk });
    setSaving(false);
    if (outcome.kind === 'error') {
      if (outcome.reloadGroups) onReloadGroups();
      if (outcome.stayOpen) {
        setError(outcome.message);
        return;
      }
    }
    onDone(outcome);
  };

  const describedBy = !derived.canSave && derived.needGroup ? audienceFieldNeedGroupId(fieldId) : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onCancel();
      }}
    >
      <DialogContent
        className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto overscroll-contain"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus()?.focus();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!saving) onCancel();
        }}
        onPointerDownOutside={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <AccessEditDialogBody
          documents={documents}
          bulk={bulk}
          language={language}
          isAdmin={mine.isAdmin}
          Title={DialogTitle}
          Description={DialogDescriptionDiv}
        />
        <AudienceField
          id={fieldId}
          state={field}
          onChange={(next) => {
            setField(next);
            setError(null);
          }}
          groups={groups}
          language={language}
          mode={mode}
          bulk={bulk}
          disabled={saving}
        />
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button ref={keepRef} type="button" variant="outline" onClick={onCancel} disabled={saving}>
            {accessGroupText('action.keepAccess', language)}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!derived.canSave || saving} aria-describedby={describedBy}>
            {saving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}
            {saving ? accessGroupText('save.running', language) : accessGroupText('action.saveAccess', language)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface SelectableRow {
  id: string;
  status?: string;
  access?: DocumentAccess;
}

/** A row an admin can relabel: the server sent its access, it is stored (ready) and not connector-managed. */
export function isSelectableRow(row: SelectableRow): boolean {
  return row.access !== undefined && row.access.connectorManaged !== true && (row.status === undefined || row.status === 'ready');
}

export function selectableIds(rows: readonly SelectableRow[]): string[] {
  return rows.filter(isSelectableRow).map((row) => row.id);
}

/** Keeps only ids that are still selectable rows (a deleted, filtered-out-and-relabelled or connector row drops out). */
export function pruneSelection(selected: readonly string[], rows: readonly SelectableRow[]): string[] {
  const allowed = new Set(selectableIds(rows));
  return selected.filter((id) => allowed.has(id));
}

export function toggleSelected(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((each) => each !== id) : [...selected, id];
}

/** The header checkbox: the filtered rows on screen only (UI-SPEC 6.11, 9 item 10). */
export function headerSelectionState(visibleIds: readonly string[], selected: readonly string[]): boolean | 'indeterminate' {
  if (visibleIds.length === 0) return false;
  const chosen = new Set(selected);
  const ticked = visibleIds.filter((id) => chosen.has(id)).length;
  if (ticked === 0) return false;
  return ticked === visibleIds.length ? true : 'indeterminate';
}

export function toggleAllVisible(visibleIds: readonly string[], selected: readonly string[]): string[] {
  if (headerSelectionState(visibleIds, selected) === true) {
    const visible = new Set(visibleIds);
    return selected.filter((id) => !visible.has(id));
  }
  const chosen = new Set(selected);
  return [...selected, ...visibleIds.filter((id) => !chosen.has(id))];
}

/** The dialog's title and description, rendered without the Radix portal (tests and the dialog share it). */
export function AccessEditDialogBody({
  documents,
  bulk,
  language,
  isAdmin,
  Title = 'h2',
  Description = 'div',
}: {
  documents: readonly AccessEditDocument[];
  bulk: boolean;
  language: string;
  isAdmin: boolean;
  Title?: React.ElementType;
  Description?: React.ElementType;
}) {
  const single = documents.length === 1 && !bulk ? documents[0]! : null;
  const currentView = single ? audienceViewOf(single.access, isAdmin, language) : null;
  return (
    <DialogHeader className="min-w-0 text-left">
      <Title className="break-words text-balance text-lg font-semibold leading-snug tracking-tight">
        {single ? accessGroupText('edit.title', language, { file: single.name }) : accessGroupText('bulk.title', language)}
      </Title>
      <Description className="min-w-0 text-sm text-muted-foreground">
        {currentView ? (
          <AudienceLine view={currentView} context="dialog" />
        ) : (
          <p>{accessGroupText('bulk.selected', language, { count: documents.length })}</p>
        )}
      </Description>
    </DialogHeader>
  );
}
