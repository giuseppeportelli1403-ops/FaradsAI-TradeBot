// Market Researcher Agent — Battlefield Preparation
// Runs daily at 05:30 UTC + Sunday 22:00 UTC
// Produces research briefs consumed by the ICT Trading Agent
//
// Answers three questions:
//   1. What is the regime? (risk-on, risk-off, mixed)
//   2. What are today's/this week's themes?
//   3. Which instruments are in play?

import Anthropic from '@anthropic-ai/sdk';
import { loadPromptWithSystemTime } from './load-prompt.js';
import { extractText, withTimeout } from './llm-output.js';
import { fetchYieldCurve, fetchEconomicCalendar, fetchSectorStrength } from '../mcp-server/market-data.js';
import { getRankedInstruments, INSTRUMENT_UNIVERSE } from '../scanner/index.js';
import { saveResearchBrief } from '../database/index.js';
import type { ResearchBrief, RegimeData, EconomicEvent, SectorStrength } from '../types.js';

const anthropic = new Anthropic();

// 2026-04-29 audit fix (P0-R3): regime classification.
// Pre-fix RegimeData only contained yields; the prompt promised a risk-on /
// risk-off / mixed classification but the code never produced one. Compute
// it deterministically from yield-curve shape + sector dispersion.
function classifyRegime(
  yields: { us2y: number; us10y: number; us30y: number },
  sectors: SectorStrength[],
): 'risk-on' | 'risk-off' | 'mixed' | 'unknown' {
  // Yield-curve signal: 2y/10y inversion is a classic late-cycle / risk-off
  // proxy (negative spread = inverted = recession warning).
  // 10y > 2y by 50+bps = healthy steepener (risk-on bias).
  if (!Number.isFinite(yields.us10y) || !Number.isFinite(yields.us2y) || yields.us10y === 0) {
    return 'unknown';
  }
  const spread = yields.us10y - yields.us2y;
  const yieldSignal: 'risk-on' | 'risk-off' | 'neutral' =
    spread > 0.5 ? 'risk-on' : spread < 0 ? 'risk-off' : 'neutral';

  // Sector signal: tech/financials/energy outperforming defensives = risk-on.
  // Defensives outperforming = risk-off.
  if (sectors.length === 0) {
    return yieldSignal === 'neutral' ? 'mixed' : yieldSignal;
  }
  const cyclical = sectors.find((s) => s.sector === 'Technology');
  const defensive = sectors.find((s) => s.sector === 'Consumer Defensive');
  const sectorSignal: 'risk-on' | 'risk-off' | 'neutral' =
    cyclical && defensive
      ? cyclical.performance_1d > defensive.performance_1d + 0.5
        ? 'risk-on'
        : defensive.performance_1d > cyclical.performance_1d + 0.5
          ? 'risk-off'
          : 'neutral'
      : 'neutral';

  if (yieldSignal === sectorSignal && yieldSignal !== 'neutral') return yieldSignal;
  if (yieldSignal === 'neutral' && sectorSignal !== 'neutral') return sectorSignal;
  if (sectorSignal === 'neutral' && yieldSignal !== 'neutral') return yieldSignal;
  return 'mixed';
}

// ==================== THEME EXTRACTION ====================

async function extractThemes(
  regime: RegimeData,
  calendar: EconomicEvent[],
  sectors: SectorStrength[],
): Promise<string[]> {
  const highImpactEvents = calendar.filter((e) => e.impact === 'high');
  const topSectors = sectors.slice(0, 3).map((s) => s.sector);
  const bottomSectors = sectors.slice(-3).map((s) => s.sector);

  // 2026-04-29 audit fix (P0-R1): use the FULL researcher-agent.md prompt,
  // not a 1-sentence inline stub. Pre-fix the prompt file was loaded into
  // a `_systemPrompt` variable that was never sent to Anthropic.
  const systemPrompt = loadPromptWithSystemTime('researcher-agent.md');

  // Model: Haiku 4.5 — Researcher is a structured-template task. Mixed-
  // model assignment: support roles → Haiku, decision roles → Sonnet.
  // 2026-04-29: 30s timeout (Codex AN6 — same SDK class as Analyst).
  const timeoutMs = 30_000;
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        // 2026-04-29: thinking + output_config removed for Haiku 4.5
        // compatibility (Sonnet-only API params). This was silently
        // failing on every Researcher cron since the bot moved to
        // Haiku — explains the "122h-old research brief" warning.
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `Today's market data:

REGIME:
- US 10Y yield: ${regime.yields.us10y}%
- US 2Y yield: ${regime.yields.us2y}%
- 2y/10y spread: ${Math.round((regime.yields.us10y - regime.yields.us2y) * 100) / 100}bps

SECTOR ROTATION (1d %):
- Top performers: ${topSectors.join(', ') || 'no data'}
- Bottom performers: ${bottomSectors.join(', ') || 'no data'}

HIGH-IMPACT EVENTS NEXT 5 DAYS:
${highImpactEvents.map((e) => `- ${e.date} ${e.time || ''} ${e.event} (${e.country})`).join('\n') || '- None'}

Produce 3-5 themes for today/this week. Output ONLY a JSON array of strings, e.g.: ["theme 1", "theme 2", "theme 3"]`,
        }],
      }),
      timeoutMs,
      'Researcher themes',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Researcher] theme extraction API call failed: ${msg}.`);
    return [`⚠️ THEME EXTRACTION FAILED — ${msg}. Treat regime/calendar inputs as raw data only.`];
  }

  // 2026-04-29 audit fix (P0-A1): use extractText to read all blocks. Pre-
  // fix `content[0].type === 'text'` returned '' whenever adaptive thinking
  // placed a ThinkingBlock at index 0 — the catch block then silently
  // returned the "theme extraction failed" stub. The researcher's brief
  // has been a one-fake-theme document for an unknown number of cycles.
  const text = extractText(response.content);

  // Themes come as a JSON array — use a balanced-bracket extractor.
  // Same logic as extractJsonObject but for `[...]`.
  const arrayMatch = text.match(/\[[\s\S]*?\]/);
  if (!arrayMatch) {
    console.warn('[Researcher] No JSON array found in response. Raw text:', text.slice(0, 500));
    return ['⚠️ THEME EXTRACTION FAILED — no JSON array in LLM response. Inputs raw only.'];
  }
  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return ['⚠️ THEME EXTRACTION FAILED — empty array returned. Inputs raw only.'];
    }
    return parsed.map((t) => String(t)).slice(0, 5);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Researcher] JSON.parse failed for themes array: ${msg}. Raw:`, arrayMatch[0]);
    return [`⚠️ THEME EXTRACTION FAILED — invalid JSON: ${msg}. Inputs raw only.`];
  }
}

