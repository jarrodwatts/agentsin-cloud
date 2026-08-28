import { OnrampCapabilityReview, type OnrampCapabilitySet } from "@t3tools/contracts/onramp";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  CURRENT_ONRAMP_CAPABILITY_DECISION,
  CURRENT_ONRAMP_REVIEW_VERSION,
  currentOnrampProductionPolicy,
  makeOnrampProductionPolicy,
  ONRAMP_PRODUCTION_CLIENT_SURFACE,
} from "./onrampPolicy.ts";

const PASSING: OnrampCapabilitySet = {
  nativeCircleUsdcToExternalTurnkeyEoa: "pass",
  macosElectronApplePayReturn: "pass",
  signedReplaySafeWebhooks: "pass",
  nonCustodialDirectWalletDelivery: "pass",
  documentedGeographiesAndKyc: "pass",
  thirdPartyDesktopProductionAccess: "pass",
};

const target = {
  chainId: 143,
  assetContract: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  clientSurface: ONRAMP_PRODUCTION_CLIENT_SURFACE,
} as const;

const approvedReview = Schema.decodeUnknownSync(OnrampCapabilityReview)({
  schemaVersion: 1,
  reviewVersion: "approved-test-v1",
  reviewedAt: "2026-08-27T00:00:00.000Z",
  reviewedBy: "test-reviewer",
  evidenceDocument: "docs/internals/onramp-production-gate.md",
  target,
  providers: { crossmint: PASSING, banxa: PASSING },
});

it.effect("keeps the checked-in production decision blocked", () =>
  Effect.gen(function* () {
    expect(CURRENT_ONRAMP_CAPABILITY_DECISION.status).toBe("blocked");
    const policy = yield* currentOnrampProductionPolicy;
    const result = yield* Effect.result(
      policy.authorize({
        operation: "fund",
        provider: "crossmint",
        reviewVersion: CURRENT_ONRAMP_REVIEW_VERSION,
        target,
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe("blocked");
  }),
);

it.effect("authorizes only an approved decision with an exact binding", () =>
  Effect.gen(function* () {
    const policy = yield* makeOnrampProductionPolicy(approvedReview);
    expect(
      yield* policy.authorize({
        operation: "enable",
        provider: "crossmint",
        reviewVersion: approvedReview.reviewVersion,
        target,
      }),
    ).toEqual({
      operation: "enable",
      provider: "crossmint",
      reviewVersion: approvedReview.reviewVersion,
      target,
    });
  }),
);

it.effect("rejects provider, chain, asset, client, and review-version mismatches", () =>
  Effect.gen(function* () {
    const policy = yield* makeOnrampProductionPolicy(approvedReview);
    const mismatches = [
      { provider: "banxa" },
      { target: { ...target, chainId: 1 } },
      { target: { ...target, assetContract: "0x1111111111111111111111111111111111111111" } },
      { target: { ...target, clientSurface: "web" } },
      { reviewVersion: "different-review-v1" },
    ];
    for (const mismatch of mismatches) {
      const result = yield* Effect.result(
        policy.authorize({
          operation: "fund",
          provider: "crossmint",
          reviewVersion: approvedReview.reviewVersion,
          target,
          ...mismatch,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe("bindingMismatch");
    }
  }),
);

it.effect("rejects strings, booleans, and environment-shaped approval objects", () =>
  Effect.gen(function* () {
    const invalidReviews = [
      "approved",
      true,
      { ONRAMP_PROVIDER: "crossmint", ONRAMP_APPROVED: "true" },
      { ...approvedReview, decision: "approved" },
    ];
    for (const review of invalidReviews) {
      const result = yield* Effect.result(makeOnrampProductionPolicy(review));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe("invalidReview");
    }

    const policy = yield* makeOnrampProductionPolicy(approvedReview);
    const request = yield* Effect.result(policy.authorize("approved"));
    expect(Result.isFailure(request)).toBe(true);
    if (Result.isFailure(request)) expect(request.failure.code).toBe("invalidRequest");
  }),
);
