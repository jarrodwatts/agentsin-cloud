# Hosted artifact storage

The hosted control plane stores artifact metadata in PostgreSQL and payload bytes in Cloudflare
R2. PostgreSQL is authoritative: an object is not visible to clients or exports until its byte
length, SHA-256 digest, media type, ETag, and optional object version have been verified and the
artifact row reaches `complete`.

Artifacts are immutable. Their object keys are deterministically derived from validated,
length-bounded workspace, thread, artifact, kind, and digest inputs. Every identity segment is
encoded independently and the resulting key is capped at 1,024 UTF-8 bytes, so separators,
traversal, malformed Unicode, non-canonical Unicode, directional overrides, and multibyte boundary
tricks cannot alias another tenant's key. Storage operations accept an authenticated workspace and
thread plus an artifact ID; they never accept a caller-provided object key.

`cloud_thread_artifact_outbox` records unfinished verification and deletion work. Production starts
a scoped drain which claims bounded batches with PostgreSQL `SKIP LOCKED`, leases each claim, caps
attempts with backoff, requeues expired leases, and stops with the process scope. A process that
loses its database connection after uploading can reconcile the existing object and finish the
metadata transition. Failed, reserved, and uploading rows remain invisible until reconciliation.
Reconciliation hashes a bounded read of the actual object bytes; it never trusts caller-writable
object metadata. Deletion is an explicit state transition. The adapter contract can bind it
atomically to a stored ETag and optional object version; Cloudflare R2 does not currently document
that capability, so the production R2 adapter fails closed and preserves `delete_pending` rather
than risking deletion of a replacement object. A staging capability proof is required before R2
deletion can be enabled.

Railway production composition requires all of:

- `R2_ACCOUNT_ID`
- `R2_ENDPOINT`, exactly `https://<account-id>.r2.cloudflarestorage.com`
- `R2_ARTIFACT_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

`R2_MAX_ARTIFACT_BYTES` defaults to 16 MiB and is capped at 64 MiB.
`R2_REQUEST_TIMEOUT_MS` defaults to 30 seconds and is capped at 120 seconds. The adapter supplies
credentials directly to the S3-compatible client; it never uses the ambient AWS credential chain.
There is no in-memory fallback in production composition.

Thread exports are deterministic, versioned JSON manifests. A durable export intent freezes one
payload-free snapshot before the R2 write, so retries after any crash reuse the same manifest.
Commands, events, approvals, and checkpoints are exported only as ordered identifiers, timestamps,
sequences, and an explicit omitted-payload marker. The export source never selects their envelopes
or payload columns and never queries provider profile, GitHub token lease, wallet, or R2 credential
tables. Completed non-export artifacts appear as integrity descriptors; large payloads remain R2
references. Row count, per-field size, aggregate canonical bytes, and cancellation are bounded.

The deterministic local implementation has the same parent-thread authorization, tenant isolation,
integrity, deadline, and outbox recovery semantics used by service tests. A strict fake S3 boundary
runs the shared immutable-object conformance suite. Live R2 compatibility remains a staging gate;
tests never use real credentials or silently substitute the local implementation in production.
