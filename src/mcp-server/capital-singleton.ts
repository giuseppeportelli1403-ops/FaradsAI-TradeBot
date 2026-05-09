// Capital.com client singleton.
//
// Lives in a leaf module (no imports from agents/, scanner/, scheduler/) so
// callers in those layers can import it without creating a circular import
// graph. Specifically: src/scanner/index.ts needs to import this for L3b-2
// (min_deal_size lookup), and src/agents/trading-agent.ts already imports
// from src/scanner/index.ts — so the singleton MUST live below both in the
// dependency graph.
//
// Construction is side-effect-free per CapitalClient's constructor: it
// stores config and creates an axios instance, but no network call until
// the first authed request triggers ensureSession()/createSession(). That
// means importing this module never blocks; the auth handshake happens
// lazily on first use.
//
// Added 2026-05-09 (L3b-2 plan-review fix). Previously the singleton lived
// at src/agents/trading-agent.ts and was unexported; both reviewers (Claude +
// Codex) flagged that exposing it from there would cycle scanner ↔
// trading-agent.

import { CapitalClient } from './capital-client.js';

export const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_API_KEY_PASSWORD || '',
  baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
});
