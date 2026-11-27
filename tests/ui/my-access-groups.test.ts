import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MyAccessGroupsView, buildMyAccessGroupsView, type MyAccessGroupsInput } from '@/components/ui/my-access-groups';
import { ACCESS_GROUPS_OFF, type AccessGroupsMine } from '@/lib/stores/access-groups-store';

const GROUP_A = '00000000-0000-4000-8000-00000000000a';
const GROUP_B = '00000000-0000-4000-8000-00000000000b';
const INJECTED = '<img src=x onerror=alert(1)>';

function mine(overrides: Partial<AccessGroupsMine> = {}): AccessGroupsMine {
  return {
    enabled: true,
    personal: false,
    isAdmin: false,
    ownGroups: [
      { id: GROUP_A, name: 'group-a' },
      { id: GROUP_B, name: 'group-b' },
    ],
    assignableGroups: [{ id: GROUP_A, name: 'group-a' }],
    ...overrides,
  };
}

function input(overrides: Partial<MyAccessGroupsInput> = {}): MyAccessGroupsInput {
  return { mine: mine(), status: 'ready', error: null, knownEnabled: true, singleTenant: false, ...overrides };
}

describe('buildMyAccessGroupsView', () => {
  it('lists the own group names as chips with the help line', () => {
    const view = buildMyAccessGroupsView(input(), 'en');
    expect(view).toEqual({
      kind: 'groups',
      title: 'Your access groups',
      chips: [
        { id: GROUP_A, name: 'group-a' },
        { id: GROUP_B, name: 'group-b' },
      ],
      help: 'You can see documents restricted to these groups and documents visible to everyone.',
    });
  });

  it('never carries assignable groups, counts or any other field', () => {
    const view = buildMyAccessGroupsView(input({ mine: mine({ ownGroups: [{ id: GROUP_B, name: 'group-b' }] }) }), 'en');
    expect(view.kind).toBe('groups');
    if (view.kind !== 'groups') return;
    expect(view.chips).toEqual([{ id: GROUP_B, name: 'group-b' }]);
    expect(Object.keys(view).sort()).toEqual(['chips', 'help', 'kind', 'title']);
    expect(JSON.stringify(view)).not.toMatch(/\d+ (members|documents)/);
  });

  it('gives mine.none for a member of no group', () => {
    const view = buildMyAccessGroupsView(input({ mine: mine({ ownGroups: [] }) }), 'en');
    expect(view).toEqual({
      kind: 'text',
      title: 'Your access groups',
      text: 'You are in no access group. You can see the documents that are visible to everyone.',
    });
  });

  it('gives mine.admin for an owner or admin and lists no group', () => {
    const view = buildMyAccessGroupsView(input({ mine: mine({ isAdmin: true }) }), 'en');
    expect(view).toEqual({
      kind: 'text',
      title: 'Your access groups',
      text: 'As an owner or admin you can see every document in this workspace.',
    });
    expect(JSON.stringify(view)).not.toContain('group-a');
  });

  it('gives mine.adminSingle for a single-tenant admin', () => {
    const view = buildMyAccessGroupsView(input({ mine: mine({ isAdmin: true }), singleTenant: true }), 'en');
    expect(view).toMatchObject({ kind: 'text', text: 'As an admin you can see every document.' });
  });

  it('gives mine.unavailable with Reload groups on a server failure', () => {
    const view = buildMyAccessGroupsView(
      input({ mine: ACCESS_GROUPS_OFF, status: 'error', error: 'access_groups_mine_503', knownEnabled: false }),
      'en',
    );
    expect(view).toEqual({
      kind: 'unavailable',
      title: 'Your access groups',
      text: 'Your access groups could not be loaded. Select Reload groups.',
      reload: 'Reload groups',
    });
  });

  it('gives mine.unavailable on a network failure only when the switch was seen on', () => {
    const failed = { mine: ACCESS_GROUPS_OFF, status: 'error' as const, error: 'access_groups_mine_network' };
    expect(buildMyAccessGroupsView(input({ ...failed, knownEnabled: true }), 'en').kind).toBe('unavailable');
    expect(buildMyAccessGroupsView(input({ ...failed, knownEnabled: false }), 'en').kind).toBe('hidden');
    expect(buildMyAccessGroupsView(input({ ...failed, error: 'access_groups_mine_timeout', knownEnabled: false }), 'en').kind).toBe('hidden');
  });

  it('renders nothing for a refused request (signed out, not a member)', () => {
    for (const error of ['access_groups_mine_401', 'access_groups_mine_403', 'access_groups_mine_400']) {
      expect(buildMyAccessGroupsView(input({ mine: ACCESS_GROUPS_OFF, status: 'error', error, knownEnabled: false }), 'en').kind).toBe('hidden');
    }
  });

  it('renders nothing with the switch off, in a personal workspace or before the answer', () => {
    expect(buildMyAccessGroupsView(input({ mine: ACCESS_GROUPS_OFF, knownEnabled: false }), 'en').kind).toBe('hidden');
    expect(buildMyAccessGroupsView(input({ mine: mine({ personal: true, ownGroups: [] }) }), 'en').kind).toBe('hidden');
    expect(buildMyAccessGroupsView(input({ status: 'idle', mine: ACCESS_GROUPS_OFF, knownEnabled: false }), 'en').kind).toBe('hidden');
    expect(buildMyAccessGroupsView(input({ status: 'loading', mine: ACCESS_GROUPS_OFF, knownEnabled: false }), 'en').kind).toBe('hidden');
  });

  it('uses the zh and it strings', () => {
    expect(buildMyAccessGroupsView(input(), 'zh')).toMatchObject({ title: '你的访问组' });
    expect(buildMyAccessGroupsView(input({ mine: mine({ ownGroups: [] }) }), 'it')).toMatchObject({
      text: 'Non fai parte di alcun gruppo di accesso. Puoi vedere i documenti visibili a tutti.',
    });
  });
});

describe('MyAccessGroupsView', () => {
  it('renders nothing for the hidden view', () => {
    expect(renderToStaticMarkup(createElement(MyAccessGroupsView, { view: { kind: 'hidden' }, onReload: () => {} }))).toBe('');
  });

  it('renders read-only chips without a remove button', () => {
    const html = renderToStaticMarkup(createElement(MyAccessGroupsView, { view: buildMyAccessGroupsView(input(), 'en'), onReload: () => {} }));
    expect(html).toContain('Your access groups');
    expect(html).toContain('group-a');
    expect(html).toContain('group-b');
    expect(html).not.toContain('<button');
    expect(html).toContain('<ul');
  });

  it('renders injected markup in a group name as text', () => {
    const view = buildMyAccessGroupsView(input({ mine: mine({ ownGroups: [{ id: GROUP_A, name: INJECTED }] }) }), 'en');
    const html = renderToStaticMarkup(createElement(MyAccessGroupsView, { view, onReload: () => {} }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders the unavailable line with one Reload groups button', () => {
    const view = buildMyAccessGroupsView(input({ mine: ACCESS_GROUPS_OFF, status: 'error', error: 'access_groups_mine_500' }), 'en');
    const html = renderToStaticMarkup(createElement(MyAccessGroupsView, { view, onReload: () => {} }));
    expect(html).toContain('Your access groups could not be loaded. Select Reload groups.');
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(html).toContain('Reload groups');
  });
});
