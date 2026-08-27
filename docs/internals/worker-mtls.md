# Cloud worker mTLS and recovery

The hosted worker has two network paths. Its first, single-use certificate
exchange uses the ordinary control-plane HTTPS origin. All later traffic uses a
dedicated direct TLS service. The direct service must be exposed by Railway as
a TCP port without Railway terminating TLS; application-layer headers are not
worker authentication.

The TLS service sets `requestCert` and `rejectUnauthorized`. Its server
certificate and key come from the deployment secret store, and workers also
pin the server certificate's SPKI digest from their sealed bootstrap. A worker
creates its own P-256 private key inside the sandbox. The private key never
crosses the sandbox boundary. The control plane sends the public SPKI to an
injected `CertificateSigner`; production supplies a KMS/HSM-backed certificate
issuer. No CA or signing private key belongs in this repository, process logs,
PostgreSQL, or a worker bootstrap.

## Identity flow

1. C3 verifies C1's active sandbox reservation and asks the identity service
   for a random, short-lived token. PostgreSQL stores only its SHA-256 digest.
   The record binds workspace, thread, sandbox, reservation, environment
   revision, worker, and provider.
2. C3 materializes the token behind the bootstrap's opaque
   `relayCredentialRef`. The worker exchanges it exactly once over HTTPS and
   deletes the token file only after the certificate grant is durably saved.
3. The signer embeds a SPIFFE URI SAN and the private
   `1.3.6.1.4.1.57264.1.1` extension. Both carry the digest of the complete
   sealed identity. The control plane verifies the returned certificate's
   public key, SAN, validity, issuer attestation, and fingerprint before it
   records the certificate.
4. The direct listener authenticates the real TLS peer fingerprint and SAN
   against PostgreSQL. Identity and replay cursors are never accepted from a
   worker frame.
5. Certificates are short-lived. At `rotateAfter`, the connector closes and
   reconnects after rotating over the old mTLS identity. Generations overlap
   briefly, while the active-lease generation prevents an older certificate
   from replacing a newer route.
6. Pause, destroy, or replacement calls `fenceSandbox`. It consumes unused
   tokens, revokes every sandbox certificate, fences the durable lease, and
   closes the matching in-memory socket.

## Routing and recovery

PostgreSQL owns the worker lease, heartbeat sequence, last-seen timestamp, and
command/event cursors. An atomic upsert permits exactly one active lease per
sandbox. A newer lease generation deterministically closes the old socket, and
an old close callback cannot clear the replacement route.

An event or command acknowledgement is first validated and committed by the
authoritative recovery source. The relay persists only the cursor or delivery
identifier returned by that source, never the value claimed by the worker.
During reconnect, replay is enqueued in order before the route is published to
live senders. Recovery failure closes the unpublished connection and marks its
durable lease disconnected.

The in-memory route registry is only an adapter. B5 may replace it with Valkey
presence and cross-replica routing without changing identity or lease rules.
On process restart, a stable Railway replica identity marks only that replica's
orphaned leases disconnected; sockets reconnect and the `WorkerRecoverySource`
replays B2 commands/events from authoritative persisted cursors. B4 does not
create, pause, resume, or destroy E2B sandboxes.

`WorkerRecoverySource` is also C3's authenticated integration seam. Its
`AuthenticatedWorkerPrincipal` is derived from the verified peer certificate
and contains workspace, thread, environment revision, sandbox reservation,
worker, provider, certificate fingerprint, and certificate generation. C3
must bind reconnect decisions to that principal rather than accepting identity
fields or reusable credentials from a worker request body.

The C2 heartbeat frame is decoded under fixed frame and queue limits. Its full
identity must match the client certificate, and its sequence must increase.
Connection, timeout, rotation, and fencing transitions are also written to
B2's worker lifecycle projection. Heartbeats update the dedicated authoritative
last-seen row rather than creating an unbounded lifecycle event stream.

## Railway deployment and health

Deploy the normal control-plane HTTP service and the direct worker TLS service
as separate Railway services or separately exposed ports sharing PostgreSQL.
The normal service owns `/healthz`, `/readyz`, and the bootstrap exchange. Use
that service for Railway HTTP health checks. The direct TLS service intentionally
has no unauthenticated HTTP health route; use a TCP health probe or process
health from the normal service. Allowing an unauthenticated health exception on
the direct listener would weaken TLS-level client-certificate enforcement.

Bound the TLS handshake, HTTP headers/body, authentication lookup, WebSocket
payload, inbound and outbound queues, connection count, and heartbeat deadline.
Neither service logs bootstrap tokens, certificates, private keys, or raw
credential payloads.

Production startup requires `WORKER_MTLS_PORT`, the three absolute
`WORKER_MTLS_*_FILE` paths, a stable `WORKER_PROCESS_INSTANCE_ID`, and
`WORKER_CERTIFICATE_SIGNER_KMS_KEY_ID`. The mounted private key must be a
regular, owner-only file; TLS material is opened without following symlinks and
is never copied into environment variables. `makeProgram` also requires the
deployment's KMS-backed signer plus the C1 reservation verifier and C3 recovery
source. Direct module execution fails closed until that Railway launcher is
provided; there is no development issuer fallback.
