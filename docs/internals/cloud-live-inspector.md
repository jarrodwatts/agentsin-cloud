# Cloud live inspector

The hosted inspector is a bounded, authenticated transport from the desktop client through the
Railway control plane to the one current E2B worker for a thread. It does not expose E2B directly
and it does not add a generic command-execution endpoint.

The client upgrades `/api/v1/inspector` with a thread and lifecycle-attempt identifier. Better Auth
derives the user and workspace. PostgreSQL resolves the current thread attempt, and the control
plane accepts the connection only when the attempt is ready and its complete sandbox, worker,
environment revision, provider, and route generation match the active mTLS worker lease. Caller
workspace IDs are absent. Every control-plane-to-worker command carries the server-created binding;
worker frames must echo it and use a contiguous per-session sequence.

The protocol is a closed versioned union for Terminal, Files, Ports, Browser, and Desktop. Paths are
workspace-relative. Hosted Linux pins the checkout root's device and inode, traverses every
directory by descriptor with `O_NOFOLLOW`, and performs reads and compare-and-swap writes through
those descriptors. PTYs bind the pinned `/proc/<worker-pid>/fd/<root-fd>` descriptor and assert its
device/inode again at spawn; they never resolve the original checkout path. Every inspector writer
shares a path lock and observes cancellation before commit. Conditional writes atomically capture
the named version into a random worker-owned `0700` transaction directory outside the checkout.
Replacement bytes are prepared there behind a retained descriptor, verified by digest and inode,
and published with a no-replace hard link. Hosted startup requires
that directory to share the checkout filesystem while its parent is not writable by the untrusted
provider uid. A competing writer therefore wins safely instead of being overwritten. Replacing the
root or any traversed component fails the operation. Sensitive paths are denied as a second defense.
Ports are HTTP(S)-only adapter calls within the configured unprivileged range. Browser and Desktop
use an injected codec-neutral visual adapter; the default E2B worker reports them unsupported
instead of claiming a native desktop API. Browser or desktop input is denied until C7 supplies an
exclusive control-lease authorizer.

Hosted terminal processes use a dedicated UID/GID that must differ from both worker root and the
provider runtime identity. Hosted startup supplies them as `AGENTSIN_INSPECTOR_UID` and
`AGENTSIN_INSPECTOR_GID` independently of `AGENTSIN_AGENT_UID` and `AGENTSIN_AGENT_GID`; missing or
reused identities fail startup. A fixed trusted launcher opens the already pinned checkout descriptor,
then `setpriv` clears supplementary groups, drops to the inspector identity, and sets
no-new-privileges before executing Bubblewrap. The shell has no capabilities and runs in separate
Bubblewrap user, mount, process, IPC, UTS, and network namespaces; further user namespaces are
disabled. The interactive inspector shell has no worker-loopback or host-network access; the
separately supervised provider runtime retains its explicitly configured outbound access. The PTY
namespace contains the checkout and a read-only operating-system runtime, but not the worker
bootstrap, provider profile, mTLS directory, worker home, or host `/run` and `/tmp`. The secret
broker owns a streaming redactor for remaining known values; raw secret values are not passed to the
inspector runtime.
The provider consumes its temporary materialization at startup, which is scrubbed before the
inspector factory or protected-path validation can run.

Both client and worker sockets have frame, queue, byte, session, heartbeat, request-rate,
concurrency, terminal, artifact, and deadline bounds. A live runtime keeps a bounded replay window
across relay reconnects, and the ready frame exposes its sequence as a client resume cursor. A
replacement runtime without that replay history rejects the resume instead of inventing continuity;
the sequence-free `inspector.resume-rejected` control frame advances the bridge to the worker's
explicit latest cursor without being inserted into data history. Only frames matching a bounded,
expiring closed-session binding tombstone are treated as late cleanup; unknown sessions or changed
attempt/route bindings remain fatal worker-identity failures. Active terminal reservations are
counted independently by the control plane and survive reconnect/replay until a sequenced
terminal-retirement event or session teardown. A cancelled open remains reserved; if the worker
reports that it won the race, the bridge sends a bounded close request and waits for retirement.
Durable thread/workspace
recovery owns reconstruction. An older route, changed attempt binding, or
non-contiguous frame fails closed. PostgreSQL remains authoritative for thread and worker
lifecycle. Valkey is not used for inspector history.

Inline terminal output is capped. Larger terminal chunks and visual frames cross the already
authenticated worker relay as bounded artifact proposals. The control plane verifies their decoded
length and SHA-256 digest, uploads them through the B6 artifact service/outbox, and sends clients
only the scoped artifact identity and integrity descriptor. Raw R2 keys, credentials, provider
profiles, and environment values are never inspector frame fields. Clients retrieve artifact bytes
from the Better Auth-protected inspector artifact endpoint, which derives the workspace from the
session and requires the exact current thread attempt; no unauthenticated artifact route exists.

## Current staging gaps

C6 defines and secures the Browser, Desktop, and Port adapter boundaries but deliberately ships
fail-closed unsupported adapters. Wiring an E2B-compatible browser capture, a real desktop codec,
and public HTTP(S) port previews remains product integration work. Exclusive user input and
Take Control remain C7. Inspector replay is intentionally bounded; when its live window is evicted,
durable artifact/thread reconstruction must be supplied by the later client experience rather than
fabricated by this transport. The C1 E2B template must provision an explicit checkout ACL when an
interactive inspector shell needs write access: the provider-owned checkout and inspector UID/GID
are intentionally distinct, and C6 does not weaken ownership or make the checkout world-writable.
