import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AudienceLine } from '@/components/ui/access-audience';
import {
  DOCUMENTS_ACCESS_PATH,
  accessSaveBody,
  applyAccessUpdates,
  initAccessEditField,
  readAccessSaveResponse,
  readDocumentAccess,
  rowMarkView,
  saveDocumentsAccess,
  showAccessControls,
  type AccessEditDocument,
} from '@/components/ui/access-edit-dialog';

const DOC_A = '00000000-0000-4000-8000-0000000000a1';
const DOC_B = '00000000-0000-4000-8000-0000000000b2';
const GROUP_A = '00000000-0000-4000-8000-00000000000a';
const GROUP_B = '00000000-0000-4000-8000-00000000000b';
const INJECTED = '<img src=x onerror=alert(1)>';

const adminRecord = {
  id: DOC_A,
  filename: 'notes.pdf',
  restricted: true,
  audience: { kind: 'groups', groups: [{ id: GROUP_A, name: 'group-a' }], peopleCount: 0, fallbackReason: null },
  connectorManaged: false,
};

function audienceOf(documentId: string, kind: string, groups: Array<{ id: string; name: string }> = []) {
  return { documentId, filename: 'x', kind, groups, peopleCount: 0, fallbackReason: null, connectorManaged: false };
}

describe('showAccessControls (D-09, D-17, UI-SPEC 6.11)', () => {
  it('switch off: no mark and no edit controls, whatever the caller is', () => {
    expect(showAccessControls({ enabled: false, isAdmin: true, readOnly: false })).toEqual({ mark: false, edit: false });
  });
  it('admin, not readOnly: mark and edit controls', () => {
    expect(showAccessControls({ enabled: true, isAdmin: true, readOnly: false })).toEqual({ mark: true, edit: true });
  });
  it('readOnly admin: the mark only', () => {
    expect(showAccessControls({ enabled: true, isAdmin: true, readOnly: true })).toEqual({ mark: true, edit: false });
  });
  it('non-admin: the mark only', () => {
    expect(showAccessControls({ enabled: true, isAdmin: false, readOnly: false })).toEqual({ mark: true, edit: false });
  });
  it('personal workspace: no edit controls (no groups exist there)', () => {
    expect(showAccessControls({ enabled: true, isAdmin: true, readOnly: false, personal: true }).edit).toBe(false);
  });
});

describe('readDocumentAccess (04.3-15 list fields)', () => {
  it('switch off: a record without restricted carries no access', () => {
    expect(readDocumentAccess({ id: DOC_A, filename: 'notes.pdf' })).toBeUndefined();
  });
  it('non-admin record: the boolean only, even if extra fields are present', () => {
    expect(readDocumentAccess({ id: DOC_A, restricted: true })).toEqual({ restricted: true });
  });
  it('admin record: kind, groups as id and name, people count, reason and the connector flag', () => {
    expect(readDocumentAccess({ ...adminRecord, audience: { ...adminRecord.audience, peopleCount: 2 }, connectorManaged: true })).toEqual({
      restricted: true,
      kind: 'groups',
      groups: [{ id: GROUP_A, name: 'group-a' }],
      peopleCount: 2,
      fallbackReason: null,
      connectorManaged: true,
    });
  });
});

describe('rowMarkView (UI-SPEC 6.2.1)', () => {
  it('nothing for Everyone and for a row without access', () => {
    expect(rowMarkView(undefined, true, 'en')).toBeNull();
    expect(rowMarkView({ restricted: false }, false, 'en')).toBeNull();
    expect(rowMarkView({ restricted: false, kind: 'everyone', groups: [] }, true, 'en')).toBeNull();
  });
  it('admin: the mark and the audience line with group names and the people count only', () => {
    const view = rowMarkView({ ...readDocumentAccess(adminRecord)!, peopleCount: 3 }, true, 'en')!;
    const html = renderToStaticMarkup(createElement(AudienceLine, { view, context: 'list' }));
    expect(html).toContain('Restricted');
    expect(html).toContain('Visible to: group-a, people at the source: 3');
  });
  it('admin, fallback audience: the warning tone and the reason', () => {
    const view = rowMarkView({ restricted: true, kind: 'uploader_only', groups: [], fallbackReason: 'group_deleted' }, true, 'en')!;
    expect(view.tone).toBe('warning');
    const html = renderToStaticMarkup(createElement(AudienceLine, { view, context: 'list' }));
    expect(html).toContain('Uploader and admins only');
    expect(html).toContain('Its access group was deleted.');
  });
  it('non-admin: the mark with its fixed hint only, no names, reason or count', () => {
    for (const access of [{ restricted: true }, { ...readDocumentAccess(adminRecord)!, peopleCount: 987 }]) {
      const view = rowMarkView(access, false, 'en')!;
      const html = renderToStaticMarkup(createElement(AudienceLine, { view, context: 'list' }));
      expect(html).toContain('Restricted');
      expect(html).toContain('Only some members can see this document.');
      expect(html).not.toContain('group-a');
      expect(html).not.toContain('987');
      expect(html).not.toContain('people at the source');
    }
  });
  it('group names render as text', () => {
    const view = rowMarkView({ restricted: true, kind: 'groups', groups: [{ id: GROUP_A, name: INJECTED }] }, true, 'en')!;
    const html = renderToStaticMarkup(createElement(AudienceLine, { view, context: 'list' }));
    expect(html).not.toContain('<img');
  });
});

