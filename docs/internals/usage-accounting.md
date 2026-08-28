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

H5 owns receipt signing, settlement batching, wallet authorization, on-chain transfer, and daily
reconciliation. H4 does not submit a Turnkey or Monad operation and does not mark any accrual as
settled.
