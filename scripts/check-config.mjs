import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isSecretConfigEntry } = require('./config-server-security.js');

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TRACKED = {
  'config-server': 'scripts/config-server.js',
  'config-ui': 'scripts/config-ui/index.html',
  'env-ts': 'src/lib/env.ts',
  'init-env': 'scripts/init-env.js',
};
export const TRACKED_LOCATIONS = Object.keys(TRACKED);
const MANIFEST_PATH = 'scripts/rag/env-manifest.json';
export const VENDOR_INVENTORY_PATH = 'config/rag/vendor-data-flow.json';
/** D-20: providers inside the deployment boundary (app signing secrets, the deployment's own sidecar, the metrics-only monitor webhook). */
export const IN_DEPLOYMENT_PROVIDERS = new Set(['app', 'sidecar', 'webhook']);
const ENV_LOCAL = '.env.local';
export const RAG_AFFECTING_PATH = 'src/lib/rag/config-gate/rag-affecting.generated.json';
const WRITE_RAG_AFFECTING = 'node scripts/check-config.mjs --write-rag-affecting';
const NAME_PATTERN = '(?:NEXT_PUBLIC_)?RAG_[A-Z0-9_]+|LLAMACLOUD_[A-Z0-9_]+|LANGFUSE_[A-Z0-9_]+|VOYAGE_[A-Z0-9_]+|DEEPINFRA_[A-Z0-9_]+|COHERE_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+|WEAVIATE_[A-Z0-9_]+|QDRANT_[A-Z0-9_]+|OPENAI_EMBEDDING_MODEL';
const SRC_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const DEFAULTS_DECISION_PATH = 'eval/decisions/04.1-retrieval-defaults.json';
export const METADATA_TYPES = ['bool', 'enum', 'number', 'string', 'secret', 'url'];
const GENERATED_SECTION_LOADER = /<script\b[^>]*\bsrc=["'][^"']*rag-panels\/rag-pipeline\.js["']/;

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

  const metadataContext = {
    byName: new Map(vars.filter((entry) => entry && typeof entry.name === 'string').map((entry) => [entry.name, entry])),
    initEnvText: texts['init-env'] ?? '',
    implicitEmpty: implicitInTemplates(root),
  };
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
    if ('ragAffecting' in entry ? typeof entry.ragAffecting !== 'boolean' : /^(?:NEXT_PUBLIC_)?RAG_/.test(name)) {
      violations.push({ name, location: 'manifest', message: 'ragAffecting must be stated as true or false (D-11)' });
    }
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
    const metadataViolations = status === 'managed' ? checkEntryMetadata(entry, metadataContext) : [];
    violations.push(...metadataViolations);
    const regex = presenceRegex(name);
    for (const location of TRACKED_LOCATIONS) {
      if (!(location in texts)) continue;
      const present =
        regex.test(texts[location]) ||
        (location === 'config-ui' && metadataViolations.length === 0 && rendersGeneratedSection(entry, texts[location]));
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

  violations.push(...checkModelMappings(root, texts));
  violations.push(...checkRoutingModels(root, texts));
  if (manifest) violations.push(...checkRagAffectingFile(root, manifest));
  violations.push(...checkVendorInventory(root, vars));

  const effectiveEnv = loadEffectiveEnv(root);
  const ingestion = checkIngestionSwitches(effectiveEnv);
  violations.push(...ingestion.errors);

  violations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  return { violations, warnings: ingestion.warnings, varCount: vars.length };
}

/** D-20: the provider ids config/rag/vendor-data-flow.json covers (vendor ids and their providers lists). */
function inventoryProviders(root) {
  const file = path.join(root, VENDOR_INVENTORY_PATH);
  if (!fs.existsSync(file)) return { ids: new Set(), problems: [] };
  let inventory;
  try {
    inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ids: new Set(), problems: [{ name: '-', location: 'manifest', message: `${VENDOR_INVENTORY_PATH} is not valid JSON: ${error.message}` }] };
  }
  const ids = new Set();
  for (const entry of Array.isArray(inventory?.vendors) ? inventory.vendors : []) {
    if (typeof entry?.vendor === 'string') ids.add(entry.vendor);
    for (const provider of Array.isArray(entry?.providers) ? entry.providers : []) if (typeof provider === 'string') ids.add(provider);
  }
  return { ids, problems: [] };
}

