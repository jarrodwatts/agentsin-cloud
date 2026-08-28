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
lease or desktop lease expires, its expiry time begins the 15-minute idle window. The boundary is
inclusive: a runtime last active at 12:00 is eligible at 12:15:00, never before.

A heartbeat arriving at or after its prior expiry is rejected; an expired claim cannot be
resurrected. If an end event is delivered after expiry, the prior expiry remains the effective idle
boundary instead of the later delivery time. Worker activity is currently accepted through this
generation-fenced service port. The B4 gateway integration must derive its activity identity from
`VerifiedWorkerPrincipal` before exposing the port to worker traffic; caller-supplied worker
identity is not a production authentication boundary.

## Pause

An idle scheduler atomically changes `running` to `pause_dispatched` with a deterministic provider
request identity. Concurrent activity locks the same runtime row, so activity either wins and
blocks the pause or loses to the durable fence and is rejected.

Before calling E2B, the controller:

1. revokes central broker grants and credential material without depending on the worker or
   sandbox;
2. independently fences the worker route;
3. scrubs temporary provider, GitHub, and plugin credentials through a trusted E2B control path;
4. calls the E2B-only `SandboxProvider.pause` operation, or destroys the sandbox when local scrub
   or a confirmed pause operation fails.

Every attempt and outcome is durable. The transition identity binds workspace, thread, lifecycle
attempt, sandbox, and worker generation, and every external retry reuses it. Failures in one step do
not prevent central revocation or forced provider containment from being attempted. A lost or
retryable response stays recoverable; a confirmed failure may be shown as
`reconciliation_required`, but the recovery scheduler continues quarantine work until durable
receipts prove route fencing, central credential revocation, and either a sanitized pause or
sandbox destruction. A destroyed sandbox remains visibly unrecoverable and cannot consume a
pending resume. The runtime never reports `paused` from an uncertain result.

## Resume

A user message, opening the inspector, or an approved continuation records an idempotent resume
request. The caller supplies only stable identity and reason; the control-plane clock assigns the
persisted request time, and delayed retries replay that original time. If a pause is already in
flight, the request remains pending and is claimed immediately
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

The jobs may use multiple replicas because idle claims share a durable per-thread fence and
provider operations use stable request identities. Production composition must supply the E2B
provider, the B4 worker route/recovery adapters, the central credential revoker, the sandbox-local
credential scrubber, and the sealed bootstrap issuer. There is no alternative sandbox
implementation or development fallback.
