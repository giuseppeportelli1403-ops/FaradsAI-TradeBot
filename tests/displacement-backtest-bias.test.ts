// tests/displacement-backtest-bias.test.ts
import { describe, it, expect } from "vitest";
import { detectBias } from "../scripts/_displacement-backtest.js";

describe("detectBias (ported from scanner)", () => {
  it("returns bullish on clean HH+HL sequence", () => {
    const candles = [
      { open: 1.10, high: 1.10, low: 1.08, close: 1.09 }, // L=1.08, H=1.10
      { open: 1.09, high: 1.11, low: 1.09, close: 1.10 }, // L=1.09 (HL), H=1.11 (HH)
      { open: 1.10, high: 1.12, low: 1.10, close: 1.11 }, // L=1.10 (HL), H=1.12 (HH)
      { open: 1.11, high: 1.13, low: 1.11, close: 1.12 }, // L=1.11 (HL), H=1.13 (HH)
    ];
    expect(detectBias(candles)).toBe("bullish");
  });

  it("returns bearish on clean LH+LL sequence", () => {
    const candles = [
      { open: 1.13, high: 1.13, low: 1.11, close: 1.12 },
      { open: 1.12, high: 1.12, low: 1.10, close: 1.11 },
      { open: 1.11, high: 1.11, low: 1.09, close: 1.10 },
      { open: 1.10, high: 1.10, low: 1.08, close: 1.09 },
    ];
    expect(detectBias(candles)).toBe("bearish");
  });

  it("returns neutral on choppy candles", () => {
    const candles = [
      { open: 1.10, high: 1.12, low: 1.08, close: 1.09 },
      { open: 1.09, high: 1.13, low: 1.07, close: 1.11 },
      { open: 1.11, high: 1.12, low: 1.08, close: 1.10 },
      { open: 1.10, high: 1.13, low: 1.07, close: 1.09 },
    ];
    expect(detectBias(candles)).toBe("neutral");
  });
});
