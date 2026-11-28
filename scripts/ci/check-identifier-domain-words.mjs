import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Quick 261127-idn: identifier code names shapes, not domains. The word list is CI configuration, never product code.

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_FILE = 'scripts/ci/identifier-domain-words.json';
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs']);

export function readConfig(root = DEFAULT_ROOT, file = CONFIG_FILE) {
  const full = path.isAbsolute(file) ? file : path.join(root, file);
  const config = JSON.parse(fs.readFileSync(full, 'utf8'));
  for (const key of ['scan', 'words']) {
    if (!Array.isArray(config[key]) || config[key].length === 0) throw new Error(`${file}: "${key}" must be a non-empty array`);
  }
  return { scan: config.scan, words: config.words, phrases: config.phrases ?? [], allow: config.allow ?? [] };
}

/** Lower-case words of a text: split at non-letters, digits and lower-to-upper case changes (TaxId -> tax, id). */
export function wordsOf(text) {
  const out = [];
  for (const match of text.matchAll(/[A-Za-z]+/g)) {
    for (const part of match[0].split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) out.push({ word: part.toLowerCase(), index: match.index });
  }
  return out;
}

function walk(full, files) {
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isFile()) {
    if (SCAN_EXTENSIONS.has(path.extname(full))) files.push(full);
    return;
  }
  for (const entry of fs.readdirSync(full)) walk(path.join(full, entry), files);
}

export function collectFiles(root, scan) {
  const files = [];
  for (const rel of scan) walk(path.join(root, rel), files);
  return [...new Set(files.map((file) => path.relative(root, file).split(path.sep).join('/')))].sort();
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function blank(text, needle) {
  let out = text;
  let at = out.indexOf(needle);
  while (at !== -1) {
    out = out.slice(0, at) + needle.replace(/[^\n]/g, ' ') + out.slice(at + needle.length);
    at = out.indexOf(needle, at + needle.length);
  }
  return out;
}

export function checkIdentifierDomainWords(root = DEFAULT_ROOT, configFile = CONFIG_FILE) {
  const config = readConfig(root, configFile);
  const words = new Set(config.words.map((word) => word.toLowerCase()));
  const files = collectFiles(root, config.scan);
  const violations = [];
  const problems = [];
  for (const [i, entry] of config.allow.entries()) {
    if (typeof entry?.path !== 'string' || typeof entry?.text !== 'string' || entry.text === '') problems.push(`allow ${i}: path and text are required`);
    else if (typeof entry.reason !== 'string' || entry.reason.trim() === '') problems.push(`allow ${i} (${entry.path}): reason is required`);
    else if (!files.includes(entry.path)) problems.push(`allow ${i}: ${entry.path} is not a scanned file`);
    else if (!fs.readFileSync(path.join(root, entry.path), 'utf8').includes(entry.text)) problems.push(`allow ${i} (${entry.path}): stale entry, text not found`);
  }
  for (const rel of files) {
    let text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const entry of config.allow) if (entry?.path === rel && typeof entry.text === 'string' && entry.text !== '') text = blank(text, entry.text);
    for (const { word, index } of wordsOf(text)) {
      if (words.has(word)) violations.push({ file: rel, line: lineOf(text, index), word });
    }
    for (const phrase of config.phrases) {
      let at = text.indexOf(phrase);
      while (at !== -1) {
        violations.push({ file: rel, line: lineOf(text, at), word: phrase });
        at = text.indexOf(phrase, at + phrase.length);
      }
    }
  }
  return { scanned: files.length, violations, problems };
}

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT, config: CONFIG_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--config') args.config = path.resolve(argv[++i] ?? '');
  }
  return args;
}

function main() {
  const { root, config } = parseArgs(process.argv.slice(2));
  const result = checkIdentifierDomainWords(root, config);
  for (const v of result.violations) console.error(`${v.file}:${v.line} domain word "${v.word}"; name the shape instead`);
  for (const problem of result.problems) console.error(`${CONFIG_FILE}: ${problem}`);
  if (result.violations.length > 0 || result.problems.length > 0) {
    console.error(`[check-identifier-domain-words] ${result.violations.length} finding(s), ${result.problems.length} config problem(s)`);
    return 1;
  }
  console.log(`[check-identifier-domain-words] ok: ${result.scanned} file(s) scanned`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
