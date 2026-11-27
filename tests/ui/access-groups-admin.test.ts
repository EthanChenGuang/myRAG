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

import {
  DELETE_DIALOG_INITIAL,
  MEMBER_SEARCH_INITIAL,
  deleteDialogReducer,
  deriveDeleteDialog,
  deriveMemberSearch,
  memberLabel,
  memberSearchReducer,
  readCandidates,
  readImpact,
  readMembers,
  shouldSearchMembers,
  type MemberCandidate,
} from '@/components/ui/access-groups-admin';

const USER = '00000000-0000-4000-8000-0000000000u1';
const candidate = (n: number, already = false): MemberCandidate => ({ userId: `u-${n}`, displayName: `member-${n}`, email: null, already });

describe('members', () => {
  it('reads members and candidates and labels a member by name, e-mail or the id in mono', () => {
    expect(readMembers([{ userId: USER, displayName: 'member-a', email: 'a@example.org', addedAt: '2026-01-01T00:00:00Z' }, { nope: 1 }]))
      .toEqual([{ userId: USER, displayName: 'member-a', email: 'a@example.org', addedAt: '2026-01-01T00:00:00Z' }]);
    expect(readCandidates([{ userId: USER, displayName: null, email: null, already: true }])).toEqual([
      { userId: USER, displayName: null, email: null, already: true },
    ]);
    expect(memberLabel({ userId: USER, displayName: 'member-a', email: 'a@example.org' })).toEqual({ text: 'member-a', mono: false });
    expect(memberLabel({ userId: USER, displayName: '  ', email: 'a@example.org' })).toEqual({ text: 'a@example.org', mono: false });
    expect(memberLabel({ userId: USER, displayName: null, email: null })).toEqual({ text: USER, mono: true });
  });

  it('searches only from 2 characters, says the hint before, and caps the results at 20', () => {
    expect(shouldSearchMembers('a')).toBe(false);
    expect(shouldSearchMembers(' a ')).toBe(false);
    expect(shouldSearchMembers('ab')).toBe(true);
    let state = memberSearchReducer(MEMBER_SEARCH_INITIAL, { type: 'query', value: 'a' });
    expect(deriveMemberSearch(state, 'en').message).toBe('Type at least 2 characters.');
    state = memberSearchReducer(state, { type: 'query', value: 'ab' });
    state = memberSearchReducer(state, { type: 'start', query: 'ab' });
    expect(deriveMemberSearch(state, 'en')).toMatchObject({ spinner: true, message: 'Searching…' });
    state = memberSearchReducer(state, { type: 'results', query: 'ab', candidates: Array.from({ length: 25 }, (_, i) => candidate(i)) });
    const view = deriveMemberSearch(state, 'en');
    expect(view.spinner).toBe(false);
    expect(view.results).toHaveLength(20);
    expect(view.message).toBeNull();
  });

  it('keeps earlier results while a new search runs and ignores a late answer', () => {
    let state = memberSearchReducer(MEMBER_SEARCH_INITIAL, { type: 'query', value: 'ab' });
    state = memberSearchReducer(state, { type: 'start', query: 'ab' });
    state = memberSearchReducer(state, { type: 'results', query: 'ab', candidates: [candidate(1)] });
    state = memberSearchReducer(state, { type: 'query', value: 'abc' });
    state = memberSearchReducer(state, { type: 'start', query: 'abc' });
    expect(deriveMemberSearch(state, 'en').results).toEqual([candidate(1)]);
    state = memberSearchReducer(state, { type: 'results', query: 'ab', candidates: [candidate(9)] });
    expect(state.searching).toBe(true);
    expect(deriveMemberSearch(state, 'en').results).toEqual([candidate(1)]);
  });

  it('says no match with the query as text', () => {
    let state = memberSearchReducer(MEMBER_SEARCH_INITIAL, { type: 'query', value: INJECTED });
    state = memberSearchReducer(state, { type: 'start', query: INJECTED });
    state = memberSearchReducer(state, { type: 'results', query: INJECTED, candidates: [] });
    expect(deriveMemberSearch(state, 'en').message).toBe(`No member of this workspace matches "${INJECTED}".`);
  });
});

