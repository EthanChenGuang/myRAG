#!/usr/bin/env node
// D-20: renders docs/vendor-data-flow.md from config/rag/vendor-data-flow.json, validated against the VendorDataFlow JSON Schema.
// Exit codes: 0 written or up to date, 1 the committed document is out of date (--check), 2 the inventory is invalid.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INVENTORY_PATH = 'config/rag/vendor-data-flow.json';
export const DOC_PATH = 'docs/vendor-data-flow.md';
export const SCHEMA_PATH = 'rag-sidecar/schemas/VendorDataFlow.schema.json';
const PREFIX = '[gen-vendor-doc]';

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node?.[key], root);
}

function typeOk(type, value) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  throw new Error(`unsupported type ${type}`);
}

/** A structural check for the JSON Schema subset the exported VendorDataFlow schema uses. */
export function validateSchema(schema, value, root = schema, at = '$') {
  if (schema.$ref) return validateSchema(resolveRef(root, schema.$ref), value, root, at);
  if (schema.anyOf) {
    return schema.anyOf.some((option) => validateSchema(option, value, root, at).length === 0) ? [] : [`${at}: matches no allowed form`];
  }
  const errors = [];
  if (schema.type && !typeOk(schema.type, value)) return [`${at}: expected ${schema.type}`];
  if ('const' in schema && value !== schema.const) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(schema.items, item, root, `${at}[${i}]`)));
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) errors.push(...validateSchema(properties[key], item, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown field ${key}`);
    }
  }
  return errors;
}

function repeats(list) {
  const seen = new Set();
  return list.filter((item) => (seen.has(item) ? true : (seen.add(item), false)));
}

/** The VendorEntry and VendorDataFlow model validators that a JSON Schema cannot express. */
export function validateSemantics(inventory) {
  const errors = [];
  const vendors = Array.isArray(inventory?.vendors) ? inventory.vendors : [];
  vendors.forEach((entry, i) => {
    const at = `$.vendors[${i}]`;
    for (const field of ['hosts', 'content', 'providers']) {
      if (Array.isArray(entry[field]) && repeats(entry[field]).length > 0) errors.push(`${at}.${field}: repeated ${repeats(entry[field]).join(', ')}`);
    }
    if (entry.multi_tenant === 'requires_ack' && !entry.ack_switch) errors.push(`${at}: multi_tenant requires_ack names its ack_switch`);
    if (entry.multi_tenant !== 'requires_ack' && entry.ack_switch !== undefined) errors.push(`${at}: ack_switch belongs to multi_tenant requires_ack only`);
  });
  const ids = repeats(vendors.map((entry) => entry.vendor));
  if (ids.length > 0) errors.push(`$.vendors: repeated vendor ${ids.join(', ')}`);
  return errors;
}

export function validateInventory(inventory, schema) {
  const structural = validateSchema(schema, inventory);
  return structural.length > 0 ? structural : validateSemantics(inventory);
}

const code = (text) => `\`${text}\``;
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function multiTenantCell(entry) {
  if (entry.multi_tenant === 'requires_ack') return `requires ${code(entry.ack_switch)}=true`;
  return entry.multi_tenant;
}

/** Deterministic Markdown: one row per vendor and host, sorted by vendor id. */
export function renderDoc(inventory) {
  const vendors = [...inventory.vendors].sort((a, b) => (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0));
  const lines = [
    '# Vendor data flow',
    '',
    `<!-- Generated from ${INVENTORY_PATH} by scripts/rag/gen-vendor-doc.mjs. Do not edit; run \`node scripts/rag/gen-vendor-doc.mjs\`. -->`,
    '',
    `Generated from ${INVENTORY_PATH} (ADM-04, D-20). Each row is one external host and the content that can reach it. Content kinds: query, chunk_text, answer, vectors, lexical_text (tokenised text, readable), file_bytes, traces. Vectors are listed as content because embeddings are partly invertible. A switch of "-" means the vendor has no single enabling variable (see the vendor name). Retention and training read to_verify until the live check confirms the vendor terms.`,
    '',
    '| Vendor | Name | Host | Content | Switch | Opt-in | Multi-tenant | Retention | Training |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of vendors) {
    for (const host of entry.hosts) {
      lines.push(
        `| ${[
          code(entry.vendor),
          cell(entry.name),
          code(host),
          entry.content.map(code).join(', '),
          entry.switch ? code(entry.switch) : '-',
          entry.opt_in ? 'yes' : 'no',
          multiTenantCell(entry),
          cell(entry.retention),
          cell(entry.training),
        ].join(' | ')} |`,
      );
    }
  }
  lines.push('', '## Manifest providers', '');
  for (const entry of vendors) {
    const providers = entry.providers ?? [];
    lines.push(`- ${code(entry.vendor)}: ${providers.length > 0 ? providers.map(code).join(', ') : 'none (no managed url or secret variable)'}`);
  }
  const open = vendors
    .map((entry) => [entry.vendor, ['retention', 'training'].filter((field) => entry[field] === 'to_verify')])
    .filter(([, fields]) => fields.length > 0);
  lines.push('', '## Open items', '');
  if (open.length === 0) lines.push('None.');
  else {
    lines.push('Fields still marked to_verify (operator action: confirm against the vendor terms during the live check):', '');
    for (const [vendor, fields] of open) lines.push(`- ${code(vendor)}: ${fields.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { check: false, inventory: path.join(ROOT, INVENTORY_PATH), out: path.join(ROOT, DOC_PATH), schema: path.join(ROOT, SCHEMA_PATH) };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--inventory') args.inventory = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--schema') args.schema = path.resolve(argv[++i] ?? '');
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${PREFIX} ${error.message}`);
    return 2;
  }
  let inventory;
  let schema;
  try {
    inventory = JSON.parse(fs.readFileSync(args.inventory, 'utf8'));
    schema = JSON.parse(fs.readFileSync(args.schema, 'utf8'));
  } catch (error) {
    console.error(`${PREFIX} invalid inventory: cannot read ${error.path ?? 'input'} (${error.message})`);
    return 2;
  }
  const errors = validateInventory(inventory, schema);
  if (errors.length > 0) {
    for (const error of errors) console.error(`${PREFIX} invalid inventory: ${error}`);
    return 2;
  }
  const rendered = renderDoc(inventory);
  if (args.check) {
    const current = fs.existsSync(args.out) ? fs.readFileSync(args.out, 'utf8') : null;
    if (current !== rendered) {
      console.error(`${PREFIX} ${path.relative(ROOT, args.out) || args.out} is out of date; run \`node scripts/rag/gen-vendor-doc.mjs\``);
      return 1;
    }
    console.log(`${PREFIX} ok: ${inventory.vendors.length} vendor(s), document up to date`);
    return 0;
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, rendered);
  console.log(`${PREFIX} wrote ${path.relative(ROOT, args.out) || args.out} (${inventory.vendors.length} vendor(s))`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
