import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type {
  SandboxProvider,
  SandboxProviderError,
  SandboxProviderSandbox,
} from "@t3tools/contracts/cloud";
import { SandboxId, SandboxSnapshotId } from "@t3tools/contracts/cloud";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";

import { e2bDescriptionMatchesIdentity, e2bIdentityMetadataFor } from "./identity.ts";
import { E2B_ACTIVE_TIMEOUT_MS, parseE2bTemplateReference } from "./template.ts";
import {
  E2bClientFailure,
  type E2bSandboxDescription,
  type E2bSandboxProviderDependencies,
  type SandboxIdentityRecord,
} from "./types.ts";

const DEFAULT_MAX_INLINE_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 2_000;
const DEFAULT_MAX_LIST_BYTES = 2 * 1024 * 1024;

const error = (
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
): SandboxProviderError => ({
  code,
  message,
  retryable,
  ...(details === undefined ? {} : { details }),
});

const mapFailure = (operation: string, cause: unknown): SandboxProviderError => {
  if (cause instanceof E2bClientFailure) {
    const code =
      cause.code === "authentication"
        ? "E2B_AUTHENTICATION_FAILED"
        : cause.code === "notFound"
          ? "E2B_SANDBOX_NOT_FOUND"
          : cause.code === "outputLimit"
            ? "E2B_OUTPUT_LIMIT_EXCEEDED"
            : cause.code === "invalidRequest"
              ? "E2B_INVALID_REQUEST"
              : cause.code === "rateLimited"
                ? "E2B_RATE_LIMITED"
                : cause.code === "timeout"
                  ? "E2B_TIMEOUT"
                  : "E2B_UNAVAILABLE";
    return error(code, cause.message, cause.retryable, {
      operation,
      ...(cause.createDisposition === undefined
        ? {}
        : { createDisposition: cause.createDisposition }),
    });
  }
  return error("E2B_INTERNAL_ERROR", `E2B ${operation} failed`, true, { operation });
};

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => mapFailure(operation, cause),
  });

const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const iso = (date: Date) => date.toISOString();
const dateFromIso = (value: string) => DateTime.toDate(DateTime.makeUnsafe(value));

const confinedPath = (workspaceDirectory: string, candidate: string | undefined) => {
  const root = NodePath.posix.resolve(workspaceDirectory);
  const resolved = NodePath.posix.resolve(root, candidate ?? ".");
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new E2bClientFailure({
      code: "invalidRequest",
      message: "Sandbox operation path must remain inside the thread workspace",
      retryable: false,
    });
  }
  return resolved;
};

const inlineFileContent = (bytes: Uint8Array) => {
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf8" as const,
    };
  } catch {
    return { content: Buffer.from(bytes).toString("base64"), encoding: "base64" as const };
  }
};

const createDispositionFrom = (failure: SandboxProviderError) => {
  if (typeof failure.details !== "object" || failure.details === null) return undefined;
  if (!("createDisposition" in failure.details)) return undefined;
  const disposition = failure.details.createDisposition;
  if (typeof disposition !== "object" || disposition === null || !("status" in disposition)) {
    return undefined;
  }
  if (disposition.status === "no-compute-confirmed" || disposition.status === "cleanup-confirmed") {
    return {
      status: disposition.status,
      ...("providerHandle" in disposition && typeof disposition.providerHandle === "string"
        ? { providerHandle: disposition.providerHandle }
        : {}),
    } as const;
  }
  if (
    disposition.status !== "cleanup-required" ||
    !("reclaimMetadata" in disposition) ||
    typeof disposition.reclaimMetadata !== "object" ||
    disposition.reclaimMetadata === null ||
    !Object.values(disposition.reclaimMetadata).every((value) => typeof value === "string")
  ) {
    return undefined;
  }
  return {
    status: "cleanup-required" as const,
    ...("providerHandle" in disposition && typeof disposition.providerHandle === "string"
      ? { providerHandle: disposition.providerHandle }
      : {}),
    reclaimMetadata: disposition.reclaimMetadata as Readonly<Record<string, string>>,
  };
};

const toSandbox = (
  identity: SandboxIdentityRecord,
  remote: E2bSandboxDescription,
  updatedAt: string,
): SandboxProviderSandbox => ({
  sandboxId: identity.sandboxId,
  workspaceId: identity.workspaceId,
  environmentId: identity.environmentId,
  infrastructureProvider: "e2b",
  workspace: {
    workspaceId: identity.workspaceId,
    projectId: identity.projectId,
    threadId: identity.threadId,
    repositoryIdentity: identity.repositoryIdentity,
    workspaceDirectory: identity.workspaceDirectory,
  },
  binding: {
    workspaceId: identity.workspaceId,
    threadId: identity.threadId,
    sandboxId: identity.sandboxId,
  },
  revisionId: identity.revisionId,
  providerHandle: identity.providerHandle,
  state: remote.state === "paused" ? "suspended" : "ready",
  createdAt: identity.createdAt,
  updatedAt,
});

