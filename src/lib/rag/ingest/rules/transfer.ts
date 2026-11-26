import { constants as fsConstants } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '@/lib/rag-eval/trace';
import { TenantRulesFileSchema, type BoilerplateRule, type SectionRuleSet, type TenantRulesFile } from '@/lib/rag-eval/contracts.generated';
import { checkTenantLinePattern } from '../../patterns/tenant-line-pattern';
import { scopeKey, type TenantScope } from '../../tenant/scope';
import type { RunnerIo } from '../backfill/runners';
import { INGEST_SOURCES } from '../types';
import {
  listBoilerplateRules,
  listSectionRuleSets,
  saveBoilerplateRule,
  saveSectionRuleSet,
  TENANT_RULE_LIMITS,
  type RuleAdminInput,
  type RuleFailure,
  type RuleLimitName,
  type StoredBoilerplateRule,
  type StoredSectionRuleSet,
} from './service';

/**
 * The rag:rules import and export (TPL-08, D-24, D-34). A rule file kept outside the repository is validated as a whole (generated
 * TenantRulesFile schema, every pattern through the save-time check, projected limits) before any write; the report always comes first and
 * writes happen only with --apply, through the rule service, which repeats every check. Output carries list names, indexes, counts and code
 * words only, never a pattern or a rule or heading name. Nothing here compiles or runs a pattern.
 */

export const RULES_FILE_MAX_BYTES = 2 * 1024 * 1024;

const LOG = '[RAG Rules]';

export type RulesList = 'section_rule_sets' | 'boilerplate_rules';

export interface RulesFileIssue {
  path: string;
  code: string;
}

export type ReadRulesFileResult = { ok: true; file: TenantRulesFile } | { ok: false; issues: RulesFileIssue[] };

/** The file could not be opened or read: a usage error (exit 64). */
export class RulesFileError extends Error {
  constructor() {
    super('the rules file could not be read');
    this.name = 'RulesFileError';
  }
}

function issuePath(parts: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const part of parts) out += typeof part === 'number' ? `[${part}]` : `${out === '' ? '' : '.'}${String(part)}`;
  return out;
}

/** Shape checks the contract does not carry: unique names per list, the line/fragment split, a known ingest source. */
function structuralIssues(file: TenantRulesFile): RulesFileIssue[] {
  const issues: RulesFileIssue[] = [];
  const sources = INGEST_SOURCES as readonly string[];
  const lists: Array<[RulesList, ReadonlyArray<{ name: string; source?: string }>]> = [
    ['section_rule_sets', file.section_rule_sets ?? []],
    ['boilerplate_rules', file.boilerplate_rules ?? []],
  ];
  for (const [list, rows] of lists) {
    const names = new Set<string>();
    rows.forEach((row, index) => {
      if (names.has(row.name)) issues.push({ path: `${list}[${index}].name`, code: 'duplicate_name' });
      names.add(row.name);
      if (row.source !== undefined && !sources.includes(row.source)) issues.push({ path: `${list}[${index}].source`, code: 'invalid_source' });
    });
  }
  (file.boilerplate_rules ?? []).forEach((rule, index) => {
    const line = rule.kind === 'line';
    const fields = { pattern: line, flags: line, max_length: !line, min_page_share: !line } as const;
    for (const [field, required] of Object.entries(fields)) {
      if ((rule[field as keyof typeof fields] !== undefined) !== required) {
        issues.push({ path: `boilerplate_rules[${index}].${field}`, code: required ? 'required_for_kind' : 'not_allowed_for_kind' });
      }
    }
  });
  return issues;
}

/** Reads and parses the whole file: over RULES_FILE_MAX_BYTES, not JSON, refused by the contract or the shape checks is a refused file. */
export async function readRulesFile(filePath: string, options: { signal: AbortSignal }): Promise<ReadRulesFileResult> {
  let text: string;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new RulesFileError();
    if (info.size > RULES_FILE_MAX_BYTES) return { ok: false, issues: [{ path: '', code: 'file_too_large' }] };
    text = await readFile(filePath, { encoding: 'utf8', signal: options.signal });
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof RulesFileError) throw error;
    throw new RulesFileError();
  }
  if (Buffer.byteLength(text, 'utf8') > RULES_FILE_MAX_BYTES) return { ok: false, issues: [{ path: '', code: 'file_too_large' }] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path: '', code: 'invalid_json' }] };
  }
  const parsed = TenantRulesFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.errors.map((issue) => ({ path: issuePath(issue.path), code: issue.code })) };
  const structural = structuralIssues(parsed.data);
  return structural.length > 0 ? { ok: false, issues: structural } : { ok: true, file: parsed.data };
}

