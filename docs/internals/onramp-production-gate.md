# ADR: hosted onramp production gate

- Status: accepted, blocked pending vendor proof
- Date: 2026-08-27
- Evidence version: `h2-onramp-2026-08-27-v1`
- Target: Monad mainnet chain `143`, native Circle USDC contract
  `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, macOS Electron client

## Decision

Hosted funding remains blocked. Crossmint is evaluated first. Banxa is evaluated only when Crossmint
does not pass all six mandatory capabilities. A provider is approved only when every capability is
`pass`; `unknown` is preserved as a distinct evidence state and fails the gate exactly like `fail`.
We will not choose a third provider under this decision.

The control plane derives this decision from a strict, versioned review record. It does not accept an
environment variable, provider name, boolean, or prewritten `approved` string as authority. A future
funding operation must match the approved provider, evidence version, chain, asset contract, and
client surface exactly.

## Chain and asset facts

These are source facts, not vendor-capability inferences:

- Monad documents mainnet chain ID `143` in its
  [official chain configuration](https://docs.monad.xyz/developer-essentials/changelog).
- Circle lists native USDC on Monad at
  [`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`](https://developers.circle.com/stablecoins/usdc-contract-addresses)
  and describes Monad support in its
  [USDC support FAQ](https://help.circle.com/support/en/usdc-supported-blockchains-minting-redemption-faqs?id=kb_article_view&sysparm_article=KB0010590).
- Apple documents
  [`ASWebAuthenticationSession`](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)
  as an Authentication Services browser-session API. That platform fact does not prove either vendor
  supports the required Electron/macOS Apple Pay return flow.

## Capability evidence

`Unknown` means the reviewed official material did not affirmatively establish the complete
requirement. Absence of proof is recorded as unknown, not converted into a source fact that a vendor
cannot provide the capability.

| Capability                                                                                     | Crossmint | Banxa   | Official source facts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Gate inference                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native Circle USDC on Monad to an arbitrary external Turnkey EOA                               | unknown   | unknown | Crossmint documents [external-wallet delivery](https://docs.crossmint.com/onramp/guides/onramp-to-external-wallets) and marks Monad onramp as non-self-serve in [supported chains](https://docs.crossmint.com/introduction/supported-chains). Banxa lists USDC/Monad in [supported assets](https://docs.banxa.com/products/native-api/docs/how-it-works/supported-cryptocurrencies-and-blockchains) and accepts `walletAddress` in [buy orders](https://docs.banxa.com/products/hosted-checkout/docs/api-integration/create-buy-order).                                                  | Neither source set binds delivery to Circle's exact native contract and an arbitrary external Turnkey EOA.                                                                     |
| Apple Pay from macOS Electron through an authenticated system browser with a documented return | unknown   | unknown | Crossmint's [onramp overview](https://docs.crossmint.com/onramp/overview) lists Apple Pay, while its [Apple Pay guide](https://docs.crossmint.com/payments/embedded/guides/apple-pay) covers browser/mobile integration. Banxa's [Apple Pay guide](https://docs.banxa.com/products/native-api/docs/guides/apple-pay) covers web, React Native, and iOS.                                                                                                                                                                                                                                  | Neither vendor documents the required Electron/macOS system-browser and application-return flow.                                                                               |
| Signed, replay-safe webhooks                                                                   | pass      | pass    | Crossmint documents [signature and timestamp verification](https://docs.crossmint.com/introduction/platform/webhooks/verify-webhooks) plus [duplicate-event handling](https://docs.crossmint.com/introduction/platform/webhooks/best-practices). Banxa documents [HMAC-SHA256, nonce authentication, retries, and idempotent handling](https://docs.banxa.com/products/native-api/docs/transaction-lifecycle/webhooks).                                                                                                                                                                  | The documented controls meet the gate, subject to correct server-side implementation.                                                                                          |
| Direct wallet delivery/withdrawal without platform custody                                     | pass      | pass    | Crossmint documents [delivery to external wallets](https://docs.crossmint.com/onramp/guides/onramp-to-external-wallets), [user ownership of non-custodial wallets](https://docs.crossmint.com/agents/how-agents-pay), and [direct stablecoin payouts](https://docs.crossmint.com/solutions/fintech/stablecoin-payouts). Banxa documents [onramp delivery](https://docs.banxa.com/products/hosted-checkout/docs/on-ramp-off-ramp/on-ramp-overview) and a [non-custodial off-ramp mode](https://docs.banxa.com/products/hosted-checkout/docs/on-ramp-off-ramp/custodial-vs-non-custodial). | The documented non-custodial product paths meet the gate; a production contract must bind the selected path, and Banxa must be configured specifically for non-custodial mode. |
| Documented geographies and KYC                                                                 | pass      | pass    | Crossmint documents [onboarding/KYC](https://docs.crossmint.com/onramp/introduction/user-onboarding) and [supported geographies](https://docs.crossmint.com/stablecoin-orchestration/supported-geographies). Banxa documents its [global KYC framework](https://docs.banxa.com/products/native-api/docs/compliance/global-kyc-framework) and restrictions in its [supported-assets table](https://docs.banxa.com/products/native-api/docs/how-it-works/supported-cryptocurrencies-and-blockchains).                                                                                      | Both vendors publish sufficient policy documentation for this capability; runtime eligibility remains transaction-specific.                                                    |
| Public or contracted third-party macOS Electron production access                              | unknown   | unknown | Crossmint documents [Desktop/CLI client keys](https://docs.crossmint.com/introduction/platform/api-keys/client-side). Banxa documents [production approval and credential issuance](https://docs.banxa.com/products/hosted-checkout/docs/getting-started/access-and-setup).                                                                                                                                                                                                                                                                                                              | Neither source affirmatively grants production onramp access for this exact Electron/macOS surface.                                                                            |

The resulting decision is `blocked` for both providers.

## Evidence required to unblock

A new evidence version and review are required. Written first-party documentation or a countersigned
vendor commitment must establish, for one provider, all of the following at once:

1. Orders settle native Circle USDC on chain `143` at the exact contract above to any supplied,
   externally controlled Turnkey EOA—not a vendor wallet, bridged token, or custody balance.
2. Apple Pay is approved for a third-party macOS Electron application using the system browser, with
   documented callback/deep-link handling and production domain/application requirements.
3. Webhook signatures bind the raw body and freshness data, and replay/duplicate handling is
   documented for production events.
4. The selected product mode delivers directly to and withdraws directly from the user's external
   wallet without platform custody.
5. Production geographies, KYC tiers, asset restrictions, and rejection behavior remain documented.
6. Our third-party desktop application is eligible for production credentials and the exact onramp
   product under a public program or written contract.

Browser redirects never authorize credit. Any later integration must verify signed webhooks and
terminal provider state server-side, bind orders to the exact chain/asset/address, and keep provider
credentials outside the Electron renderer.
