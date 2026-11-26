export interface RuleAdminInput {
  actorUserId: string;
  tenantKey: string;
  signal: AbortSignal;
}
type Stub = { ok: false; reason: 'unavailable' };
const stub = async (..._args: unknown[]): Promise<Stub> => ({ ok: false, reason: 'unavailable' });
export const listSectionRuleSets = stub;
export const saveSectionRuleSet = stub;
export const deleteSectionRuleSet = stub;
export const listBoilerplateRules = stub;
export const saveBoilerplateRule = stub;
export const deleteBoilerplateRule = stub;
export function sectionRulesEnabled(): boolean {
  return true;
}
export function pageBoilerplateEnabled(): boolean {
  return true;
}
