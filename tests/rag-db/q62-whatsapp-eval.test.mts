import '../helpers/next-async-storage.mts';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRunConfig } from '../../eval/harness/run-config.mts';
import {
  openWhatsAppEntry,
  readMultiTurnItems,
  writeWhatsAppReport,
  type WhatsAppEntryReport,
  type WhatsAppEntrySession,
} from '../../eval/harness/whatsapp-entry.mts';

/**
 * D-24, D-31 (g), P-34: the fixture multi_turn items through the WhatsApp entry point (handler, fake client, chat route in process).
 * Switch on: every item sends history, every item the gate routes to condense is condensed and retrieves its gold document, in zh, en
 * and it; the report is deterministic. Switch off: no item sends history or is condensed. Placeholder JIDs only.
 */
const RUN_CONFIG = path.resolve('eval/config/runs/q62-whatsapp-multi-turn.json');
const LANGUAGES = ['en', 'it', 'zh'];

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
let session: WhatsAppEntrySession | undefined;
let on: WhatsAppEntryReport;
let again: WhatsAppEntryReport;
let off: WhatsAppEntryReport;

before(async () => {
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  const runConfig = loadRunConfig(RUN_CONFIG);
  assert.equal(runConfig.env.RAG_WHATSAPP_HISTORY, 'true');
  session = await openWhatsAppEntry({ runConfig });
  on = await session.run({ name: runConfig.name, history: true });
  again = await session.run({ name: runConfig.name, history: true });
  off = await session.run({ name: `${runConfig.name}-off`, history: false });
});

after(async () => {
  await session?.close();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

describe('WhatsApp entry point over the fixture multi_turn items', () => {
  test('switch on: every item is replayed with history, in all three languages', () => {
    const expected = readMultiTurnItems();
    assert.ok(expected.length >= 9);
    assert.equal(on.items.length, expected.length);
    assert.deepEqual(Object.keys(on.by_language), LANGUAGES);
    assert.ok(on.items.every((item) => item.history_sent), 'every final request carries the stored turns');
  });

  test('switch on: each item the gate routes to condense is condensed and retrieves its gold document', () => {
    for (const language of LANGUAGES) {
      const counts = on.by_language[language];
      assert.ok(counts, `${language} is reported`);
      assert.ok(counts.condense_eligible > 0, `${language} has eligible items`);
      assert.equal(counts.eligible_passed, counts.condense_eligible, `${language}: ${JSON.stringify(counts)}`);
    }
    const failed = on.items.filter((item) => item.condense_eligible && !(item.condensed && item.gold_retrieved));
    assert.deepEqual(failed, []);
    assert.equal(on.passed, true);
  });

  test('the report is deterministic across two runs', () => {
    assert.deepEqual(again, on);
  });

  test('switch off: the same items run without history and nothing is condensed', () => {
    assert.equal(off.whatsapp_history, false);
    assert.equal(off.items.length, on.items.length);
    assert.ok(off.items.every((item) => !item.history_sent && !item.condensed && !item.condense_eligible));
    assert.equal(off.passed, false);
  });

  test('the report file is JSON with counts per language and carries no JID', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q62-whatsapp-'));
    try {
      const file = writeWhatsAppReport(on, dir);
      assert.equal(path.basename(file), 'whatsapp-report.json');
      const text = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text) as WhatsAppEntryReport;
      assert.equal(parsed.schema_version, 1);
      assert.equal(parsed.entry_point, 'whatsapp');
      assert.equal(parsed.totals.items, on.items.length);
      assert.doesNotMatch(text, /@(s\.whatsapp\.net|g\.us|lid|c\.us)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
