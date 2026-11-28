import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_PICKER_MENU_CLASS,
  ACCESS_PICKER_TRIGGER_CLASS,
  ACCESS_UNTOUCHED,
  AccessChoiceLine,
  AccessGroupPicker,
  accessFormValue,
  accessPickerTriggerLabel,
  accessPickerVisible,
  buildAccessPickerItems,
  isGroupNotAllowed,
  keepAccessMenuOpen,
  toggleAccessPickerValue,
  visibleAccessValue,
  type AccessPickerValue,
} from '@/components/ui/access-group-picker';
import { ACCESS_GROUP_LABEL_KEYS, accessGroupLocaleTable, accessGroupText } from '@/components/ui/access-group-labels';
import { buildChatUploadFormData } from '@/components/ui/doc-type-picker';
import { UploadQueueRow } from '@/components/ui/upload-queue-row';
import {
  ACCESS_GROUPS_OFF,
  accessGroupsMineUrl,
  readAccessGroupsMine,
  useAccessGroupsStore,
  type AccessGroupOption,
} from '@/lib/stores/access-groups-store';

const GROUP_A = '00000000-0000-4000-8000-00000000000a';
const GROUP_B = '00000000-0000-4000-8000-00000000000b';
const GROUPS: AccessGroupOption[] = [
  { id: GROUP_A, name: 'group-a' },
  { id: GROUP_B, name: 'group-b' },
];
const INJECTED = '<img src=x onerror=alert(1)>';

const noop = () => undefined;

async function formEntries(formData: FormData): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of formData.entries()) {
    entries.push([key, typeof value === 'string' ? value : `file:${(value as File).name}`]);
  }
  return entries;
}

describe('access-group labels', () => {
  it('has every key in en, zh and it, with English fallback for other languages', () => {
    for (const locale of ['zh', 'it']) {
      const table = accessGroupLocaleTable(locale);
      expect(table).toBeDefined();
      for (const key of ACCESS_GROUP_LABEL_KEYS) {
        expect(table?.[key], `${locale} ${key}`).toBeTruthy();
      }
    }
    expect(accessGroupText('picker.trigger', 'xx')).toBe('Access');
    expect(accessGroupText('picker.trigger', 'zh')).toBe('可见范围');
    expect(accessGroupText('picker.trigger', 'it')).toBe('Accesso');
  });

  it('writes counts as label: number with no plural form', () => {
    expect(accessGroupText('picker.groups', 'en', { n: 1 })).toBe('Groups: 1');
    expect(accessGroupText('picker.groups', 'en', { n: 2 })).toBe('Groups: 2');
    expect(accessGroupText('picker.groups', 'zh', { n: 0 })).toBe('访问组：0');
    expect(accessGroupText('bulk.selected', 'it', { count: 3 })).toBe('Selezionati: 3');
  });

  it('carries the app-only strings and the single-tenant admin line', () => {
    expect(accessGroupText('action.reloadGroups', 'en')).toBe('Reload groups');
    expect(accessGroupText('mine.adminSingle', 'it')).toBe('Come amministratore puoi vedere ogni documento.');
    expect(accessGroupText('error.groupNotAllowed', 'en')).toBe('Not uploaded. Choose Everyone or one of your own groups.');
  });
});

