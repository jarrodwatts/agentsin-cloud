# Provider credential security

Hosted provider login runs in a disposable credential-only job beside the control plane's KMS
boundary, never inside the thread worker. The job has an empty home, no repository or worker mounts,
a digest-pinned provider executable, allowlisted egress, bounded output and runtime, and confirmed
process-tree termination. Provider-specific command construction belongs to the provider adapter.
The runner returns an owned mutable byte buffer locally; the coordinator immediately seals and
zeroizes it. There is no worker-to-control-plane credential transport.

Each stored provider profile uses a random AES-256-GCM data key bound to the workspace, assigned
profile ID, provider instance, provider driver, and KMS key version. A deployment KMS wraps that data
key. PostgreSQL receives only the opaque envelope. An active, server-authorized materialization lease
is required before the KMS seam may unwrap it, and plaintext crosses only the certificate-pinned mTLS
control-plane-to-worker binary channel. Both ends zeroize owned mutable buffers after success,
failure, timeout, disconnect, or shutdown.

Pause, destroy, and sandbox replacement transactionally move every affected materialization into
durable cleanup-required state before the worker route is removed. Cleanup is dispatched while the
current route is still usable; failures remain retryable in PostgreSQL and reconnect reconciliation
must confirm generation-matched absence before the row becomes cleaned. Active reconnect also rearms
the worker's local expiry timer through the relay-attested provisional transport before that route is
published; the normal authorization path still requires an active published route. A worker reports
materialization success only after its expiry cleanup is armed, and the control plane refreshes its
clock immediately before the transactional authorization-expiry confirmation.

Sandbox replacement invalidates both active and provisional relay routes after the durable identity
fence. A reconnect revalidates its exact certificate, lease, and route generations immediately before
publication and again before activation, so an in-flight old-sandbox reconciliation cannot reappear.

Provider-login attempts are count-, byte-, rate-, and time-bounded before a durable login row is
allocated. Terminal rows whose worker cleanup is confirmed are permanently purged after 30 days.
Running sessions, retryable cleanup failures, and current provider profiles are never included in
that purge. Before each deletion, PostgreSQL retains only daily non-secret aggregates by workspace,
provider, and terminal outcome. Login URLs, device codes, CLI output, account labels, and credential
material are not copied into the aggregate.

Inside the thread sandbox, the privileged worker owns the mTLS identity and private credential root.
Ordinary provider and agent commands run through a restricted supervisor under the configured
unprivileged UID/GID with supplementary groups cleared and no privileged file descriptors. Production
startup fails closed unless the worker uses explicit hosted mode, the kernel identity boundary can be
established, trusted runtime artifacts match their pinned digests, the credential root is disjoint
from the checkout, the login runner validates its isolation configuration, and the KMS adapter exposes
a non-empty key ID and key version. The root interpreter path and SHA-256 are explicit hosted
configuration. Every privileged launch reopens and verifies its root-owned, non-writable ancestor
chain, mode, digest, device, and inode, executes through the verified descriptor, and verifies the
inline launcher digest before dropping supplementary groups and UID/GID.
