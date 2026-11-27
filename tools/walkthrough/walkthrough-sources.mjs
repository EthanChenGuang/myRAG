// Walkthrough item 3 (04.2-26): source version lines and "Also in N other documents" in the main app's Sources panel.
// Runs against the local app (localhost:3000) wired to the EVAL project. Reads ADMIN_EMAIL / ADMIN_PASSWORD from .env.local; never prints them.
// Uploads placeholder .txt documents into the signed-in admin's own workspace (u:<id>) only, and deletes exactly those documents at the end.
// Usage:
//   node walkthrough-sources.mjs setup     # backs up .env.local and turns the needed switches on (restart `npm run dev` afterwards)
//   node walkthrough-sources.mjs run [out] # the walkthrough
//   node walkthrough-sources.mjs restore   # puts the backed-up .env.local back (restart `npm run dev` afterwards)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = process.env.MYRAG_DIR || path.join(process.env.HOME, 'Projects/Experiments/myRAG');
const ENV_FILE = path.join(REPO, '.env.local');
const BACKUP = path.join(REPO, '.env.local.walkthrough-backup');
const APP = 'http://localhost:3000';
const SWITCHES = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_VERSION_SCOPE: 'true',
  RAG_DUP_CLUSTERS: 'true',
  RAG_RESULT_DIVERSITY: 'collapse',
  RAG_INGEST_PIPELINE: 'unified',
  RAG_INGEST_ASYNC: 'off',
  RAG_UPLOAD_APPROVAL: 'off',
};

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

const mode = process.argv[2];

if (mode === 'setup') {
  if (!fs.existsSync(BACKUP)) fs.copyFileSync(ENV_FILE, BACKUP);
  let lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  const current = readEnv(ENV_FILE);
  const extra = !current.OPENROUTER_API_KEY && current.OPENAI_API_KEY ? { NEXT_PUBLIC_AI_PROVIDER: 'openai' } : {};
  if (extra.NEXT_PUBLIC_AI_PROVIDER) console.log('No OpenRouter key found: chat will use OpenAI (gpt-4o-mini) for this walkthrough.');
  for (const [key, value] of Object.entries({ ...SWITCHES, ...extra })) {
    const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'));
  console.log('Switches set in .env.local:', Object.entries(SWITCHES).map(([k, v]) => `${k}=${v}`).join(', '));
  console.log(`Backup of the previous file: ${BACKUP}`);
  console.log('Now restart `npm run dev` (Ctrl+C, then npm run dev), then run: node walkthrough-sources.mjs run');
  process.exit(0);
}

if (mode === 'restore') {
  if (!fs.existsSync(BACKUP)) {
    console.log('No backup found; nothing to restore.');
    process.exit(0);
  }
  fs.copyFileSync(BACKUP, ENV_FILE);
  fs.unlinkSync(BACKUP);
  console.log('.env.local restored from the backup. Restart `npm run dev`.');
  process.exit(0);
}

if (mode !== 'run') {
  console.log('Usage: node walkthrough-sources.mjs setup | run [outDir] | restore');
  process.exit(2);
}

const OUT = path.resolve(process.argv[3] || 'out-sources');
fs.mkdirSync(OUT, { recursive: true });
const RUN = 'wt' + Array.from({ length: 4 }, () => 'abcdefghijkmnpqrstuvwxyz'[Math.floor(Math.random() * 24)]).join('');
const steps = [];
const uploaded = [];
let shot = 0;
const record = (id, name, status, note = '') => {
  const n = String(note).replace(/\s+/g, ' ').slice(0, 400);
  steps.push({ id, name, status, note: n });
  console.log(`[${status}] ${id} ${name}${n ? ' — ' + n.slice(0, 220) : ''}`);
};

const env = readEnv(ENV_FILE);
const missing = Object.entries(SWITCHES).filter(([k, v]) => (env[k] || '').toLowerCase() !== v).map(([k]) => k);
if (missing.length) {
  console.error(`Switches not set: ${missing.join(', ')}. Run "node walkthrough-sources.mjs setup" and restart npm run dev first.`);
  process.exit(2);
}
if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL or ADMIN_PASSWORD missing in .env.local.');
  process.exit(2);
}
if (!env.RAG_SUPPORTED_LANGUAGES || !env.RAG_PRIMARY_LANGUAGE) {
  console.error('Languages are not configured (RAG_SUPPORTED_LANGUAGES / RAG_PRIMARY_LANGUAGE). v2 needs them.');
  process.exit(2);
}
const provider = env.NEXT_PUBLIC_AI_PROVIDER || 'openrouter';
const hasProviderKey = provider === 'openrouter' ? Boolean(env.OPENROUTER_API_KEY) : provider === 'openai' ? Boolean(env.OPENAI_API_KEY) : true;