export interface ListCounts {
  create: number;
  replace: number;
  unchanged: number;
  kept: number;
}

export type RulesWrite =
  | { list: 'section_rule_sets'; index: number; id?: string; body: SectionRuleSet }
  | { list: 'boilerplate_rules'; index: number; id?: string; body: BoilerplateRule };

export interface RulesImportPlan {
  report: Record<RulesList, ListCounts>;
  /** Rule sets first; within a list, writes whose result is disabled go before enabled ones. */
  writes: RulesWrite[];
  limit: RuleLimitName | null;
}

export interface StoredRules {
  ruleSets: readonly StoredSectionRuleSet[];
  boilerplateRules: readonly StoredBoilerplateRule[];
}

function planList<T extends { name: string; enabled: boolean }>(
  rows: readonly T[],
  stored: ReadonlyArray<{ id: string; body: T }>,
): { counts: ListCounts; writes: Array<{ index: number; id?: string; body: T }>; projected: T[] } {
  const byName = new Map(stored.map((item) => [item.body.name, item]));
  const named = new Set(rows.map((row) => row.name));
  const counts: ListCounts = { create: 0, replace: 0, unchanged: 0, kept: 0 };
  const writes: Array<{ index: number; id?: string; body: T }> = [];
  rows.forEach((row, index) => {
    const current = byName.get(row.name);
    if (!current) {
      counts.create += 1;
      writes.push({ index, body: row });
    } else if (canonicalJson(current.body) === canonicalJson(row)) {
      counts.unchanged += 1;
    } else {
      counts.replace += 1;
      writes.push({ index, id: current.id, body: row });
    }
  });
  const kept = stored.filter((item) => !named.has(item.body.name));
  counts.kept = kept.length;
  writes.sort((a, b) => Number(a.body.enabled) - Number(b.body.enabled) || a.index - b.index);
  return { counts, writes, projected: [...kept.map((item) => item.body), ...rows] };
}

/** Pure: compares the file with the stored rows by name and returns the report, the ordered writes and the first projected limit breach. */
export function planRulesImport(file: TenantRulesFile, stored: StoredRules): RulesImportPlan {
  const sets = planList(file.section_rule_sets ?? [], stored.ruleSets.map((item) => ({ id: item.id, body: item.ruleSet })));
  const rules = planList(file.boilerplate_rules ?? [], stored.boilerplateRules.map((item) => ({ id: item.id, body: item.rule })));
  let limit: RuleLimitName | null = null;
  if (sets.projected.length > TENANT_RULE_LIMITS.maxRuleSets) limit = 'rule_sets';
  else if (rules.projected.length > TENANT_RULE_LIMITS.maxBoilerplateRules) limit = 'boilerplate_rules';
  else {
    const bindings = new Set<string>();
    for (const set of sets.projected) {
      if (!set.enabled) continue;
      const binding = canonicalJson([set.doc_type ?? null, set.source ?? null]);
      if (bindings.has(binding)) {
        limit = 'binding';
        break;
      }
      bindings.add(binding);
    }
  }
  return {
    report: { section_rule_sets: sets.counts, boilerplate_rules: rules.counts },
    writes: [
      ...sets.writes.map((write) => ({ list: 'section_rule_sets' as const, ...write })),
      ...rules.writes.map((write) => ({ list: 'boilerplate_rules' as const, ...write })),
    ],
    limit,
  };
}

export interface RulesRunDeps {
  signal: AbortSignal;
  io: RunnerIo;
}

export interface RulesImportInput {
  scope: TenantScope;
  actorUserId: string;
  /** The rule file, already read and accepted by readRulesFile. */
  file: TenantRulesFile;
  apply: boolean;
  /** The effective switches: a list whose switch is on is read even when the file names none of its rows, so `kept` is right. */
  sectionRules: boolean;
  pageBoilerplate: boolean;
}

