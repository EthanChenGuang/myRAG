import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { armTieStats, shinglesOf, type TieHit } from '../eval/harness/lexical-stats.mts';

/** quick-44 (Phase 4.4 G1): the report-only tie summary of one ranked lexical list. Neutral synthetic text only. */
function hit(document: string, score: number, text: string): TieHit {
  return { document_id: document, score, shingles: shinglesOf(text) };
}

const SAME = 'the amber valve opens after the third bell of the morning shift';
const OTHER = 'a quiet lantern rests beside the copper gate near the river path';

describe('armTieStats', () => {
  test('equal scores on near-duplicate chunks form one duplicate tie group', () => {
    const stats = armTieStats([hit('d1', 3, SAME), hit('d2', 3, SAME), hit('d3', 1, OTHER)]);
    assert.equal(stats.tie_groups, 1);
    assert.equal(stats.tied_hits, 2);
    assert.equal(stats.duplicate_tie_groups, 1);
    assert.equal(stats.duplicate_pairs, 1);
    assert.equal(stats.distinct_documents, 3);
    assert.equal(stats.mean_duplicate_gap, 0);
    assert.equal(stats.tie_at_cut_5, false);
  });

  test('a tie of different texts is not a duplicate tie', () => {
    const stats = armTieStats([hit('d1', 2, SAME), hit('d2', 2, OTHER)]);
    assert.equal(stats.tie_groups, 1);
    assert.equal(stats.duplicate_tie_groups, 0);
    assert.equal(stats.duplicate_pairs, 0);
    assert.equal(stats.mean_duplicate_gap, null);
  });

  test('a tie group spanning ranks 5 and 6 crosses the rank-5 cut', () => {
    const scores = [9, 8, 7, 6, 5, 5, 4];
    const stats = armTieStats(scores.map((score, index) => hit(`d${index}`, score, `${OTHER} ${index}`)));
    assert.equal(stats.tie_at_cut_5, true);
    assert.equal(stats.tie_at_cut_10, false);
  });

  test('distinct scores give no tie and a relative gap between adjacent duplicates', () => {
    const stats = armTieStats([hit('d1', 4, SAME), hit('d2', 2, SAME)]);
    assert.equal(stats.tie_groups, 0);
    assert.equal(stats.mean_duplicate_gap, 0.5);
  });
});
