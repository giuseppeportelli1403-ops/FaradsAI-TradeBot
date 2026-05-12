// Integration tests for src/rejection-log/digest.ts. Asserts the
// recordRejection -> insertRejection -> getDailyRejections -> buildDailyDigest
// roundtrip works end-to-end against an in-memory sql.js DB.
//
// SC-002: 100% of rejections fall into a named category, no OTHER bucket.
// SC-003: fail-closed REJECTs distinguishable from cause-REJECTs.

import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';

// Hot-swap the shared db reference in src/database/index.ts via the same
// initDatabaseAsync() path so the production helpers (insertRejection,
// updateAnalystLogCategory, etc.) write to a fresh in-memory DB per test.
import {
  initDatabaseAsync,
  insertRejection,
  updateAnalystLogCategory,
  getDb,
} from '../../src/database/index.js';
import { recordRejection } from '../../src/rejection-log/record.js';
import { buildDailyDigest, formatDigestForTelegram } from '../../src/rejection-log/digest.js';

// Helper: fresh DB with Migration 007 already applied. The
// initDatabaseAsync() path reuses the SQL.js WASM instance so this is
// cheap to call between tests.
async function freshDb(): Promise<void> {
  // Force a fresh memory DB by deleting the on-disk file before init.
  // initDatabaseAsync reads from DB_PATH if it exists; we can't easily
  // override that, so we operate on the live db and reset between tests
  // by truncating the relevant tables.
  await initDatabaseAsync();
  const db = getDb();
  db.run('DELETE FROM trade_rejections');
  db.run('DELETE FROM analyst_log');
}

const TODAY = new Date().toISOString().slice(0, 10);

describe('rejection-log roundtrip — buildDailyDigest', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('buildDailyDigest returns total_rejections=0 on a clean DB', () => {
    const payload = buildDailyDigest(TODAY);
    expect(payload.total_rejections).toBe(0);
    expect(payload.fail_closed_total).toBe(0);
    expect(payload.has_other).toBe(false);
    expect(Object.keys(payload.by_category)).toHaveLength(0);
  });

  it('captures a single scanner-layer KILL_ZONE_OUT rejection', () => {
    recordRejection({
      instrument: 'EURUSD',
      layer: 'scanner',
      category: 'KILL_ZONE_OUT',
      reason_text: 'Outside kill zones',
    });
    const payload = buildDailyDigest(TODAY);
    expect(payload.total_rejections).toBe(1);
    expect(payload.by_category['KILL_ZONE_OUT']).toBe(1);
    expect(payload.fail_closed_total).toBe(0);
    expect(payload.has_other).toBe(false);
  });

  it('counts 12 rejections across 5 categories with no OTHER (SC-002)', () => {
    // Mirror the spec.md US-2 acceptance scenario 3.
    const fixtures: Array<{ category: string; n: number }> = [
      { category: 'KILL_ZONE_OUT', n: 5 },
      { category: 'EXECUTOR_REJECT_SCORE_BELOW_TIER_MIN', n: 3 },
      { category: 'POST_APPROVAL_HASH_MISMATCH', n: 2 },
      { category: 'POST_APPROVAL_TTL_EXPIRED', n: 1 },
      { category: 'EXECUTOR_REJECT_RR_FLOOR', n: 1 },
    ];
    const layerOf = (cat: string): 'scanner' | 'executor' | 'post_approval' => {
      if (cat.startsWith('KILL_ZONE') || cat.startsWith('SCANNER')) return 'scanner';
      if (cat.startsWith('POST_APPROVAL')) return 'post_approval';
      return 'executor';
    };
    for (const { category, n } of fixtures) {
      for (let i = 0; i < n; i++) {
        insertRejection({
          instrument: `INST${i}`,
          layer: layerOf(category),
          category,
          reason_text: `forced ${category} #${i}`,
        });
      }
    }
    const payload = buildDailyDigest(TODAY);
    expect(payload.total_rejections).toBe(12);
    expect(Object.keys(payload.by_category)).toHaveLength(5);
    expect(payload.has_other).toBe(false);
    // Sum of by_category counts equals total
    const sum = Object.values(payload.by_category).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBe(12);
  });

  it('distinguishes fail-closed REJECTs from cause-REJECTs (SC-003)', () => {
    // Plant 1 cause-REJECT and 1 fail-closed REJECT in analyst_log via
    // the standard logAnalystDecision-then-recordRejection flow.
    const db = getDb();
    db.run(
      'INSERT INTO analyst_log (trade_id, strategy_tag, decision, reason, modifications, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))',
      ['trade-cause-1', 'ICT_INTRADAY', 'REJECT', 'Banned setup pattern detected', '{}', 0.8],
    );
    const causeId = db.exec('SELECT last_insert_rowid()')[0]!.values[0]![0] as number;
    updateAnalystLogCategory(causeId, 'ANALYST_REJECT_BANNED_PATTERN', false, null);

    db.run(
      'INSERT INTO analyst_log (trade_id, strategy_tag, decision, reason, modifications, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))',
      ['trade-failed-1', 'ICT_INTRADAY', 'REJECT', 'Analyst API failure: ECONNRESET', '{}', 0],
    );
    const failId = db.exec('SELECT last_insert_rowid()')[0]!.values[0]![0] as number;
    updateAnalystLogCategory(failId, 'ANALYST_FAIL_CLOSED_API_ERROR', true, 'AxiosError');

    const payload = buildDailyDigest(TODAY);
    expect(payload.total_rejections).toBe(2);
    expect(payload.fail_closed_total).toBe(1);
    expect(payload.by_category['ANALYST_REJECT_BANNED_PATTERN']).toBe(1);
    expect(payload.by_category['ANALYST_FAIL_CLOSED_API_ERROR']).toBe(1);
  });
});

describe('formatDigestForTelegram', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('produces a non-empty markdown body for a populated payload', () => {
    insertRejection({
      instrument: 'EURUSD',
      layer: 'scanner',
      category: 'KILL_ZONE_OUT',
      reason_text: 'test',
    });
    const payload = buildDailyDigest(TODAY);
    const body = formatDigestForTelegram(payload);
    expect(body).toContain('Rejection Digest');
    expect(body).toContain(TODAY);
    expect(body).toContain('KILL_ZONE_OUT');
    expect(body).toContain('Total: 1');
    expect(body).not.toContain('OTHER');
  });

  it('appends an SC-002 violation warning when OTHER is present', async () => {
    // Force-inject an OTHER row at the SQL layer (recordRejection's
    // type checking would normally prevent this).
    const db = getDb();
    db.run(
      'INSERT INTO trade_rejections (instrument, layer, category, reason_text) VALUES (?, ?, ?, ?)',
      ['EURUSD', 'executor', 'OTHER', 'forced for test'],
    );
    const payload = buildDailyDigest(TODAY);
    expect(payload.has_other).toBe(true);
    const body = formatDigestForTelegram(payload);
    expect(body).toContain('SC-002 violation');
  });
});
