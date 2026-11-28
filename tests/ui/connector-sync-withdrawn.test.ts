import { describe, expect, it } from 'vitest';
import { syncCountParts } from '@/components/ui/nango/connector-grid';
import { en } from '@/translations/en';
import { zh } from '@/translations/zh';

const base = { processed: 0, failed: 0, skipped: 0, deleted: 0, failClosed: 0 };

describe('syncCountParts (06.3-21 SyncStats.withdrawn)', () => {
  it('lists the withdrawn count after skipped, only when above zero', () => {
    expect(syncCountParts({ ...base, processed: 2, skipped: 1, withdrawn: 3 }).map((p) => [p.key, p.count])).toEqual([
      ['processed', 2],
      ['skipped', 1],
      ['withdrawn', 3],
    ]);
    expect(syncCountParts({ ...base, withdrawn: 0 })).toEqual([]);
    expect(syncCountParts({ ...base })).toEqual([]);
    expect(syncCountParts({ ...base, withdrawn: Number.NaN })).toEqual([]);
  });

  it('labels the withdrawn count in en and zh without purge vocabulary', () => {
    const part = syncCountParts({ ...base, withdrawn: 1 })[0]!;
    expect(part.labelKey).toBe('connectorSyncWithdrawnLabel');
    expect(en.connectorSyncWithdrawnLabel).toBe('{count} withdrawn, not synced again');
    expect(zh.connectorSyncWithdrawnLabel).toBe('{count} 已撤回，不再同步');
    expect(en.connectorSyncWithdrawnLabel.toLowerCase()).not.toContain('purge');
  });
});
