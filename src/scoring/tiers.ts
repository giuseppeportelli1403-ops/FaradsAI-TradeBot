// Tier thresholds — single import surface for the rest of src/scoring/.
// tier3FloorFor is spread-class dependent (carve-out at agents/spread.ts).

export { tier3FloorFor } from '../agents/spread.js';

export const TIER_1_THRESHOLD = 80;
export const TIER_2_THRESHOLD = 60;
