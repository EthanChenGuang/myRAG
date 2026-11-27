import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AccessGroupsAdmin,
  CREATE_FORM_INITIAL,
  ACCESS_ADMIN_CLASSES,
  accessAdminRequest,
  buildGroupRows,
  createFormReducer,
  deriveCreateForm,
  failureMessage,
  failureOutcome,
  readAdminGroups,
  showAccessGroupsTab,
  suggestGroupKey,
  type AdminFetch,
  type CreateFormState,
} from '@/components/ui/access-groups-admin';

const INJECTED = '<img src=x onerror=alert(1)>';
const GROUP_A = '00000000-0000-4000-8000-00000000000a';

function apply(actions: Parameters<typeof createFormReducer>[1][], start: CreateFormState = CREATE_FORM_INITIAL): CreateFormState {
  return actions.reduce(createFormReducer, start);
}

function fakeFetch(status: number, body: unknown): AdminFetch {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe('showAccessGroupsTab', () => {
  it('is true only with the switch on, for owners and admins, outside personal projects', () => {
    expect(showAccessGroupsTab({ enabled: true, userRole: 'owner', isPersonal: false })).toBe(true);
    expect(showAccessGroupsTab({ enabled: true, userRole: 'admin', isPersonal: false })).toBe(true);
    expect(showAccessGroupsTab({ enabled: false, userRole: 'owner', isPersonal: false })).toBe(false);
    expect(showAccessGroupsTab({ enabled: true, userRole: 'member', isPersonal: false })).toBe(false);
    expect(showAccessGroupsTab({ enabled: true, userRole: 'viewer', isPersonal: false })).toBe(false);
    expect(showAccessGroupsTab({ enabled: true, userRole: 'owner', isPersonal: true })).toBe(false);
  });
});

describe('group rows', () => {
  it('give name, key and the two counts', () => {
    const groups = readAdminGroups([
      { id: GROUP_A, key: 'group-a', name: 'group-a', source: 'manual', memberCount: 4, documentCount: 12 },
      { id: 'b', key: 'group-b', name: 'group-b', source: 'connector', memberCount: 0, documentCount: 1200 },
      { id: GROUP_A, key: 'dup', name: 'dup' },
      { key: 'no-id' },
    ]);
    const rows = buildGroupRows(groups, 'en');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: GROUP_A,
      name: 'group-a',
      key: 'group-a',
      fromConnector: null,
      membersLine: 'Members: 4',
      documentsLine: 'Documents: 12',
    });
    expect(rows[1].fromConnector).toBe('From a connector');
    expect(rows[1].membersLine).toBe('Members: 0');
    expect(rows[1].documentsLine).toBe('Documents: 1,200');
    expect(buildGroupRows(groups, 'zh')[0].membersLine).not.toBe('Members: 4');
  });
});

describe('new group form', () => {
  it('suggests the key from the name until the key is edited', () => {
    expect(suggestGroupKey('Group A one')).toBe('group-a-one');
    expect(suggestGroupKey('  Équipe 2 ')).toBe('equipe-2');
    expect(suggestGroupKey('组')).toBe('');
    expect(suggestGroupKey('All')).toBe('');
    let state = apply([{ type: 'name', value: 'Group A' }]);
    expect(state.key).toBe('group-a');
    state = apply([{ type: 'key', value: 'custom' }, { type: 'name', value: 'Other name' }], state);
    expect(state.key).toBe('custom');
  });

  it('starts disabled with the findings naming the missing fields', () => {
    const view = deriveCreateForm(CREATE_FORM_INITIAL);
    expect(view.canCreate).toBe(false);
    expect(view.findings).toEqual(['form.needName', 'form.badKey']);
  });

  it('refuses all and an invalid key', () => {
    expect(deriveCreateForm(apply([{ type: 'name', value: 'x' }, { type: 'key', value: 'all' }])).keyError).toBe('form.reservedKey');
    expect(deriveCreateForm(apply([{ type: 'name', value: 'x' }, { type: 'key', value: '-bad' }])).keyError).toBe('form.badKey');
    expect(deriveCreateForm(apply([{ type: 'name', value: 'x' }, { type: 'key', value: 'Upper' }])).keyError).toBe('form.badKey');
    const ok = deriveCreateForm(apply([{ type: 'name', value: 'x' }, { type: 'key', value: 'good-1' }]));
    expect(ok.canCreate).toBe(true);
    expect(ok.findings).toEqual([]);
  });

  it('maps 409 group_exists to error.groupExists at the Key field and keeps the values', async () => {
    const filled = apply([{ type: 'name', value: 'Group A' }, { type: 'submit' }]);
    expect(deriveCreateForm(filled).canCreate).toBe(false);
    const result = await accessAdminRequest('', { method: 'POST', body: {}, fetcher: fakeFetch(409, { success: false, error: 'group_exists' }) });
    expect(result.kind).toBe('fail');
    if (result.kind === 'ok') throw new Error('unexpected');
    const outcome = failureOutcome(result, true);
    expect(outcome).toEqual({ type: 'code', status: 409, code: 'group_exists', detail: null });
    const refused = createFormReducer(filled, { type: 'refused', code: 'group_exists' });
    const view = deriveCreateForm(refused);
    expect(view.keyError).toBe('error.groupExists');
    expect(view.focusKey).toBe(true);
    expect(refused.name).toBe('Group A');
    expect(refused.key).toBe('group-a');
    const edited = createFormReducer(refused, { type: 'key', value: 'group-a2' });
    expect(deriveCreateForm(edited).keyError).toBeNull();
  });
});

