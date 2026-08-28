# User-owned hosted wallets

Hosted workspaces use one user-owned Turnkey EOA to hold native Circle USDC on Monad mainnet. The wallet is an infrastructure-payment account, not a platform custody account. Agents in Cloud stores only public wallet metadata and opaque Turnkey references. It cannot export a private key, and sandbox workers never receive a wallet credential, signing stamp, passkey assertion, or recovery bundle.

## Fixed asset binding

All wallet contracts, database constraints, and adapter checks bind to:

- EVM chain ID `143` (Monad mainnet).
- Circle native USDC contract `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`.
- Six-decimal, fixed-point micro-USDC integer amounts. Floating-point money is not accepted.

Monad publishes chain ID 143 in its [network information](https://docs.monad.xyz/developer-essentials/network-information). Circle publishes the contract in its [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses). A contract-address change requires a new schema version, migration, policy revision, and explicit user authorization; it is not a configuration toggle.

## Custody boundary

Turnkey documents that key material is generated and used inside its secure enclaves and that its system is designed as non-custodial key management ([non-custodial key management](https://docs.turnkey.com/security/non-custodial-key-mgmt)). Each wallet owner receives a Turnkey sub-organization, a passkey owner, email recovery, and one Ethereum account at `m/44'/60'/0'/0/0`. The public control-plane model stores:

- workspace, owner, EOA address, and lifecycle state;
- opaque provider organization, wallet, activity, policy, user, and delegated-credential references;
- idempotent operation records, recovery status, spend reservations, and audit events.

It never stores private keys, API private keys, signing stamps, passkey registration/assertion payloads, recovery emails, or recovery bundles. Those values cross only a `Secret`-typed process boundary into an authenticated Turnkey gateway and are redacted from diagnostic fields. Turnkey's [sub-organization model](https://docs.turnkey.com/features/sub-organizations) and [Swift passkey flow](https://docs.turnkey.com/sdks/swift/register-passkey) are the provider source for this lifecycle.

The adapter accepts an opaque secret-broker reference, not secret bytes. An absent or incomplete production configuration selects a disabled adapter that fails closed. The gateway owns Turnkey SDK authentication and request stamping; no RPC or worker-facing contract exposes it.

## Delegated settlement

The user explicitly authorizes a bounded settlement window. The control plane creates a short-lived delegated Turnkey user/credential and an allow policy. The compiled policy permits only:

- `SIGN_TRANSACTION` on chain 143;
- zero native value;
- a call to the fixed USDC contract's `transfer(address,uint256)` method;
- the configured platform treasury as decoded destination;
- a positive amount no greater than the per-charge ceiling.

The delegated credential expires with the authorization. Before any provider call, PostgreSQL locks the wallet and reserves one durable delegation-configuration intent. A competing fresh idempotency key observes that in-progress intent and cannot call Turnkey. Replacing an authorization is then a fail-closed state machine: the control plane first requests provider-side revocation of the prior delegated credential, delegated user, and policy; persists the Turnkey activity reference and observed status; and only then marks the configuration attempt as started. An unknown revocation is queried by activity reference on replay and never skips ahead to new access. Turnkey documents delegated users and credentials in [delegated access](https://docs.turnkey.com/features/policies/delegated-access/overview), backend credential creation in [backend delegated access](https://docs.turnkey.com/features/policies/delegated-access/backend), and decoded EVM call constraints in its [Ethereum policy examples](https://docs.turnkey.com/features/policies/examples/ethereum).

The provider configuration result is not treated as active until its activity, policy, delegated-user, and delegated-credential references are durably recorded. If the process loses the response before that commit, replay queries the original idempotent provider operation; it never submits another configuration call. If the evidence was committed but authorization activation was interrupted, replay completes activation from that evidence without contacting Turnkey. Recovery completion reserves the same wallet-scoped intent, so it cannot race a credential replacement; it preserves the prior-revocation-before-recovery ordering.

Two additional controls are enforced outside the Turnkey policy:

1. PostgreSQL locks the authorization row and atomically reserves cumulative UTC-day spend before any provider call. Turnkey's published policy language does not expose a cumulative daily counter.
2. The service rejects expired authorizations using server time. A Turnkey top-level time policy is added only when the production account explicitly enables that Early Access capability. Turnkey labels time policies as Early Access in [time-based policies](https://docs.turnkey.com/features/policies/time-based-policies), so their absence cannot weaken the local expiry or delegated-credential expiry.

Only an injected billing-settlement authorizer may call automated charge and reconciliation methods. There is no manual or evidence-free reservation-release operation. A sandbox request cannot construct provider access merely by knowing wallet IDs.

## Durable operations and uncertain outcomes

Every provisioning, delegation, recovery, withdrawal, and settlement request has a workspace-scoped idempotency key and a canonical SHA-256 request fingerprint. A repeated key with the same fingerprint returns the recorded result; a changed fingerprint is rejected. Before calling Turnkey, provisioning acquires an owner-scoped PostgreSQL lock and stores a single durable intent keyed by workspace and owner. Delegated-access configuration and recovery completion similarly use one pending wallet-scoped intent. Competing fresh keys therefore observe the same completed result or pending intent instead of creating a second provider wallet or delegated credential. PostgreSQL is authoritative for provisioning ownership, delegated configuration and revocation, daily reservations, and audit state.

Every attempted delegated transfer persists a provider activity reference, its observation time, and one of three monotonic reconciliation outcomes:

- `applied`: a transaction hash is required and the reservation becomes submitted.
- `notApplied`: provider or on-chain evidence confirms no external effect and the reservation becomes released.
- `stillUnknown`: submission may have happened, so the reservation remains pending and the activity is queried again. The service never blindly resubmits.

The repository rejects a terminal transition without matching provider evidence, and an activity reference cannot be replaced after it is recorded. This matches Turnkey's separation between signing and broadcasting described in [transaction broadcasting](https://docs.turnkey.com/features/transaction-management/broadcasting). Production reconciliation must query Turnkey activity status and Monad transaction state before it completes, releases, or compensates an uncertain record.

## User flows

- **Provision:** an authenticated owner supplies an ephemeral passkey registration, recovery email, and owner stamp. The repository first reserves the workspace owner, the adapter creates the sub-organization and account once, then the repository atomically completes that intent, activates wallet metadata, and writes an audit event.
- **Deposit:** the app displays only the EOA address and fixed Monad/USDC binding. USDC arrives directly at the user-owned address.
- **Withdraw:** a fresh approval binds workspace, wallet, destination, exact micro-USDC amount, approving user, auth session, request fingerprint, and expiry. The same user/session must submit it before expiry.
- **Recover:** the owner initiates Turnkey email recovery with an ephemeral email and target public key. Only attempt IDs, provider activity references, state, and expiries are durable. Completion revokes and durably confirms all old delegated access before consuming an encrypted recovery bundle transiently. The recovered wallet remains frozen until the owner authorizes and the repository durably stores a new bounded delegation.
- **Settle:** the billing service reserves budget transactionally, submits a policy-bounded transfer, persists provider evidence, and emits terminal audit events only for `applied` or `notApplied` outcomes.

Turnkey's recovery initiation contract is documented in [init email recovery](https://docs.turnkey.com/api-reference/activities/init-email-recovery), and its transaction-signing activity is documented in [sign transaction](https://docs.turnkey.com/api-reference/activities/sign-transaction).

## Shared responsibility

The operator owns authorization correctness, secret-broker isolation, database backups, reconciliation, treasury configuration, activity monitoring, and incident response. Turnkey documents these customer responsibilities in its [shared responsibility model](https://docs.turnkey.com/security/shared-responsibility-model). The current code deliberately stops at provider-neutral contracts, durable state, a deterministic fake, and an authenticated-gateway seam. It does not create a live wallet, install production Turnkey credentials, broadcast a transfer, or expose wallet UI.
