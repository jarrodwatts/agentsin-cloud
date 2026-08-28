# Hosted usage accounting

PostgreSQL is the authority for hosted infrastructure usage. Valkey, the desktop client, and the
E2B sandbox worker never own billable state. Workers do not receive wallet, signing, treasury, or
settlement credentials.

## What can be charged

A charge starts with an exact cost record retrieved through an authenticated E2B billing surface.
The record must identify one logical evidence item, its monotonically increasing revision, a
non-empty interval, the exact upstream cost in integer micro-USDC, and a SHA-256 digest of the
upstream payload. CPU, memory, disk, uptime, and other monitoring metrics returned by E2B's metrics
API are useful operational telemetry, but they are not invoice evidence and cannot be converted into
a customer charge by this service.

The production source is deliberately unavailable until an operator configures an E2B surface that
can provide exact authenticated cost records. Missing, estimated, malformed, or identity-mismatched
evidence fails closed and creates no ledger row.

## Ordering and identity

The first revision of an evidence item is accepted only for the one active E2B sandbox currently
bound to the workspace, environment, and thread. First-revision intervals for a sandbox are
monotonic and non-overlapping. A new interval may begin exactly when the previous interval ends.

An E2B correction keeps the evidence identity, interval, workspace, environment, thread, and
sandbox unchanged, increments the revision by exactly one, and changes the upstream payload digest.
Corrections remain valid after a sandbox has been replaced because they refer to an already accepted
historical sample. New usage for the replaced sandbox is rejected.

Every request has a workspace-scoped idempotency key and canonical request fingerprint. PostgreSQL
serializes concurrent replay before sequence checks. Reusing a key with different input is rejected;
same-input replay returns the original accrual without consulting E2B or creating another debit.

## Fixed-point pricing

All values are safe integer micro-USDC. Floating point money and unsafe integers are rejected.
Markup is fixed at 500 basis points. Each workspace (the v1 billing account) has one PostgreSQL
pricing cursor containing its cumulative verified upstream spend. Markup is one twentieth of that
cumulative amount, rounded half-up to the nearest micro-USDC. An accrual posts only the signed
difference between the cursor's exact total before and after the evidence transition. This makes
the result invariant to evidence partitioning and parallel threads: two 10-micro records produce a
cumulative upstream amount of 20, markup of 1, and total of 21. The cursor never resets when a
settlement is created or finalized.

Provider corrections never edit history. A correction contributes the signed difference between
the revised evidence amount and its preceding revision to the same workspace cursor. A downward
correction therefore produces a negative upstream delta and may produce negative markup and total
deltas; an upward correction produces positive deltas. The cursor is locked and advanced in the
same transaction as evidence and ledger insertion, so concurrent threads cannot observe or write
the same pricing sequence.

## Receipt boundary

Each accepted revision atomically appends its evidence row and one ledger accrual. The immutable
receipt input binds tenant, thread, sandbox, evidence revision and digest, workspace pricing scope
and version, cursor sequence, cumulative values before and after, signed deltas, the 5% policy, and
its recorded time. A domain-separated SHA-256 digest covers that payload. Database triggers reject
updates and deletes. H5 receives the signed total delta and its debit/credit direction directly;
settlement batches must not recalculate or round it.

H5 loads those immutable accruals directly from PostgreSQL. Callers provide only an internal
scheduler or sandbox lifecycle trigger; they cannot provide an amount, markup, receipt, wallet, or
authorization. Batches are scoped to one workspace and thread, preserve every signed debit or
credit transition, and transfer only a positive net balance. A net credit remains available to
offset later infrastructure usage rather than creating a synthetic zero-value chain transaction.

A batch becomes eligible after five minutes, at 250,000 micro-USDC, or when its sandbox pauses or
closes. PostgreSQL assigns each accrual to at most one deterministic settlement attempt before an
external call. A bounded processing lease prevents ordinary concurrent submission, while the same
settlement ID and request fingerprint are the mandatory provider idempotency identity after a
crash. `submission-pending` is deliberately ambiguous: recovery inspects Turnkey/on-chain evidence
before it may submit. Unknown outcomes enter `reconciliation-required`, establish a durable
billing hold, and are never blindly resubmitted. Explicit inspection retries have a persisted
minimum delay; definitive `notApplied` evidence closes one immutable provider-attempt generation
before a fresh idempotency key can be created.

Authorization is revalidated in the same PostgreSQL transaction that starts every provider-attempt
generation. Expiry or revocation at that boundary creates an authorization hold without calling
Turnkey. A replacement authorization may be bound only after the prior provider generation is
definitively not applied; ambiguous or already-applied generations keep their original authority
and remain inspect-only.

After an exact Monad transfer is observed, the control plane signs a receipt binding the workspace,
thread, ordered E2B evidence range, every immutable H4 posting, signed upstream/markup/total sums,
and transaction hash. The receipt and finalized attempt are immutable. Signing, validation, or
finalization failure after a transfer leaves `transfer-applied` recoverable without another
transfer and activates the same durable runtime hold until receipt finalization succeeds.

Insufficient balance, unavailable authorization, definitive provider failure, and ambiguous
provider evidence create a durable per-thread billing fence. The fence's episode gives runtime
pause one stable idempotency key across crashes and lost responses. PostgreSQL blocks thread create
and resume transitions while that fence is active. The hold stays active through retries and is
cleared atomically only with successful receipt finalization; low balance requires an explicit
post-funding retry.

Migration `0017-usage-settlement-hardening.sql` is additive over the original settlement schema. It
backfills authorization and provider-attempt generation history, canonicalizes safe legacy hashes,
and fails closed when case-variant hashes or incomplete applied history require operator review.

## Production gates

The checked-in settlement service has injected Turnkey/on-chain, receipt-signing, and runtime-pause
ports and uses fakes in tests. Production must remain disabled until the composition root supplies:

- an idempotent WalletService/Turnkey adapter that verifies Monad chain 143, native Circle USDC,
  treasury, exact amount, transaction status, and confirmation depth;
- a KMS-backed receipt signer whose public key and rotation history are published;
- the C4 runtime pause adapter and authoritative create/resume composition for every billing-fence
  transition;
- activation and recovery of the approved workspace-wide wallet-policy hold, including pausing
  already-running sibling threads; the checked-in per-thread fence must not be presented as that
  workspace-wide control;
- an authenticated E2B invoice source for H4 and an operator reconciler comparing that source,
  immutable accruals, signed receipts, wallet reservations, and on-chain transfers;
- a controlled tiny-value Monad mainnet canary before customer funds are enabled.
