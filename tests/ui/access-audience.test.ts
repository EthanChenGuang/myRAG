import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AudienceField,
  AudienceLine,
  RestrictedMark,
  audienceFieldReducer,
  buildAudienceView,
  deriveAudienceField,
  initAudienceField,
  type AudienceFieldState,
} from '@/components/ui/access-audience';
import type { AccessGroupOption } from '@/lib/stores/access-groups-store';

const GROUP_A = '00000000-0000-4000-8000-00000000000a';
const GROUP_B = '00000000-0000-4000-8000-00000000000b';
const GROUPS: AccessGroupOption[] = [
  { id: GROUP_A, name: 'group-a' },
  { id: GROUP_B, name: 'group-b' },
];
const INJECTED = '<img src=x onerror=alert(1)>';

describe('buildAudienceView for a non-admin', () => {
  it('gives the mark and its hint only: no names, reason or count', () => {
    for (const audience of [
      { restricted: true },
      { restricted: true, kind: 'groups' as const, groupNames: ['group-a'], peopleCount: 3 },
      { restricted: true, kind: 'uploader_only' as const, fallbackReason: 'group_deleted' },
    ]) {
      const view = buildAudienceView(audience, false, 'en');
      expect(view.reading).toBe('restricted');
      expect(view.label).toBe('Restricted');
      expect(view.tone).toBe('neutral');
      expect(view.hint).toBe('Only some members can see this document.');
      expect(view.groupNames).toEqual([]);
      expect(view.groupsLine).toBeNull();
      expect(view.peopleLine).toBeNull();
      expect(view.reason).toBeNull();
    }
  });

  it('shows nothing for a document visible to everyone', () => {
    const view = buildAudienceView({ restricted: false }, false, 'zh');
    expect(view.reading).toBe('everyone');
    expect(view.label).toBeNull();
    expect(view.everyoneText).toBe('可见范围：所有人');
  });
});

describe('buildAudienceView for an admin', () => {
  it('names the groups and the people count', () => {
    const view = buildAudienceView({ restricted: true, kind: 'groups', groupNames: ['group-a', 'group-b'], peopleCount: 4 }, true, 'en');
    expect(view.reading).toBe('groups');
    expect(view.label).toBe('Restricted');
    expect(view.groupNames).toEqual(['group-a', 'group-b']);
    expect(view.groupsLine).toBe('Visible to: group-a, group-b');
    expect(view.peopleLine).toBe('people at the source: 4');
    expect(view.hint).toBeNull();
  });

  it('gives the warning tone and the reason sentence for the fallback audience', () => {
    const view = buildAudienceView({ restricted: true, kind: 'uploader_only', fallbackReason: 'unmapped_source' }, true, 'it');
    expect(view.reading).toBe('uploader_only');
    expect(view.label).toBe('Solo chi ha caricato e amministratori');
    expect(view.tone).toBe('warning');
    expect(view.reason).toEqual({ before: 'La sua condivisione alla fonte non è associata a un gruppo di accesso.', code: null, after: '' });
  });

  it('puts an unknown reason code inside reason.other', () => {
    const view = buildAudienceView({ restricted: true, kind: 'uploader_only', fallbackReason: 'x_new' }, true, 'en');
    expect(view.reason).toEqual({ before: 'Restricted by the system with the code ', code: 'x_new', after: '.' });
  });
});