const Z = `ZEBRA${RUN}`.toUpperCase();
const Q = `quokka${RUN}`;
const policy = (days) =>
  `Walkthrough policy for order type ${Z}.\n\nThe refund window for order type ${Z} is ${days} days from delivery. ` +
  `Requests after the refund window for ${Z} are declined. This document is placeholder text for a software test.\n`;
const passage =
  `The ${Q} maintenance checklist requires the technician to inspect the copper valve, clean the intake filter, ` +
  `check the pressure gauge against the reference card, tighten the brass fittings, replace the rubber seal when it shows cracks, ` +
  `record every finding in the blue ledger, sign the ledger page, and report any leak to the site supervisor before the shift ends. ` +
  `The ${Q} checklist applies to every pump room and every technician, and a missing ledger entry counts as a skipped inspection.`;
const handbook = (team) => `Walkthrough handbook prepared for team ${team}.\n\n${passage}\n\nPlaceholder text for a software test.\n`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
const snap = async (label) => {
  shot += 1;
  await page.screenshot({ path: path.join(OUT, `${String(shot).padStart(2, '0')}-${label}.png`), fullPage: true }).catch(() => {});
};
let addVersionsAll = false;
await page.route('**/api/chat', async (route) => {
  const req = route.request();
  if ((addVersionsAll || provider === 'openai') && req.method() === 'POST') {
    try {
      const body = req.postDataJSON();
      if (addVersionsAll) body.retrievalFilters = { versions: 'all' };
      if (provider === 'openai') {
        body.data = body.data || {};
        body.data.settings = { ...(body.data.settings || {}), model: 'openai/gpt-4o-mini' };
      }
      return route.continue({ postData: JSON.stringify(body), headers: { ...req.headers(), 'content-type': 'application/json' } });
    } catch {}
  }
  return route.continue();
});

async function step(id, name, fn) {
  try { await fn(); } catch (error) {
    record(id, name, 'FAIL', error instanceof Error ? error.message.split('\n')[0] : String(error));
    await snap(`${id}-error`);
  }
}

async function upload(filename, content) {
  const res = await page.request.post(APP + '/api/process-document', {
    multipart: { file: { name: filename, mimeType: 'text/plain', buffer: Buffer.from(content, 'utf8') } },
    timeout: 180000,
  });
  let body = {};
  try { body = await res.json(); } catch {}
  const id = body.documentId || body.id || null;
  if (id) uploaded.push(id);
  return { status: res.status(), id, version: body.version ?? null, chunks: body.successfulChunks ?? null, state: body.status ?? null, error: body.error ?? null };
}

async function ask(question, label) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Use incognito chat' }).click().catch(() => {});
  const input = page.locator('textarea[placeholder="Ask anything"]:visible, input[placeholder="Ask anything"]:visible').first();
  await input.fill(question);
  await input.press('Enter');
  const sources = page.getByRole('button', { name: 'Show sources' }).last();
  await sources.waitFor({ timeout: 180000 });
  await page.waitForTimeout(3000);
  await sources.click();
  await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await snap(label);
  return page.locator('body').innerText();
}