describe('delete dialog', () => {
  const impact = { onlyCount: 0, sharedCount: 0, memberCount: 0, mappingCount: 0 };

  it('opens counting with Delete group disabled', () => {
    const view = deriveDeleteDialog(DELETE_DIALOG_INITIAL, 'group-a', 'en');
    expect(view.title).toBe('Delete group-a?');
    expect(view.message).toBe('Counting affected documents…');
    expect(view.canDelete).toBe(false);
    expect(view.lines).toEqual([]);
  });

  it('shows the three counts, zeros included, and mappings only when some exist', () => {
    expect(readImpact({ onlyCount: 0, sharedCount: 0, memberCount: 0, mappingCount: 0 })).toEqual(impact);
    expect(readImpact({ onlyCount: 'x' })).toBeNull();
    const zero = deriveDeleteDialog(deleteDialogReducer(DELETE_DIALOG_INITIAL, { type: 'counted', impact }), 'group-a', 'en');
    expect(zero.canDelete).toBe(true);
    expect(zero.message).toBeNull();
    expect(zero.lines).toEqual([
      'Documents restricted to this group alone: 0',
      'Documents that stay visible to their other groups: 0',
      'Members who lose access through this group: 0',
    ]);
    const mapped = deriveDeleteDialog(
      deleteDialogReducer(DELETE_DIALOG_INITIAL, { type: 'counted', impact: { ...impact, onlyCount: 7, mappingCount: 2 } }),
      'group-a',
      'en',
    );
    expect(mapped.lines).toHaveLength(4);
    expect(mapped.lines[0]).toBe('Documents restricted to this group alone: 7');
    expect(mapped.lines[3]).toBe('Connector mappings removed with it: 2');
  });

  it('without the count offers Count again and never Delete group; a stale count recounts', () => {
    const failed = deleteDialogReducer(DELETE_DIALOG_INITIAL, { type: 'countFailed' });
    const view = deriveDeleteDialog(failed, 'group-a', 'en');
    expect(view.canDelete).toBe(false);
    expect(view.countAgain).toBe(true);
    expect(view.message).toContain('could not be counted');
    let state = deleteDialogReducer(DELETE_DIALOG_INITIAL, { type: 'counted', impact });
    state = deleteDialogReducer(state, { type: 'delete' });
    expect(deriveDeleteDialog(state, 'group-a', 'en')).toMatchObject({ canDelete: false, busy: true });
    state = deleteDialogReducer(state, { type: 'count' });
    expect(state).toEqual({ phase: 'counting', impact: null });
    expect(deriveDeleteDialog(state, 'group-a', 'en').canDelete).toBe(false);
  });
});

