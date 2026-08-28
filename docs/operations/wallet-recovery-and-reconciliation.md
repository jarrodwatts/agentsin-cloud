# Wallet recovery and reconciliation

This runbook covers user-owned Turnkey wallets used for Monad USDC infrastructure settlement. Never paste a signing stamp, passkey assertion, API private key, recovery email, recovery bundle, or delegated credential into an issue, log, database query, or support message.

## Before enabling production

Confirm all of the following:

1. The configured chain is Monad mainnet ID `143`, and the token is Circle native USDC at `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` ([Monad network information](https://docs.monad.xyz/developer-essentials/network-information), [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)).
2. The treasury is an approved production EVM address and matches the active Turnkey policy.
3. The Turnkey parent organization, authenticated gateway, and opaque delegated-credential secret reference are present. Missing configuration must make validation fail closed.
4. The billing-settlement service is the only caller authorized for delegated charges and reconciliation. No manual release path is enabled.
5. Per-charge and daily ceilings are reviewed, fixed-point micro-USDC integers, and lower than operational loss limits.
6. Authorization and delegated credential expiry match. Enable Turnkey's top-level time condition only if Turnkey has enabled its documented Early Access [time-based policies](https://docs.turnkey.com/features/policies/time-based-policies) for the production organization.
7. PostgreSQL backup, audit export, Monad RPC, and Turnkey activity-query paths have been exercised in staging.

## Recovery

1. Authenticate the wallet owner in a fresh app session. Do not accept a recovery request from a sandbox worker or automation.
2. Freeze new delegated settlement for the wallet while recovery is active.
3. Start email recovery through the authenticated Turnkey gateway. Recovery email and target public key remain process-local `Secret` values. Persist only the attempt ID, activity reference, state, and expiry.
4. Revoke the previous delegated credential, delegated user, and policy. Persist the revocation activity reference and do not continue while its status is `stillUnknown` or `notApplied`.
5. Give the encrypted recovery bundle only to the recovery completion call. Do not retain it after the call returns.
6. Confirm the Turnkey recovery activity reached a terminal success state before marking recovery complete. Turnkey documents the initiation activity in [init email recovery](https://docs.turnkey.com/api-reference/activities/init-email-recovery).
7. Keep the recovered wallet frozen. Require the owner to authorize a new bounded settlement window; only durable creation of that new delegated authorization reactivates the wallet.
8. Review the wallet audit timeline and verify that no settlement was submitted during the freeze.

If a recovery activity expires or fails, leave the wallet frozen, mark the attempt terminal, and start a new attempt with a new idempotency key. Never overwrite or reuse an expired recovery attempt.

## Pending or uncertain wallet operation

An `uncertain` provider result means an external effect may have occurred. Do not retry the provider call.

1. Locate the workspace-scoped operation or spend reservation by idempotency key and request fingerprint.
2. Query the referenced Turnkey activity through an authenticated operator path. Turnkey separates signing and broadcasting as described in [transaction broadcasting](https://docs.turnkey.com/features/transaction-management/broadcasting).
3. If a transaction hash exists, verify chain ID, token contract, decoded `transfer` destination, amount, receipt status, and confirmation depth on Monad.
4. Submit the observed status through the reconciliation service. `applied` requires a matching transaction hash and atomically marks the reservation submitted.
5. Submit `notApplied` only with definitive provider or on-chain evidence that no signature/submission occurred. This is the sole path that releases a reservation.
6. Submit `stillUnknown` with the unchanged provider activity reference when evidence remains ambiguous. Keep the record pending, pause further settlement if it would exceed either ceiling, and escalate. Do not manufacture a terminal result to unblock billing.
7. Replay terminal reconciliations rather than querying or writing again. A provider activity reference must never be substituted after the first durable observation.

For user withdrawals, contact the user before any compensating action. A new withdrawal always requires a new, exact, unexpired approval.

For delegated-access configuration, inspect the wallet-scoped configuration intent before taking action:

- `reserved` means no configuration attempt has started. Prior delegated access must be terminally revoked before advancing it.
- `attempting` means Turnkey may have created access. Query the original provider operation or recorded activity; never submit a second configuration call.
- `providerApplied` contains the activity, policy, delegated-user, and delegated-credential references required to complete local activation without another provider call.
- `completed` is terminal and replays the durable authorization. `failed` permits a new owner-approved request only after `notApplied` evidence or a definitively pre-provider failure.

Recovery completion uses the same wallet-scoped intent. Do not manually clear it to make a concurrent configuration or recovery proceed. A process crash after Turnkey success is recovered by status lookup with the original operation ID; a process crash after evidence persistence is recovered directly from that evidence.

## Daily limit or low-balance incident

- A daily-limit rejection is terminal for that request until enough UTC-day capacity exists. Do not release submitted spend to create artificial capacity.
- A released reservation no longer counts toward the daily total; release only after definitive `notApplied` evidence.
- A wallet balance is not authoritative spend state. Reconcile the on-chain balance, submitted reservations, withdrawals, direct deposits, and any pending transaction together.
- Amounts are micro-USDC integers. Reject fractional or floating-point operator input.
- A low-balance settlement must be `low-balance-paused` before support asks the user to fund it.
  Confirm the thread workspace still exists. After funding is confirmed, invoke the exact
  settlement's explicit funding retry; do not create a replacement settlement or release its H4
  accruals.
- A `submission-pending` or `reconciliation-required` settlement is not evidence that no transfer
  occurred. Inspect the original Turnkey activity and Monad transaction identity before any retry.
- A `transfer-applied` settlement needs receipt signing/finalization only. Never submit its USDC
  transfer again.

## Suspected credential or policy compromise

1. Disable the billing-settlement authorizer and freeze affected wallets.
2. Revoke the delegated credential, delegated user, and policy through Turnkey.
3. Preserve audit, operation, provider-activity, and on-chain evidence. Do not preserve raw credentials.
4. Compare every transfer against chain 143, the fixed Circle USDC contract, treasury, per-charge ceiling, authorization lifetime, and cumulative daily ceiling.
5. Rotate the secret-broker reference and authenticated gateway credentials before restoring service.
6. Require fresh owner authorization. Do not reactivate an old policy after a compromise.

Turnkey's [delegated access overview](https://docs.turnkey.com/features/policies/delegated-access/overview), [Ethereum policy examples](https://docs.turnkey.com/features/policies/examples/ethereum), and [shared responsibility model](https://docs.turnkey.com/security/shared-responsibility-model) define the provider-side controls and operator responsibilities used by this runbook.