/** D-20: every managed url or secret variable names a provider with a vendor data-flow entry, unless it stays inside the deployment. */
export function checkVendorInventory(root, vars) {
  const { ids, problems } = inventoryProviders(root);
  const out = [...problems];
  for (const entry of vars) {
    if (!entry || entry.status !== 'managed' || (entry.type !== 'url' && entry.type !== 'secret')) continue;
    const provider = entry.provider;
    if (!isNonEmptyString(provider) || IN_DEPLOYMENT_PROVIDERS.has(provider) || ids.has(provider)) continue;
    out.push(metadataViolation(entry.name, `provider ${provider} has no vendor data-flow entry in ${VENDOR_INVENTORY_PATH}`));
  }
  return out;
}

function metadataViolation(name, message) {
  return { name, location: 'manifest', message };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function templateLine(initEnvText, name) {
  const match = initEnvText.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1] : null;
}

/** 04.1 D-25: once the retrieval defaults flipped, every name in implicit_in_templates ships an empty template value. */
function implicitInTemplates(root) {
  const file = path.join(root, DEFAULTS_DECISION_PATH);
  if (!fs.existsSync(file)) return new Set();
  try {
    const decision = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (decision?.status !== 'flip' || !Array.isArray(decision.implicit_in_templates)) return new Set();
    return new Set(decision.implicit_in_templates.filter((name) => typeof name === 'string'));
  } catch {
    return new Set();
  }
}

/** D-14: the metadata the generated Config UI section needs for one managed entry. */
export function checkEntryMetadata(entry, { byName, initEnvText, implicitEmpty }) {
  const name = entry.name;
  const out = [];
  for (const field of ['group', 'label']) {
    if (!isNonEmptyString(entry[field])) out.push(metadataViolation(name, `missing metadata: ${field}`));
  }
  const type = entry.type;
  const typeKnown = METADATA_TYPES.includes(type);
  if (type === undefined) out.push(metadataViolation(name, 'missing metadata: type'));
  else if (!typeKnown) out.push(metadataViolation(name, `invalid metadata type ${JSON.stringify(type)} (expected ${METADATA_TYPES.join(', ')})`));

  const options = entry.options;
  const optionsValid =
    Array.isArray(options) && options.length > 0 && options.every((o) => typeof o === 'string' && o !== '') && new Set(options).size === options.length;
  if (type === 'enum' && !optionsValid) out.push(metadataViolation(name, 'enum metadata needs options (distinct non-empty strings)'));
  if (typeKnown && type !== 'enum' && options !== undefined) out.push(metadataViolation(name, 'options are allowed only on enum metadata'));

  if (!Array.isArray(entry.requires)) {
    out.push(metadataViolation(name, 'missing metadata: requires (a list, empty when nothing is required)'));
  } else {
    for (const requirement of entry.requires) {
      const match = typeof requirement === 'string' ? requirement.match(/^([A-Z][A-Z0-9_]*)(?:=(.*))?$/) : null;
      if (!match) {
        out.push(metadataViolation(name, `requires entry ${JSON.stringify(requirement)} must be NAME or NAME=value`));
        continue;
      }
      const target = byName.get(match[1]);
      if (!target) {
        out.push(metadataViolation(name, `requires names an unknown variable ${match[1]}`));
      } else if (match[2] !== undefined && target.type === 'enum' && Array.isArray(target.options) && !target.options.includes(match[2])) {
        out.push(metadataViolation(name, `requires ${match[1]}=${match[2]}, which is not one of its options`));
      }
    }
  }

  if ((type === 'url' || type === 'secret') && !isNonEmptyString(entry.provider)) out.push(metadataViolation(name, 'missing metadata: provider'));

  if ('help' in entry && !(isNonEmptyString(entry.help) && !/[\r\n\u2028\u2029]/.test(entry.help))) {
    out.push(metadataViolation(name, 'help must be a non-empty single-line string'));
  }

  const detectedSecret = isSecretConfigEntry(name, '');
  if (detectedSecret && typeKnown && type !== 'secret') {
    out.push(metadataViolation(name, 'name is detected as a secret, so metadata type must be secret'));
  } else if (!detectedSecret && type === 'secret') {
    out.push(metadataViolation(name, 'metadata type secret but the name is not detected as a secret'));
  }

  if (!('default' in entry)) {
    out.push(metadataViolation(name, 'missing metadata: default'));
    return out;
  }
  const value = entry.default;
  if (typeof value !== 'string') {
    out.push(metadataViolation(name, 'metadata default must be a string'));
    return out;
  }
  const template = templateLine(initEnvText, name);
  if (type === 'secret' && value !== '') out.push(metadataViolation(name, 'secret default must be empty'));
  else if (type === 'bool' && value !== 'true' && value !== 'false' && !(value === '' && (template ?? '') === '')) {
    out.push(metadataViolation(name, 'bool default must be true or false (use enum for on/off switches)'));
  } else if (type === 'enum' && optionsValid && value !== '' && !options.includes(value)) {
    out.push(metadataViolation(name, 'enum default must be one of its options'));
  }
  if (implicitEmpty.has(name) && value !== '') {
    out.push(metadataViolation(name, 'default must be empty: implicit in templates (04.1 D-25)'));
  } else if (type !== 'secret' && template !== null && template !== value) {
    out.push(metadataViolation(name, `default differs from init-env.js (${JSON.stringify(value)} vs ${JSON.stringify(template)})`));
  } else if (type !== 'secret' && template === null && presenceRegex(name).test(initEnvText)) {
    out.push(metadataViolation(name, `init-env.js has no ${name}= template line to compare the default with`));
  }
  return out;
}

