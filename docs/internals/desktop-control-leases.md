# Desktop control leases

The live inspector has two independent authorities: the coding agent and one
authenticated desktop client. PostgreSQL is the source of truth for which one
may send mouse or keyboard input. Valkey and process memory are never used to
decide ownership.

Each active lease is bound to one workspace, thread, lifecycle attempt,
environment revision, sandbox, worker, and worker-route generation. Acquiring
or resuming a lease, and rebinding it to a newer worker route, allocates a
permanently monotonic generation. Agent-only route synchronization also
advances that fence. The control plane commits that state first, then sends a
derived authority revision over the pinned worker relay. It does not keep a
database transaction open while it waits on the worker.

User input follows the same fence:

1. Better Auth and the inspector socket derive the workspace, user, auth
   session, and server-generated client identity.
2. PostgreSQL verifies the exact current ready lifecycle and returns a bounded
   permit for the active lease generation.
3. The control plane serializes that permit onto the current worker route.
4. The worker rechecks the permit against its monotonic authority gate inside
   the queued request, immediately before invoking a visual input adapter.

Release, expiry, lifecycle replacement, pause, and destroy durably revoke the
lease. Older authority revisions cannot restore it. A socket disconnect changes
the public controller state to `disconnected` and shortens the lease to a
bounded grace period. Only the same user and auth session, presenting the
opaque reconnect proof, can resume during that grace; a new server-generated
client identity receives a new generation. Every successful resume atomically
rotates the proof to one bound to the exact auth session, presented generation,
and idempotent request. The durable holder remains bound to the server-generated
socket identity. If a committed response is lost, the same authenticated
session can recover that exact proof on a new socket by retrying the original
request. Recovery is read-only at the worker relay and never resends unchanged
authority. The client then performs a second fenced resume to transfer the
holder and emit a higher worker generation. A different session or a fresh
request using an older holder proof cannot reclaim the lease.

The worker starts with computer input disabled until the control plane
synchronizes explicit agent authority. While user or disconnected authority is
active, agent input is denied. C7 defines and enforces this gate, but it does not
claim that E2B supplies a native desktop API. Browser and desktop adapters stay
unsupported unless a separately reviewed adapter is injected. Any future agent
computer-use adapter must call the same gate immediately before every input.

## Threat boundaries

- Client frames never carry a workspace, user, auth-session, or client holder
  identity; excess fields are rejected by the wire schema.
- Reconnect proofs are stored only as hashes and are never sent to a worker.
- Public controller state does not reveal another client or auth-session ID.
- A route or lifecycle mismatch fails closed before acquisition, heartbeat,
  resume, or input.
- Database locks linearize lease state only. They never span worker/network
  dispatch, preventing a stalled sandbox from blocking durable lease changes.
- Lease and audit retention may delete history, but the generation counter is
  retained with the thread so a fence is never reused.
