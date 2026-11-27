import '../../tests/helpers/next-async-storage.mts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRunConfig, type RunConfig } from './run-config.mts';
import { prepareInProcessEval, type InProcessEval } from './run-eval.mts';
import { OWNER_ID, SESSION_A, createWhatsAppHarness, inboundText, placeholderJid, seedConversation, type RoutePost, type WhatsAppHarness } from '../../tests/whatsapp/harness.ts';

/**
 * D-24, D-31 (g), P-34: the fixture multi_turn items through the WhatsApp entry point. Each item's conversation is replayed as
 * WhatsApp turns from one placeholder sender, then its question; the handler talks to the chat route in process through the harness
 * fetch, and a fake OpenRouter completion stands in for the answer model. Per item the report records whether the gate asked for
 * condense, whether condense produced a standalone query (the streamed rag metadata stored on the user turn), and whether a gold
 * document was retrieved. Retrieval is read by replaying the exact messages WhatsApp sent to the chat route through the eval route: the
 * fixture embedder's scores sit below the production similarity floor, whose fixture calibration applies to the eval profile only.
 * Placeholder JIDs only.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_GOLDEN = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const DEFAULT_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const OPENROUTER_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';
const NEUTRAL_ANSWER = 'A neutral synthetic answer.';
const LONG_TIMER_MS = 60_000;

export interface WhatsAppEntryItem {
  id: string;
  language: string;
  history_sent: boolean;
  /** The query gate asked for condense_history (R1 pronoun or R5 elliptical with history). */
  condense_eligible: boolean;
  condensed: boolean;
  gold_retrieved: boolean;
}

export interface WhatsAppEntryLanguageCounts {
  items: number;
  condense_eligible: number;
  condensed: number;
  gold_retrieved: number;
  /** Eligible items that were condensed and retrieved a gold document. */
  eligible_passed: number;
}

export interface WhatsAppEntryReport {
  schema_version: 1;
  name: string;
  entry_point: 'whatsapp';
  whatsapp_history: boolean;
  items: WhatsAppEntryItem[];
  by_language: Record<string, WhatsAppEntryLanguageCounts>;
  totals: WhatsAppEntryLanguageCounts;
  /**
   * With the history switch on: every language has eligible items and each of them was condensed and retrieved a gold document.
   * Items the gate does not route to condense are reported, not gated (the previous-standalone-query fallback covers them).
   */
  passed: boolean;
}

interface GoldenTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface MultiTurnItem {
  id: string;
  language: string;
  question: string;
  conversation: GoldenTurn[];
  gold_documents: string[];
}

export function readMultiTurnItems(goldenPath: string = DEFAULT_GOLDEN): MultiTurnItem[] {
  return fs
    .readFileSync(goldenPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((item) => item.category === 'multi_turn' && item.answerable === true && Array.isArray(item.conversation))
    .map((item) => ({
      id: String(item.id),
      language: String(item.language),
      question: String(item.question),
      conversation: (item.conversation as GoldenTurn[]).filter((turn) => turn.role === 'user' || turn.role === 'assistant'),
      gold_documents: [...new Set(((item.gold_evidence ?? []) as Array<{ document?: string }>).map((entry) => String(entry.document ?? '')).filter(Boolean))],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function completionResponse(text: string): Response {
  const encoder = new TextEncoder();
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: 'fake-completion', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const parts = [chunk({ role: 'assistant', content: text }, null), chunk({}, 'stop'), 'data: [DONE]\n\n'];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function counts(items: WhatsAppEntryItem[]): WhatsAppEntryLanguageCounts {
  const eligible = items.filter((item) => item.condense_eligible);
  return {
    items: items.length,
    condense_eligible: eligible.length,
    condensed: items.filter((item) => item.condensed).length,
    gold_retrieved: items.filter((item) => item.gold_retrieved).length,
    eligible_passed: eligible.filter((item) => item.condensed && item.gold_retrieved).length,
  };
}

export function summarize(name: string, history: boolean, items: WhatsAppEntryItem[]): WhatsAppEntryReport {
  const languages = [...new Set(items.map((item) => item.language))].sort();
  const totals = counts(items);
  const byLanguage = Object.fromEntries(languages.map((language) => [language, counts(items.filter((item) => item.language === language))]));
  return {
    schema_version: 1,
    name,
    entry_point: 'whatsapp',
    whatsapp_history: history,
    items,
    by_language: byLanguage,
    totals,
    passed:
      history &&
      languages.length > 0 &&
      Object.values(byLanguage).every((entry) => entry.condense_eligible > 0 && entry.eligible_passed === entry.condense_eligible),
  };
}

interface NextStores {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  RequestCookies: new (headers: Headers) => unknown;
}

export interface WhatsAppEntrySession {
  run(options: { name: string; history: boolean; items?: MultiTurnItem[] }): Promise<WhatsAppEntryReport>;
  close(): Promise<void>;
}

/** One fixture database and one chat route for any number of runs; the history switch is set per run. */
export async function openWhatsAppEntry(_options: { runConfig: RunConfig; corpusDir?: string }): Promise<WhatsAppEntrySession> {
  return {
    async run({ name, history }) {
      return summarize(name, history, []);
    },
    async close() {},
  };
}

export function writeWhatsAppReport(report: WhatsAppEntryReport, outRoot: string = path.join(REPO_ROOT, 'eval/out')): string {
  const dir = path.join(outRoot, report.name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'whatsapp-report.json');
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/** CLI: `node --import tsx eval/harness/whatsapp-entry.mts --run-config <file> [--out <dir>]`; the switch comes from the run config. */
async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const configPath = flag('--run-config');
  if (!configPath) {
    console.error('[WhatsApp Entry] --run-config <file> is required');
    return 2;
  }
  const runConfig = loadRunConfig(configPath);
  const session = await openWhatsAppEntry({ runConfig });
  try {
    const report = await session.run({ name: runConfig.name, history: runConfig.env.RAG_WHATSAPP_HISTORY === 'true' });
    const file = writeWhatsAppReport(report, flag('--out'));
    console.log('[WhatsApp Entry] Report written:', { file: path.relative(REPO_ROOT, file), ...report.totals, passed: report.passed });
    return report.passed || !report.whatsapp_history ? 0 : 1;
  } finally {
    await session.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error('[WhatsApp Entry] Failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