describe('buildAccessPickerItems', () => {
  it('lists Everyone, the groups and the note, with no Clear choice while untouched', () => {
    const items = buildAccessPickerItems(GROUPS, ACCESS_UNTOUCHED, 'en');
    expect(items.map((item) => item.type)).toEqual(['everyone', 'separator', 'label', 'group', 'group', 'separator', 'note']);
    expect(items[0]).toEqual({ type: 'everyone', label: 'Everyone', checked: false });
    expect(items[2]).toEqual({ type: 'label', label: 'Only these groups' });
    expect(items.filter((item) => item.type === 'group')).toEqual([
      { type: 'group', id: GROUP_A, name: 'group-a', checked: false },
      { type: 'group', id: GROUP_B, name: 'group-b', checked: false },
    ]);
  });

  it('adds Clear choice for a touched value and marks the chosen items', () => {
    const everyone = buildAccessPickerItems(GROUPS, { kind: 'everyone' }, 'en');
    expect(everyone[0]).toMatchObject({ type: 'everyone', checked: true });
    expect(everyone.at(-1)).toEqual({ type: 'clear', label: 'Clear choice' });
    const groups = buildAccessPickerItems(GROUPS, { kind: 'groups', groupIds: [GROUP_B] }, 'it');
    expect(groups.find((item) => item.type === 'group' && item.id === GROUP_B)).toMatchObject({ checked: true });
    expect(groups.find((item) => item.type === 'group' && item.id === GROUP_A)).toMatchObject({ checked: false });
    expect(groups.at(-1)).toEqual({ type: 'clear', label: 'Rimuovi scelta' });
  });

  it('leaves out a chosen group the caller can no longer assign', () => {
    const value: AccessPickerValue = { kind: 'groups', groupIds: ['00000000-0000-4000-8000-0000000000ff'] };
    expect(visibleAccessValue(value, GROUPS)).toEqual(ACCESS_UNTOUCHED);
    expect(buildAccessPickerItems(GROUPS, value, 'en').some((item) => item.type === 'clear')).toBe(false);
  });
});

describe('toggleAccessPickerValue', () => {
  it('ticking Everyone unticks every group, unticking it returns to untouched', () => {
    const groups: AccessPickerValue = { kind: 'groups', groupIds: [GROUP_A] };
    expect(toggleAccessPickerValue(groups, 'everyone', true, GROUPS)).toEqual({ kind: 'everyone' });
    expect(toggleAccessPickerValue({ kind: 'everyone' }, 'everyone', false, GROUPS)).toEqual(ACCESS_UNTOUCHED);
  });

  it('ticking a group unticks Everyone and keeps the group list order', () => {
    const first = toggleAccessPickerValue({ kind: 'everyone' }, { groupId: GROUP_B }, true, GROUPS);
    expect(first).toEqual({ kind: 'groups', groupIds: [GROUP_B] });
    expect(toggleAccessPickerValue(first, { groupId: GROUP_A }, true, GROUPS)).toEqual({ kind: 'groups', groupIds: [GROUP_A, GROUP_B] });
  });

  it('unticking the last group returns to untouched', () => {
    expect(toggleAccessPickerValue({ kind: 'groups', groupIds: [GROUP_A] }, { groupId: GROUP_A }, false, GROUPS)).toEqual(ACCESS_UNTOUCHED);
  });
});