let userId = null;
try {
  await step('S0', 'Sign in to the main app', async () => {
    await page.goto(APP + '/auth', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', env.ADMIN_EMAIL);
    await page.fill('#password', env.ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 30000 });
    const check = await (await page.request.get(APP + '/api/auth/check')).json();
    userId = check?.user?.id || null;
    if (!userId) throw new Error('No user id from /api/auth/check');
    record('S0', 'Sign in to the main app', 'PASS', `tenant u:<id> resolved; provider ${provider}, key present: ${hasProviderKey}`);
  });

  await step('S1', 'Upload placeholder documents (own workspace)', async () => {
    const v1 = await upload(`${RUN}-policy.txt`, policy(14));
    const v2 = await upload(`${RUN}-policy.txt`, policy(30));
    const h = [];
    for (const team of ['north', 'south', 'east']) h.push(await upload(`${RUN}-handbook-${team}.txt`, handbook(team)));
    const summary = [v1, v2, ...h].map((r) => `${r.status}/${r.state ?? '-'}/v${r.version ?? '?'}${r.error ? '/' + r.error : ''}`).join(', ');
    const ok = [v1, v2, ...h].every((r) => r.status < 300 && r.id);
    const versioned = v1.id && v2.id && String(v2.version) === '2';
    record('S1', 'Upload placeholder documents (own workspace)', ok ? (versioned ? 'PASS' : 'FAIL') : 'FAIL', `${summary}${versioned ? '' : ' (second upload did not become version 2)'}`);
  });

  await step('S2', 'Build duplicate clusters for this tenant only', async () => {
    const r = spawnSync('npm', ['run', '--silent', 'rag:dup-clusters', '--', '--tenant', `u:${userId}`], { cwd: REPO, encoding: 'utf8', timeout: 300000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter((l) => /\[|hashed|clustered|error/i.test(l)).slice(-4).join(' / ').replace(userId, '<id>');
    record('S2', 'Build duplicate clusters for this tenant only', r.status === 0 ? 'PASS' : 'FAIL', out || `exit ${r.status}`);
  });

  await step('S3', 'History question with versions: all → Superseded / Current tags', async () => {
    addVersionsAll = true;
    const t = await ask(`What is the refund window for order type ${Z}? Give the value in every version of the walkthrough policy.`, 'S3-versions-all');
    addVersionsAll = false;
    const superseded = /Superseded/.test(t);
    const current = /Current/.test(t);
    const v1 = /Version 1/.test(t);
    const v2 = /Version 2/.test(t);
    const amber = /has since been updated or removed/.test(t);
    const ok = superseded && current && v1 && v2 && !amber;
    record('S3', 'History question with versions: all → Superseded / Current tags', ok ? 'PASS' : 'FAIL',
      `Superseded=${superseded} Current=${current} Version1=${v1} Version2=${v2} amberNote=${amber}`);
  });

  await step('S4', 'Pasted passage → "Also in N other documents"', async () => {
    const t = await ask(`What does the ${Q} maintenance checklist require?`, 'S4-also-in');
    const m = t.match(/Also in (\d+) other documents?/);
    if (!m) { record('S4', 'Pasted passage → "Also in N other documents"', 'FAIL', 'No "Also in" line in the Sources panel'); return; }
    await page.getByText(/Also in \d+ other document/).first().click();
    await page.waitForTimeout(800);
    const list = page.getByRole('list', { name: 'Other documents with the same passage' }).first();
    const names = (await list.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await snap('S4-also-in-open');
    const ok = names.includes(`${RUN}-handbook`);
    record('S4', 'Pasted passage → "Also in N other documents"', ok ? 'PASS' : 'FAIL', `Also in ${m[1]}; list: ${names.slice(0, 160)}`);
  });
} finally {
  for (const id of [...new Set(uploaded)]) {
    try {
      const res = await page.request.delete(`${APP}/api/documents/${id}`);
      record('C', `Delete own test document`, res.status() < 300 || res.status() === 404 ? 'PASS' : 'FAIL', `HTTP ${res.status()}`);
    } catch (error) {
      record('C', 'Delete own test document', 'FAIL', error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
  }
  await browser.close();
}

const lines = [
  `# Sources walkthrough ${new Date().toISOString()} (run ${RUN})`,
  '',
  '| Step | Name | Result | Note |',
  '| --- | --- | --- | --- |',
  ...steps.map((s) => `| ${s.id} | ${s.name} | ${s.status} | ${s.note.replace(/\|/g, '/')} |`),
  '',
  `Browser console errors: ${consoleErrors.length}`,
];
fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
console.log(`\nScreenshots and report: ${OUT}`);