// ==================== WARNING GENERATION ====================

function generateWarnings(calendar: EconomicEvent[]): string[] {
  const warnings: string[] = [];

  // 2026-04-29 audit fix (P0-R3): high-impact events for the next 5 days,
  // not 48h. Pre-fix the calendar pulled 5 days but only 48h of warnings
  // were emitted — days 3-5 went unwarned.
  const highImpact = calendar.filter((e) => e.impact === 'high');
  for (const event of highImpact) {
    const eventTimestamp = event.time
      ? Date.parse(`${event.date}T${event.time}Z`)
      : Date.parse(`${event.date}T00:00:00Z`);
    if (!Number.isFinite(eventTimestamp)) continue;
    const hoursUntil = (eventTimestamp - Date.now()) / (1000 * 60 * 60);
    if (hoursUntil > -1 && hoursUntil < 120) {
      const dayLabel =
        hoursUntil < 24 ? 'today' : hoursUntil < 48 ? 'tomorrow' : `in ${Math.round(hoursUntil / 24)} days`;
      warnings.push(`${event.event} (${event.country}) ${dayLabel} ${event.date} — reduce new positions until after release`);
    }
  }

  if (warnings.length === 0) {
    warnings.push('No high-impact events scheduled in next 5 days.');
  }

  return warnings;
}

// ==================== MAIN RESEARCH FUNCTION ====================

export async function runResearcherAgent(): Promise<ResearchBrief> {
  console.log('Market Researcher Agent starting...');

  // 2026-04-29 audit fix (P1-R3): graceful degradation on partial failure.
  // Pre-fix `Promise.all` rejected the whole brief if any one of the 3
  // external calls threw. Now we use Promise.allSettled and surface
  // missing data in the brief's warnings array (per the prompt RULES:
  // "If data sources fail, note which data is missing in the brief
  // rather than guessing").
  const [yieldsResult, calendarResult, sectorsResult] = await Promise.allSettled([
    fetchYieldCurve(),
    fetchEconomicCalendar(5),
    fetchSectorStrength(),
  ]);

  const dataWarnings: string[] = [];
  const yields = yieldsResult.status === 'fulfilled' ? yieldsResult.value : { us2y: 0, us10y: 0, us30y: 0 };
  if (yieldsResult.status === 'rejected') {
    dataWarnings.push(`Yield-curve fetch failed: ${yieldsResult.reason}`);
  }
  const calendar = calendarResult.status === 'fulfilled' ? calendarResult.value : [];
  if (calendarResult.status === 'rejected') {
    dataWarnings.push(`Economic calendar fetch failed: ${calendarResult.reason}`);
  }
  const sectors = sectorsResult.status === 'fulfilled' ? sectorsResult.value : [];
  if (sectorsResult.status === 'rejected') {
    dataWarnings.push(`Sector strength fetch failed: ${sectorsResult.reason}`);
  }

  const regime: RegimeData = { yields, classification: classifyRegime(yields, sectors), sectors };

  // Phase 2: Extract themes using Claude
  const themes = await extractThemes(regime, calendar, sectors);

  // Phase 3: Get ranked instruments for the ICT shortlist.
  // Universe is 7 instruments post-2026-04-22 indices removal — slice to 7,
  // not 10 (audit P2-R4).
  const rankedInstruments = await getRankedInstruments(20);
  const ictShortlist = rankedInstruments
    .filter((inst) => {
      const universeEntry = INSTRUMENT_UNIVERSE.find((u) => u.ticker === inst.ticker);
      return universeEntry?.spread_quality === 'tight';
    })
    .slice(0, 7)
    .map((i) => i.ticker);

  // Phase 4: Warnings (data-fetch warnings + calendar warnings)
  const warnings = [...dataWarnings, ...generateWarnings(calendar)];

  // Phase 5: Compose and save brief
  const brief: ResearchBrief = {
    brief_id: `brief-${new Date().toISOString().split('T')[0]}-${Date.now()}`,
    date: new Date().toISOString(),
    regime,
    themes,
    events_calendar: calendar.filter((e) => e.impact === 'high' || e.impact === 'medium'),
    ict_shortlist: ictShortlist,
    warnings,
  };

  saveResearchBrief(brief);
  console.log(`Research brief saved: ${brief.brief_id}`);
  console.log(`Regime: ${regime.classification}`);
  console.log(`ICT shortlist: ${ictShortlist.join(', ')}`);
  console.log(`Warnings: ${warnings.length}`);

  return brief;
}
