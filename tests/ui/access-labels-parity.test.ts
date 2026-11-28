import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ACCESS_GROUP_LABEL_KEYS, accessGroupLocaleTable } from '@/components/ui/access-group-labels';

const require = createRequire(import.meta.url);
const { ACCESS_GROUPS_LABELS } = require('../../scripts/config-ui/rag-panels/access-groups.js') as {
  ACCESS_GROUPS_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
};

/** Every key of 04.3 UI-SPEC 12.2 to 12.4: the strings both surfaces show, which must be identical (decision 26). */
const SHARED_KEYS = [
  // UI-SPEC 12.2
  'term.everyone',
  'audience.label',
  'audience.everyone',
  'audience.groups',
  'audience.people',
  'audience.uploaderOnly',
  'badge.restricted',
  'badge.restrictedHint',
  'reason.group_deleted',
  'reason.unmapped_source',
  'reason.source_error',
  'reason.other',
  'field.everyoneHelp.org',
  'field.everyoneHelp.single',
  'field.onlyGroups',
  'field.onlyGroupsHelp',
  'action.addGroup',
  'action.removeGroupChip',
  'chip.added',
  'chip.removed',
  'field.needGroup',
  'field.noGroups',
  'field.widen',
  'field.widenMany',
  'field.mixed',
  'field.effect',
  'action.editAccess',
  'action.editAccessAria',
  'action.changeAccess',
  'action.saveAccess',
  'action.keepAccess',
  'action.cancelEditing',
  'save.running',
  'save.done',
  'save.doneMany',
  'save.skipped',
  'edit.title',
  'bulk.title',
  'bulk.selected',
  'action.clearSelection',
  'select.aria',
  'select.allAria',
  'docs.connectorManaged',
  'error.groupGone',
  'picker.trigger',
  'picker.everyone',
  'picker.groups',
  'picker.aria',
  'picker.note',
  'picker.clear',
  'error.groupNotAllowed',
  // UI-SPEC 12.3
  'groups.title',
  'action.newGroup',
  'form.name',
  'form.key',
  'form.keyHelp',
  'form.needName',
  'form.badKey',
  'form.reservedKey',
  'action.createGroup',
  'action.closeForm',
  'create.running',
  'create.done',
  'error.groupExists',
  'col.group',
  'col.members',
  'col.documents',
  'col.actions',
  'group.members',
  'group.documents',
  'group.sourceConnector',
  'action.manageMembers',
  'action.manageMembersAria',
  'action.closeMembers',
  'action.renameGroup',
  'action.renameGroupAria',
  'action.saveName',
  'rename.done',
  'action.deleteGroup',
  'action.deleteGroupAria',
  'action.keepGroup',
  'delete.title',
  'delete.counting',
  'delete.docsClosed',
  'delete.docsOther',
  'delete.members',
  'delete.mappings',
  'delete.body',
  'delete.countUnavailable',
  'action.countAgain',
  'delete.running',
  'delete.done',
  'groups.empty.title',
  'groups.empty.body',
  'groups.adminNote',
  'groups.loading',
  'groups.loaded',
  'groups.unavailable',
  'action.refreshGroups',
  'action.loadMoreGroups',
  'members.title',
  'members.search',
  'members.searchHint',
  'members.noMatch',
  'members.already',
  'members.col.name',
  'members.col.added',
  'action.addMember',
  'action.addMemberAria',
  'member.added',
  'action.removeMember',
  'action.removeMemberAria',
  'member.removed',
  'members.empty',
  'error.memberExists',
  'error.notWorkspaceMember',
  // UI-SPEC 12.4
  'mapping.title',
  'mapping.description',
  'mapping.personalNote',
  'mapping.groups.title',
  'mapping.col.source',
  'mapping.col.principal',
  'mapping.col.accessGroup',
  'mapping.notMapped',
  'mapping.kind.group',
  'mapping.kind.team',
  'mapping.kind.workspace',
  'action.saveMapping',
  'action.saveMappingAria',
  'mapping.saved',
  'action.removeMapping',
  'action.removeMappingAria',
  'mapping.removed',
  'action.newMapping',
  'mapping.form.principal',
  'mapping.form.principalHelp',
  'action.createMapping',
  'error.mappingExists',
  'mapping.empty.title',
  'mapping.empty.body',
  'mapping.loading',
  'mapping.unavailable',
  'action.refreshMapping',
  'rules.title',
  'rules.description',
  'rules.col.sharedWith',
  'rules.col.counts',
  'rules.kind.domain',
  'rules.kind.anyone',
  'rules.kind.public',
  'rules.toggleAria',
  'value.on',
  'value.off',
  'rules.confirm.title',
  'rules.confirm.body',
  'action.keepRuleOff',
  'action.turnRuleOn',
  'rules.turnedOn',
  'rules.turnedOff',
  'action.addDomain',
  'rules.form.domain',
  'rules.badDomain',
  'action.createRule',
  'rules.empty',
] as const;

const LOCALES = ['en', 'zh', 'it'] as const;

describe('access-group strings shared by the Config UI and the app (UI-SPEC 12.2 to 12.4, decision 26)', () => {
  it('the shared key list has no duplicates', () => {
    expect(new Set(SHARED_KEYS).size).toBe(SHARED_KEYS.length);
  });

  it('every shared key exists in both tables', () => {
    const appKeys = new Set<string>(ACCESS_GROUP_LABEL_KEYS);
    expect(SHARED_KEYS.filter((key) => !appKeys.has(key))).toEqual([]);
    expect(SHARED_KEYS.filter((key) => !(key in ACCESS_GROUPS_LABELS.en))).toEqual([]);
  });

  for (const locale of LOCALES) {
    it(`${locale}: every shared string is written in both tables and identical`, () => {
      const app = accessGroupLocaleTable(locale) ?? {};
      const config = ACCESS_GROUPS_LABELS[locale];
      const differences = SHARED_KEYS.flatMap((key) => {
        const a = (app as Record<string, string | undefined>)[key];
        const c = config[key];
        return typeof a === 'string' && typeof c === 'string' && a === c ? [] : [{ key, app: a ?? null, config: c ?? null }];
      });
      expect(differences).toEqual([]);
    });
  }
});
