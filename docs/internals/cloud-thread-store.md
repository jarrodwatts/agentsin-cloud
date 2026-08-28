# Hosted cloud thread store

The hosted control plane keeps a thread's durable history in PostgreSQL. The
E2B sandbox is execution state, not the system of record: replacing a worker or
disconnecting every client must not change the recorded command and event
history.

`ThreadEventStore` wraps the canonical `CloudThreadCommand` and
`CloudThreadEvent` contracts. It does not define a second command or event
model. A cloud thread row owns a monotonically increasing event sequence.
Appenders lock that row, accept only the next contiguous sequence, and treat an
identical event ID/fingerprint as an at-least-once retry. Reusing an identity
with different content fails closed.

Commands are unique by both command ID and the caller's workspace-scoped
idempotency key. Collision-free PostgreSQL rows keyed by the full workspace,
identity kind, and identity value serialize both identities across every thread
before the store checks or inserts them. Lock rows are retained for 24 hours;
the maintenance path prunes them in tenant-scoped, skip-locked batches of at
most 1,000, and deleting a workspace cascades its remaining rows.
Command/event writes and their outbox records share one PostgreSQL transaction,
so a worker can never observe an outbox instruction for state that did not
commit. Outbox consumers must preserve the stored dedupe key when performing an
external side effect.

Every table includes `workspace_id`. Child rows reference composite
workspace/thread keys, and repository reads always begin with the authenticated
workspace. Replays use a repeatable-read transaction and reject missing,
out-of-order, corrupt, or cross-workspace envelopes instead of returning a
partial history. Replay also recomputes the canonical JSON fingerprint and
cross-checks the event identity, environment, sequence, and source timestamp
text against their indexed columns. The integrity columns and command lock table
are introduced by forward migration `0003`; the shipped `0002` remains
unchanged, and legacy event timestamp text is backfilled from its envelope under
bounded lock and statement timeouts.

Approvals, checkpoints, and sandbox/worker lifecycle transitions are durable
projections beside the append-only event stream. Valkey may cache presence,
leases, and routing, but it is never authoritative for these records. Unknown
payloads must decode as lossless JSON before persistence; unsupported values
fail as `invalidRecord` rather than being stringified away.

Idle activity and E2B pause/resume transitions are also PostgreSQL-owned. See
[cloud-thread-runtime.md](./cloud-thread-runtime.md). Client disconnect is not
activity, and an uncertain provider response never becomes a successful pause
or resume projection.
