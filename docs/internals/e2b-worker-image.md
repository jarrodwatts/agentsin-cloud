# E2B worker image

The E2B base-image definition contains the bundled cloud worker and its restricted provider child.
The bundle is minified without source paths and hashed into the template manifest. Publication is
fail-closed until every mutable package and native input is reproducibly locked; only a build that
passes that gate may be called immutable.

The root worker supervises two untrusted identities. `agentsin-agent` runs the selected provider
runtime and `agentsin-inspector` runs the X server, XFCE, VNC/noVNC, and interactive inspector PTYs
behind `setpriv` and Bubblewrap. They have different fixed UIDs and GIDs, have no sudo grant, and
share only the explicit ACL on `/workspace`. The desktop uses an owner-only Xauthority cookie and a
new per-sandbox VNC password; the provider identity cannot read either. Bootstrap and mTLS
directories remain root-only under `/run/agentsin`, while the provider-credential root is
traverse-only so the restricted child can reach only its own materialization.

The fixed root-owned `/opt/agentsin/start-sandbox.sh` is the image entrypoint. It starts the desktop,
waits for `/run/agentsin/bootstrap/sealed.json`, and invokes the worker exactly once. The worker
starter accepts only that opaque, owner-only path. It never accepts bootstrap JSON, provider
credentials, wallet material, or an E2B API key as an argument or environment value. The provider
service is a fixed root-owned
`/opt/agentsin/provider/provider-service.mjs` artifact whose separate digest must match before the
worker starts. The base image intentionally does not provide a permissive development provider or
secret broker.

The image verifier checks installed binaries, native PTY loading, distinct users, workspace ACLs,
artifact hashes, empty secret directories, absent local login homes, and a real executable boot that
must fail closed without a sealed bootstrap. Each desktop launch clears old PID data, creates a
random owner-only generation directory, and atomically records each child PID with its Linux process
start time. The desktop probe binds the current generation, PID, unchanged start time, all inspector
UIDs, canonical root-owned executable, and exact argv before accepting X/VNC. It rechecks identity
after inspection so a stale or reused PID cannot satisfy the probe. The noVNC policy pins both its
Bash interpreter and root-owned proxy script. The agent UID cannot read the Xauthority, VNC
password, or generation pointer; unauthenticated X access fails, and VNC advertises password
authentication without a no-auth option. Unexpected desktop exit is always fatal, including status
zero; a clean worker exit is the separate intentional shutdown path. INT and TERM clean up exactly
once and return deterministic signal-derived statuses. A local hermetic canary additionally boots
the worker, selects the hosted mTLS adapter, completes replay and heartbeat, and shuts down with fake
in-memory ports only.

## Release gate

Image publication is currently blocked by
`packages/e2b-sandbox/template/image-provenance.lock.json`. Before any E2B API call, the build
requires either a fully built OCI digest or an immutable Debian snapshot plus the SHA-256 of the
complete resolved apt package closure and the SHA-256 closure of the Linux `node-pty` native
artifacts. A clean independent rebuild must reproduce those values before `publishable` may become
true. The in-image verifier recomputes both closures. Until then, `template:build` exits before a
remote build and the in-image verifier also refuses publication; the source hash is explicitly a
blocked definition hash, not a reproducible image claim.

C2.2/C3.1 must provide the fixed hosted T3 `ProviderService`, the concrete control-plane secret
broker, and the worker gateway that resolves a sealed bootstrap reference inside the sandbox. A
live staging canary must then create one E2B sandbox, materialize only opaque references, exchange a
real mTLS certificate, connect the relay, start the selected official provider CLI, and prove
credential cleanup. The hermetic canary does not satisfy that release gate, and this change performs
no E2B API call or network write.
