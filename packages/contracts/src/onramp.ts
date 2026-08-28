/**
 * Provider-neutral production-readiness contracts for fiat onramps.
 *
 * This module models reviewed capabilities and their deterministic selection.
 * Vendor API shapes and payment amounts deliberately live elsewhere.
 *
 * @module onramp
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EvmAddress } from "./cloud.ts";

export const ONRAMP_CAPABILITIES = [
  "nativeCircleUsdcToExternalTurnkeyEoa",
  "macosElectronApplePayReturn",
  "signedReplaySafeWebhooks",
  "nonCustodialDirectWalletDelivery",
  "documentedGeographiesAndKyc",
  "thirdPartyDesktopProductionAccess",
] as const;

export const OnrampCapability = Schema.Literals(ONRAMP_CAPABILITIES);
export type OnrampCapability = typeof OnrampCapability.Type;

export const OnrampCapabilityStatus = Schema.Literals(["pass", "fail", "unknown"]);
export type OnrampCapabilityStatus = typeof OnrampCapabilityStatus.Type;

export const OnrampProvider = Schema.Literals(["crossmint", "banxa"]);
export type OnrampProvider = typeof OnrampProvider.Type;

export const ONRAMP_PROVIDER_PRIORITY = [
  "crossmint",
  "banxa",
] as const satisfies ReadonlyArray<OnrampProvider>;

export const OnrampCapabilitySet = Schema.Struct({
  nativeCircleUsdcToExternalTurnkeyEoa: OnrampCapabilityStatus,
  macosElectronApplePayReturn: OnrampCapabilityStatus,
  signedReplaySafeWebhooks: OnrampCapabilityStatus,
  nonCustodialDirectWalletDelivery: OnrampCapabilityStatus,
  documentedGeographiesAndKyc: OnrampCapabilityStatus,
  thirdPartyDesktopProductionAccess: OnrampCapabilityStatus,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OnrampCapabilitySet = typeof OnrampCapabilitySet.Type;

export const OnrampTargetBinding = Schema.Struct({
  chainId: PositiveInt,
  assetContract: EvmAddress,
  clientSurface: TrimmedNonEmptyString,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OnrampTargetBinding = typeof OnrampTargetBinding.Type;

export const OnrampCapabilityReview = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  reviewVersion: TrimmedNonEmptyString.check(
    Schema.isLengthBetween(1, 96),
    Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
  ),
  reviewedAt: IsoDateTime,
  reviewedBy: TrimmedNonEmptyString,
  evidenceDocument: TrimmedNonEmptyString,
  target: OnrampTargetBinding,
  providers: Schema.Struct({
    crossmint: OnrampCapabilitySet,
    banxa: OnrampCapabilitySet,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OnrampCapabilityReview = typeof OnrampCapabilityReview.Type;

export const OnrampBlockingCapability = Schema.Struct({
  capability: OnrampCapability,
  status: Schema.Literals(["fail", "unknown"]),
});
export type OnrampBlockingCapability = typeof OnrampBlockingCapability.Type;

const OnrampDecisionBase = {
  reviewVersion: OnrampCapabilityReview.fields.reviewVersion,
  reviewedAt: IsoDateTime,
  target: OnrampTargetBinding,
};

export const OnrampApprovedDecision = Schema.Struct({
  ...OnrampDecisionBase,
  status: Schema.Literal("approved"),
  provider: OnrampProvider,
});
export type OnrampApprovedDecision = typeof OnrampApprovedDecision.Type;

export const OnrampBlockedDecision = Schema.Struct({
  ...OnrampDecisionBase,
  status: Schema.Literal("blocked"),
  providers: Schema.Array(
    Schema.Struct({
      provider: OnrampProvider,
      blockers: Schema.Array(OnrampBlockingCapability).check(Schema.isMinLength(1)),
    }),
  ).check(Schema.isLengthBetween(2, 2)),
});
export type OnrampBlockedDecision = typeof OnrampBlockedDecision.Type;

export const OnrampCapabilityDecision = Schema.Union([
  OnrampApprovedDecision,
  OnrampBlockedDecision,
]);
export type OnrampCapabilityDecision = typeof OnrampCapabilityDecision.Type;

const blockersFor = (capabilities: OnrampCapabilitySet) =>
  ONRAMP_CAPABILITIES.flatMap((capability) => {
    const status = capabilities[capability];
    return status === "pass" ? [] : [{ capability, status }];
  });

/** Crossmint is considered first; Banxa is considered only when Crossmint is not fully approved. */
export const decideOnrampProvider = (review: OnrampCapabilityReview): OnrampCapabilityDecision => {
  const crossmintBlockers = blockersFor(review.providers.crossmint);
  if (crossmintBlockers.length === 0) {
    return {
      status: "approved",
      provider: "crossmint",
      reviewVersion: review.reviewVersion,
      reviewedAt: review.reviewedAt,
      target: review.target,
    };
  }

  const banxaBlockers = blockersFor(review.providers.banxa);
  if (banxaBlockers.length === 0) {
    return {
      status: "approved",
      provider: "banxa",
      reviewVersion: review.reviewVersion,
      reviewedAt: review.reviewedAt,
      target: review.target,
    };
  }

  return {
    status: "blocked",
    reviewVersion: review.reviewVersion,
    reviewedAt: review.reviewedAt,
    target: review.target,
    providers: [
      { provider: "crossmint", blockers: crossmintBlockers },
      { provider: "banxa", blockers: banxaBlockers },
    ],
  };
};
