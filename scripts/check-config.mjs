import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TRACKED = {
  'config-server': 'scripts/config-server.js',
  'config-ui': 'scripts/config-ui/index.html',
  'env-ts': 'src/lib/env.ts',
  'init-env': 'scripts/init-env.js',
};
export const TRACKED_LOCATIONS = Object.keys(TRACKED);
const MANIFEST_PATH = 'scripts/rag/env-manifest.json';
const ENV_LOCAL = '.env.local';
const NAME_PATTERN = '(?:NEXT_PUBLIC_)?RAG_[A-Z0-9_]+|LLAMACLOUD_[A-Z0-9_]+|OPENAI_EMBEDDING_MODEL';
const SRC_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);

function presenceRegex(name) {
  return new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`);
}

function namesIn(text, prefixPattern) {
  const re = new RegExp(`${prefixPattern}(${NAME_PATTERN})(?![A-Z0-9_])`, 'g');
  const found = new Set();
  for (const match of text.matchAll(re)) found.add(match[1]);
  return found;
}

function walkSrc(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(full, files);
    else if (SRC_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

export function discoverNames(root, trackedTexts) {
  const names = new Set();
  for (const file of walkSrc(path.join(root, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of namesIn(text, '(?<![A-Za-z0-9_$])(?:process\\.)?env(?:\\.|\\[[\'"])')) names.add(name);
  }
  for (const text of Object.values(trackedTexts)) {
    for (const name of namesIn(text, '(?<![A-Z0-9_])')) names.add(name);
  }
  return names;
}

export function measureLocations(root) {
  const texts = {};
  const problems = [];
  for (const [location, relative] of Object.entries(TRACKED)) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) {
      problems.push({ name: '-', location, message: `tracked file ${relative} is missing` });
      continue;
    }
    texts[location] = fs.readFileSync(full, 'utf8');
  }
  return { texts, problems };
}

export function checkConfig(root) {
  const violations = [];
  const manifestFile = path.join(root, MANIFEST_PATH);
  const { texts, problems } = measureLocations(root);
  violations.push(...problems);

  let manifest = null;
  if (!fs.existsSync(manifestFile)) {
    violations.push({ name: '-', location: 'manifest', message: `${MANIFEST_PATH} is missing` });
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch (error) {
      violations.push({ name: '-', location: 'manifest', message: `${MANIFEST_PATH} is not valid JSON: ${error.message}` });
    }
  }

  const vars = manifest && Array.isArray(manifest.vars) ? manifest.vars : [];
  if (manifest && vars.length === 0) {
    violations.push({ name: '-', location: 'manifest', message: 'manifest lists zero variables' });
  }

  const seen = new Set();
  const manifestNames = new Set();
  for (const entry of vars) {
    const name = entry && entry.name;
    if (typeof name !== 'string' || !name) {
      violations.push({ name: '-', location: 'manifest', message: 'manifest entry without a name' });
      continue;
    }
    if (seen.has(name)) {
      violations.push({ name, location: 'manifest', message: 'listed more than once in the manifest' });
      continue;
    }
    seen.add(name);
    manifestNames.add(name);
    const status = entry.status;
    const gaps = Array.isArray(entry.knownGaps) ? entry.knownGaps : [];
    if (status !== 'managed' && status !== 'legacy') {
      violations.push({ name, location: 'manifest', message: `status must be managed or legacy, got ${JSON.stringify(status)}` });
    }
    if (status === 'managed' && gaps.length > 0) {
      violations.push({ name, location: 'manifest', message: `managed variable must not list knownGaps (${gaps.join(', ')})` });
    }
    for (const gap of gaps) {
      if (!TRACKED_LOCATIONS.includes(gap)) {
        violations.push({ name, location: 'manifest', message: `unknown knownGaps location ${JSON.stringify(gap)}` });
      }
    }
    const regex = presenceRegex(name);
    for (const location of TRACKED_LOCATIONS) {
      if (!(location in texts)) continue;
      const present = regex.test(texts[location]);
      const isGap = gaps.includes(location);
      if (!present && !isGap) {
        violations.push({ name, location, message: 'missing from this location' });
      } else if (present && isGap) {
        violations.push({ name, location, message: 'listed in knownGaps but now present; remove it from knownGaps' });
      }
    }
  }

  const envLocalFile = path.join(root, ENV_LOCAL);
  if (fs.existsSync(envLocalFile)) {
    const envLocalText = fs.readFileSync(envLocalFile, 'utf8');
    for (const entry of vars) {
      if (!entry || entry.status !== 'managed' || typeof entry.name !== 'string') continue;
      if (!presenceRegex(entry.name).test(envLocalText)) {
        violations.push({ name: entry.name, location: 'env-local', message: 'missing from .env.local (run `npm run config` to add it)' });
      }
    }
  }

  if (Object.keys(texts).length > 0) {
    for (const name of discoverNames(root, texts)) {
      if (!manifestNames.has(name)) {
        violations.push({ name, location: 'manifest', message: 'used in src/ or a tracked file but not in the manifest' });
      }
    }
  }

  violations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  return { violations, varCount: vars.length };
}

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i] ?? '');
  }
  return args;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const { violations, varCount } = checkConfig(root);
  if (violations.length === 0) {
    console.log(`[check-config] ok: ${varCount} variable(s) match the manifest`);
    return 0;
  }
  for (const v of violations) console.error(`${v.name} [${v.location}] ${v.message}`);
  console.error(`[check-config] ${violations.length} violation(s)`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
