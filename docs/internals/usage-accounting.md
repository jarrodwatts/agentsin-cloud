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
Markup is fixed at 500 basis points. It is calculated as one twentieth of upstream cost and rounded
half-up to the nearest micro-USDC. For example, an upstream cost of 1,010 micro-USDC has a markup of
51 and a total of 1,061. The half-micro boundary therefore rounds toward the platform by one
micro-USDC, and that policy is recorded on each accrual.

Provider corrections never edit history. The service reprices the corrected full upstream amount,
then appends the signed delta from the previous upstream, markup, and total. A downward correction
therefore produces a negative ledger delta; an upward correction produces a positive delta. This
avoids rounding a correction independently from the total it corrects.

## Receipt boundary

Each accepted revision atomically appends its evidence row and one ledger accrual. The immutable
receipt input binds tenant, thread, sandbox, evidence revision and digest, prior and current prices,
all deltas, the 5% policy, and its recorded time. A domain-separated SHA-256 digest covers that
payload. Database triggers reject updates and deletes.

H5 owns receipt signing, settlement batching, wallet authorization, on-chain transfer, and daily
reconciliation. H4 does not submit a Turnkey or Monad operation and does not mark any accrual as
settled.
