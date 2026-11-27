// Config UI walkthrough, item 1 (04.1.1-13 Terminology), against the local app + Config UI wired to the EVAL project.
// Reads ADMIN_EMAIL / ADMIN_PASSWORD from the repo's .env.local; never prints them.
// Writes only in the Workspace layer of the signed-in admin's Default workspace, and deletes only the entries this run created.
// Usage: node walkthrough-terminology.mjs [outDir]   (env MYRAG_DIR overrides the repo path)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.env.MYRAG_DIR || path.join(process.env.HOME, 'Projects/Experiments/myRAG');
const OUT = path.resolve(process.argv[2] || 'out-terminology');
const APP = 'http://localhost:3000';
const CFG = 'http://localhost:3333';
const RUN = 'wt' + Array.from({ length: 4 }, () => 'abcdefghijkmnpqrstuvwxyz'[Math.floor(Math.random() * 24)]).join('');

fs.mkdirSync(OUT, { recursive: true });
const steps = [];
const created = [];
let shot = 0;

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function record(id, name, status, note = '') {
  steps.push({ id, name, status, note: String(note).replace(/\s+/g, ' ').slice(0, 400) });
  console.log(`[${status}] ${id} ${name}${note ? ' — ' + String(note).replace(/\s+/g, ' ').slice(0, 200) : ''}`);
}

const env = readEnv(path.join(REPO, '.env.local'));
if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL or ADMIN_PASSWORD missing in .env.local. Stopping.');
  process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });

const section = page.locator('#rag-administration-terminology');
const snap = async (label) => {
  shot += 1;
  const file = path.join(OUT, `${String(shot).padStart(2, '0')}-${label}.png`);
  try { await section.screenshot({ path: file }); } catch { await page.screenshot({ path: file, fullPage: true }).catch(() => {}); }
};
const text = async () => (await section.innerText().catch(() => '')) || '';
const waitText = async (patterns, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await text();
    for (const p of patterns) if (p.test(t)) return { match: p, t };
    await page.waitForTimeout(400);
  }
  return { match: null, t: await text() };
};
const tab = async (name) => {
  await section.getByRole('tab', { name, exact: true }).click();
  await page.waitForTimeout(800);
};
const field = (name) => section.locator(`[data-terminology-field="${name}"]`);

async function step(id, name, fn) {
  try {
    await fn();
  } catch (error) {
    record(id, name, 'FAIL', error instanceof Error ? error.message.split('\n')[0] : String(error));
    await snap(`${id}-error`);
  }
}