describe('RestrictedMark and AudienceLine', () => {
  it('renders the mark as static text with Lock, no role and no names for a non-admin', () => {
    const view = buildAudienceView({ restricted: true, kind: 'groups', groupNames: ['group-a'] }, false, 'en');
    const html = renderToStaticMarkup(createElement(RestrictedMark, { view }));
    expect(html).toContain('inline-flex items-center gap-1 text-xs');
    expect(html).toContain('lucide-lock');
    expect(html).toContain('Restricted');
    expect(html).toContain('title="Only some members can see this document."');
    expect(html).not.toContain('role=');
    expect(html).not.toContain('font-medium');
    expect(html).not.toContain('group-a');
    expect(renderToStaticMarkup(createElement(AudienceLine, { view, context: 'list' }))).not.toContain('group-a');
  });

  it('uses ShieldAlert and the warning tone for the fallback audience', () => {
    const view = buildAudienceView({ restricted: true, kind: 'uploader_only', fallbackReason: 'odd_code' }, true, 'en');
    const html = renderToStaticMarkup(createElement(AudienceLine, { view, context: 'list' }));
    expect(html).toContain('lucide-shield-alert');
    expect(html).toContain('text-amber-700 dark:text-amber-300');
    expect(html).toContain('Uploader and admins only');
    expect(html).toContain('<code');
    expect(html).toContain('odd_code');
  });

  it('shows nothing in the list for Everyone and the text in a dialog', () => {
    const view = buildAudienceView({ restricted: false, kind: 'everyone' }, true, 'en');
    expect(renderToStaticMarkup(createElement(AudienceLine, { view, context: 'list' }))).toBe('');
    expect(renderToStaticMarkup(createElement(AudienceLine, { view, context: 'dialog' }))).toContain('Visible to: Everyone');
  });

  it('renders markup in group names as text', () => {
    const view = buildAudienceView({ restricted: true, kind: 'groups', groupNames: [INJECTED] }, true, 'en');
    const html = renderToStaticMarkup(createElement(AudienceLine, { view, context: 'list' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('audience field state', () => {
  it('pre-chooses the current audience of one document', () => {
    expect(initAudienceField([{ kind: 'everyone', groupIds: [] }])).toEqual({ choice: 'everyone', chips: [], restrictedNow: false, mixed: false });
    expect(initAudienceField([{ kind: 'groups', groupIds: [GROUP_B] }])).toEqual({ choice: 'groups', chips: [GROUP_B], restrictedNow: true, mixed: false });
  });

  it('never offers the fallback audience: neither radio is chosen and save is disabled', () => {
    const state = initAudienceField([{ kind: 'uploader_only', groupIds: [] }]);
    expect(state.choice).toBeNull();
    const derived = deriveAudienceField(state, GROUPS, 'en', { mode: 'org' });
    expect(derived.radios.map((radio) => radio.value)).toEqual(['everyone', 'groups']);
    expect(derived.canSave).toBe(false);
    expect(derived.submit).toBeNull();
  });

  it('pre-chooses nothing for a mixed selection', () => {
    const state = initAudienceField([
      { kind: 'everyone', groupIds: [] },
      { kind: 'groups', groupIds: [GROUP_A] },
    ]);
    expect(state).toMatchObject({ choice: null, mixed: true, restrictedNow: true });
    const derived = deriveAudienceField(state, GROUPS, 'en', { mode: 'org', bulk: true });
    expect(derived.mixed).toBe('The selected documents have different access now. Your choice replaces it for all of them.');
    expect(derived.canSave).toBe(false);
    const same = initAudienceField([
      { kind: 'groups', groupIds: [GROUP_A, GROUP_B] },
      { kind: 'groups', groupIds: [GROUP_B, GROUP_A] },
    ]);
    expect(same).toMatchObject({ choice: 'groups', mixed: false });
  });

  it('Everyone hides the chips and keeps them; switching back restores them', () => {
    let state: AudienceFieldState = initAudienceField([{ kind: 'groups', groupIds: [GROUP_A] }]);
    state = audienceFieldReducer(state, { type: 'everyone' });
    expect(state.choice).toBe('everyone');
    expect(state.chips).toEqual([GROUP_A]);
    expect(deriveAudienceField(state, GROUPS, 'en', { mode: 'org' }).chips).toEqual([]);
    state = audienceFieldReducer(state, { type: 'groups' });
    expect(deriveAudienceField(state, GROUPS, 'en', { mode: 'org' }).chips).toEqual([GROUPS[0]]);
  });

  it('cannot be saved with Only these groups and no chip', () => {
    let state = initAudienceField([{ kind: 'everyone', groupIds: [] }]);
    state = audienceFieldReducer(state, { type: 'groups' });
    let derived = deriveAudienceField(state, GROUPS, 'en', { mode: 'org' });
    expect(derived.canSave).toBe(false);
    expect(derived.needGroup).toBe('Add at least one group, or choose Everyone.');
    state = audienceFieldReducer(state, { type: 'add', groupId: GROUP_B });
    state = audienceFieldReducer(state, { type: 'add', groupId: GROUP_A });
    derived = deriveAudienceField(state, GROUPS, 'en', { mode: 'org' });
    expect(derived.canSave).toBe(true);
    expect(derived.needGroup).toBeNull();
    expect(derived.chips.map((group) => group.id)).toEqual([GROUP_A, GROUP_B]);
    expect(derived.addable).toEqual([]);
    expect(derived.submit).toEqual({ groupIds: [GROUP_A, GROUP_B] });
    state = audienceFieldReducer(state, { type: 'remove', groupId: GROUP_A });
    state = audienceFieldReducer(state, { type: 'remove', groupId: GROUP_B });
    expect(deriveAudienceField(state, GROUPS, 'en', { mode: 'org' }).canSave).toBe(false);
  });

  it('keeps the remaining chips when a chosen group no longer exists', () => {
    const state = initAudienceField([{ kind: 'groups', groupIds: [GROUP_A, GROUP_B] }]);
    const derived = deriveAudienceField(state, [GROUPS[1] as AccessGroupOption], 'en', { mode: 'org' });
    expect(derived.chips.map((group) => group.id)).toEqual([GROUP_B]);
    expect(derived.submit).toEqual({ groupIds: [GROUP_B] });
  });

  it('disables the second radio with field.noGroups when no group exists', () => {
    const derived = deriveAudienceField(initAudienceField([{ kind: 'everyone', groupIds: [] }]), [], 'en', { mode: 'single' });
    expect(derived.radios[1]).toMatchObject({ value: 'groups', disabled: true, help: 'No access groups yet. Create one first.' });
    expect(derived.radios[0]).toMatchObject({ value: 'everyone', disabled: false, help: 'Every user of this deployment, including embedded chat and WhatsApp.' });
  });

  it('shows field.widen when Everyone is chosen for a restricted document', () => {
    let state = initAudienceField([{ kind: 'groups', groupIds: [GROUP_A] }]);
    expect(deriveAudienceField(state, GROUPS, 'en', { mode: 'org' }).widen).toBeNull();
    state = audienceFieldReducer(state, { type: 'everyone' });
    const derived = deriveAudienceField(state, GROUPS, 'en', { mode: 'org' });
    expect(derived.widen).toBe('Everyone will be able to get answers from this document.');
    expect(derived.submit).toEqual({ everyone: true });
    expect(deriveAudienceField(state, GROUPS, 'en', { mode: 'org', bulk: true }).widen).toBe(
      'Everyone will be able to get answers from the selected documents.',
    );
    const open = audienceFieldReducer(initAudienceField([{ kind: 'everyone', groupIds: [] }]), { type: 'everyone' });
    expect(deriveAudienceField(open, GROUPS, 'en', { mode: 'org' }).widen).toBeNull();
  });
});

describe('AudienceField markup', () => {
  it('is a fieldset with a legend, two radios and a chip list named by the second radio', () => {
    const state = initAudienceField([{ kind: 'groups', groupIds: [GROUP_A] }]);
    const html = renderToStaticMarkup(
      createElement(AudienceField, { state, onChange: () => undefined, groups: GROUPS, language: 'en', mode: 'org', id: 'f1' }),
    );
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend');
    expect(html).toContain('Visible to');
    expect(html.match(/type="radio"/g)?.length).toBe(2);
    expect(html).toContain('Only these groups');
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-labelledby="f1-groups-label"');
    expect(html).toContain('Remove group: group-a');
    expect(html).toContain('Add group');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Applies from the next question. Nothing is rebuilt.');
    expect(html).not.toContain('Uploader and admins only');
  });

  it('shows the need-group line with its id and renders injected names as text', () => {
    const state = audienceFieldReducer(initAudienceField([{ kind: 'everyone', groupIds: [] }]), { type: 'groups' });
    const html = renderToStaticMarkup(
      createElement(AudienceField, { state, onChange: () => undefined, groups: GROUPS, language: 'en', mode: 'org', id: 'f2' }),
    );
    expect(html).toContain('id="f2-need-group"');
    expect(html).toContain('Add at least one group, or choose Everyone.');
    const injected = initAudienceField([{ kind: 'groups', groupIds: [GROUP_A] }]);
    const markup = renderToStaticMarkup(
      createElement(AudienceField, {
        state: injected,
        onChange: () => undefined,
        groups: [{ id: GROUP_A, name: INJECTED }],
        language: 'en',
        mode: 'org',
      }),
    );
    expect(markup).not.toContain('<img');
  });
});

describe('AudienceField radios', () => {
  it('wraps each radio and its text in one label (one hit target) and keeps the accent colour off', () => {
    const html = renderToStaticMarkup(
      createElement(AudienceField, { state: initAudienceField([]), onChange: () => undefined, groups: GROUPS, language: 'en', mode: 'org', id: 'f3' }),
    );
    expect(html).toMatch(/<label for="f3-everyone"[^>]*><input id="f3-everyone"/);
    expect(html).not.toContain('accent-primary');
  });
});
