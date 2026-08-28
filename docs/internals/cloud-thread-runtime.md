# Hosted cloud thread runtime

The hosted control plane pauses an E2B sandbox only after PostgreSQL proves that its thread has
been idle for 15 minutes. Client presence is not activity: closing the Mac app neither stops nor
keeps alive a thread.

`cloud_thread_runtime` is the authoritative pause/resume state for the one current lifecycle
attempt. `cloud_thread_runtime_activity` contains short, server-timed agent and preview leases.
Desktop control remains authoritative in `cloud_desktop_lease`. Desktop acquire/renew operations
and the idle claim share one durable per-thread PostgreSQL fence. Whichever obtains it first commits
its decision; the idle claimant then rechecks both activity tables before advancing runtime state.
Valkey may accelerate scheduling or presence, but it cannot make a pause decision.

The activity API accepts an authenticated worker generation and a bounded lease duration. The
control plane assigns the occurrence and expiry times. Starts, heartbeats, and ends have durable
event identities, so duplicate delivery replays the original stored timing even after a delayed
retry, while changed stable content or an old worker generation fails closed. When an activity
lease or desktop lease expires, its expiry time begins
the 15-minute idle window. The boundary is inclusive: a runtime last active at 12:00 is eligible at
12:15:00, never before.

## Pause

An idle scheduler atomically changes `running` to `pause_dispatched` with a deterministic provider
request identity. Concurrent activity locks the same runtime row, so activity either wins and
blocks the pause or loses to the durable fence and is rejected.

Before calling E2B, the controller:

1. revokes worker bootstrap tokens and certificates, fences the worker route, and records that
   receipt;
2. scrubs temporary provider, GitHub, and plugin credentials through a trusted E2B control path
   that does not depend on the now-fenced worker socket; and
3. calls the E2B-only `SandboxProvider.pause` operation.

Each receipt is durable. A lost or retryable response leaves the runtime fenced in
`pause_dispatched`; recovery repeats only the missing idempotent step with the same transition
identity. A confirmed non-retryable failure or identity mismatch moves the runtime to
`reconciliation_required`. It never reports `paused` from an uncertain result.

## Resume

A user message, opening the inspector, or an approved continuation records an idempotent resume
request. If a pause is already in flight, the request remains pending and is claimed immediately
after the pause receipt; the triggering message is not lost. A running thread simply gets a fresh
idle window.

Resume increments the runtime generation, calls E2B with the deterministic transition identity,
and issues a fresh sealed worker bootstrap tied to the original sandbox reservation. The previous
worker ID is forbidden. PostgreSQL replaces the current worker binding before start, so an old
certificate or worker cannot reclaim the route. B4 must then authenticate the new mTLS worker and
confirm that durable command/event replay completed. Only that typed recovery milestone changes
the runtime back to `running`.

Worker-start response loss is reconciled by inspecting the exact new worker. A running worker is
not started again; it still must prove authenticated replay. Unknown results remain fenced and are
retried by the recovery scheduler without polling or sleeps.

## Scheduling and production wiring

Railway runs two bounded jobs against the same PostgreSQL source of truth:

- the idle sweep claims eligible `running` rows and advances their pause saga;
- the recovery sweep advances durable pause/resume states left by process or provider failure.

The jobs may use multiple replicas because idle claims use `FOR UPDATE SKIP LOCKED` and provider
operations use stable request identities. Production composition must supply the E2B provider,
the B4 worker route/recovery adapters, the credential scrubber, and the sealed bootstrap issuer.
There is no alternative sandbox implementation or development fallback.
