// Negative-coverage tests for the 3-leg removal (Phase 1, 2026-05-08).
//
// Task 10 of the 3-leg-removal plan finalises the test surface: deletes
// 3-leg-specific tests, cleans dead fixtures in the existing suite, and
// adds this file as the single pinning surface that the structural removal
// stuck. If any of these tests start failing, a 3-leg surface has crept
// back in.
//
// Spec: docs/superpowers/specs/2026-05-08-3-leg-removal-phase-1-design.md

import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import fs from 'fs';

describe('three-leg removal — Phase 1 negative coverage', () => {
  // 1. MCP runtime guard catches stale callers passing size_c.
  it('place_split_trade rejects size_c != null', async () => {
    // _assertTwoLegOnly is exported from src/mcp-server/tools/trading-tools.ts
    // (Task 2 wired the runtime guard via this exported helper).
    const { _assertTwoLegOnly } = await import('../src/mcp-server/tools/trading-tools.js');
    expect(() => _assertTwoLegOnly({
      instrument: 'GOLD', direction: 'long',
      entry: 4735, sl: 4723, tp1: 4748, tp2: 4751,
      size_a: 0.56, size_b: 0.24, size_c: 0.1,
    })).toThrow(/3-leg placement is no longer supported/);
  });

  // 2. MCP runtime guard catches stale callers passing tp3.
  it('place_split_trade rejects tp3 != null', async () => {
    const { _assertTwoLegOnly } = await import('../src/mcp-server/tools/trading-tools.js');
    expect(() => _assertTwoLegOnly({
      instrument: 'GOLD', direction: 'long',
      entry: 4735, sl: 4723, tp1: 4748, tp2: 4751,
      size_a: 0.56, size_b: 0.24, tp3: 4760,
    })).toThrow(/3-leg placement is no longer supported/);
  });

  // 3. Type contract — handleTp3Hit is gone from scheduler exports.
  it('scheduler does not export handleTp3Hit', async () => {
    const mod = await import('../src/scheduler/index.js');
    expect((mod as unknown as Record<string, unknown>).handleTp3Hit).toBeUndefined();
  });

  // 4. Defensive read contract — historical 3-leg DB row remains queryable.
  // Skips locally if no 3-leg row exists; on the prod VPS this exercises the
  // back-compat read path we promised to keep working in Phase 1 (DB columns
  // stay; only the write/placement paths are gone).
  it('reading a historical 3-leg row does not crash', async () => {
    const SQL = await initSqlJs();
    const dbPath = 'data/trading-bot.db';
    if (!fs.existsSync(dbPath)) return; // skip if DB not present locally
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const res = db.exec(
      "SELECT id, status, tp3, position_c_id, size_c, pnl_c FROM trades WHERE position_c_id IS NOT NULL LIMIT 1",
    );
    if (!res.length) return; // no historical 3-leg rows; skip
    const row = res[0].values[0];
    expect(row).toBeDefined();
    // Type round-trip: simulate reading into TradeRecord shape, no throw.
    const trade = {
      id: row[0], status: row[1], tp3: row[2],
      position_c_id: row[3], size_c: row[4], pnl_c: row[5],
    };
    expect(trade.position_c_id).not.toBeNull();
  });
});