describe('the upload form', () => {
  const file = new File(['x'], 'document-a.pdf', { type: 'application/pdf' });

  it('is byte-identical to today for an untouched picker or no picker', async () => {
    const today = await formEntries(buildChatUploadFormData({ file, organizationId: 'org-1', pickerEnabled: false }));
    expect(today).toEqual([['file', 'file:document-a.pdf'], ['organization_id', 'org-1']]);
    for (const access of [accessFormValue(ACCESS_UNTOUCHED), accessFormValue(undefined), null]) {
      expect(await formEntries(buildChatUploadFormData({ file, organizationId: 'org-1', pickerEnabled: false, access }))).toEqual(today);
    }
  });

  it('carries everyone or group ids only, never a key', async () => {
    const everyone = await formEntries(buildChatUploadFormData({ file, pickerEnabled: false, access: accessFormValue({ kind: 'everyone' }) }));
    expect(everyone).toEqual([['file', 'file:document-a.pdf'], ['access', '{"everyone":true}']]);
    const groups = accessFormValue({ kind: 'groups', groupIds: [GROUP_A, GROUP_B] });
    expect(groups).toBe(JSON.stringify({ groupIds: [GROUP_A, GROUP_B] }));
    expect(groups).not.toMatch(/"(all|g:|u:)/);
    const entries = await formEntries(buildChatUploadFormData({ file, pickerEnabled: false, access: groups }));
    expect(entries.filter(([key]) => key === 'access')).toEqual([['access', groups]]);
  });

  it('recognizes the group_not_allowed refusal only', () => {
    expect(isGroupNotAllowed(400, { error: 'group_not_allowed' })).toBe(true);
    expect(isGroupNotAllowed(400, { error: 'invalid_access' })).toBe(false);
    expect(isGroupNotAllowed(403, { error: 'group_not_allowed' })).toBe(false);
    expect(isGroupNotAllowed(400, null)).toBe(false);
  });
});

describe('access-groups store', () => {
  afterEach(() => useAccessGroupsStore.getState().reset());

  it('reads the mine answer and treats the switch off or a malformed answer as off', () => {
    expect(readAccessGroupsMine({ success: true, enabled: false })).toEqual(ACCESS_GROUPS_OFF);
    expect(readAccessGroupsMine('nope')).toEqual(ACCESS_GROUPS_OFF);
    expect(
      readAccessGroupsMine({
        enabled: true,
        personal: false,
        isAdmin: false,
        ownGroups: [{ id: GROUP_A, name: 'group-a' }, { id: 7 }],
        assignableGroups: [{ id: GROUP_A, name: 'group-a', key: 'g:secret' }],
      }),
    ).toEqual({ enabled: true, personal: false, isAdmin: false, ownGroups: [GROUPS[0]], assignableGroups: [GROUPS[0]] });
    expect(accessGroupsMineUrl(null)).toBe('/api/rag/access-groups/mine');
    expect(accessGroupsMineUrl('org 1')).toBe('/api/rag/access-groups/mine?organizationId=org%201');
  });

  it('keeps the mine answer of a successful load', async () => {
    const urls: string[] = [];
    await useAccessGroupsStore.getState().load('org-1', async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ success: true, enabled: true, personal: false, isAdmin: true, ownGroups: [], assignableGroups: GROUPS }) };
    });
    const state = useAccessGroupsStore.getState();
    expect(urls).toEqual(['/api/rag/access-groups/mine?organizationId=org-1']);
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.mine).toEqual({ enabled: true, personal: false, isAdmin: true, ownGroups: [], assignableGroups: GROUPS });
  });

  it('writes an error string on failure and never throws', async () => {
    await expect(
      useAccessGroupsStore.getState().load(null, async () => {
        throw new TypeError('network down');
      }),
    ).resolves.toBeUndefined();
    let state = useAccessGroupsStore.getState();
    expect(state.status).toBe('error');
    expect(typeof state.error).toBe('string');
    expect(state.mine).toEqual(ACCESS_GROUPS_OFF);
    await useAccessGroupsStore.getState().load(null, async () => ({ ok: false, status: 503, json: async () => ({}) }));
    state = useAccessGroupsStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toContain('503');
  });
});

describe('picker visibility', () => {
  it('is hidden with the switch off, in a personal workspace or with nothing to assign', () => {
    expect(accessPickerVisible(ACCESS_GROUPS_OFF)).toBe(false);
    expect(accessPickerVisible({ ...ACCESS_GROUPS_OFF, enabled: true })).toBe(false);
    expect(accessPickerVisible({ enabled: true, personal: true, isAdmin: false, ownGroups: GROUPS, assignableGroups: GROUPS })).toBe(false);
    expect(accessPickerVisible({ enabled: true, personal: false, isAdmin: false, ownGroups: GROUPS, assignableGroups: GROUPS })).toBe(true);
  });
});

function renderPicker(value: AccessPickerValue, groups: AccessGroupOption[] = GROUPS, extra: { error?: string | null; language?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(AccessGroupPicker, {
      value,
      groups,
      language: extra.language ?? 'en',
      fileName: 'document-a.pdf',
      onChange: noop,
      error: extra.error ?? null,
    }),
  );
}

