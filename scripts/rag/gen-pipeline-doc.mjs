#!/usr/bin/env node
// D-19: renders the provider and switch tables of README_RAG_PIPELINE.md from scripts/rag/env-manifest.json.
// Only the text between the generated markers is written. Exit codes: 0 written or up to date, 1 out of date (--check), 2 bad input.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { RAG_PIPELINE_GROUP_ORDER, RAG_PIPELINE_LABELS, RAG_PIPELINE_PROVIDER_NAMES } = require('../config-ui/rag-panels/rag-pipeline.js');

export const MANIFEST_PATH = 'scripts/rag/env-manifest.json';
export const DOC_PATH = 'README_RAG_PIPELINE.md';
export const START_MARKER = '<!-- generated:switches:start -->';
export const END_MARKER = '<!-- generated:switches:end -->';
const PREFIX = '[gen-pipeline-doc]';

/** Group order and English titles, shared with the Config UI RAG pipeline section (07-20). */
export const GROUP_ORDER = [...RAG_PIPELINE_GROUP_ORDER];

export function groupLabel(id) {
  return RAG_PIPELINE_LABELS.en[`group.${id}.title`] ?? id;
}

export function providerName(id) {
  return RAG_PIPELINE_PROVIDER_NAMES[id] ?? id;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const code = (text) => `\`${String(text).replace(/`/g, "'")}\``;
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function managedEntries(manifest) {
  return (manifest?.vars ?? []).filter((entry) => entry.status === 'managed');
}

function defaultCell(entry) {
  if (entry.type === 'secret') return '(secret)';
  const value = entry.default ?? '';
  return value === '' ? '(empty)' : code(value);
}

/** Known groups in the Config UI order, then any unknown group id in name order. */
export function orderedGroups(manifest) {
  const ids = new Set(managedEntries(manifest).map((entry) => entry.group ?? 'other'));
  const known = GROUP_ORDER.filter((id) => ids.has(id));
  const unknown = [...ids].filter((id) => !GROUP_ORDER.includes(id)).sort();
  return known.concat(unknown);
}

/** Deterministic Markdown: the provider table, then one switch table per group, rows sorted by name. */
export function renderSwitchTables(manifest) {
  const entries = managedEntries(manifest);
  const lines = [
    `<!-- Generated from ${MANIFEST_PATH} by scripts/rag/gen-pipeline-doc.mjs. Do not edit by hand; run \`node scripts/rag/gen-pipeline-doc.mjs\`. -->`,
    '',
    '### Providers',
    '',
    '| Provider | Name | Variables |',
    '| --- | --- | --- |',
  ];
  const providers = new Map();
  for (const entry of entries) {
    if (!entry.provider) continue;
    if (!providers.has(entry.provider)) providers.set(entry.provider, []);
    providers.get(entry.provider).push(entry);
  }
  for (const id of [...providers.keys()].sort()) {
    const names = providers.get(id).sort(byName).map((entry) => code(entry.name)).join(', ');
    lines.push(`| ${code(id)} | ${cell(providerName(id))} | ${names} |`);
  }
  for (const group of orderedGroups(manifest)) {
    const rows = entries.filter((entry) => (entry.group ?? 'other') === group).sort(byName);
    lines.push(
      '',
      `### ${groupLabel(group)} (${code(group)})`,
      '',
      '| Variable | Label | Type | Default | Options | Requires |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const entry of rows) {
      const options = Array.isArray(entry.options) && entry.options.length > 0 ? entry.options.map(code).join(', ') : '-';
      const requires = Array.isArray(entry.requires) && entry.requires.length > 0 ? entry.requires.map(code).join(', ') : '-';
      lines.push(`| ${[code(entry.name), cell(entry.label ?? entry.name), entry.type ?? '-', defaultCell(entry), options, requires].join(' | ')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The text strictly between the two markers, or null when either marker is missing. */
export function extractGenerated(doc) {
  const start = doc.indexOf(START_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end < start) return null;
  return doc.slice(start + START_MARKER.length + 1, end);
}

export function replaceGenerated(doc, rendered) {
  const start = doc.indexOf(START_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end < start) throw new Error(`${DOC_PATH} has no ${START_MARKER} ... ${END_MARKER} region`);
  return `${doc.slice(0, start + START_MARKER.length)}\n${rendered}${doc.slice(end)}`;
}

function parseArgs(argv) {
  const args = { check: false, manifest: path.join(ROOT, MANIFEST_PATH), doc: path.join(ROOT, DOC_PATH) };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--manifest') args.manifest = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--doc') args.doc = path.resolve(argv[++i] ?? '');
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  let manifest;
  let doc;
  try {
    args = parseArgs(argv);
    manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    doc = fs.readFileSync(args.doc, 'utf8');
  } catch (error) {
    console.error(`${PREFIX} ${error.message}`);
    return 2;
  }
  const rendered = renderSwitchTables(manifest);
  const current = extractGenerated(doc);
  if (current === null) {
    console.error(`${PREFIX} ${path.relative(ROOT, args.doc) || args.doc} has no generated region`);
    return 2;
  }
  if (args.check) {
    if (current !== rendered) {
      console.error(`${PREFIX} ${path.relative(ROOT, args.doc) || args.doc} is out of date; run \`node scripts/rag/gen-pipeline-doc.mjs\``);
      return 1;
    }
    console.log(`${PREFIX} ok: ${managedEntries(manifest).length} managed variable(s), tables up to date`);
    return 0;
  }
  fs.writeFileSync(args.doc, replaceGenerated(doc, rendered));
  console.log(`${PREFIX} wrote ${path.relative(ROOT, args.doc) || args.doc} (${managedEntries(manifest).length} managed variable(s))`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
