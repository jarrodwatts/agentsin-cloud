# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

The [ordinary CI workflow](../../.github/workflows/ci.yml) and the
[protected worker workflow](../../.github/workflows/protected-worker-isolation.yml) run these
quality gates on pull requests and pushes to `main`:

- **Check**: `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists and
  uses only imports that Electron's sandbox can load. The verifier parses imports, then executes the
  trusted artifact with controlled bridge stubs to confirm that its required APIs are callable.
- **Test**: `vp run test` across the workspace.
- **Protected Worker Isolation**: a separate `pull_request_target` workflow whose definition and
  harness always come from the protected default branch. It fetches the event's exact PR commit as
  inert data, rejects new or changed symlinks, submodules, and dependency-input drift, then builds
  and tests the worker as UID/GID 65534 inside a disposable digest-pinned container. The container
  has no host mounts, network, capabilities, inherited credentials, or writable root filesystem. A
  base-owned, hash-verified probe and the host harness independently verify identity, groups,
  capabilities, mount/network/PID namespaces, host-file and secret denial, network denial, and the
  final exit status. The ordinary **Test Worker Isolation Compatibility** job remains an
  unprivileged semantic check and does not itself elevate the test command. Like every ordinary
  `pull_request` job on a [GitHub-hosted Linux runner][runner-admin],
  it is compatibility feedback rather than a security boundary: the runner account has ambient
  passwordless `sudo`, so its result is never security evidence for untrusted code. The five
  product-specific Linux root integration tests run only from the trusted `main`
  push after merge, with commit-pinned setup actions and a fixed root `PATH`.
- **Mobile Native Static Analysis**: `vp run lint:mobile` on macOS, wrapping
  `scripts/mobile-native-static-check.ts`. A cheap Linux **Mobile Native Changes** job gates it:
  the macOS runner only boots when the diff touches `apps/mobile` Swift/Kotlin sources, the
  SwiftLint/detekt/ktlint configuration, the `Brewfile`, the check script, the root `package.json`
  that defines `lint:mobile`, or `ci.yml`. Otherwise the job is skipped, which GitHub reports as
  success for the required check. Renames are matched on both their old and new path. The gate fails
  open in every other case: if the changed-file list cannot be resolved, GitHub truncates it, or the
  gate job itself fails, the lint runs.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts`, so
  release breakage surfaces on PRs rather than at tag time.

The protected check is authoritative only after this workflow exists on `main`. Bootstrap it in
two steps: merge the base-owned workflow without requiring its check, then open a harmless follow-up
pull request and confirm the distinct **Protected Worker Isolation** check passes. Only after that
proof should branch protection require the check. After the workflow itself or a bootstrap repair
merges, use a new documentation-only follow-up to validate the default-branch-owned check without
changing its inputs. A dependency-input change must likewise update the protected base first; the
harness fails closed instead of installing PR-selected dependencies on the host.

`.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`)
desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release. It auto-enables
signing only when platform credentials are present. macOS passkey builds additionally require
`APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing.
Without the core signing credentials, it still releases unsigned artifacts.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.

[runner-admin]: https://docs.github.com/actions/reference/runners/github-hosted-runners#administrative-privileges
