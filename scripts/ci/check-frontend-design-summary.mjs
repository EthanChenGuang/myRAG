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

const UI_PATH_RE = /(?:^|\/)scripts\/config-ui\/|(?:^|\/)src\/components\/|(?:^|\/)src\/app\//;
const PLAN_UI_RE = /scripts\/config-ui\/|src\/components\/|src\/app\//;

function readSummaries(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('-SUMMARY.md'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

function planTouchesUi(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('-PLAN.md')) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (PLAN_UI_RE.test(text)) return true;
  }
  return false;
}

const uiSpec = fs.readdirSync(phaseDir).some((name) => name.endsWith('-UI-SPEC.md'));
const uiPhase = uiSpec || planTouchesUi(phaseDir);

if (!uiPhase) {
  console.log('Frontend design SUMMARY gate: SKIP (no UI surface in phase)');
  process.exit(0);
}

const summaries = readSummaries(phaseDir);
if (summaries.length === 0) {
  console.error('BLOCKER: UI phase has no *-SUMMARY.md files');
  process.exit(2);
}

const failures = [];

for (const { name, text } of summaries) {
  const planStem = name.replace(/-SUMMARY\.md$/, '');
  const planPath = path.join(phaseDir, `${planStem}-PLAN.md`);
  const planText = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';
  const planIsUi = UI_PATH_RE.test(planText) || PLAN_UI_RE.test(planText);
  if (!planIsUi && !uiSpec) continue;

  if (!/##\s*Design skills/i.test(text)) {
    failures.push(`${name}: missing "## Design skills" section`);
    continue;
  }

  const section = text.split(/##\s*Design skills/i)[1]?.split(/^##\s/m)[0] ?? '';
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

console.log(`Frontend design SUMMARY gate: PASS (${summaries.length} summary file(s) checked)`);
process.exit(0);