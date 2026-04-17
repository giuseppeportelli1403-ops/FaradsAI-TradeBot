// Capital.com Epic Discovery Script
//
// One-shot utility. Giuseppe runs this AFTER adding valid Capital.com
// credentials to `.env`. It:
//   1. Iterates over the 20 instruments in `src/scanner/INSTRUMENT_UNIVERSE`
//   2. Calls Capital's /markets?searchTerm=<name> for each
//   3. Prints a markdown table of (internal name → discovered epic)
//   4. Writes the mapping to `scripts/epic-mapping.json`
//
// Does NOT modify source files. Giuseppe reviews the output and pastes the
// confirmed epics into `src/scanner/index.ts` manually (or a follow-up
// codemod can auto-patch it later).
//
// Usage:
//   npx tsx scripts/discover-epics.ts

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { CapitalClient } from '../src/mcp-server/capital-client.js';
import { INSTRUMENT_UNIVERSE } from '../src/scanner/index.js';

interface DiscoveryRow {
  name: string;
  currentTicker: string;
  searchTerm: string;
  topEpic: string | null;
  topInstrumentName: string | null;
  candidates: Array<{ epic: string; instrumentName: string; type: string }>;
}

async function main(): Promise<void> {
  const apiKey = process.env.CAPITAL_API_KEY ?? '';
  const identifier = process.env.CAPITAL_IDENTIFIER ?? '';
  const password = process.env.CAPITAL_PASSWORD ?? '';
  const baseURL =
    process.env.CAPITAL_API_URL ?? 'https://demo-api-capital.backend-capital.com';

  if (!apiKey || !identifier || !password) {
    console.error(
      'Missing Capital.com credentials. Set CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_PASSWORD.'
    );
    process.exit(1);
  }

  const capital = new CapitalClient({ apiKey, identifier, password, baseURL });

  const rows: DiscoveryRow[] = [];

  for (const inst of INSTRUMENT_UNIVERSE) {
    // Prefer searching by human-readable name (more reliable than ticker).
    const searchTerm = inst.name;
    try {
      const markets = await capital.searchMarkets(searchTerm);
      const top = markets[0] ?? null;
      rows.push({
        name: inst.name,
        currentTicker: inst.ticker,
        searchTerm,
        topEpic: top ? top.epic : null,
        topInstrumentName: top ? top.instrumentName : null,
        candidates: markets.slice(0, 5).map((m) => ({
          epic: m.epic,
          instrumentName: m.instrumentName,
          type: m.instrumentType,
        })),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[discover-epics] FAILED for "${inst.name}": ${msg}`);
      rows.push({
        name: inst.name,
        currentTicker: inst.ticker,
        searchTerm,
        topEpic: null,
        topInstrumentName: null,
        candidates: [],
      });
    }
  }

  // --- Print markdown table ---
  console.log('\n## Capital.com Epic Discovery\n');
  console.log('| Internal Name | Current Ticker | Top Epic | Instrument Name | Candidates |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    const alts = r.candidates
      .map((c) => `\`${c.epic}\` (${c.type})`)
      .join(', ');
    console.log(
      `| ${r.name} | \`${r.currentTicker}\` | ${r.topEpic ? `\`${r.topEpic}\`` : 'NOT FOUND'} | ${r.topInstrumentName ?? '-'} | ${alts || '-'} |`
    );
  }

  // --- Write JSON mapping ---
  const jsonPath = resolve(process.cwd(), 'scripts', 'epic-mapping.json');
  const mapping = rows.reduce<Record<string, string | null>>((acc, r) => {
    acc[r.currentTicker] = r.topEpic;
    return acc;
  }, {});
  await writeFile(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), mapping, rows }, null, 2),
    'utf8'
  );
  console.log(`\nWrote ${jsonPath}`);

  await capital.logout();
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[discover-epics] fatal: ${msg}`);
  process.exit(1);
});