describe('the tab code', () => {
  const source = readFileSync('src/components/ui/access-groups-admin.tsx', 'utf8');
  it('uses no browser alert or confirm and never sets inner HTML', () => {
    expect(source).not.toMatch(/\b(window\.)?(alert|confirm)\(/);
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
  it('replaces the content with error.notAdmin and uses the destructive button in the dialog', () => {
    expect(source).toContain("text('error.notAdmin')");
    expect(source).toContain('variant="destructive"');
  });
});

import {
  NOT_MAPPED,
  buildMappingRows,
  buildRuleRows,
  isValidRuleDomain,
  mappingSaveIntent,
  providerName,
  readMappingRows,
  readSharingRules,
  ruleToggleIntent,
  showPersonalNote,
} from '@/components/ui/access-groups-admin';

const MAP_ID = '00000000-0000-4000-8000-0000000000m1';

describe('connector mapping rows', () => {
  const raw = [
    { id: MAP_ID, provider: 'dropbox', kind: 'team', externalPrincipalId: 'dbgid:AAA', groupId: GROUP_A, documents: 2 },
    { id: null, provider: 'google-drive', kind: 'group', externalPrincipalId: INJECTED, groupId: null, documents: 9 },
    { id: null, provider: 'notion', kind: 'mystery', externalPrincipalId: '  ws-1  ', groupId: null, documents: 0 },
    { provider: 'notion' },
  ];

  it('reads rows, puts unmapped ones first and keeps ids exactly as given', () => {
    const rows = readMappingRows(raw);
    expect(rows).toHaveLength(3);
    const view = buildMappingRows(rows, 'en');
    expect(view.map((r) => r.notMapped)).toEqual([true, true, false]);
    expect(view[0]).toMatchObject({ providerName: 'Google Drive', principal: INJECTED, kindLabel: 'Group', saved: NOT_MAPPED, documents: 9 });
    expect(view[1]).toMatchObject({ principal: '  ws-1  ', kindLabel: null, kindCode: 'mystery' });
    expect(view[2]).toMatchObject({ id: MAP_ID, providerName: 'Dropbox', kindLabel: 'Team', saved: GROUP_A });
    expect(providerName('unknown-source')).toBe('unknown-source');
  });

  it('turns a select change into create, update, remove or nothing', () => {
    const [unmapped, , mapped] = buildMappingRows(readMappingRows(raw), 'en');
    expect(mappingSaveIntent(unmapped, NOT_MAPPED)).toEqual({ type: 'none' });
    expect(mappingSaveIntent(unmapped, GROUP_A)).toEqual({
      type: 'create',
      body: { provider: 'google-drive', kind: 'group', externalPrincipalId: INJECTED, groupId: GROUP_A },
    });
    expect(mappingSaveIntent(mapped, GROUP_A)).toEqual({ type: 'none' });
    expect(mappingSaveIntent(mapped, 'other-group')).toEqual({ type: 'update', id: MAP_ID, groupId: 'other-group' });
    expect(mappingSaveIntent(mapped, NOT_MAPPED)).toEqual({ type: 'remove', id: MAP_ID });
  });

  it('shows the personal note whenever mapping does not change visibility (multi-tenant)', () => {
    expect(showPersonalNote(false)).toBe(true);
    expect(showPersonalNote(true)).toBe(false);
  });
});

describe('sharing rules', () => {
  const rules = readSharingRules([
    { id: 'r1', provider: 'google-drive', kind: 'domain', domain: 'example.org', enabled: false, documents: 14 },
    { id: 'r2', provider: 'google-drive', kind: 'anyone', domain: null, enabled: true, documents: 3 },
    { id: 'r3', provider: 'notion', kind: 'public', domain: null, enabled: false, documents: 1 },
    { id: 'r4', provider: 'notion', kind: 'odd', domain: null, enabled: false, documents: 0 },
    { provider: 'x' },
  ]);

  it('reads rules and words each with the visible state', () => {
    const view = buildRuleRows(rules, 'en');
    expect(view).toHaveLength(4);
    expect(view[0]).toMatchObject({ sharedWith: 'Everyone at example.org', stateWord: 'Off', enabled: false, documents: 14, providerName: 'Google Drive' });
    expect(view[0].toggleAria).toBe('Count as Everyone: Everyone at example.org, Google Drive');
    expect(view[1]).toMatchObject({ sharedWith: 'Anyone with the link', stateWord: 'On' });
    expect(view[2].sharedWith).toBe('Published to the web');
    expect(view[3]).toMatchObject({ sharedWith: 'odd', kindCode: 'odd' });
  });

  it('asks before turning a rule on and turns it off at once', () => {
    expect(ruleToggleIntent({ enabled: false }, true)).toBe('confirm');
    expect(ruleToggleIntent({ enabled: true }, false)).toBe('disable');
    expect(ruleToggleIntent({ enabled: true }, true)).toBe('none');
  });

  it('accepts a host name with a dot only', () => {
    expect(isValidRuleDomain('example.org')).toBe(true);
    expect(isValidRuleDomain('sub.example.org')).toBe(true);
    for (const bad of ['', 'example', 'https://example.org', 'example.org/path', 'example.org:80', '*.example.org', 'exa mple.org', '.example.org']) {
      expect(isValidRuleDomain(bad)).toBe(false);
    }
  });
});