/** D-14: index.html renders every managed entry with complete metadata once it loads the generated section. */
function rendersGeneratedSection(entry, configUiText) {
  return entry.status === 'managed' && GENERATED_SECTION_LOADER.test(configUiText);
}

/** D-11: the sorted union of the manifest entries marked ragAffecting and ragAffectingExtra. */
export function ragAffectingNames(manifest) {
  const vars = Array.isArray(manifest?.vars) ? manifest.vars : [];
  const extra = Array.isArray(manifest?.ragAffectingExtra) ? manifest.ragAffectingExtra : [];
  const names = vars.filter((entry) => entry && entry.ragAffecting === true && typeof entry.name === 'string').map((entry) => entry.name);
  for (const name of extra) if (typeof name === 'string' && name) names.push(name);
  return [...new Set(names)].sort();
}

export function renderRagAffecting(manifest) {
  return `${JSON.stringify({ names: ragAffectingNames(manifest) }, null, 2)}\n`;
}

function checkRagAffectingFile(root, manifest) {
  const file = path.join(root, RAG_AFFECTING_PATH);
  const expected = renderRagAffecting(manifest);
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (actual === expected) return [];
  const state = actual === null ? 'is missing' : 'is out of date with the manifest';
  return [{ name: '-', location: 'manifest', message: `${RAG_AFFECTING_PATH} ${state}; run \`${WRITE_RAG_AFFECTING}\`` }];
}

function writeRagAffectingFile(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8'));
  const file = path.join(root, RAG_AFFECTING_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderRagAffecting(manifest));
  return ragAffectingNames(manifest).length;
}