export interface RulesImportOutcome {
  exitCode: 0 | 1 | 2 | 3 | 64;
  status: 'done' | 'failed' | 'report_only' | 'refused' | 'actor_refused';
  report: Record<RulesList, ListCounts> | null;
  writesApplied: number;
}

const LIST_LABEL: Record<RulesList, string> = { section_rule_sets: 'section rule sets', boilerplate_rules: 'boilerplate rules' };

function reportLines(report: Record<RulesList, ListCounts>): string[] {
  return (Object.keys(LIST_LABEL) as RulesList[]).map((list) => {
    const c = report[list];
    return `${LOG} ${LIST_LABEL[list]}: create ${c.create}, replace ${c.replace}, unchanged ${c.unchanged}, kept ${c.kept}`;
  });
}

async function patternRefusals(file: TenantRulesFile, signal: AbortSignal): Promise<string[]> {
  const lines: string[] = [];
  for (const [i, set] of (file.section_rule_sets ?? []).entries()) {
    for (const [j, heading] of set.headings.entries()) {
      const checked = await checkTenantLinePattern('heading', heading.pattern, heading.flags, { signal });
      if (!checked.ok) lines.push(`section_rule_sets[${i}].headings[${j}]: ${checked.findings.map((f) => f.code).join(', ')}`);
    }
  }
  for (const [i, rule] of (file.boilerplate_rules ?? []).entries()) {
    if (rule.kind !== 'line' || rule.pattern === undefined || rule.flags === undefined) continue;
    const checked = await checkTenantLinePattern('boilerplate_line', rule.pattern, rule.flags, { signal });
    if (!checked.ok) lines.push(`boilerplate_rules[${i}]: ${checked.findings.map((f) => f.code).join(', ')}`);
  }
  return lines;
}

function adminInput(scope: TenantScope, actorUserId: string, signal: AbortSignal): RuleAdminInput {
  return { actorUserId, tenantKey: scopeKey(scope), signal };
}

async function readStored(input: RuleAdminInput, wantSets: boolean, wantRules: boolean): Promise<{ ok: true; stored: StoredRules } | RuleFailure> {
  const sets = wantSets ? await listSectionRuleSets(input) : { ok: true as const, items: [] };
  if (!sets.ok) return sets;
  const rules = wantRules ? await listBoilerplateRules(input) : { ok: true as const, items: [] };
  if (!rules.ok) return rules;
  return { ok: true, stored: { ruleSets: sets.items, boilerplateRules: rules.items } };
}

/**
 * Validates every pattern, reads the stored rows, plans, reports and, with apply, writes. Exit codes: 0 done, 1 failed, 2 report only,
 * 3 file refused (a pattern or a projected limit), 64 actor refused.
 */
export async function runRulesImport(input: RulesImportInput, deps: RulesRunDeps): Promise<RulesImportOutcome> {
  const { io, signal } = deps;
  const refusals = await patternRefusals(input.file, signal);
  if (refusals.length > 0) {
    for (const line of refusals) io.err(`${LOG}   ${line}`);
    io.err(`${LOG} file refused: ${refusals.length} pattern(s) failed the save-time check; nothing was written`);
    return { exitCode: 3, status: 'refused', report: null, writesApplied: 0 };
  }

  const admin = adminInput(input.scope, input.actorUserId, signal);
  const stored = await readStored(
    admin,
    input.sectionRules || (input.file.section_rule_sets ?? []).length > 0,
    input.pageBoilerplate || (input.file.boilerplate_rules ?? []).length > 0,
  );
  if (!stored.ok) {
    io.err(`${LOG} failed: ${stored.reason}; nothing was written`);
    return { exitCode: 1, status: 'failed', report: null, writesApplied: 0 };
  }
  const plan = planRulesImport(input.file, stored.stored);
  if (plan.limit !== null) {
    io.err(`${LOG} file refused: limit_reached: ${plan.limit}; nothing was written`);
    return { exitCode: 3, status: 'refused', report: plan.report, writesApplied: 0 };
  }
  for (const line of reportLines(plan.report)) io.out(line);
  if (!input.apply) {
    io.out(`${LOG} report only: nothing was written; run again with --apply to write`);
    return { exitCode: 2, status: 'report_only', report: plan.report, writesApplied: 0 };
  }

  const total = plan.writes.length;
  for (const [position, write] of plan.writes.entries()) {
    signal.throwIfAborted();
    const result =
      write.list === 'section_rule_sets'
        ? await saveSectionRuleSet(admin, write.body, write.id)
        : await saveBoilerplateRule(admin, write.body, write.id);
    if (!result.ok) {
      signal.throwIfAborted();
      if (result.reason === 'not_admin') {
        io.err(`${LOG} actor refused: the actor is not an admin of this tenant; ${position} of ${total} writes applied`);
        return { exitCode: 64, status: 'actor_refused', report: plan.report, writesApplied: position };
      }
      io.err(`${LOG} failed at write ${position + 1} of ${total}: ${result.reason}; ${position} of ${total} writes applied`);
      io.err(`${LOG} applied writes stay applied; running the same file again completes the import`);
      return { exitCode: 1, status: 'failed', report: plan.report, writesApplied: position };
    }
    io.out(`${LOG} write ${position + 1} of ${total}: ${write.list}[${write.index}] ${write.id === undefined ? 'created' : 'replaced'}`);
  }
  io.out(total === 0 ? `${LOG} nothing to write: every row is unchanged` : `${LOG} done: ${total} of ${total} writes applied`);
  return { exitCode: 0, status: 'done', report: plan.report, writesApplied: total };
}

