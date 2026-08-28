# Hosted E2B runtime

E2B is the only hosted sandbox provider. The control plane composes the official E2B SDK with the
PostgreSQL sandbox identity store; there is no alternate provider or local-compute fallback.

Every create first commits a `cloud_e2b_sandbox_identity` reservation. Its partial unique index is
the one-sandbox-per-thread fence for pending, active, and cleanup-required resources. The E2B
sandbox receives non-secret workspace, environment, project, thread, revision, reservation, and
repository identifiers as metadata. Connect, command, file, PTY, pause, resume, port, usage, and
destroy operations compare that metadata with the durable identity before continuing.

Hosted startup requires `E2B_API_KEY`. An environment revision must independently pin an immutable
`e2b://template/<name>:build-<uuid>` image. Missing credentials fail configuration; a missing or
mutable template reference fails before remote compute is created.

Worker bootstrapping crosses an opaque-reference boundary. The lifecycle stores a sealed bootstrap
reference, while the injected KMS/secret-broker adapter resolves and materializes that reference
inside the exact bound sandbox. The control-plane adapter never accepts or returns bootstrap
plaintext, and implementations must not place plaintext in command arguments, environment
variables, logs, or durable rows. E2B traffic tokens follow the same rule and are converted to
opaque broker references before leaving the SDK adapter.

## Required production gates

The hosted composition deliberately requires production implementations for streaming R2 artifact
writes, durable PTY ownership, distributed lifecycle locking, E2B traffic-token sealing, and sealed
bootstrap materialization. It has no in-memory defaults for those capabilities.

Before enabling hosted thread creation, operators must also complete:

- a live E2B canary that creates the pinned image, verifies metadata, executes a bounded command,
  pauses, resumes, reads usage, and destroys the sandbox;
- the mTLS worker relay and one-time worker certificate bootstrap;
- the KMS-backed provider credential and GitHub token brokers;
- the authenticated desktop stream and exclusive desktop lease path.

Until those gates pass, production launchers should construct no hosted thread lifecycle executor.