describe('AccessGroupPicker', () => {
  it('renders the outline trigger with the three state texts and the file name in its name', () => {
    const untouched = renderPicker(ACCESS_UNTOUCHED);
    expect(untouched).toContain('aria-label="Access, Choose who can see document-a.pdf"');
    for (const cls of ACCESS_PICKER_TRIGGER_CLASS.split(' ')) expect(untouched).toContain(cls);
    expect(renderPicker({ kind: 'everyone' })).toContain('>Everyone</span>');
    const groups = renderPicker({ kind: 'groups', groupIds: [GROUP_A, GROUP_B] });
    expect(groups).toContain('>Groups: 2</span>');
    expect(groups).toContain('title="Groups: 2 (group-a, group-b)"');
    expect(accessPickerTriggerLabel({ kind: 'groups', groupIds: [GROUP_A] }, GROUPS, 'zh')).toBe('访问组：1');
  });

  it('shows the refusal on the row', () => {
    const html = renderPicker(ACCESS_UNTOUCHED, GROUPS, { error: accessGroupText('error.groupNotAllowed', 'en') });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Not uploaded. Choose Everyone or one of your own groups.');
  });

  it('keeps the menu open on checkbox items and caps the menu height', () => {
    const event = new Event('select', { cancelable: true });
    keepAccessMenuOpen(event);
    expect(event.defaultPrevented).toBe(true);
    expect(ACCESS_PICKER_MENU_CLASS).toContain('max-h-72');
    expect(ACCESS_PICKER_MENU_CLASS).toContain('overflow-y-auto');
  });
});

describe('AccessChoiceLine', () => {
  it('renders nothing while untouched, Everyone with a clear button, or one removable chip per group', () => {
    const line = (value: AccessPickerValue, groups = GROUPS) =>
      renderToStaticMarkup(createElement(AccessChoiceLine, { value, groups, language: 'en', onChange: noop }));
    expect(line(ACCESS_UNTOUCHED)).toBe('');
    const everyone = line({ kind: 'everyone' });
    expect(everyone).toContain('Visible to: Everyone');
    expect(everyone).toContain('<span class="sr-only">Clear choice</span>');
    const chips = line({ kind: 'groups', groupIds: [GROUP_A, GROUP_B] });
    expect(chips).toContain('Visible to');
    expect(chips).toContain('Remove group: group-a');
    expect(chips).toContain('Remove group: group-b');
    expect(chips).toContain('max-w-[10rem] truncate');
  });

  it('truncates a long name with the full name in title, and renders markup in names as text', () => {
    const long = 'g'.repeat(120);
    const groups = [{ id: GROUP_A, name: long }, { id: GROUP_B, name: INJECTED }];
    const html = renderToStaticMarkup(
      createElement(AccessChoiceLine, { value: { kind: 'groups', groupIds: [GROUP_A, GROUP_B] }, groups, language: 'en', onChange: noop }),
    );
    expect(html).toContain(`title="${long}"`);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(renderPicker({ kind: 'groups', groupIds: [GROUP_B] }, groups)).not.toContain('<img');
  });
});

describe('UploadQueueRow with the access picker', () => {
  const base = { fileName: 'document-a.pdf', fileSize: 1024, language: 'en', disabled: false, docType: null, onRemove: noop };

  it('renders the row of today when the picker is not shown', () => {
    const today = renderToStaticMarkup(createElement(UploadQueueRow, base));
    expect(renderToStaticMarkup(createElement(UploadQueueRow, { ...base, access: null }))).toBe(today);
    expect(today).not.toContain('Choose who can see');
  });

  it('adds the trigger and the choice line when the picker is shown', () => {
    const html = renderToStaticMarkup(
      createElement(UploadQueueRow, {
        ...base,
        access: { groups: GROUPS, value: { kind: 'groups', groupIds: [GROUP_A] }, onChange: noop, error: null },
      }),
    );
    expect(html).toContain('Choose who can see document-a.pdf');
    expect(html).toContain('Remove group: group-a');
    expect(html.indexOf('Remove group: group-a')).toBeLessThan(html.indexOf('Choose who can see'));
  });
});

describe('number formatting', () => {
  it('formats counts with Intl.NumberFormat for the UI language', () => {
    expect(accessGroupText('bulk.selected', 'en', { count: 1200 })).toBe('Selected: 1,200');
    expect(accessGroupText('bulk.selected', 'it', { count: 1200 })).toBe(`Selezionati: ${new Intl.NumberFormat('it').format(1200)}`);
    expect(accessGroupText('bulk.selected', 'not a tag!', { count: 1200 })).toBe('Selected: 1,200');
  });
});