const ANTHROPIC_ID_PATTERN = /^claude-[a-z0-9-]+$/;
const MODEL_LIST_ANCHORS = {
  'init-env': [/DEFAULT_OPENROUTER_MODELS\s*=\s*'/],
  'config-server': [/DEFAULT_OPENROUTER_MODELS\s*=\s*'/],
  'env-ts': [/NEXT_PUBLIC_OPENROUTER_MODELS:\s*process\.env\.NEXT_PUBLIC_OPENROUTER_MODELS\s*\|\|\s*JSON\.stringify\(/],
  'config-ui': [
    /defaultOpenRouterModels\s*=[^\n]*?JSON\.stringify\(/,
    /openrouterModels:\s*safeJsonParse\(\s*defaultOpenRouterModels\s*,\s*/,
    /openrouterModels:\s*(?=\[\s*\{)/,
  ],
};

function matchingClose(text, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stringField(objectText, key) {
  const re = new RegExp(`(?:^|[{,\\s])(['"]?)${key}\\1\\s*:\\s*(['"])((?:\\\\.|(?!\\2).)*)\\2`);
  const match = objectText.match(re);
  return match ? match[3] : undefined;
}

function hasField(objectText, key) {
  return new RegExp(`(?:^|[{,\\s])(['"]?)${key}\\1\\s*:`).test(objectText);
}

/** Model objects of one array literal (JSON or JS object literals); null when no array starts at `from`. */
function modelsInArray(text, from) {
  const start = text.indexOf('[', from);
  if (start === -1) return null;
  const end = matchingClose(text, start, '[', ']');
  if (end === -1) return null;
  const models = [];
  let i = start + 1;
  while (i < end) {
    const open = text.indexOf('{', i);
    if (open === -1 || open > end) break;
    const close = matchingClose(text, open, '{', '}');
    if (close === -1 || close > end) break;
    const objectText = text.slice(open, close + 1);
    const id = stringField(objectText, 'id');
    if (id !== undefined) {
      models.push({ id, anthropicId: stringField(objectText, 'anthropicId'), hasAnthropicField: hasField(objectText, 'anthropicId') });
    }
    i = close + 1;
  }
  return models;
}

function envLocalModelList(text) {
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?NEXT_PUBLIC_OPENROUTER_MODELS\s*=(.*)$/);
    if (match) return match[1].trim();
  }
  return null;
}

/** Every OpenRouter model list: the tracked locations (three fallback arrays in the Config UI) and .env.local when it sets one. */
function openRouterModelLists(root, texts) {
  const lists = [];
  for (const [location, anchors] of Object.entries(MODEL_LIST_ANCHORS)) {
    const text = texts[location] ?? '';
    anchors.forEach((anchor, index) => {
      const label = anchors.length > 1 ? `fallback array ${index + 1} of ${anchors.length}` : 'model list';
      const match = anchor.exec(text);
      const models = match ? modelsInArray(text, match.index + match[0].length) : null;
      lists.push({ location, label, models });
    });
  }
  const envLocalFile = path.join(root, ENV_LOCAL);
  if (fs.existsSync(envLocalFile)) {
    const value = envLocalModelList(fs.readFileSync(envLocalFile, 'utf8'));
    const models = value ? modelsInArray(value, 0) : null;
    if (models !== null) lists.push({ location: 'env-local', label: 'NEXT_PUBLIC_OPENROUTER_MODELS', models });
  }
  return lists;
}

/** D-08: an anthropicId must be well formed and identical in every model location; unmapped ids stay free. */
export function checkModelMappings(root, texts) {
  const lists = openRouterModelLists(root, texts);
  const violations = [];
  const mapped = new Map();
  for (const list of lists) {
    for (const model of list.models ?? []) {
      if (!model.hasAnthropicField) continue;
      if (!mapped.has(model.id)) mapped.set(model.id, new Set());
      if (model.anthropicId === undefined) {
        violations.push({ name: model.id, location: list.location, message: `anthropicId must be a string (${list.label})` });
        continue;
      }
      if (!model.id.startsWith('anthropic/')) {
        violations.push({ name: model.id, location: list.location, message: `only anthropic/ models may carry an anthropicId (${list.label})` });
      }
      if (!ANTHROPIC_ID_PATTERN.test(model.anthropicId)) {
        violations.push({
          name: model.id,
          location: list.location,
          message: `anthropicId ${JSON.stringify(model.anthropicId)} does not match ${ANTHROPIC_ID_PATTERN} (${list.label})`,
        });
      }
    }
  }

  for (const id of mapped.keys()) {
    const seen = lists.map((list) => {
      const entries = (list.models ?? []).filter((model) => model.id === id);
      const values = new Set(entries.map((model) => model.anthropicId ?? null));
      return { list, entries, values };
    });
    const summary = seen
      .map(({ list, entries, values }) => {
        const where = list.label === 'model list' || list.location === 'env-local' ? list.location : `${list.location}#${list.label.split(' ')[2]}`;
        if (entries.length === 0) return `${where}=missing`;
        return `${where}=${[...values].map((value) => value ?? 'none').join('|')}`;
      })
      .join(', ');
    const counts = new Map();
    for (const { values } of seen) for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const agreed = ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
    for (const { list, entries, values } of seen) {
      if (list.models === null) {
        violations.push({ name: id, location: list.location, message: `OpenRouter ${list.label} not found, so the mapped model is missing (${summary})` });
      } else if (entries.length === 0) {
        violations.push({ name: id, location: list.location, message: `mapped model is missing from this location's ${list.label} (${summary})` });
      } else if (values.has(null)) {
        violations.push({ name: id, location: list.location, message: `listed without anthropicId in ${list.label} (${summary})` });
      } else if (agreed === null || values.size > 1 || !values.has(agreed)) {
        violations.push({ name: id, location: list.location, message: `anthropicId differs across locations in ${list.label}: ${summary}` });
      }
    }
  }
  return violations;
}

export const ROUTING_MODEL_NAMES = ['RAG_ROUTING_FAST_MODEL', 'RAG_ROUTING_QUALITY_MODEL'];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The routing model ids one location writes as defaults: every occurrence, so each config-server template counts. */
function routingDefaults(location, text, name) {
  const n = escapeRegex(name);
  const patterns = {
    'init-env': [new RegExp(`^${n}=(.*)$`, 'gm')],
    'env-ts': [new RegExp(`${n}:\\s*process\\.env\\.${n}\\s*\\|\\|\\s*'([^']*)'`, 'g')],
    'config-server': [new RegExp(`'${n}=([^']*)'`, 'g'), new RegExp(`getEnvValue\\('${n}'\\)\\s*\\|\\|\\s*'([^']*)'`, 'g')],
  }[location];
  if (!patterns) return [];
  return patterns.flatMap((re) => [...text.matchAll(re)].map((match) => match[1].trim()));
}

/**
 * 06.2 D-19, D-35: both routing model ids name a model of every OpenRouter model list and never the auto entry; the
 * tracked locations write them as defaults, never empty. An empty value in .env.local is left to the Config UI warning.
 */
export function checkRoutingModels(root, texts) {
  const lists = openRouterModelLists(root, texts).filter((list) => list.models !== null);
  const configured = [];
  for (const location of ['init-env', 'env-ts', 'config-server']) {
    for (const name of ROUTING_MODEL_NAMES) {
      for (const value of routingDefaults(location, texts[location] ?? '', name)) configured.push({ name, location, value, allowEmpty: false });
    }
  }
  const envLocalFile = path.join(root, ENV_LOCAL);
  if (fs.existsSync(envLocalFile)) {
    const env = parseEnvAssignments(fs.readFileSync(envLocalFile, 'utf8'));
    for (const name of ROUTING_MODEL_NAMES) {
      if (name in env) configured.push({ name, location: 'env-local', value: env[name], allowEmpty: true });
    }
  }

  const violations = [];
  const reported = new Set();
  for (const { name, location, value, allowEmpty } of configured) {
    const key = `${name}|${location}|${value}`;
    if (reported.has(key)) continue;
    reported.add(key);
    if (value === '') {
      if (!allowEmpty) violations.push({ name, location, message: 'must name a listed model as its default, not an empty value (06.2 D-35)' });
      continue;
    }
    if (value === 'auto') {
      violations.push({ name, location, message: 'must not be auto; it names the model the Auto entry resolves to (06.2 D-19)' });
      continue;
    }
    const missing = lists
      .filter((list) => !list.models.some((model) => model.id === value))
      .map((list) => (list.label === 'model list' || list.location === 'env-local' ? list.location : `${list.location}#${list.label.split(' ')[2]}`));
    if (missing.length > 0) {
      violations.push({ name, location, message: `${value} is not in the OpenRouter model list (${missing.join(', ')}) (06.2 D-19)` });
    }
  }
  return violations;
}

function parseEnvAssignments(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    map[name] = trimmed.slice(eq + 1).trim();
  }
  return map;
}

function loadEffectiveEnv(root) {
  let env = {};
  const initPath = path.join(root, TRACKED['init-env']);
  if (fs.existsSync(initPath)) {
    env = { ...env, ...parseEnvAssignments(fs.readFileSync(initPath, 'utf8')) };
  }
  const localPath = path.join(root, ENV_LOCAL);
  if (fs.existsSync(localPath)) {
    env = { ...env, ...parseEnvAssignments(fs.readFileSync(localPath, 'utf8')) };
  }
  return env;
}

/** D-10, D-22 and A-2: invalid switch combinations fail CI; cloud-off with legacy warns only. */
export function checkIngestionSwitches(env) {
  const errors = [];
  const warnings = [];
  const pipeline = (env.RAG_INGEST_PIPELINE ?? 'legacy').trim().toLowerCase();
  const routing = (env.RAG_PARSE_ROUTING ?? 'fixed').trim().toLowerCase();
  const asyncVal = (env.RAG_INGEST_ASYNC ?? 'off').trim().toLowerCase();
  const allowCloud = (env.RAG_PARSER_ALLOW_CLOUD ?? 'true').trim().toLowerCase();
  const llamaKey = (env.LLAMA_CLOUD_API_KEY ?? '').trim();

  if (routing === 'tiered' && (pipeline !== 'unified' || asyncVal !== 'on')) {
    errors.push({
      name: 'RAG_PARSE_ROUTING',
      location: 'ingestion',
      message:
        'D-10: RAG_PARSE_ROUTING=tiered requires RAG_INGEST_PIPELINE=unified and RAG_INGEST_ASYNC=on',
    });
  }

  if (asyncVal === 'on' && pipeline !== 'unified') {
    errors.push({
      name: 'RAG_INGEST_ASYNC',
      location: 'ingestion',
      message: 'D-22: RAG_INGEST_ASYNC=on requires RAG_INGEST_PIPELINE=unified',
    });
  }

  const cloudRefused = !['', 'true', '1', 'yes', 'on'].includes(allowCloud);
  if (cloudRefused && pipeline === 'legacy' && llamaKey !== '') {
    warnings.push({
      name: 'RAG_PARSER_ALLOW_CLOUD',
      location: 'ingestion',
      message:
        'A-2: RAG_PARSER_ALLOW_CLOUD refuses cloud parsing with legacy pipeline while LLAMA_CLOUD_API_KEY is set (key present; value not shown)',
    });
  }

  const supabaseUrl = (env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  if (supabaseUrl.startsWith('postgresql://') || supabaseUrl.startsWith('postgres://')) {
    errors.push({
      name: 'NEXT_PUBLIC_SUPABASE_URL',
      location: 'ingestion',
      message:
        'Use the Supabase project HTTPS URL (PostgREST / API), not a direct Postgres connection string',
    });
  } else if (/^https:\/\/db\.[a-z0-9-]+\.supabase\.co/i.test(supabaseUrl) || /:5432\b/.test(supabaseUrl)) {
    warnings.push({
      name: 'NEXT_PUBLIC_SUPABASE_URL',
      location: 'ingestion',
      message:
        'NEXT_PUBLIC_SUPABASE_URL should be the project API host (*.supabase.co), not db.* or port 5432',
    });
  }

  return { errors, warnings };
}

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT, writeRagAffecting: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--write-rag-affecting') args.writeRagAffecting = true;
  }
  return args;
}

function main() {
  const { root, writeRagAffecting } = parseArgs(process.argv.slice(2));
  if (writeRagAffecting) {
    const count = writeRagAffectingFile(root);
    console.log(`[check-config] wrote ${RAG_AFFECTING_PATH} (${count} name(s))`);
  }
  const { violations, varCount, warnings } = checkConfig(root);
  for (const w of warnings) console.warn(`${w.name} [${w.location}] ${w.message}`);
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
