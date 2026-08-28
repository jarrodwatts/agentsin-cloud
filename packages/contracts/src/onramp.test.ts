import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  decideOnrampProvider,
  OnrampCapabilityReview,
  type OnrampCapabilitySet,
} from "./onramp.ts";

const PASSING: OnrampCapabilitySet = {
  nativeCircleUsdcToExternalTurnkeyEoa: "pass",
  macosElectronApplePayReturn: "pass",
  signedReplaySafeWebhooks: "pass",
  nonCustodialDirectWalletDelivery: "pass",
  documentedGeographiesAndKyc: "pass",
  thirdPartyDesktopProductionAccess: "pass",
};

const decodeReview = Schema.decodeUnknownSync(OnrampCapabilityReview);
const review = (providers: {
  readonly crossmint: OnrampCapabilitySet;
  readonly banxa: OnrampCapabilitySet;
}) =>
  decodeReview({
    schemaVersion: 1,
    reviewVersion: "h2-test-v1",
    reviewedAt: "2026-08-27T00:00:00.000Z",
    reviewedBy: "test-reviewer",
    evidenceDocument: "docs/internals/onramp-production-gate.md",
    target: {
      chainId: 143,
      assetContract: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      clientSurface: "macos-electron",
    },
    providers,
  });

describe("onramp provider decision", () => {
  it("selects Crossmint when all six Crossmint capabilities pass", () => {
    expect(decideOnrampProvider(review({ crossmint: PASSING, banxa: PASSING }))).toMatchObject({
      status: "approved",
      provider: "crossmint",
    });
  });

  it("falls back to Banxa when Crossmint fails and all six Banxa capabilities pass", () => {
    const decision = decideOnrampProvider(
      review({
        crossmint: { ...PASSING, signedReplaySafeWebhooks: "fail" },
        banxa: PASSING,
      }),
    );
    expect(decision).toMatchObject({ status: "approved", provider: "banxa" });
  });

  it("blocks when neither provider passes every capability", () => {
    const decision = decideOnrampProvider(
      review({
        crossmint: { ...PASSING, macosElectronApplePayReturn: "fail" },
        banxa: { ...PASSING, thirdPartyDesktopProductionAccess: "fail" },
      }),
    );
    expect(decision.status).toBe("blocked");
  });

  it("preserves unknown distinctly and treats it as non-passing", () => {
    const decision = decideOnrampProvider(
      review({
        crossmint: { ...PASSING, nativeCircleUsdcToExternalTurnkeyEoa: "unknown" },
        banxa: { ...PASSING, macosElectronApplePayReturn: "fail" },
      }),
    );
    expect(decision).toMatchObject({
      status: "blocked",
      providers: [
        {
          provider: "crossmint",
          blockers: [{ capability: "nativeCircleUsdcToExternalTurnkeyEoa", status: "unknown" }],
        },
        {
          provider: "banxa",
          blockers: [{ capability: "macosElectronApplePayReturn", status: "fail" }],
        },
      ],
    });
  });

  it("rejects booleans, approval strings, and excess decision fields", () => {
    expect(() => decodeReview("approved")).toThrow();
    expect(() =>
      decodeReview({
        ...review({ crossmint: PASSING, banxa: PASSING }),
        decision: "approved",
      }),
    ).toThrow();
    expect(() =>
      decodeReview({
        ...review({ crossmint: PASSING, banxa: PASSING }),
        providers: {
          crossmint: { ...PASSING, signedReplaySafeWebhooks: true },
          banxa: PASSING,
        },
      }),
    ).toThrow();
  });
});
