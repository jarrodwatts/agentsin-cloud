import type { MicroUsdc } from "@t3tools/contracts/cloud";
import { describe, expect, it } from "vite-plus/test";

import { exactUsagePrice, exactUsagePriceDelta } from "./usagePricing.ts";

describe("exact usage pricing", () => {
  it("charges exact upstream cost plus 5% with half-up micro-USDC rounding", () => {
    expect(exactUsagePrice(0 as MicroUsdc)).toEqual({
      upstreamMicroUsdc: 0,
      markupMicroUsdc: 0,
      totalMicroUsdc: 0,
    });
    expect(exactUsagePrice(9 as MicroUsdc).markupMicroUsdc).toBe(0);
    expect(exactUsagePrice(10 as MicroUsdc).markupMicroUsdc).toBe(1);
    expect(exactUsagePrice(20 as MicroUsdc).markupMicroUsdc).toBe(1);
    expect(exactUsagePrice(30 as MicroUsdc).markupMicroUsdc).toBe(2);
    expect(exactUsagePrice(1_000_000 as MicroUsdc)).toEqual({
      upstreamMicroUsdc: 1_000_000,
      markupMicroUsdc: 50_000,
      totalMicroUsdc: 1_050_000,
    });
  });

  it("matches exact integer half-up arithmetic across a broad deterministic sample", () => {
    for (let upstream = 0; upstream <= 100_000; upstream += 137) {
      const priced = exactUsagePrice(upstream as MicroUsdc);
      const expectedMarkup = Number((BigInt(upstream) + 10n) / 20n);
      expect(priced.markupMicroUsdc).toBe(expectedMarkup);
      expect(priced.totalMicroUsdc).toBe(upstream + expectedMarkup);
    }
  });

  it("posts corrections as the exact delta between fully repriced totals", () => {
    expect(exactUsagePriceDelta(1_010 as MicroUsdc, 1_000 as MicroUsdc)).toMatchObject({
      upstreamDeltaMicroUsdc: -10,
      markupDeltaMicroUsdc: -1,
      totalDeltaMicroUsdc: -11,
      upstreamMicroUsdc: 1_000,
      markupMicroUsdc: 50,
      totalMicroUsdc: 1_050,
    });
    expect(exactUsagePriceDelta(1_000 as MicroUsdc, 1_010 as MicroUsdc)).toMatchObject({
      upstreamDeltaMicroUsdc: 10,
      markupDeltaMicroUsdc: 1,
      totalDeltaMicroUsdc: 11,
    });
  });

  it("rejects unsafe, fractional, negative, and overflowing monetary inputs", () => {
    expect(() => exactUsagePrice(-1 as MicroUsdc)).toThrow(RangeError);
    expect(() => exactUsagePrice(1.5 as MicroUsdc)).toThrow(RangeError);
    expect(() => exactUsagePrice(Number.MAX_SAFE_INTEGER as MicroUsdc)).toThrow(RangeError);
    expect(exactUsagePrice(8_578_285_004_515_229 as MicroUsdc).totalMicroUsdc).toBeLessThanOrEqual(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => exactUsagePrice(8_578_285_004_515_230 as MicroUsdc)).toThrow(RangeError);
  });
});
