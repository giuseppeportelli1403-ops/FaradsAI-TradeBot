// Backtest Report Generator
// Outputs a formatted console summary + saves JSON results to disk.

import fs from 'fs';
import path from 'path';
import type { BacktestResult } from './engine.js';

export interface CombinedReport {
  generated_at: string;
  period: string;
  instruments: number;
  total_trades: number;
  overall_win_rate: number;
  overall_profit_factor: number;
  total_r_all_pairs: number;
  max_drawdown_r: number;
  avg_r_per_trade: number;
  per_instrument: BacktestResult[];
}

export function buildCombinedReport(
  results: BacktestResult[],
  startYear: number,
  endYear: number,
): CombinedReport {
  const totalTrades = results.reduce((s, r) => s + r.total_trades, 0);
  const totalWins = results.reduce((s, r) => s + r.wins, 0);
  const totalR = results.reduce((s, r) => s + r.total_r, 0);
  const grossProfit = results.reduce((s, r) => {
    return s + r.trades.filter((t) => t.pnl_r > 0).reduce((x, t) => x + t.pnl_r, 0);
  }, 0);
  const grossLoss = Math.abs(results.reduce((s, r) => {
    return s + r.trades.filter((t) => t.pnl_r < 0).reduce((x, t) => x + t.pnl_r, 0);
  }, 0));
  const maxDD = Math.max(...results.map((r) => r.max_drawdown_r));

  return {
    generated_at: new Date().toISOString(),
    period: `${startYear}–${endYear}`,
    instruments: results.length,
    total_trades: totalTrades,
    overall_win_rate: totalTrades > 0 ? Math.round((totalWins / totalTrades) * 1000) / 10 : 0,
    overall_profit_factor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : 0,
    total_r_all_pairs: Math.round(totalR * 100) / 100,
    max_drawdown_r: Math.round(maxDD * 100) / 100,
    avg_r_per_trade: totalTrades > 0 ? Math.round((totalR / totalTrades) * 100) / 100 : 0,
    per_instrument: results,
  };
}

export function printReport(report: CombinedReport): void {
  const sep = '─'.repeat(70);
  console.log('\n' + sep);
  console.log('  FARADBOT — BACKTEST REPORT');
  console.log(`  Period: ${report.period}  |  Generated: ${report.generated_at}`);
  console.log(sep);
  console.log(`  Instruments:        ${report.instruments}`);
  console.log(`  Total Trades:       ${report.total_trades}`);
  console.log(`  Win Rate:           ${report.overall_win_rate}%`);
  console.log(`  Profit Factor:      ${report.overall_profit_factor}`);
  console.log(`  Total R (all):      ${report.total_r_all_pairs}R`);
  console.log(`  Max Drawdown:       ${report.max_drawdown_r}R`);
  console.log(`  Avg R / Trade:      ${report.avg_r_per_trade}R`);
  console.log(sep);
  console.log('  PER-INSTRUMENT BREAKDOWN\n');

  const sorted = [...report.per_instrument].sort((a, b) => b.total_r - a.total_r);
  for (const r of sorted) {
    const bar = r.total_r >= 0 ? '▲' : '▼';
    console.log(
      `  ${bar} ${r.ticker.padEnd(10)} | ` +
      `${String(r.total_trades).padStart(4)} trades | ` +
      `WR ${String(r.win_rate).padStart(5)}% | ` +
      `PF ${String(r.profit_factor).padStart(5)} | ` +
      `Total ${r.total_r >= 0 ? '+' : ''}${r.total_r}R | ` +
      `MaxDD ${r.max_drawdown_r}R`,
    );
    for (const tb of r.tier_breakdown) {
      if (tb.count === 0) continue;
      const twr = tb.count > 0 ? Math.round((tb.wins / tb.count) * 1000) / 10 : 0;
      console.log(
        `           Tier ${tb.tier}: ${tb.count} trades | WR ${twr}% | ${tb.total_r >= 0 ? '+' : ''}${Math.round(tb.total_r * 100) / 100}R`,
      );
    }
  }
  console.log('\n' + sep);
}

export function saveReport(report: CombinedReport, outDir = 'backtest-results'): string {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filename = `backtest_${report.period.replace('–', '-')}_${Date.now()}.json`;
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Results saved to: ${outPath}`);
  return outPath;
}