try {
  await step('T0', 'Sign in to the main app', async () => {
    await page.goto(APP + '/auth', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', env.ADMIN_EMAIL);
    await page.fill('#password', env.ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 30000 });
    record('T0', 'Sign in to the main app', 'PASS');
  });

  await step('T1', 'Open the Terminology panel (Workspace layer)', async () => {
    await page.goto(CFG, { waitUntil: 'domcontentloaded' });
    await page.locator('a.menu-item[data-tab="rag-administration"]:visible').first().click();
    await section.scrollIntoViewIfNeeded();
    const r = await waitText([/Entries:\s*\d+/, /unavailable/i, /sign-in required/i], 30000);
    if (!r.match || r.match.source !== 'Entries:\\s*\\d+') throw new Error('Panel did not load: ' + r.t.slice(0, 200));
    await section.getByLabel('Workspace (this workspace only)').check();
    await page.waitForTimeout(2000);
    const count = ((await text()).match(/Entries:\s*(\d+)/) || [])[1];
    await snap('T1-workspace-layer');
    record('T1', 'Open the Terminology panel (Workspace layer)', 'PASS', `Workspace entries before the run: ${count}`);
  });

  await step('T2', 'Save a translation pair', async () => {
    await tab('Entries');
    await section.getByRole('button', { name: 'New entry', exact: true }).click();
    await field('kind').selectOption('translation');
    await page.waitForTimeout(500);
    const codes = (await field('source_language').locator('option').evaluateAll((os) => os.map((o) => o.value))).filter(Boolean);
    if (codes.length < 2) {
      await snap('T2-no-languages');
      await section.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => {});
      record('T2', 'Save a translation pair', 'SKIP', `Only ${codes.length} enabled language(s); a pair needs two. Configure languages first.`);
      return;
    }
    const term = `${RUN}tgt`;
    await field('canonical').fill(term);
    await field('variants').fill(`${RUN}src`);
    await field('source_language').selectOption(codes[0]);
    await field('target_language').selectOption(codes[1]);
    await section.getByRole('button', { name: 'Save entry', exact: true }).click();
    const r = await waitText([/Entry saved\./, /Saved with a warning/, /Not saved\./]);
    await snap('T2-translation-pair');
    if (r.match && !/Not saved/.test(r.match.source)) {
      created.push(term);
      record('T2', 'Save a translation pair', 'PASS', `${codes[0]} → ${codes[1]}`);
    } else {
      await section.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => {});
      record('T2', 'Save a translation pair', 'FAIL', r.t.slice(0, 300));
    }
  });

  await step('T3', 'CSV check (dry run) and apply', async () => {
    const csv = path.join(OUT, 'import.csv');
    fs.writeFileSync(
      csv,
      [
        'canonical,variants,language,kind,mode,enabled,note,source_language,target_language',
        `${RUN}eps,${RUN}eps-a|${RUN}eps-b,any,synonym,equivalent,true,walkthrough test,,`,
        `${RUN}kappa,${RUN}kp,any,abbreviation,one_way,true,walkthrough test,,`,
      ].join('\n') + '\n',
    );
    await tab('Import and export');
    await section.locator('input[type="file"]').setInputFiles(csv);
    await section.getByLabel('Merge (add and update)').check().catch(() => {});
    await section.getByRole('button', { name: 'Check file', exact: true }).click();
    const checked = await waitText([/File checked/, /Issues/, /could not be read/, /too large/]);
    await snap('T3a-csv-check');
    const t = checked.t;
    const toCreate = (t.match(/To create\D{0,20}(\d+)/) || [])[1];
    if (!/File checked/.test(t) || toCreate !== '2') {
      record('T3a', 'CSV check (dry run)', 'FAIL', `To create=${toCreate ?? '?'}; ${t.slice(0, 250)}`);
      return;
    }
    record('T3a', 'CSV check (dry run)', 'PASS', `To create=${toCreate}`);
    await section.getByRole('button', { name: 'Apply import', exact: true }).click();
    const applied = await waitText([/Import applied\./, /Check the file again/, /Fix the errors/]);
    await snap('T3b-csv-apply');
    if (applied.match && /Import applied/.test(applied.match.source)) {
      created.push(`${RUN}eps`, `${RUN}kappa`);
      record('T3b', 'CSV apply', 'PASS');
    } else {
      record('T3b', 'CSV apply', 'FAIL', applied.t.slice(0, 250));
    }
  });

  await step('T4', 'Preview a query', async () => {
    await tab('Preview');
    await section.getByLabel('Query', { exact: true }).fill(`guide on ${RUN}eps-a and tab-zz`);
    await section.getByRole('button', { name: 'Preview', exact: true }).click();
    const r = await waitText([/Added to the search/, /No dictionary term was found/]);
    await snap('T4-preview');
    const t = r.t;
    const ok = /Added to the search/.test(t) && t.includes(`${RUN}eps`);
    record('T4', 'Preview a query', ok ? 'PASS' : 'FAIL', ok ? 'Expansion shows the imported synonym' : t.slice(0, 250));
  });

  await step('T5', 'Candidates (dismiss)', async () => {
    await tab('Candidates');
    const r = await waitText([/No candidates to review/, /Dismiss/]);
    await snap('T5-candidates');
    if (r.match && /No candidates/.test(r.match.source)) {
      record('T5', 'Candidates (dismiss)', 'SKIP', 'No candidates in this workspace (the miner has not produced any). Dismiss not testable here.');
    } else {
      record('T5', 'Candidates (dismiss)', 'INFO', 'Candidates exist; not dismissed by the script because they are not walkthrough data.');
    }
  });

  await step('T6', 'History shows the changes', async () => {
    await tab('History');
    const r = await waitText([/Imported|Created/, /No changes recorded/]);
    await snap('T6-history');
    record('T6', 'History shows the changes', r.match && /Imported|Created/.test(r.match.source) ? 'PASS' : 'FAIL', r.t.slice(0, 160));
  });
} finally {
  // Cleanup: only entries this run created.
  try {
    if (created.length) {
      await tab('Entries');
      for (const term of created) {
        try {
          const search = section.getByLabel('Search terms');
          await search.fill(term);
          await page.waitForTimeout(1500);
          await section.getByRole('button', { name: `Delete ${term}`, exact: true }).click();
          const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).first();
          await dialog.waitFor({ timeout: 5000 }).catch(() => {});
          const focused = await page.evaluate(() => (document.activeElement && document.activeElement.textContent || '').trim());
          await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
          const r = await waitText([/Entry deleted\./], 15000);
          record('C-' + term, `Delete own test entry ${term}`, r.match ? 'PASS' : 'FAIL', `dialog focus on: "${focused}"`);
        } catch (error) {
          record('C-' + term, `Delete own test entry ${term}`, 'FAIL', error instanceof Error ? error.message.split('\n')[0] : String(error));
        }
      }
      await section.getByLabel('Search terms').fill('');
      await page.waitForTimeout(1500);
      await snap('C-after-cleanup');
      const count = ((await text()).match(/Entries:\s*(\d+)/) || [])[1];
      record('C', 'Cleanup finished', 'INFO', `Workspace entries after cleanup: ${count}`);
    }
  } catch (error) {
    record('C', 'Cleanup', 'FAIL', error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
  await browser.close();
}

const lines = [
  `# Terminology walkthrough ${new Date().toISOString()} (run ${RUN})`,
  '',
  '| Step | Name | Result | Note |',
  '| --- | --- | --- | --- |',
  ...steps.map((s) => `| ${s.id} | ${s.name} | ${s.status} | ${s.note.replace(/\|/g, '/')} |`),
  '',
  `Browser console errors: ${consoleErrors.length}`,
  ...consoleErrors.slice(0, 10).map((e) => `- ${e.replace(/\|/g, '/')}`),
];
fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
console.log(`\nScreenshots and report: ${OUT}`);
