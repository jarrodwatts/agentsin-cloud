# Cloud coordination state

The hosted control plane uses Valkey only for state that is safe to lose. PostgreSQL remains the
authority for threads, commands, worker identities, approvals, checkpoints, and lifecycle events.
Deleting every Valkey key must never delete work or authorize an external side effect.

Production composition requires `VALKEY_URL` with a `redis://` or `rediss://` scheme. Plaintext is
accepted only for loopback, private-address, or `.internal` hosts; public endpoints require TLS.
Query parameters, fragments, malformed/partial authentication, and database numbers outside 0–15
are rejected rather than passed through to the client. Optional
`VALKEY_NAMESPACE`, `VALKEY_CONNECT_TIMEOUT_MS`, and `VALKEY_COMMAND_TIMEOUT_MS` values are validated
at startup. The adapter connects and pings eagerly, disables offline command queues, and bounds each
request so a disconnected store cannot silently accumulate coordination writes. URL data is parsed
into host, port, database, authentication, and TLS fields before the client is constructed, so it
cannot override the offline-queue, retry, or deadline policy.

## Keyspace and isolation

All keys use the configured deployment namespace followed by the fixed `v1` keyspace version.
Workspace, thread, connection, holder, and resource identifiers are base64url-encoded key parts.
They are never concatenated as delimiters. Ill-formed Unicode identifiers are rejected before UTF-8
encoding, which makes the encoding injective. Raw credentials, provider profiles, GitHub tokens,
and lease capabilities are forbidden. The service issues every renewable lease capability from 32
CSPRNG bytes and stores only its SHA-256 digest.

Routes and presence records have explicit millisecond TTLs. Route replacement requires a strictly
newer authoritative fencing generation, or an exact retry by the same connection and process. The
generation is allocated transactionally in PostgreSQL from `cloud_thread_route_generation`, whose
primary key is the same workspace-and-thread scope as the route. A replacement sandbox therefore
receives a higher generation even when its sandbox-scoped worker lease generation starts at one.
Removal also compares the connection and generation, so cleanup from an old socket cannot erase a
new route. A non-authoritative route watermark retains the generation and connection identity after
the live record expires; this prevents an older worker from resurrecting a route during the same
Valkey data lifetime. Presence uses the same generation rule per connection. Watermarks and lease
generation counters expire after 24 hours, which bounds key growth while exceeding every live route
or lease lifetime.

## Leases

The generic lease primitive is intended for exclusive, transient control such as desktop input.
Acquire, heartbeat, and release are atomic Lua operations. A duplicate or competing acquire loses
while a lease is live; the successful acquire is the only response that receives the newly issued
capability. A competing holder can take over only after expiry. Heartbeat and release compare the
holder, capability digest, and fencing generation.

Lease generations are monotonic only within one Valkey data lifetime. A downstream operation that
requires durable authorization must still validate its PostgreSQL approval or lifecycle record.
Desktop input is transient, so losing all leases on a Valkey restart safely returns control to an
unowned state rather than reconstructing ownership from stale data.

## Rate-limit policy

The limiter is an atomic fixed window. A request that would exceed the limit is not counted and
returns the remaining window as `retryAfterMs`. Every call must provide a failure mode:

- `CONTROL_MUTATION_RATE_POLICY` is fail-closed. Public mutations, ownership changes, and other
  security-relevant operations must stop when Valkey cannot decide.
- `PRESENCE_HEARTBEAT_RATE_POLICY` is fail-open. Presence is advisory; an unavailable limiter may
  report a degraded allow decision, but it cannot create authority or mutate durable state.

Corrupt Valkey replies always fail. Fail-open applies only to store unavailability, never invalid
state or invalid caller input.

## Restart and recovery

After Valkey loss, routes, presence, leases, and limiter windows are empty. Reconnecting workers
must first pass the existing mTLS and PostgreSQL worker-lifecycle checks, then republish a route
with their authoritative generation. Clients republish presence after authenticated reconnect.
No coordination adapter writes PostgreSQL or synthesizes durable state during recovery.

The production runtime acquires and pings Valkey before either listener becomes ready. The B4 relay
keeps its process-local socket map for actual frame delivery and mirrors only authenticated worker
routes into Valkey for cross-replica discovery. A new connection must publish its route before it is
accepted. Heartbeat mirroring is advisory and fails open for an already healthy local socket; its
remote route simply expires. Cloud RPC command submission consumes the fail-closed mutation policy
before PostgreSQL persistence.

Pause and sandbox replacement are transient lifecycle operations. After the authoritative lifecycle
pauses or fences the current sandbox, the relay closes its local socket and clears only the current
route and presence records. It retains the route watermark and creates no thread tombstone, so a
resumed or replacement worker can publish immediately with its newly allocated durable generation.
The C3 compensation path uses the production `WorkerRouteLifecycle` adapter to fence the worker and
clear transient state before destroying a failed sandbox; an uncertain fence preserves C3's durable
`cleanup_required` state instead of destroying first. C4 will invoke the pause seam when it adds the
authoritative pause/resume transition.
Only terminal thread destruction or retirement invokes `retireThreadTerminal`: indexed routes,
presence, leases, and their Valkey-only generations are removed atomically and a 24-hour tombstone
blocks stale reconnection. The tombstone is bounded; after it expires, the existing mTLS and
PostgreSQL lifecycle checks remain the authority preventing resurrection. Migration order reserves
`0006` for C5 and `0007` for D1; B5's route counter is migration `0008` and follows both on the
integration branch.

`valkeyCoordination.integration.test.ts` runs only when `AGENTSIN_TEST_VALKEY_URL` is set. CI provides
a dedicated Valkey service and exercises the actual Lua scripts, TTL/PTTL behavior, concurrent lease
acquisition, stale fencing, reconnect/offline-queue behavior, command deadlines, rate-limit
boundaries, and retirement cleanup. The same job provides an isolated PostgreSQL service for
`workerRouteGeneration.postgres.test.ts`, including concurrent replacement allocation and rollback
of a generation whose stale certificate activation is rejected.

The CI service currently follows the official `valkey/valkey:8-alpine` tag. Pinning it by digest is a
non-blocking supply-chain follow-up and must use a digest verified from the official image registry;
we do not guess or copy an unverified digest into the workflow.
