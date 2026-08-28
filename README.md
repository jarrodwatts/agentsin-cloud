# Agents in Cloud

> Forked from T3 Code. See [NOTICE](./NOTICE) for attribution and [LICENSE](./LICENSE) for the preserved MIT terms.

Agents in Cloud is being built as a macOS control surface for coding agents that run in cloud
sandboxes. Each thread owns one remote workspace, so agent work can continue after the desktop app
closes.

The project builds on T3 Code's provider harness. The v1 architecture is designed for Codex, Claude
Code, Cursor, Grok, OpenCode, and OpenRouter connections.

## Status

> [!WARNING]
> Agents in Cloud is under active development. There is no public desktop binary or hosted beta
> yet. Published builds will appear on the
> [Releases page](https://github.com/jarrodwatts/agentsin-cloud/releases).

The first release is intentionally macOS-only. The web and mobile clients inherited from T3 Code
remain in the repository as shared architecture, but they are not Agents in Cloud v1 release
targets.

## Develop locally

Install the repository's pinned Node and Vite+ toolchain, then install dependencies:

```bash
curl -fsSL https://vite.plus | bash
vp i
```

Start the desktop development client:

```bash
vp run dev:desktop
```

This is a source-development workflow, not a production cloud deployment. See
[Run from source](./docs/user/install.md) for requirements and the current runtime boundary.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Run Agents in Cloud from source](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Inherited T3 runtime: [run the local server as a Linux background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

Agents in Cloud uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an
[Ideas discussion](https://github.com/jarrodwatts/agentsin-cloud/discussions/categories/ideas).
