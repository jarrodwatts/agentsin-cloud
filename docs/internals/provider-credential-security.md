# Provider credential security

Hosted provider login runs in a disposable credential-only job beside the control plane's KMS
boundary, never inside the thread worker. The job has an empty home, no repository or worker mounts,
a digest-pinned provider executable, allowlisted egress, bounded output and runtime, and confirmed
process-tree termination. Provider-specific command construction belongs to the provider adapter.
The runner returns an owned mutable byte buffer locally; the coordinator immediately seals and
zeroizes it. There is no worker-to-control-plane credential transport.

The first hosted adapters support exactly the existing T3 driver identifiers `codex` and
`claudeAgent`. Codex runs the official `codex login --device-auth` flow with an isolated
`CODEX_HOME`; Claude Code runs `claude auth login --claudeai` with isolated
`CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`. Both commands are executed as an exact
argument vector without a shell from an absolute, SHA-256-pinned executable. Raw stdout and stderr
remain inside the disposable job. The job emits only validated HTTPS authorization URLs, bounded
device codes, and stable status values. URL hosts must match that adapter's egress allowlist.

Credential jobs inherit no host environment. Their complete base environment is an explicit
`HOME`, `TMPDIR`, executable `PATH`, fixed locale, and `NO_COLOR`; the adapter adds only its fixed
isolated config-directory variables. Extra variables fail startup validation. In particular, API
keys, OAuth/auth tokens, credentials, endpoint overrides, and base-URL overrides for OpenAI, Codex,
Anthropic, or Claude are never inherited or accepted. The disposable-job implementation must create
the declared private directories before launching the CLI and must pass this exact environment map.

The job starts from empty storage and may export only the adapter's explicit file allowlist. Codex
requires `auth.json`. Claude requires `.credentials.json`. Those files are encoded into the canonical
provider-profile bundle under `codex/` or `claude/`; settings, missing required files, extra files,
malformed paths, oversized bundles, and unknown drivers fail closed. Login tests use a fake job
executor and never contact a provider or read a developer's existing credentials.

The runner compares the server clock with the login deadline before launch and again immediately
after the CLI exits. An authorization completed at or after its deadline is wiped before any terminal
event is emitted and is recorded as expired, never authorized. PostgreSQL independently makes the
same deadline decision while holding the login row lock; its single completion statement stores the
encrypted envelope only when `completedAt < expiresAt`, and otherwise atomically clears all envelope
columns and records the attempt as expired.

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

`HostedAgentConnectionAdapter` is the server-owned implementation of begin, poll, seal,
materialize, validate, refresh, and revoke. It accepts the authenticated Better Auth principal and
identifier-only commands; workspace, driver, clock, sandbox, worker identity, and target path remain
server-derived. Refresh confirms that an encrypted reusable CLI profile is active and structurally
valid without decrypting it. The official CLIs perform access-token refresh only after that profile is
materialized into the authorized sandbox. A rejected or expired profile therefore requires the normal
login flow again; the platform does not impersonate either provider's OAuth client.
