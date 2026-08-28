import {
  decideOnrampProvider,
  OnrampCapabilityReview,
  type OnrampCapabilityDecision,
  type OnrampProvider,
  type OnrampTargetBinding,
} from "@t3tools/contracts/onramp";
import { MONAD_MAINNET_CHAIN_ID, MONAD_MAINNET_NATIVE_USDC } from "@t3tools/contracts/cloud";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const CURRENT_ONRAMP_REVIEW_VERSION = "h2-onramp-2026-08-27-v1" as const;
export const ONRAMP_PRODUCTION_CLIENT_SURFACE = "macos-electron" as const;

const decodeCurrentReview = Schema.decodeUnknownSync(OnrampCapabilityReview);
const decodeReview = Schema.decodeUnknownEffect(OnrampCapabilityReview);

/** Reviewed source facts are recorded in docs/internals/onramp-production-gate.md. */
export const CURRENT_ONRAMP_CAPABILITY_REVIEW = decodeCurrentReview({
  schemaVersion: 1,
  reviewVersion: CURRENT_ONRAMP_REVIEW_VERSION,
  reviewedAt: "2026-08-27T00:00:00.000Z",
  reviewedBy: "H2 official-source review",
  evidenceDocument: "docs/internals/onramp-production-gate.md",
  target: {
    chainId: MONAD_MAINNET_CHAIN_ID,
    assetContract: MONAD_MAINNET_NATIVE_USDC,
    clientSurface: ONRAMP_PRODUCTION_CLIENT_SURFACE,
  },
  providers: {
    crossmint: {
      nativeCircleUsdcToExternalTurnkeyEoa: "unknown",
      macosElectronApplePayReturn: "unknown",
      signedReplaySafeWebhooks: "pass",
      nonCustodialDirectWalletDelivery: "pass",
      documentedGeographiesAndKyc: "pass",
      thirdPartyDesktopProductionAccess: "unknown",
    },
    banxa: {
      nativeCircleUsdcToExternalTurnkeyEoa: "unknown",
      macosElectronApplePayReturn: "unknown",
      signedReplaySafeWebhooks: "pass",
      nonCustodialDirectWalletDelivery: "pass",
      documentedGeographiesAndKyc: "pass",
      thirdPartyDesktopProductionAccess: "unknown",
    },
  },
});

export const CURRENT_ONRAMP_CAPABILITY_DECISION = decideOnrampProvider(
  CURRENT_ONRAMP_CAPABILITY_REVIEW,
);

export const OnrampProductionOperation = Schema.Literals(["enable", "fund"]);
export type OnrampProductionOperation = typeof OnrampProductionOperation.Type;

export const OnrampProductionAuthorizationRequest = Schema.Struct({
  operation: OnrampProductionOperation,
  provider: Schema.Literals(["crossmint", "banxa"]),
  reviewVersion: OnrampCapabilityReview.fields.reviewVersion,
  target: OnrampCapabilityReview.fields.target,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type OnrampProductionAuthorizationRequest = typeof OnrampProductionAuthorizationRequest.Type;

export interface OnrampProductionAuthorization {
  readonly operation: OnrampProductionOperation;
  readonly provider: OnrampProvider;
  readonly reviewVersion: string;
  readonly target: OnrampTargetBinding;
}

export class OnrampPolicyError extends Schema.TaggedErrorClass<OnrampPolicyError>()(
  "OnrampPolicyError",
  {
    code: Schema.Literals(["invalidReview", "invalidRequest", "blocked", "bindingMismatch"]),
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {}

export interface OnrampProductionPolicyService {
  readonly decision: OnrampCapabilityDecision;
  readonly authorize: (
    request: unknown,
  ) => Effect.Effect<OnrampProductionAuthorization, OnrampPolicyError>;
}

export class OnrampProductionPolicy extends Context.Service<
  OnrampProductionPolicy,
  OnrampProductionPolicyService
>()("@agentsin-cloud/control-plane/onrampPolicy/OnrampProductionPolicy") {}

const decodeAuthorizationRequest = Schema.decodeUnknownEffect(OnrampProductionAuthorizationRequest);

/**
 * Derive policy from a reviewed capability record. There is deliberately no
 * environment or string approval override: status is always recomputed.
 */
export const makeOnrampProductionPolicy = (
  untrustedReview: unknown,
): Effect.Effect<OnrampProductionPolicyService, OnrampPolicyError> =>
  decodeReview(untrustedReview).pipe(
    Effect.mapError(
      (cause) => new OnrampPolicyError({ code: "invalidReview", operation: "configure", cause }),
    ),
    Effect.map((review) => {
      const decision = decideOnrampProvider(review);
      return OnrampProductionPolicy.of({
        decision,
        authorize: (untrustedRequest) =>
          decodeAuthorizationRequest(untrustedRequest).pipe(
            Effect.mapError(
              (cause) =>
                new OnrampPolicyError({
                  code: "invalidRequest",
                  operation: "authorize",
                  cause,
                }),
            ),
            Effect.flatMap((request) => {
              if (decision.status !== "approved") {
                return Effect.fail(
                  new OnrampPolicyError({ code: "blocked", operation: request.operation }),
                );
              }
              if (
                request.provider !== decision.provider ||
                request.reviewVersion !== decision.reviewVersion ||
                request.target.chainId !== decision.target.chainId ||
                request.target.assetContract !== decision.target.assetContract ||
                request.target.clientSurface !== decision.target.clientSurface
              ) {
                return Effect.fail(
                  new OnrampPolicyError({ code: "bindingMismatch", operation: request.operation }),
                );
              }
              return Effect.succeed({
                operation: request.operation,
                provider: decision.provider,
                reviewVersion: decision.reviewVersion,
                target: decision.target,
              });
            }),
          ),
      });
    }),
  );

export const currentOnrampProductionPolicy = makeOnrampProductionPolicy(
  CURRENT_ONRAMP_CAPABILITY_REVIEW,
);

export const currentOnrampProductionPolicyLayer = Layer.effect(
  OnrampProductionPolicy,
  currentOnrampProductionPolicy,
);
