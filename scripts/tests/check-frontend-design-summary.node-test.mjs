import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/ci/check-frontend-design-summary.mjs');

const DESIGN_TABLE = `## Design skills

| Skill | Outcome | Notes |
|-------|---------|-------|
| frontend-design | n/a | controls inside existing panels, no new interface |
| Impeccable | n/a | controls inside existing panels, no new interface |
| web-design-guidelines | all findings resolved | labels tied to controls |
`;

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function plan(filesModified) {
  return `---\nphase: 99\nplan: 01\nfiles_modified:\n${filesModified.map((file) => `  - ${file}`).join('\n')}\nautonomous: true\n---\n\n# Plan\n\nMentions src/components/ui/button.tsx in prose only.\n`;
}

function summary({ keyFiles = [], body = '' } = {}) {
  const modified = keyFiles.length ? `\n  modified:\n${keyFiles.map((file) => `    - ${file}`).join('\n')}` : '';
  return `---\nphase: 99\nplan: 01\nkey-files:\n  created: []${modified}\nstatus: complete\n---\n\n# Summary\n\n${body}\n`;
}

function phaseDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-gate-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function run(dir) {
  const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('check-frontend-design-summary: only UI plans need the Design skills section', () => {
  test('a UI plan (files_modified under scripts/config-ui/) without the section fails with exit 2', () => {
    const dir = phaseDir({ '99-01-PLAN.md': plan(['scripts/config-ui/index.html']), '99-01-SUMMARY.md': summary() });
    const result = run(dir);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /99-01-SUMMARY\.md: missing "## Design skills" section/);
  });

  test('a non-UI plan passes even when the phase has a UI-SPEC', () => {
    const dir = phaseDir({
      '99-UI-SPEC.md': '# UI spec\n',
      '99-01-PLAN.md': plan(['supabase/migrations/0425_search_path_empty.sql', 'tests/rag-db/search-path-empty.test.mts']),
      '99-01-SUMMARY.md': summary({ keyFiles: ['supabase/single-tenant-setup.sql'] }),
    });
    const result = run(dir);
    assert.equal(result.status, 0, result.output);
  });

  test('an api-only plan (src/app/api/**) passes: route handlers are not UI surface', () => {
    const dir = phaseDir({
      '99-UI-SPEC.md': '# UI spec\n',
      '99-01-PLAN.md': plan(['src/app/api/chat/route.ts', 'src/app/api/internal/voice-rag/route.ts']),
      '99-01-SUMMARY.md': summary({ keyFiles: ['src/app/api/chat/route.ts'] }),
    });
    const result = run(dir);
    assert.equal(result.status, 0, result.output);
  });

  test('a plan is UI when only its SUMMARY key-files name a UI path', () => {
    const dir = phaseDir({
      '99-01-PLAN.md': plan(['src/lib/rag/index.ts']),
      '99-01-SUMMARY.md': summary({ keyFiles: ['src/components/ui/sidebar.tsx'] }),
    });
    assert.equal(run(dir).status, 2);
  });

  test('src/app page and layout files and stylesheets are UI surface', () => {
    for (const file of ['src/app/shared/[shareId]/page.tsx', 'src/app/layout.tsx', 'src/app/globals.css', 'scripts/config-ui/styles.css']) {
      const dir = phaseDir({ '99-01-PLAN.md': plan([file]), '99-01-SUMMARY.md': summary() });
      assert.equal(run(dir).status, 2, file);
    }
  });

  test('a UI plan with a complete Design skills table passes', () => {
    const dir = phaseDir({ '99-01-PLAN.md': plan(['scripts/config-ui/index.html']), '99-01-SUMMARY.md': summary({ body: DESIGN_TABLE }) });
    const result = run(dir);
    assert.equal(result.status, 0, result.output);
  });

  test('a sentence that quotes the heading inline is not a Design skills section', () => {
    const body = 'The known "## Design skills" gap is unchanged.\n';
    const dir = phaseDir({ '99-01-PLAN.md': plan(['scripts/config-ui/index.html']), '99-01-SUMMARY.md': summary({ body }) });
    const result = run(dir);
    assert.equal(result.status, 2);
    assert.match(result.output, /missing "## Design skills" section/);
  });

  test('a phase with no UI plan and no UI-SPEC is skipped; usage errors exit 1', () => {
    const dir = phaseDir({ '99-01-PLAN.md': plan(['src/lib/env.ts']), '99-01-SUMMARY.md': summary() });
    const result = run(dir);
    assert.equal(result.status, 0);
    assert.match(result.output, /SKIP/);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 1);
    assert.equal(run(path.join(dir, 'missing')).status, 1);
  });
});
