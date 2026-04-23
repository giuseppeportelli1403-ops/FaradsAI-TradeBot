// Market Researcher Agent — Battlefield Preparation
// Runs daily at 05:30 UTC + Sunday 22:00 UTC
// Produces research briefs consumed by both trading agents
//
// Answers three questions:
//   1. What is the regime? (risk-on, risk-off, mixed)
//   2. What are today's/this week's themes?
//   3. Which instruments are in play?

import Anthropic from '@anthropic-ai/sdk';
import { loadPrompt } from './load-prompt.js';
import { fetchVix, fetchDxy, fetchYieldCurve, fetchEconomicCalendar, fetchSectorStrength } from '../mcp-server/market-data.js';
import { getRankedInstruments, INSTRUMENT_UNIVERSE } from '../scanner/index.js';
import { getNewsContext } from '../news/index.js';
import { saveResearchBrief, getLatestBrief } from '../database/index.js';
import type { ResearchBrief, RegimeData, EconomicEvent, SectorStrength } from '../types.js';

const anthropic = new Anthropic();

// ==================== REGIME DETECTION ====================

async function detectRegime(): Promise<RegimeData> {
  const [vixData, dxyData, yields] = await Promise.all([
    fetchVix(),
    fetchDxy(),
    fetchYieldCurve(),
  ]);

  let vixRegime: 'low' | 'normal' | 'elevated' | 'crisis';
  if (vixData.vix < 15) vixRegime = 'low';
  else if (vixData.vix < 20) vixRegime = 'normal';
  else if (vixData.vix < 30) vixRegime = 'elevated';
  else vixRegime = 'crisis';

  return {
    vix: vixData.vix,
    vix_30d_avg: vixData.vix_30d_avg,
    vix_regime: vixRegime,
    dxy: dxyData.dxy,
    dxy_direction: dxyData.direction,
    yields,
  };
}

// ==================== THEME EXTRACTION ====================

async function extractThemes(
  regime: RegimeData,
  calendar: EconomicEvent[],
  sectors: SectorStrength[]
): Promise<string[]> {
  const highImpactEvents = calendar.filter(e => e.impact === 'high');
  const topSectors = sectors.slice(0, 3).map(s => s.sector);
  const bottomSectors = sectors.slice(-3).map(s => s.sector);

  // Use Claude to synthesise themes from raw data
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: [{ type: 'text', text: 'You are a market research analyst. Given market data, produce 3-5 concise theme statements for today/this week. Each theme is one sentence. No filler. Factual and actionable.', cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Regime: VIX ${regime.vix} (${regime.vix_regime}), DXY ${regime.dxy} (${regime.dxy_direction}), 10Y yield ${regime.yields.us10y}%
Top sectors: ${topSectors.join(', ')}
Bottom sectors: ${bottomSectors.join(', ')}
High-impact events next 5 days: ${highImpactEvents.map(e => `${e.date} ${e.event} (${e.country})`).join(', ') || 'None'}

List 3-5 themes as a JSON array of strings.`,
    }],
  });

  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch { /* fall through */ }

  return ['Market data collected but theme extraction failed — agents should check raw data'];
}

// ==================== WARNING GENERATION ====================

function generateWarnings(calendar: EconomicEvent[], regime: RegimeData): string[] {
  const warnings: string[] = [];

  // VIX warnings
  if (regime.vix_regime === 'elevated') {
    warnings.push('VIX elevated (20-30) — reduce position size by 25% across both agents');
  } else if (regime.vix_regime === 'crisis') {
    warnings.push('VIX crisis mode (30+) — Swing agent stands down, ICT Tier 1 only');
  }

  // High-impact event warnings
  const highImpact = calendar.filter(e => e.impact === 'high');
  for (const event of highImpact) {
    const eventDate = new Date(event.date);
    const now = new Date();
    const hoursUntil = (eventDate.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursUntil > 0 && hoursUntil < 48) {
      warnings.push(`${event.event} on ${event.date} — no new swing positions in affected instruments until after release`);
    }
  }

  return warnings;
}

// ==================== MAIN RESEARCH FUNCTION ====================

export async function runResearcherAgent(): Promise<ResearchBrief> {
  console.log('Market Researcher Agent starting...');

  // Load the full researcher prompt (used as reference context; theme extraction uses inline prompt)
  const _systemPrompt = loadPrompt('researcher-agent.md');

  // Phase 1: Gather all data in parallel
  const [regime, calendar, sectors] = await Promise.all([
    detectRegime(),
    fetchEconomicCalendar(5),
    fetchSectorStrength(),
  ]);

  // Phase 2: Extract themes using Claude
  const themes = await extractThemes(regime, calendar, sectors);

  // Phase 3: Get ranked instruments for the ICT shortlist
  //
  // Swing shortlist removed 2026-04-23 along with the Swing Agent itself. The
  // ResearchBrief type still has an optional `swing_shortlist` field so older
  // JSON briefs in the DB continue to parse; new briefs simply don't populate
  // it.
  const rankedInstruments = await getRankedInstruments(20);

  // ICT: instruments with tight spreads, active during kill zones
  const ictShortlist = rankedInstruments
    .filter(inst => {
      const universeEntry = INSTRUMENT_UNIVERSE.find(u => u.ticker === inst.ticker);
      return universeEntry?.spread_quality === 'tight';
    })
    .slice(0, 10)
    .map(i => i.ticker);

  // Phase 4: Generate warnings
  const warnings = generateWarnings(calendar, regime);

  // Phase 5: Compose and save brief
  const brief: ResearchBrief = {
    brief_id: `brief-${new Date().toISOString().split('T')[0]}-${Date.now()}`,
    date: new Date().toISOString(),
    regime,
    themes,
    events_calendar: calendar.filter(e => e.impact === 'high' || e.impact === 'medium'),
    ict_shortlist: ictShortlist,
    warnings,
  };

  saveResearchBrief(brief);
  console.log(`Research brief saved: ${brief.brief_id}`);
  console.log(`ICT shortlist: ${ictShortlist.join(', ')}`);
  console.log(`Warnings: ${warnings.length}`);

  return brief;
}