export const makeE2bSandboxProvider = (
  dependencies: E2bSandboxProviderDependencies,
): SandboxProvider => {
  const activeTimeoutMs = dependencies.activeTimeoutMs ?? E2B_ACTIVE_TIMEOUT_MS;
  const maxInlineFileBytes = dependencies.maxInlineFileBytes ?? DEFAULT_MAX_INLINE_FILE_BYTES;
  const maxListEntries = dependencies.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const maxListBytes = dependencies.maxListBytes ?? DEFAULT_MAX_LIST_BYTES;

  const openExecutionWriters = async (request: Parameters<SandboxProvider["execute"]>[0]) => {
    const stdout = await dependencies.artifacts.open({
      workspaceId: request.workspaceId,
      environmentId: request.environmentId,
      sandboxId: request.sandboxId,
      requestId: request.requestId,
      kind: "command-stdout",
      contentType: "text/plain; charset=utf-8",
    });
    try {
      const stderr = await dependencies.artifacts.open({
        workspaceId: request.workspaceId,
        environmentId: request.environmentId,
        sandboxId: request.sandboxId,
        requestId: request.requestId,
        kind: "command-stderr",
        contentType: "text/plain; charset=utf-8",
      });
      return { stdout, stderr };
    } catch (cause) {
      await stdout.abort().catch(() => undefined);
      throw cause;
    }
  };

  const openPtyWriter = (request: Parameters<SandboxProvider["pty"]>[0]) =>
    dependencies.artifacts.open({
      workspaceId: request.workspaceId,
      environmentId: request.environmentId,
      sandboxId: request.sandboxId,
      requestId: request.requestId,
      kind: "pty-output",
      contentType: "application/octet-stream",
    });

  const getIdentity = (request: {
    readonly sandboxId: SandboxIdentityRecord["sandboxId"];
    readonly workspaceId: SandboxIdentityRecord["workspaceId"];
    readonly environmentId: SandboxIdentityRecord["environmentId"];
    readonly threadId: SandboxIdentityRecord["threadId"];
  }) =>
    Effect.gen(function* () {
      const lookup = yield* attempt("identity lookup", () =>
        dependencies.identities.get(request.workspaceId, request.sandboxId),
      );
      if (lookup === undefined) {
        return yield* Effect.fail(
          error("E2B_SANDBOX_NOT_FOUND", "No E2B sandbox identity is registered", false),
        );
      }
      if (lookup.state === "cleanup_required") {
        return yield* Effect.fail(
          error(
            "E2B_RECONCILIATION_REQUIRED",
            "The E2B sandbox is quarantined pending operator reconciliation",
            false,
          ),
        );
      }
      const identity = lookup.identity;
      if (
        identity.provider !== "e2b" ||
        identity.sandboxId !== request.sandboxId ||
        identity.workspaceId !== request.workspaceId ||
        identity.environmentId !== request.environmentId ||
        identity.threadId !== request.threadId
      ) {
        return yield* Effect.fail(
          error("E2B_IDENTITY_MISMATCH", "E2B sandbox identity does not match the request", false),
        );
      }
      return identity;
    });

  const getActive = (request: {
    readonly sandboxId: SandboxIdentityRecord["sandboxId"];
    readonly workspaceId: SandboxIdentityRecord["workspaceId"];
    readonly environmentId: SandboxIdentityRecord["environmentId"];
    readonly threadId: SandboxIdentityRecord["threadId"];
  }) =>
    Effect.gen(function* () {
      const identity = yield* getIdentity(request);
      if (identity.destroyedAt !== undefined) {
        return yield* Effect.fail(
          error("E2B_SANDBOX_DESTROYED", "The E2B sandbox has been destroyed", false),
        );
      }
      const remote = yield* attempt("inspect", () =>
        dependencies.client.inspect(identity.providerHandle),
      );
      if (remote === undefined) {
        return yield* Effect.fail(
          error("E2B_SANDBOX_NOT_FOUND", "The registered E2B sandbox no longer exists", false),
        );
      }
      if (!e2bDescriptionMatchesIdentity(remote, identity)) {
        return yield* Effect.fail(
          error(
            "E2B_IDENTITY_MISMATCH",
            "E2B sandbox metadata does not match its registration",
            false,
          ),
        );
      }
      return { identity, remote };
    });

  const getRunning = (request: Parameters<typeof getActive>[0]) =>
    Effect.gen(function* () {
      const active = yield* getActive(request);
      if (active.remote.state === "paused") {
        return yield* Effect.fail(
          error("E2B_SANDBOX_PAUSED", "Resume the E2B sandbox before this operation", false),
        );
      }
      return active;
    });

  const provider: SandboxProvider = {
    capabilities: [
      "create",
      "connect",
      "execute",
      "files",
      "pty",
      "pause",
      "resume",
      "snapshot",
      "desktop",
      "ports",
      "usage",
      "destroy",
    ],
    create: (request) =>
      Effect.gen(function* () {
        const template = parseE2bTemplateReference(request.revision.blueprint.image);
        if (template === undefined) {
          return yield* Effect.fail(
            error(
              "E2B_TEMPLATE_REQUIRED",
              "Environment revision must pin an immutable E2B template build ID",
              false,
            ),
          );
        }
        const reservation = {
          reservationId: request.requestId,
          provider: "e2b" as const,
          workspaceId: request.workspaceId,
          environmentId: request.environmentId,
          projectId: request.workspace.projectId,
          threadId: request.workspace.threadId,
          revisionId: request.revision.revisionId,
          providerTemplateId: template.templateId,
          providerBuildId: template.buildId,
          repositoryIdentity: request.workspace.repositoryIdentity,
          workspaceDirectory: request.workspace.workspaceDirectory,
          requestedAt: request.requestedAt,
        };
        const reservationResult = yield* attempt("identity reservation", () =>
          dependencies.identities.reserve(reservation),
        );
        if (reservationResult.state === "active") {
          const identity = reservationResult.identity;
          const remote = yield* attempt("inspect idempotent create", () =>
            dependencies.client.inspect(identity.providerHandle),
          );
          if (remote === undefined || !e2bDescriptionMatchesIdentity(remote, identity)) {
            return yield* Effect.fail(
              error(
                "E2B_RESERVATION_RECONCILIATION_REQUIRED",
                "The existing E2B sandbox reservation requires reconciliation",
                true,
                { reservationId: reservation.reservationId },
              ),
            );
          }
          return {
            type: "created",
            requestId: request.requestId,
            workspaceId: request.workspaceId,
            sandbox: toSandbox(identity, remote, iso(dependencies.clock.now())),
            completedAt: iso(dependencies.clock.now()),
          };
        }
        if (reservationResult.disposition === "existing") {
          return yield* Effect.fail(
            error(
              "E2B_CREATE_RECONCILIATION_REQUIRED",
              "An earlier E2B create with this reservation has an unknown outcome",
              true,
              { reservationId: reservation.reservationId },
            ),
          );
        }
        const creation = yield* Effect.result(
          attempt("create", () =>
            dependencies.client.create({
              templateId: template.templateId,
              buildId: template.buildId,
              timeoutMs: activeTimeoutMs,
              metadata: {
                ...e2bIdentityMetadataFor(request, template),
              },
            }),
          ),
        );
        if (Result.isFailure(creation)) {
          const disposition = createDispositionFrom(creation.failure);
          const cleanupRequired =
            disposition?.status === "cleanup-required" ? disposition : undefined;
          if (
            disposition?.status !== "no-compute-confirmed" &&
            disposition?.status !== "cleanup-confirmed"
          ) {
            const reclaim = yield* Effect.exit(
              attempt("reservation cleanup-required transition", () =>
                dependencies.identities.markReservationCleanupRequired({
                  workspaceId: reservation.workspaceId,
                  reservationId: reservation.reservationId,
                  reason: "remote-create-cleanup-uncertain",
                  ...(cleanupRequired?.providerHandle === undefined
                    ? {}
                    : { providerHandle: cleanupRequired.providerHandle }),
                  reclaimMetadata:
                    cleanupRequired?.reclaimMetadata ?? e2bIdentityMetadataFor(request, template),
                  recordedAt: iso(dependencies.clock.now()),
                }),
              ),
            );
            return yield* Effect.fail(
              error(
                "E2B_ORPHAN_CLEANUP_REQUIRED",
                "E2B create cleanup is uncertain; the durable thread fence remains active",
                true,
                {
                  reservationId: reservation.reservationId,
                  ...(cleanupRequired?.providerHandle === undefined
                    ? {}
                    : { providerHandle: cleanupRequired.providerHandle }),
                  reclaimMetadata:
                    cleanupRequired?.reclaimMetadata ?? e2bIdentityMetadataFor(request, template),
                  durableFenceRecorded: true,
                  durableReclaimRecorded: Exit.isSuccess(reclaim),
                },
              ),
            );
          }
          const reconciled = yield* Effect.exit(
            attempt("reservation create failure", () =>
              dependencies.identities.markReservationFailed(
                reservation.workspaceId,
                reservation.reservationId,
                iso(dependencies.clock.now()),
                "remote-create-failed",
              ),
            ),
          );
          if (Exit.isFailure(reconciled)) {
            return yield* Effect.fail(
              error(
                "E2B_RESERVATION_RECONCILIATION_REQUIRED",
                "E2B create failed and its durable reservation requires reconciliation",
                true,
                { reservationId: reservation.reservationId },
              ),
            );
          }
          return yield* Effect.fail(creation.failure);
        }
        const remote = creation.success;
        if (remote.sandboxId.length === 0 || remote.sandboxId !== remote.sandboxId.trim()) {
          const cleanup = yield* Effect.exit(
            attempt("create cleanup", () => dependencies.client.destroy(remote.sandboxId)),
          );
          let reservationReconciled = false;
          if (Exit.isSuccess(cleanup) && cleanup.value) {
            const reconciliation = yield* Effect.exit(
              attempt("reservation reclaim", () =>
                dependencies.identities.markReservationFailed(
                  reservation.workspaceId,
                  reservation.reservationId,
                  iso(dependencies.clock.now()),
                  "remote-reclaimed",
                ),
              ),
            );
            reservationReconciled = Exit.isSuccess(reconciliation);
          }
          const cleanupConfirmed = Exit.isSuccess(cleanup) && cleanup.value;
          return yield* Effect.fail(
            error(
              !cleanupConfirmed
                ? "E2B_ORPHAN_CLEANUP_REQUIRED"
                : !reservationReconciled
                  ? "E2B_RESERVATION_RECONCILIATION_REQUIRED"
                  : "E2B_IDENTITY_MISMATCH",
              !cleanupConfirmed
                ? "E2B returned an invalid identity and remote cleanup requires reconciliation"
                : !reservationReconciled
                  ? "E2B reclaimed an invalid sandbox but its reservation requires reconciliation"
                  : "E2B returned an invalid sandbox identity",
              !cleanupConfirmed || !reservationReconciled,
              {
                reservationId: reservation.reservationId,
                providerHandle: remote.sandboxId,
                durableFenceRecorded: true,
                reservationReconciled,
              },
            ),
          );
        }
        const createdAt = iso(remote.startedAt);
        const sandboxId = SandboxId.make(remote.sandboxId);
        const identity: SandboxIdentityRecord = {
          reservationId: reservation.reservationId,
          sandboxId,
          provider: "e2b",
          workspaceId: request.workspaceId,
          environmentId: request.environmentId,
          projectId: request.workspace.projectId,
          threadId: request.workspace.threadId,
          revisionId: request.revision.revisionId,
          providerTemplateId: template.templateId,
          providerBuildId: template.buildId,
          repositoryIdentity: request.workspace.repositoryIdentity,
          workspaceDirectory: request.workspace.workspaceDirectory,
          providerHandle: remote.sandboxId,
          createdAt,
        };
        if (!e2bDescriptionMatchesIdentity(remote, identity)) {
          const cleanup = yield* Effect.exit(
            attempt("create cleanup", () => dependencies.client.destroy(remote.sandboxId)),
          );
          let reservationReconciled = false;
          if (Exit.isSuccess(cleanup) && cleanup.value) {
            const reconciliation = yield* Effect.exit(
              attempt("reservation reclaim", () =>
                dependencies.identities.markReservationFailed(
                  reservation.workspaceId,
                  reservation.reservationId,
                  iso(dependencies.clock.now()),
                  "remote-reclaimed",
                ),
              ),
            );
            reservationReconciled = Exit.isSuccess(reconciliation);
          }
          const cleanupConfirmed = Exit.isSuccess(cleanup) && cleanup.value;
          return yield* Effect.fail(
            error(
              !cleanupConfirmed
                ? "E2B_ORPHAN_CLEANUP_REQUIRED"
                : !reservationReconciled
                  ? "E2B_RESERVATION_RECONCILIATION_REQUIRED"
                  : "E2B_IDENTITY_MISMATCH",
              !cleanupConfirmed
                ? "Created E2B metadata changed and remote cleanup requires reconciliation"
                : !reservationReconciled
                  ? "E2B reclaimed a mismatched sandbox but its reservation requires reconciliation"
                  : "Created E2B sandbox metadata was not preserved",
              !cleanupConfirmed || !reservationReconciled,
              {
                reservationId: reservation.reservationId,
                providerHandle: remote.sandboxId,
                durableFenceRecorded: true,
                reservationReconciled,
              },
            ),
          );
        }
        const registration = yield* Effect.exit(
          attempt("identity activation", () =>
            dependencies.identities.activateReservation(
              reservation.workspaceId,
              reservation.reservationId,
              identity,
            ),
          ),
        );
        if (Exit.isFailure(registration)) {
          const recordedAt = iso(dependencies.clock.now());
          const orphanId = sha256(
            [request.workspaceId, request.workspace.threadId, remote.sandboxId].join("\0"),
          );
          const orphan = yield* Effect.exit(
            attempt("cleanup orphan registration", () =>
              dependencies.identities.recordCleanupOrphan({
                orphanId,
                reservationId: reservation.reservationId,
                identity,
                reason: "identity-registration-failed",
                recordedAt,
              }),
            ),
          );
          const cleanup = yield* Effect.exit(
            attempt("identity registration cleanup", () =>
              dependencies.client.destroy(remote.sandboxId),
            ),
          );
          if (Exit.isSuccess(cleanup) && cleanup.value) {
            const reservationReclaimed = yield* Effect.exit(
              attempt("reservation reclaim", () =>
                dependencies.identities.markReservationFailed(
                  reservation.workspaceId,
                  reservation.reservationId,
                  iso(dependencies.clock.now()),
                  "remote-reclaimed",
                ),
              ),
            );
            if (Exit.isSuccess(orphan) && Exit.isSuccess(reservationReclaimed)) {
              yield* Effect.exit(
                attempt("cleanup orphan reclaim", () =>
                  dependencies.identities.markCleanupOrphanReclaimed(
                    reservation.workspaceId,
                    orphanId,
                    iso(dependencies.clock.now()),
                  ),
                ),
              );
            }
            return yield* Effect.fail(
              error(
                Exit.isSuccess(reservationReclaimed)
                  ? "E2B_IDENTITY_REGISTRATION_FAILED"
                  : "E2B_RESERVATION_RECONCILIATION_REQUIRED",
                Exit.isSuccess(reservationReclaimed)
                  ? "E2B sandbox identity registration failed; the sandbox was reclaimed"
                  : "E2B sandbox was reclaimed but its durable reservation requires reconciliation",
                true,
                {
                  reservationId: reservation.reservationId,
                  orphanId,
                  providerHandle: remote.sandboxId,
                  durableFenceRecorded: true,
                  reservationReconciled: Exit.isSuccess(reservationReclaimed),
                },
              ),
            );
          }
          if (Exit.isSuccess(orphan)) {
            yield* Effect.exit(
              attempt("cleanup orphan failure receipt", () =>
                dependencies.identities.recordCleanupFailure(
                  reservation.workspaceId,
                  orphanId,
                  iso(dependencies.clock.now()),
                ),
              ),
            );
          }
          return yield* Effect.fail(
            error(
              "E2B_ORPHAN_CLEANUP_REQUIRED",
              "E2B identity registration and remote cleanup failed; operator reclaim is required",
              true,
              {
                orphanId,
                reservationId: reservation.reservationId,
                providerHandle: remote.sandboxId,
                durableOrphanRecorded: Exit.isSuccess(orphan),
                durableFenceRecorded: true,
              },
            ),
          );
        }
        return {
          type: "created",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandbox: toSandbox(identity, remote, iso(dependencies.clock.now())),
          completedAt: iso(dependencies.clock.now()),
        };
      }),
    connect: (request) =>
      Effect.gen(function* () {
        const { identity } = yield* getActive(request);
        const remote = yield* attempt("connect", () =>
          dependencies.client.connect(identity.providerHandle, activeTimeoutMs),
        );
        if (!e2bDescriptionMatchesIdentity(remote, identity)) {
          return yield* Effect.fail(
            error("E2B_IDENTITY_MISMATCH", "Connected E2B sandbox metadata changed", false),
          );
        }
        if (remote.sandboxDomain === undefined) {
          return yield* Effect.fail(
            error("E2B_UNAVAILABLE", "E2B did not return a sandbox connection endpoint", true),
          );
        }
        const completedAt = iso(dependencies.clock.now());
        return {
          type: "connected",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandboxId: request.sandboxId,
          connection: {
            transport: "http",
            endpoint: `https://${remote.sandboxDomain}`,
            ...(remote.trafficCredentialRef === undefined
              ? {}
              : { credentialRef: remote.trafficCredentialRef }),
            expiresAt: iso(remote.endAt),
          },
          completedAt,
        };
      }),
    execute: (request) =>
      Effect.gen(function* () {
        const { identity } = yield* getRunning(request);
        const cwd = yield* Effect.try({
          try: () => confinedPath(identity.workspaceDirectory, request.cwd),
          catch: (cause) => mapFailure("execute path validation", cause),
        });
        const startedAt = iso(dependencies.clock.now());
        const output = yield* attempt("artifact open", () => openExecutionWriters(request));
        const result = yield* attempt("execute", async () => {
          try {
            return await dependencies.client.execute(
              identity.providerHandle,
              {
                command: request.command,
                arguments: request.arguments,
                cwd,
                ...(request.environment === undefined ? {} : { environment: request.environment }),
                ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
              },
              output,
              activeTimeoutMs,
            );
          } catch (cause) {
            await Promise.allSettled([output.stdout.abort(), output.stderr.abort()]);
            throw cause;
          }
        });
        return {
          type: "executed",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandboxId: request.sandboxId,
          exitCode: result.exitCode,
          ...(result.signal === undefined ? {} : { signal: result.signal }),
          stdoutSummary: result.stdoutSummary,
          stderrSummary: result.stderrSummary,
          stdoutArtifact: result.stdoutArtifact,
          stderrArtifact: result.stderrArtifact,
          startedAt,
          completedAt: iso(dependencies.clock.now()),
        };
      }),
    files: (request) =>
      Effect.gen(function* () {
        const { identity } = yield* getRunning(request);
        const operation = yield* Effect.try({
          try: () => ({
            ...request.operation,
            path: confinedPath(identity.workspaceDirectory, request.operation.path),
          }),
          catch: (cause) => mapFailure("file path validation", cause),
        });
        const result = yield* attempt("files", () =>
          dependencies.client.files(
            identity.providerHandle,
            operation,
            {
              maxReadBytes: maxInlineFileBytes,
              maxListEntries,
              maxListBytes,
            },
            activeTimeoutMs,
          ),
        );
        if (result.type === "read") {
          if (result.bytes.byteLength > maxInlineFileBytes) {
            return yield* Effect.fail(
              error(
                "E2B_OUTPUT_LIMIT_EXCEEDED",
                "File is too large for an inline sandbox response",
                false,
                { maxInlineFileBytes },
              ),
            );
          }
          const { content, encoding } = inlineFileContent(result.bytes);
          return {
            type: "files",
            requestId: request.requestId,
            workspaceId: request.workspaceId,
            sandboxId: request.sandboxId,
            result: {
              type: "read",
              path: result.path,
              content,
              encoding,
              contentHash: sha256(result.bytes),
            },
            completedAt: iso(dependencies.clock.now()),
          };
        }
        if (result.type === "list" && result.entries.length > maxListEntries) {
          return yield* Effect.fail(
            error(
              "E2B_OUTPUT_LIMIT_EXCEEDED",
              "Directory contains too many entries for an inline sandbox response",
              false,
              { maxListEntries },
            ),
          );
        }
        return {
          type: "files",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandboxId: request.sandboxId,
          result,
          completedAt: iso(dependencies.clock.now()),
        };
      }),
    pty: (request) =>
      Effect.gen(function* () {
        const { identity } = yield* getRunning(request);
        const operation = yield* Effect.try({
          try: () =>
            request.operation.type === "open"
              ? {
                  ...request.operation,
                  cwd: confinedPath(identity.workspaceDirectory, request.operation.cwd),
                }
              : request.operation,
          catch: (cause) => mapFailure("PTY path validation", cause),
        });
        const output =
          request.operation.type === "open"
            ? yield* attempt("PTY artifact open", () => openPtyWriter(request))
            : undefined;
        const result = yield* attempt("pty", async () => {
          try {
            return await dependencies.client.pty(
              identity.providerHandle,
              operation,
              activeTimeoutMs,
              output,
            );
          } catch (cause) {
            await output?.abort().catch(() => undefined);
            throw cause;
          }
        });
        if ((result.outputSummary === undefined) !== (result.outputArtifact === undefined)) {
          yield* Effect.exit(
            attempt("PTY artifact abort", () => output?.abort() ?? Promise.resolve()),
          );
          return yield* Effect.fail(
            error("E2B_INVALID_RESPONSE", "E2B returned incomplete PTY output metadata", false),
          );
        }
        return {
          type: "pty",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandboxId: request.sandboxId,
          ptyId: result.ptyId,
          state: result.state,
          ...(result.outputSummary === undefined || result.outputArtifact === undefined
            ? {}
            : { outputSummary: result.outputSummary, outputArtifact: result.outputArtifact }),
          completedAt: iso(dependencies.clock.now()),
        };
      }),
    pause: (request) =>
      Effect.gen(function* () {
        const { identity, remote } = yield* getActive(request);
        yield* attempt("PTY pause reconciliation", () =>
          dependencies.client.reconcilePtys(identity.providerHandle, "pause", activeTimeoutMs),
        );
        if (remote.state !== "paused") {
          yield* attempt("pause", () => dependencies.client.pause(identity.providerHandle));
        }
        const completedAt = iso(dependencies.clock.now());
        return {
          type: "paused",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandbox: toSandbox(identity, { ...remote, state: "paused" }, completedAt),
          completedAt,
        };
      }),
    resume: (request) =>
      Effect.gen(function* () {
        const { identity } = yield* getActive(request);
        const remote = yield* attempt("resume", () =>
          dependencies.client.connect(identity.providerHandle, activeTimeoutMs),
        );
        if (!e2bDescriptionMatchesIdentity(remote, identity)) {
          return yield* Effect.fail(
            error("E2B_IDENTITY_MISMATCH", "Resumed E2B sandbox metadata changed", false),
          );
        }
        const completedAt = iso(dependencies.clock.now());
        return {
          type: "resumed",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandbox: toSandbox(identity, { ...remote, state: "running" }, completedAt),
          completedAt,
        };
      }),
    snapshot: (request) =>
      Effect.gen(function* () {
        const { identity, remote } = yield* getRunning(request);
        yield* attempt("PTY snapshot reconciliation", () =>
          dependencies.client.reconcilePtys(identity.providerHandle, "snapshot", activeTimeoutMs),
        );
        const snapshot = yield* attempt("snapshot", () =>
          dependencies.client.snapshot(identity.providerHandle, request.label, activeTimeoutMs),
        );
        if (
          snapshot.snapshotId.length === 0 ||
          snapshot.snapshotId !== snapshot.snapshotId.trim()
        ) {
          return yield* Effect.fail(
            error("E2B_INVALID_RESPONSE", "E2B returned an invalid snapshot identity", false),
          );
        }
        const completedAt = iso(dependencies.clock.now());
        return {
          type: "snapshotted",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandbox: toSandbox(identity, { ...remote, state: snapshot.state }, completedAt),
          snapshot: {
            snapshotId: SandboxSnapshotId.make(snapshot.snapshotId),
            workspaceId: request.workspaceId,
            sandboxId: request.sandboxId,
            revisionId: identity.revisionId,
            ...(request.label === undefined ? {} : { label: request.label }),
            contentHash: sha256(
              ["e2b", snapshot.snapshotId, identity.revisionId, request.label ?? ""].join("\0"),
            ),
            createdAt: completedAt,
          },
          completedAt,
        };
      }),
    desktop: (request) =>
      Effect.gen(function* () {
        const { identity } = yield* getRunning(request);
        const connection = yield* attempt("desktop", () =>
          dependencies.client.desktop(identity.providerHandle, activeTimeoutMs),
        );
        if (connection === undefined) {
          return yield* Effect.fail(
            error(
              "E2B_UNSUPPORTED_CAPABILITY",
              "This E2B template does not expose the desktop service",
              false,
              { capability: "desktop" },
            ),
          );
        }
        return {
          type: "desktop",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandboxId: request.sandboxId,
          endpoint: connection.endpoint,
          ...(connection.credentialRef === undefined
            ? {}
            : { credentialRef: connection.credentialRef }),
          completedAt: iso(dependencies.clock.now()),
        };
      }),
    ports: (request) =>
      Effect.gen(function* () {
        const { identity } = yield* getRunning(request);
        const ports = yield* attempt("ports", () =>
          dependencies.client.ports(identity.providerHandle, activeTimeoutMs),
        );
        return {
          type: "ports",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandboxId: request.sandboxId,
          ports: ports.map((port) => ({
            internalPort: port.internalPort,
            protocol: "https",
            visibility: "authenticated",
            endpoint: port.endpoint,
          })),
          completedAt: iso(dependencies.clock.now()),
        };
      }),
    usage: (request) =>
      Effect.gen(function* () {
        const { identity } = yield* getActive(request);
        const since = dateFromIso(request.since);
        const until = dateFromIso(request.until);
        const metrics = yield* attempt("usage", () =>
          dependencies.client.observability(identity.providerHandle, since, until),
        );
        const measurements = metrics.flatMap((metric, index) => {
          const intervalStart = index === 0 ? since : metrics[index - 1]!.timestamp;
          const intervalEnd = metric.timestamp;
          return [
            {
              meter: "e2b.observability.cpu.percent",
              quantity: metric.cpuUsedPct,
              unit: "percent",
            },
            {
              meter: "e2b.observability.memory.used",
              quantity: metric.memoryUsedBytes,
              unit: "byte",
            },
            {
              meter: "e2b.observability.memory.total",
              quantity: metric.memoryTotalBytes,
              unit: "byte",
            },
            { meter: "e2b.observability.disk.used", quantity: metric.diskUsedBytes, unit: "byte" },
            {
              meter: "e2b.observability.disk.total",
              quantity: metric.diskTotalBytes,
              unit: "byte",
            },
          ].map((measurement) => ({
            ...measurement,
            intervalStart: iso(intervalStart),
            intervalEnd: iso(intervalEnd),
          }));
        });
        return {
          type: "usage",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          sandboxId: request.sandboxId,
          measurements,
          completedAt: iso(dependencies.clock.now()),
        };
      }),
    destroy: (request) =>
      Effect.gen(function* () {
        const identity = yield* getIdentity(request);
        if (identity.destroyedAt === undefined) {
          const remote = yield* attempt("inspect", () =>
            dependencies.client.inspect(identity.providerHandle),
          );
          if (remote !== undefined && !e2bDescriptionMatchesIdentity(remote, identity)) {
            return yield* Effect.fail(
              error("E2B_IDENTITY_MISMATCH", "E2B sandbox metadata changed before destroy", false),
            );
          }
          yield* attempt("PTY destroy reconciliation", () =>
            dependencies.client.reconcilePtys(identity.providerHandle, "destroy", activeTimeoutMs),
          );
          const destroyed = yield* attempt("destroy", () =>
            dependencies.client.destroy(identity.providerHandle),
          );
          if (!destroyed) {
            return yield* Effect.fail(
              error("E2B_DESTROY_NOT_CONFIRMED", "E2B sandbox absence was not confirmed", true),
            );
          }
          yield* attempt("identity destroy", () =>
            dependencies.identities.markDestroyed(
              request.workspaceId,
              request.sandboxId,
              iso(dependencies.clock.now()),
            ),
          );
        }
        return {
          type: "destroyed",
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          environmentId: request.environmentId,
          sandboxId: request.sandboxId,
          completedAt: iso(dependencies.clock.now()),
        };
      }),
  };

  const withLifecycleLock = <A>(
    request: { readonly sandboxId: SandboxIdentityRecord["sandboxId"] },
    operation: () => Effect.Effect<A, SandboxProviderError>,
  ) =>
    Effect.tryPromise({
      try: () =>
        dependencies.lifecycleLocks.withLock(request.sandboxId, () =>
          Effect.runPromise(operation()),
        ),
      catch: (cause) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          typeof cause.code === "string" &&
          "message" in cause &&
          typeof cause.message === "string" &&
          "retryable" in cause &&
          typeof cause.retryable === "boolean"
        ) {
          return {
            code: cause.code,
            message: cause.message,
            retryable: cause.retryable,
            ...("details" in cause ? { details: cause.details } : {}),
          };
        }
        return error("E2B_LOCK_UNAVAILABLE", "E2B lifecycle lock is unavailable", true);
      },
    });

  return {
    ...provider,
    connect: (request) => withLifecycleLock(request, () => provider.connect(request)),
    execute: (request) => withLifecycleLock(request, () => provider.execute(request)),
    files: (request) => withLifecycleLock(request, () => provider.files(request)),
    pty: (request) => withLifecycleLock(request, () => provider.pty(request)),
    pause: (request) => withLifecycleLock(request, () => provider.pause(request)),
    resume: (request) => withLifecycleLock(request, () => provider.resume(request)),
    snapshot: (request) => withLifecycleLock(request, () => provider.snapshot(request)),
    desktop: (request) => withLifecycleLock(request, () => provider.desktop(request)),
    ports: (request) => withLifecycleLock(request, () => provider.ports(request)),
    usage: (request) => withLifecycleLock(request, () => provider.usage(request)),
    destroy: (request) => withLifecycleLock(request, () => provider.destroy(request)),
  };
};