export interface RulesExportInput {
  scope: TenantScope;
  actorUserId: string;
  out: string;
  sectionRules: boolean;
  pageBoilerplate: boolean;
  /** The working directory the output must stay outside of. */
  cwd: string;
}

export interface RulesExportOutcome {
  exitCode: 0 | 1 | 64;
  ruleSets: number;
  boilerplateRules: number;
}

/** True when target is the directory itself or below it. */
function inside(directory: string, target: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Writes the tenant's rules (the lists whose switch is on) in the contract shape, sorted by name, to a new file with mode 0600 outside the
 * working tree. No id, version, tenant key, actor or timestamp leaves. Zero rows writes no file.
 */
export async function runRulesExport(input: RulesExportInput, deps: RulesRunDeps): Promise<RulesExportOutcome> {
  const { io, signal } = deps;
  if (inside(input.cwd, input.out)) {
    io.err(`${LOG} refused: --out must be outside the working directory`);
    return { exitCode: 64, ruleSets: 0, boilerplateRules: 0 };
  }
  if (await exists(input.out)) {
    io.err(`${LOG} refused: --out already exists; nothing was written`);
    return { exitCode: 64, ruleSets: 0, boilerplateRules: 0 };
  }
  const stored = await readStored(adminInput(input.scope, input.actorUserId, signal), input.sectionRules, input.pageBoilerplate);
  if (!stored.ok) {
    io.err(`${LOG} failed: ${stored.reason}; nothing was written`);
    return { exitCode: 1, ruleSets: 0, boilerplateRules: 0 };
  }
  const ruleSets = stored.stored.ruleSets.map((item) => item.ruleSet).sort(byName);
  const boilerplateRules = stored.stored.boilerplateRules.map((item) => item.rule).sort(byName);
  if (ruleSets.length + boilerplateRules.length === 0) {
    io.out(`${LOG} nothing to export: the tenant has no rules; no file was written`);
    return { exitCode: 0, ruleSets: 0, boilerplateRules: 0 };
  }
  const file: Record<string, unknown> = { schema_version: 1 };
  if (input.sectionRules) file.section_rule_sets = ruleSets;
  if (input.pageBoilerplate) file.boilerplate_rules = boilerplateRules;
  const checked = TenantRulesFileSchema.safeParse(file);
  if (!checked.success) {
    io.err(`${LOG} failed: a stored row does not match the rules file contract; nothing was written`);
    return { exitCode: 1, ruleSets: 0, boilerplateRules: 0 };
  }
  const text = `${JSON.stringify(JSON.parse(canonicalJson(checked.data)), null, 2)}\n`;
  try {
    await writeFile(input.out, text, { encoding: 'utf8', mode: 0o600, flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, signal });
  } catch {
    signal.throwIfAborted();
    io.err(`${LOG} failed: the output file could not be written`);
    return { exitCode: 1, ruleSets: 0, boilerplateRules: 0 };
  }
  io.out(`${LOG} exported: section rule sets ${ruleSets.length}, boilerplate rules ${boilerplateRules.length}`);
  return { exitCode: 0, ruleSets: ruleSets.length, boilerplateRules: boilerplateRules.length };
}
