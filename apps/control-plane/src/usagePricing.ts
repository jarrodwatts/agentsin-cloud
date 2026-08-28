import type { MicroUsdc, SignedMicroUsdc } from "@t3tools/contracts/cloud";

export const MAX_MICRO_USDC = BigInt(Number.MAX_SAFE_INTEGER);

export interface UsagePrice {
  readonly upstreamMicroUsdc: MicroUsdc;
  readonly markupMicroUsdc: MicroUsdc;
  readonly totalMicroUsdc: MicroUsdc;
}

const microUsdc = (value: bigint, field: string) => {
  if (value < 0n || value > MAX_MICRO_USDC) {
    throw new RangeError(`${field} must be a non-negative safe micro-USDC integer`);
  }
  return Number(value) as MicroUsdc;
};

const signedMicroUsdc = (value: bigint, field: string) => {
  if (value < -MAX_MICRO_USDC || value > MAX_MICRO_USDC) {
    throw new RangeError(`${field} must be a safe signed micro-USDC integer`);
  }
  return Number(value) as SignedMicroUsdc;
};

export const exactUsagePrice = (upstreamMicroUsdc: MicroUsdc): UsagePrice => {
  if (!Number.isSafeInteger(upstreamMicroUsdc) || upstreamMicroUsdc < 0) {
    throw new RangeError("upstreamMicroUsdc must be a non-negative safe integer");
  }
  const upstream = BigInt(upstreamMicroUsdc);
  // 5% is one twentieth. At the only unrepresentable boundary (half of one micro-USDC),
  // half-up rounds toward the platform by one micro-USDC and is recorded in every accrual.
  const markup = upstream / 20n + (upstream % 20n >= 10n ? 1n : 0n);
  return {
    upstreamMicroUsdc,
    markupMicroUsdc: microUsdc(markup, "markupMicroUsdc"),
    totalMicroUsdc: microUsdc(upstream + markup, "totalMicroUsdc"),
  };
};

export interface CumulativeUsagePriceTransition {
  readonly before: UsagePrice;
  readonly after: UsagePrice;
  readonly upstreamDeltaMicroUsdc: SignedMicroUsdc;
  readonly markupDeltaMicroUsdc: SignedMicroUsdc;
  readonly totalDeltaMicroUsdc: SignedMicroUsdc;
}

/**
 * Advances the one workspace pricing cursor. The 5% fee is rounded only on cumulative verified
 * spend; callers persist the resulting signed delta and never re-round settlement batches.
 */
export const exactCumulativeUsageTransition = (
  cumulativeUpstreamBeforeMicroUsdc: MicroUsdc,
  upstreamDeltaMicroUsdc: SignedMicroUsdc,
): CumulativeUsagePriceTransition => {
  if (!Number.isSafeInteger(upstreamDeltaMicroUsdc)) {
    throw new RangeError("upstreamDeltaMicroUsdc must be a safe signed integer");
  }
  const before = exactUsagePrice(cumulativeUpstreamBeforeMicroUsdc);
  const cumulativeAfter =
    BigInt(cumulativeUpstreamBeforeMicroUsdc) + BigInt(upstreamDeltaMicroUsdc);
  const after = exactUsagePrice(microUsdc(cumulativeAfter, "cumulativeUpstreamAfterMicroUsdc"));
  return {
    before,
    after,
    upstreamDeltaMicroUsdc,
    markupDeltaMicroUsdc: signedMicroUsdc(
      BigInt(after.markupMicroUsdc) - BigInt(before.markupMicroUsdc),
      "markupDeltaMicroUsdc",
    ),
    totalDeltaMicroUsdc: signedMicroUsdc(
      BigInt(after.totalMicroUsdc) - BigInt(before.totalMicroUsdc),
      "totalDeltaMicroUsdc",
    ),
  };
};
