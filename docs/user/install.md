# Run Agents in Cloud from source

Agents in Cloud does not have a public desktop binary or hosted beta yet. The
[Releases page](https://github.com/jarrodwatts/agentsin-cloud/releases) is the source of truth for
future published builds. The upstream T3 Code downloads and package-registry entries are not Agents
in Cloud releases.

## Requirements

Node.js `^24.13.1` and the [Vite+](https://viteplus.dev/guide/) `vp` command.

For the inherited local development runtime, install and authenticate at least one provider CLI.
See [Providers](#providers) below.

## Start the development app

```bash
curl -fsSL https://vite.plus | bash
vp i
vp run dev:desktop
```

This starts the Electron development client and its local T3-derived server. It is a source
development workflow, not a production cloud deployment. Worktree development uses repository-local
`.t3` state; never point it at a live `~/.t3` data directory.

## Providers

The inherited local runtime drives provider CLIs; it does not ship them. Install the CLI for each
provider you want to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
the runtime looks for, but authenticate with `agent login`, not `cursor-agent login`.

Grok models that support adjustable reasoning show a **Reasoning** control beside the model picker.
The available levels and default come from the installed Grok Build CLI, so they can vary by model
and CLI version.

Run the login command on the machine running the development server. These local credentials are
for development only; Agents in Cloud never copies raw local provider credentials into cloud
sandboxes.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started the server.

### When Auth Is Needed

Provider auth is required before you start a local development session with that provider, not
before you start the app. A provider that is not authenticated shows its status in **Settings** and
fails at session start with the login command to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much the inherited runtime asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping the inherited runtime in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
