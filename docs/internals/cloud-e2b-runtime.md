# Hosted E2B runtime

E2B is the only hosted sandbox provider. The control plane composes the official E2B SDK with the
PostgreSQL sandbox identity store; there is no alternate provider or local-compute fallback.

Every create first commits a `cloud_e2b_sandbox_identity` reservation. Its partial unique index is
the one-sandbox-per-thread fence for pending, active, and cleanup-required resources. The E2B
sandbox receives non-secret workspace, environment, project, thread, revision, reservation, and
repository identifiers as metadata. Connect, command, file, PTY, pause, resume, port, usage, and
destroy operations compare that metadata with the durable identity before continuing.

Hosted startup requires `E2B_API_KEY`. An environment revision must independently pin an immutable
`e2b://template/<provider-template-id>@build-<provider-build-id>` image. Creation verifies that
exact provider-native template/build pair is still ready before requesting compute, then persists
both identities beside the thread reservation. Creation and reconnect reject any remote sandbox
whose template or build metadata differs. Missing credentials fail configuration; a missing or
mutable template reference fails before remote compute is created.

The installed E2B 2.46 SDK cannot bind a provider build ID to `Sandbox.create`; it accepts only a
template or tag. The official runtime therefore reports immutable launch as unavailable and fails
before provider create I/O. Test runtimes may advertise the build-bound capability to exercise the
rest of the lifecycle, but hosted creation remains gated until E2B exposes and the live canary proves
an immutable build-bound launch primitive. Build-status verification alone is not sufficient.
Using a unique, never-reused template name or tag lowers accidental drift but is not accepted as
strict proof because the API still resolves that mutable identity at launch time. This requires an
explicit E2B product/API feature escalation; the adapter must not send an undocumented `buildID`.

Sandbox networking is default-deny: both public ingress and outbound Internet access are disabled
at creation and during the image verification probe. Future network grants must pass through an
explicitly reviewed broker/allowlist path; possession of a provider, GitHub, or plugin credential
never implies arbitrary egress.

Worker bootstrapping crosses an opaque-reference boundary. The lifecycle stores a sealed bootstrap
reference, while the hosted thread lifecycle verifies the active identity and immutable remote
template before the injected KMS/secret-broker adapter resolves and materializes that reference
inside the exact bound sandbox. Cleanup-required identities are quarantined from every ordinary
operation. The control-plane adapter never accepts or returns bootstrap
plaintext, and implementations must not place plaintext in command arguments, environment
variables, logs, or durable rows. E2B traffic tokens follow the same rule and are converted to
opaque broker references before leaving the SDK adapter.

## Required production gates

The hosted composition deliberately requires production implementations for streaming R2 artifact
writes, durable PTY ownership, distributed lifecycle locking, E2B traffic-token sealing, and sealed
bootstrap materialization. It has no in-memory defaults for those capabilities.

Before enabling hosted thread creation, operators must also complete:

- a live E2B canary that creates the pinned image, verifies metadata, executes a bounded command,
  pauses, resumes, reads resource-observability gauges, and destroys the sandbox;
- an E2B SDK/API launch primitive that binds the persisted provider template ID and build ID to the
  created sandbox, replacing the current fail-closed capability gate;
- the mTLS worker relay and one-time worker certificate bootstrap;
- the KMS-backed provider credential and GitHub token brokers;
- the authenticated desktop stream and exclusive desktop lease path.

E2B resource gauges are observability only and are never accepted as billable `UsageSample`
evidence. Billing remains gated on authenticated, reconcilable E2B cost evidence.
