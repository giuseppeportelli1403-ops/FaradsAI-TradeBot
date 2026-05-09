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

  // 4. Schema contract (Phase 2, 2026-05-09) — trades table no longer has
  // 3-leg columns. Pins the migration outcome: a successful Phase 2 deploy
  // drops these columns and they stay dropped.
  it('trades schema does not have 3-leg columns (Phase 2 dropped them)', async () => {
    const SQL = await initSqlJs();
    const dbPath = 'data/trading-bot.db';
    if (!fs.existsSync(dbPath)) return; // skip if DB not present locally
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const cols = db.exec('PRAGMA table_info(trades)')[0]?.values.map((r) => String(r[1])) ?? [];
    expect(cols).not.toContain('tp3');
    expect(cols).not.toContain('position_c_id');
    expect(cols).not.toContain('size_c');
    expect(cols).not.toContain('pnl_c');
  });

  // 5. Sibling: lessons table no longer has C-outcome columns.
  it('lessons schema does not have C-outcome columns (Phase 2 dropped them)', async () => {
    const SQL = await initSqlJs();
    const dbPath = 'data/trading-bot.db';
    if (!fs.existsSync(dbPath)) return;
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const cols = db.exec('PRAGMA table_info(lessons)')[0]?.values.map((r) => String(r[1])) ?? [];
    expect(cols).not.toContain('position_c_outcome');
    expect(cols).not.toContain('pnl_c_r');
  });
});
