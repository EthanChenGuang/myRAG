#!/usr/bin/env node
/**
 * Frontend design SUMMARY gate for UI phases/plans.
 * Exit 0 pass, 1 usage error, 2 policy fail (BLOCKER for gsd-verifier).
 */
import fs from 'node:fs';
import path from 'node:path';

const phaseDir = process.argv[2];
if (!phaseDir) {
  console.error('usage: node scripts/ci/check-frontend-design-summary.mjs <phase_dir>');
  process.exit(1);
}
if (!fs.existsSync(phaseDir) || !fs.statSync(phaseDir).isDirectory()) {
  console.error(`phase directory not found: ${phaseDir}`);
  process.exit(1);
}

/**
 * UI surface, per frontend-design-pipeline.md ("each UI plan") and frontend-design-verifier-gate.md: Config UI, components, App Router
 * pages and layouts, and stylesheets. Route handlers under src/app/api/ are not UI.
 */
function isUiPath(file) {
  const p = file.replace(/^\.\//, '');
  if (/^src\/app\/api\//.test(p)) return false;
  return (
    /^scripts\/config-ui\//.test(p) ||
    /^src\/components\//.test(p) ||
    /^src\/app\/(?:.*\/)?(?:page|layout)\.(?:tsx|jsx|ts|js)$/.test(p) ||
    /\.css$/.test(p)
  );
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match ? match[1] : '';
}

/** Paths listed under a top-level frontmatter key, as a block list or an inline [a, b] list (nested lists such as key-files.modified included). */
function frontmatterPaths(text, key) {
  const lines = frontmatter(text).split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start < 0) return [];
  const block = [lines[start].slice(key.length + 1)];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z_][\w-]*:/.test(line)) break;
    block.push(line);
  }
  return [...block.join('\n').matchAll(/[\w.@[\]-]+(?:\/[\w.@[\]-]+)+|[\w.-]+\.css\b/g)].map((m) => m[0]);
}

function readSummaries(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('-SUMMARY.md'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

function planText(dir, stem) {
  const planPath = path.join(dir, `${stem}-PLAN.md`);
  return fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';
}

/** A plan is a UI plan when its PLAN files_modified or its SUMMARY key-files name a UI path. */
function isUiPlan(plan, summaryText) {
  return [...frontmatterPaths(plan, 'files_modified'), ...frontmatterPaths(summaryText, 'key-files')].some(isUiPath);
}

const summaries = readSummaries(phaseDir);
const uiSpec = fs.readdirSync(phaseDir).some((name) => name.endsWith('-UI-SPEC.md'));
const planOnlyUi = fs
  .readdirSync(phaseDir)
  .filter((name) => name.endsWith('-PLAN.md'))
  .some((name) => frontmatterPaths(fs.readFileSync(path.join(phaseDir, name), 'utf8'), 'files_modified').some(isUiPath));
const uiSummaries = summaries.filter(({ name, text }) => isUiPlan(planText(phaseDir, name.replace(/-SUMMARY\.md$/, '')), text));
const uiPhase = uiSpec || planOnlyUi || uiSummaries.length > 0;

if (!uiPhase) {
  console.log('Frontend design SUMMARY gate: SKIP (no UI surface in phase)');
  process.exit(0);
}

if (summaries.length === 0) {
  console.error('BLOCKER: UI phase has no *-SUMMARY.md files');
  process.exit(2);
}

const failures = [];

const DESIGN_HEADING = /^##[ \t]+Design skills[ \t]*$/im;

for (const { name, text } of uiSummaries) {
  const heading = DESIGN_HEADING.exec(text);
  if (!heading) {
    failures.push(`${name}: missing "## Design skills" section`);
    continue;
  }

  const section = text.slice(heading.index + heading[0].length).split(/^##\s/m)[0] ?? '';
  const required = ['frontend-design', 'Impeccable', 'web-design-guidelines'];
  for (const skill of required) {
    if (!section.includes(skill)) failures.push(`${name}: Design skills table missing row for ${skill}`);
  }

  if (!/web-design-guidelines[\s\S]*?(pass|all findings resolved|none)/i.test(section)) {
    failures.push(`${name}: web-design-guidelines outcome must be pass / all findings resolved / none`);
  }

  if (/web-design-guidelines[\s\S]*(TODO|FIXME|open finding|unresolved)/i.test(section)) {
    failures.push(`${name}: unresolved web-design-guidelines findings listed`);
  }

  if (!/(frontend-design|Impeccable)[\s\S]*(pass|n\/a)/i.test(section)) {
    failures.push(`${name}: frontend-design and Impeccable must record pass or n/a`);
  }
}

if (failures.length > 0) {
  console.error('BLOCKER: frontend design SUMMARY gate failed:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(2);
}

console.log(`Frontend design SUMMARY gate: PASS (${uiSummaries.length} UI plan summary file(s) checked of ${summaries.length})`);
process.exit(0);