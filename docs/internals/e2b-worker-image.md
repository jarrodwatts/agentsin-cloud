# E2B worker image

The immutable E2B base image contains the bundled cloud worker and its restricted provider child.
The bundle is minified without source paths, hashed into the template manifest, and copied beside a
locked Linux `node-pty` installation. Template publication stops before assigning an immutable E2B
tag when either emitted artifact differs from the checked-in manifest.

The root worker supervises two untrusted identities. `agentsin-agent` runs the selected provider
runtime and `agentsin-inspector` runs interactive inspector PTYs behind `setpriv` and Bubblewrap.
They have different fixed UIDs and GIDs, have no sudo grant, and share only the explicit ACL on
`/workspace`. Bootstrap, mTLS, and provider credential directories remain root-only under
`/run/agentsin`.

`/opt/agentsin/start-worker.sh` accepts one opaque, owner-only bootstrap file reference below
`/run/agentsin/bootstrap`. It never accepts bootstrap JSON, provider credentials, wallet material,
or an E2B API key as an argument or environment value. The provider service is a fixed root-owned
`/opt/agentsin/provider/provider-service.mjs` artifact whose separate digest must match before the
worker starts. The base image intentionally does not provide a permissive development provider or
secret broker.

The image verifier checks installed binaries, native PTY loading, distinct users, workspace ACLs,
artifact hashes, empty secret directories, absent local login homes, and a real executable boot that
must fail closed without a sealed bootstrap. A local hermetic canary additionally boots the worker,
selects the hosted mTLS adapter, completes replay and heartbeat, and shuts down with fake in-memory
ports only.

## Release gate

C2.2/C3.1 must provide the fixed hosted T3 `ProviderService`, the concrete control-plane secret
broker, and the worker gateway that resolves a sealed bootstrap reference inside the sandbox. A
live staging canary must then create one E2B sandbox, materialize only opaque references, exchange a
real mTLS certificate, connect the relay, start the selected official provider CLI, and prove
credential cleanup. The hermetic canary does not satisfy that release gate, and this change performs
no E2B API call or network write.