describe('the single save (D-17)', () => {
  const doc: AccessEditDocument = { id: DOC_A, name: 'notes.pdf', access: { restricted: false, kind: 'everyone', groups: [] } };

  it('pre-chooses the current audience of one document', () => {
    expect(initAccessEditField([doc]).choice).toBe('everyone');
    expect(initAccessEditField([{ ...doc, access: readDocumentAccess(adminRecord) }])).toMatchObject({ choice: 'groups', chips: [GROUP_A] });
  });

  it('PUTs the document ids and the group ids, with the workspace', async () => {
    const fetcher = vi.fn(async () => ({ status: 200, json: async () => ({ success: true, changed: 1, skipped: 0, notFound: 0, audiences: [] }) }));
    await saveDocumentsAccess([doc], { groupIds: [GROUP_A] }, { organizationId: 'org-1', isAdmin: true, language: 'en', fetcher });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DOCUMENTS_ACCESS_PATH);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ organizationId: 'org-1', documentIds: [DOC_A], groupIds: [GROUP_A] });
    expect(accessSaveBody([DOC_A], { everyone: true }, null)).toEqual({ documentIds: [DOC_A], everyone: true });
  });

  it('a save announces save.done with the file and the new audience, and the row updates in place', () => {
    const outcome = readAccessSaveResponse(
      200,
      { success: true, changed: 1, skipped: 0, notFound: 0, audiences: [audienceOf(DOC_A, 'groups', [{ id: GROUP_A, name: 'group-a' }])] },
      { documents: [doc], isAdmin: true, language: 'en' },
    );
    expect(outcome.kind).toBe('saved');
    if (outcome.kind !== 'saved') return;
    expect(outcome.message).toBe('Access saved for notes.pdf. Visible to: group-a');
    const rows = applyAccessUpdates<AccessEditDocument>([{ id: DOC_A, name: 'notes.pdf' }, { id: DOC_B, name: 'other.pdf' }], outcome.updates);
    expect(rows[0]!.access).toMatchObject({ restricted: true, kind: 'groups', groups: [{ id: GROUP_A, name: 'group-a' }] });
    expect(rows[1]).toEqual({ id: DOC_B, name: 'other.pdf' });
  });

  it('409 access_managed_by_connector maps to docs.connectorManaged and reloads the row', () => {
    const outcome = readAccessSaveResponse(409, { success: false, error: 'access_managed_by_connector' }, { documents: [doc], isAdmin: true, language: 'en' });
    expect(outcome).toMatchObject({
      kind: 'error',
      message: 'Access follows the sharing at the source. Change it there, or change the connector mapping.',
      reloadRows: true,
      stayOpen: false,
    });
  });

  it('400 unknown_group maps to error.groupGone, keeps the dialog open and reloads the groups', () => {
    const outcome = readAccessSaveResponse(400, { success: false, error: 'unknown_group' }, { documents: [doc], isAdmin: true, language: 'en' });
    expect(outcome).toMatchObject({
      kind: 'error',
      message: 'Not saved. One of the chosen groups no longer exists. The groups have been reloaded.',
      stayOpen: true,
      reloadGroups: true,
    });
  });

  it('a thrown request maps to error.outcomeUnknown and reloads the rows; 404 to error.changed; 403 to error.notAdmin', async () => {
    const thrown = await saveDocumentsAccess([doc], { everyone: true }, {
      organizationId: null,
      isAdmin: true,
      language: 'en',
      fetcher: async () => {
        throw new TypeError('network');
      },
    });
    expect(thrown).toMatchObject({ kind: 'error', reloadRows: true });
    expect(thrown.kind === 'error' && thrown.message).toContain('The server did not answer');
    expect(readAccessSaveResponse(404, { error: 'not_found' }, { documents: [doc], isAdmin: true, language: 'en' })).toMatchObject({
      message: 'This item was changed by someone else. The list has been reloaded.',
    });
    expect(readAccessSaveResponse(403, { error: 'Admin access required' }, { documents: [doc], isAdmin: true, language: 'en' })).toMatchObject({
      reloadMine: true,
    });
  });
});
