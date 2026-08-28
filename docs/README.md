# Agents in Cloud docs

Agents in Cloud is derived from T3 Code. The local runtime, provider, and client documentation below
describes the inherited foundation; cloud-specific behavior is documented separately as it lands.

## Development

- [Run Agents in Cloud from source](./user/install.md)

## Inherited T3 runtime guides

- [Permission modes](./user/permission-modes.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Review usage](./user/usage.md)
- [Customize a project icon](./user/project-settings.md)
- [Mobile appearance](./user/mobile-appearance.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [Background service (Linux)](./user/background-service.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md)

Inherited mobile client: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on Agents in Cloud

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [Workspace layout](./internals/workspace-layout.md)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [CI gates](./internals/ci.md)
- [Engineering work artifacts](./internals/work-artifacts.md)
- [Cloud coordination](./internals/cloud-coordination.md)
- [Cloud thread runtime](./internals/cloud-thread-runtime.md)
- [Cloud thread store](./internals/cloud-thread-store.md)
- [E2B runtime](./internals/cloud-e2b-runtime.md)
- [E2B worker image](./internals/e2b-worker-image.md)
- [Worker mTLS](./internals/worker-mtls.md)
- [Cloud live inspector](./internals/cloud-live-inspector.md)

### Runbooks

- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