describe('failures', () => {
  it('maps 403 to notAdmin, 503 and network to unavailable, write timeouts to outcomeUnknown and 404 to changed', async () => {
    const forbidden = await accessAdminRequest('', { fetcher: fakeFetch(403, { error: 'Forbidden' }) });
    if (forbidden.kind === 'ok') throw new Error('unexpected');
    expect(failureOutcome(forbidden, false).type).toBe('notAdmin');
    const down = await accessAdminRequest('', { fetcher: fakeFetch(503, { error: 'access_groups_unavailable' }) });
    if (down.kind === 'ok') throw new Error('unexpected');
    expect(failureOutcome(down, false).type).toBe('unavailable');
    const thrown = await accessAdminRequest('', { fetcher: async () => { throw new TypeError('offline'); } });
    expect(thrown.kind).toBe('network');
    if (thrown.kind === 'ok') throw new Error('unexpected');
    expect(failureOutcome(thrown, false).type).toBe('unavailable');
    expect(failureOutcome(thrown, true).type).toBe('outcomeUnknown');
    const gone = await accessAdminRequest('', { fetcher: fakeFetch(404, { error: 'not_found' }) });
    if (gone.kind === 'ok') throw new Error('unexpected');
    expect(failureOutcome(gone, true).type).toBe('changed');
    expect(failureMessage({ type: 'unavailable' }, 'en')?.text).toBe('Access groups are unavailable right now. Select Reload groups in a moment.');
    expect(failureMessage({ type: 'notAdmin' }, 'en')).toBeNull();
  });
});

describe('AccessGroupsAdmin render', () => {
  it('first render shows the loading state, the card and the documents hint', () => {
    const html = renderToStaticMarkup(createElement(AccessGroupsAdmin, { organizationId: GROUP_A, language: 'en' }));
    expect(html).toContain('Loading access groups…');
    expect(html).toContain('role="status"');
    expect(html).toContain('New group');
    expect(html).toContain(ACCESS_ADMIN_CLASSES.CARD_CLASS);
    expect(html).toContain('open the document list and select Edit access');
  });
});

describe('workspace settings modal wiring', () => {
  const modal = readFileSync('src/components/ui/workspace-settings-modal.tsx', 'utf8');
  const switcher = readFileSync('src/components/organization-switcher.tsx', 'utf8');

  it('renders the third tab through showAccessGroupsTab with grid-cols-3 and the sibling trigger classes', () => {
    expect(modal).toContain('<AccessGroupsAdmin');
    expect(modal).toContain('grid-cols-3');
    expect(modal).toContain('showAccessGroupsTab({ enabled: true, userRole, isPersonal })');
    const trigger = '"data-[state=inactive]:hover:bg-[#FFE0D0] data-[state=inactive]:dark:hover:bg-[#2A2A2A]"';
    expect(modal.split(trigger).length - 1).toBe(3);
    const content = '"max-h-[calc(95vh-280px)] lg:max-h-[calc(650px-280px)]",';
    expect(modal.split(content).length - 1).toBe(3);
  });

  it('copies the card and primary class strings from the modal', () => {
    expect(modal).toContain(ACCESS_ADMIN_CLASSES.CARD_CLASS);
    expect(modal).toContain(ACCESS_ADMIN_CLASSES.MODAL_PRIMARY_CLASS);
  });

  it('gets isPersonal from the switcher', () => {
    expect(switcher).toContain('isPersonal={settingsOrgPersonal}');
  });
});

export { INJECTED };
