// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the audited Node worker boundary.
// @effect-diagnostics globalDateInEffect:off -- The integration test supplies a live future worker expiry.
// @effect-diagnostics globalDate:off -- Native worker lease tests use a live future deadline.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { AgentMaterializationId, AgentProfileId } from "@t3tools/contracts/cloud";
import type { WorkerProviderCredentialResult } from "@t3tools/contracts/worker";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeWorkerProviderCredentialExecutor,
  type WorkerCredentialIdentityRuntime,
  WorkerProviderCredentialError,
} from "./ProviderCredentialExecutor.ts";

const providerInstanceId = "codex-work" as ProviderInstanceId;
const providerDriver = "codex" as ProviderDriverKind;
const now = "2026-08-27T12:00:00.000Z";
const restrictedUid = (process.getuid?.() ?? 0) + 1;
const restrictedGid = (process.getgid?.() ?? 0) + 1;
const testIdentityRuntime: WorkerCredentialIdentityRuntime = {
  verify: async () => undefined,
  chown: async () => undefined,
  chownFile: async () => undefined,
  isOwnedBy: () => true,
  spawn: async (executable, arguments_, options) => {
    const { uid: _uid, gid: _gid, ...testOptions } = options;
    return NodeChildProcess.spawn(executable, [...arguments_], testOptions);
  },
};
const bundle = (files: ReadonlyArray<{ readonly path: string; readonly contents: string }>) =>
  (() => {
    const encoded = files.map((file) => ({
      path: Buffer.from(file.path),
      contents: Buffer.from(file.contents),
    }));
    const output = Buffer.alloc(
      6 + encoded.reduce((total, file) => total + 6 + file.path.length + file.contents.length, 0),
    );
    output.writeUInt32BE(0x41494350, 0);
    output.writeUInt16BE(encoded.length, 4);
    let offset = 6;
    for (const file of encoded) {
      output.writeUInt16BE(file.path.length, offset);
      output.writeUInt32BE(file.contents.length, offset + 2);
      offset += 6;
      file.path.copy(output, offset);
      offset += file.path.length;
      file.contents.copy(output, offset);
      offset += file.contents.length;
    }
    return output;
  })();

const futureAuthorization = () => new Date(Date.now() + 60_000).toISOString();

const fixture = <A>(
  use: (input: {
    readonly root: string;
    readonly workspace: string;
  }) => Effect.Effect<A, WorkerProviderCredentialError>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const temporaryRoot = await NodeFSP.realpath(NodeOS.tmpdir());
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(temporaryRoot, "aic-worker-credentials-"),
      );
      const root = NodePath.join(directory, "private");
      const workspace = NodePath.join(directory, "checkout");
      await NodeFSP.mkdir(workspace, { mode: 0o700 });
      return { directory, root, workspace };
    }),
    use,
    ({ directory }) =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

it.effect("writes atomically outside the checkout and requires worker-confirmed absence", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      const results: Array<WorkerProviderCredentialResult> = [];
      const executor = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: workspace,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        now: Effect.succeed(now),
      });
      const operationId = "materialization-a" as AgentMaterializationId;
      const credentialPayload = bundle([
        { path: ".config/codex/auth.json", contents: "secret-value" },
      ]);
      yield* executor.execute(
        {
          type: "provider.credentials.command",
          operation: "materialize",
          operationId,
          routeGeneration: 1,
          profileId: "profile-a" as AgentProfileId,
          profileGeneration: 1,
          providerInstanceId,
          providerDriver,
          authorizationExpiresAt: futureAuthorization(),
          credentialPayloadBytes: credentialPayload.byteLength,
        },
        credentialPayload,
        (result) =>
          Effect.sync(() => {
            results.push(result);
          }),
      );
      const path = NodePath.join(
        root,
        "profiles",
        `materialization-${operationId}`,
        ".config/codex/auth.json",
      );
      expect(yield* Effect.promise(() => NodeFSP.readFile(path, "utf8"))).toBe("secret-value");
      expect((yield* Effect.promise(() => NodeFSP.stat(path))).mode & 0o077).toBe(0);
      expect(path.startsWith(workspace)).toBe(false);

      yield* executor.execute(
        {
          type: "provider.credentials.command",
          operation: "cleanup",
          operationId,
          routeGeneration: 1,
          profileId: "profile-a" as AgentProfileId,
          profileGeneration: 1,
          providerInstanceId,
          providerDriver,
        },
        undefined,
        (result) =>
          Effect.sync(() => {
            results.push(result);
          }),
      );
      expect(results.at(-1)).toMatchObject({ operation: "cleanup", outcome: "absent" });
      expect((yield* Effect.tryPromise(() => NodeFSP.lstat(path)).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );

      const latePayload = bundle([{ path: "auth.json", contents: "late-secret" }]);
      const lateMaterialization = yield* executor
        .execute(
          {
            type: "provider.credentials.command",
            operation: "materialize",
            operationId,
            routeGeneration: 1,
            profileId: "profile-a" as AgentProfileId,
            profileGeneration: 1,
            providerInstanceId,
            providerDriver,
            authorizationExpiresAt: futureAuthorization(),
            credentialPayloadBytes: latePayload.byteLength,
          },
          latePayload,
          (result) =>
            Effect.sync(() => {
              results.push(result);
            }),
        )
        .pipe(Effect.exit);
      expect(lateMaterialization._tag).toBe("Failure");
      expect(results.at(-1)).toMatchObject({
        operation: "materialize",
        outcome: "failed",
        errorCode: "cleanup_fenced",
      });
      expect((yield* Effect.tryPromise(() => NodeFSP.lstat(path)).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
    }),
  ),
);

it.effect("scrubs a materialization at lease expiry and fences a late retry", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      let expire: (() => Promise<void>) | undefined;
      const executor = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: workspace,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        leaseScheduler: {
          nowMs: () => Date.parse(now),
          schedule: (_delay, scheduled) => {
            expire = scheduled;
            return { cancel: () => undefined };
          },
        },
        now: Effect.succeed(now),
      });
      const operationId = "materialization-expiry" as AgentMaterializationId;
      const payload = bundle([{ path: "auth.json", contents: "expiring-secret" }]);
      yield* executor.execute(
        {
          type: "provider.credentials.command",
          operation: "materialize",
          operationId,
          routeGeneration: 1,
          profileId: "profile-expiry" as AgentProfileId,
          profileGeneration: 2,
          providerInstanceId,
          providerDriver,
          authorizationExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
          credentialPayloadBytes: payload.byteLength,
        },
        payload,
        () => Effect.void,
      );
      expect(expire).toBeTypeOf("function");
      yield* Effect.promise(() => expire!());
      const credentialPath = NodePath.join(
        root,
        "profiles",
        `materialization-${operationId}`,
        "auth.json",
      );
      expect((yield* Effect.exit(Effect.promise(() => NodeFSP.lstat(credentialPath))))._tag).toBe(
        "Failure",
      );
      const retry = bundle([{ path: "auth.json", contents: "stale" }]);
      expect(
        (yield* Effect.exit(
          executor.execute(
            {
              type: "provider.credentials.command",
              operation: "materialize",
              operationId,
              routeGeneration: 1,
              profileId: "profile-expiry" as AgentProfileId,
              profileGeneration: 2,
              providerInstanceId,
              providerDriver,
              authorizationExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
              credentialPayloadBytes: retry.byteLength,
            },
            retry,
            () => Effect.void,
          ),
        ))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect("arms expiry cleanup before reporting materialization success", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const executor = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: workspace,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        leaseScheduler: {
          nowMs: () => Date.parse(now),
          schedule: () => {
            order.push("arm");
            return { cancel: () => undefined };
          },
        },
        now: Effect.succeed(now),
      });
      const payload = bundle([{ path: "auth.json", contents: "ordered-secret" }]);
      yield* executor.execute(
        {
          type: "provider.credentials.command",
          operation: "materialize",
          operationId: "materialization-ordered" as AgentMaterializationId,
          routeGeneration: 1,
          profileId: "profile-ordered" as AgentProfileId,
          profileGeneration: 1,
          providerInstanceId,
          providerDriver,
          authorizationExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
          credentialPayloadBytes: payload.byteLength,
        },
        payload,
        (result) => Effect.sync(() => order.push(`emit:${result.outcome}`)),
      );
      expect(order).toEqual(["arm", "emit:materialized"]);
    }),
  ),
);

it.effect("removes the credential bundle and never reports success when lease arming fails", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      const results: Array<WorkerProviderCredentialResult> = [];
      const executor = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: workspace,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        leaseScheduler: {
          nowMs: () => Date.parse(now),
          schedule: () => {
            throw new Error("scheduler unavailable");
          },
        },
        now: Effect.succeed(now),
      });
      const operationId = "materialization-arm-failure" as AgentMaterializationId;
      const payload = bundle([{ path: "auth.json", contents: "must-be-removed" }]);
      expect(
        (yield* executor
          .execute(
            {
              type: "provider.credentials.command",
              operation: "materialize",
              operationId,
              routeGeneration: 1,
              profileId: "profile-arm-failure" as AgentProfileId,
              profileGeneration: 1,
              providerInstanceId,
              providerDriver,
              authorizationExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
              credentialPayloadBytes: payload.byteLength,
            },
            payload,
            (result) => Effect.sync(() => results.push(result)),
          )
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(results).toEqual([
        expect.objectContaining({ operation: "materialize", outcome: "failed" }),
      ]);
      expect(
        (yield* Effect.promise(() =>
          NodeFSP.lstat(NodePath.join(root, "profiles", `materialization-${operationId}`)),
        ).pipe(Effect.exit))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect("rearms an on-disk credential lease after worker restart", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      const operationId = "materialization-rearm" as AgentMaterializationId;
      const expiresAt = new Date(Date.parse(now) + 60_000).toISOString();
      const first = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: workspace,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        leaseScheduler: {
          nowMs: () => Date.parse(now),
          schedule: () => ({ cancel: () => undefined }),
        },
        now: Effect.succeed(now),
      });
      const payload = bundle([{ path: "auth.json", contents: "restart-secret" }]);
      yield* first.execute(
        {
          type: "provider.credentials.command",
          operation: "materialize",
          operationId,
          routeGeneration: 1,
          profileId: "profile-rearm" as AgentProfileId,
          profileGeneration: 3,
          providerInstanceId,
          providerDriver,
          authorizationExpiresAt: expiresAt,
          credentialPayloadBytes: payload.byteLength,
        },
        payload,
        () => Effect.void,
      );

      let scheduledDelay: number | undefined;
      const restarted = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: workspace,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        leaseScheduler: {
          nowMs: () => Date.parse(now),
          schedule: (delay) => {
            scheduledDelay = delay;
            return { cancel: () => undefined };
          },
        },
        now: Effect.succeed(now),
      });
      const results: Array<WorkerProviderCredentialResult> = [];
      yield* restarted.execute(
        {
          type: "provider.credentials.command",
          operation: "lease.arm",
          operationId,
          routeGeneration: 2,
          profileId: "profile-rearm" as AgentProfileId,
          profileGeneration: 3,
          providerInstanceId,
          providerDriver,
          authorizationExpiresAt: expiresAt,
        },
        undefined,
        (result) => Effect.sync(() => results.push(result)),
      );

      expect(scheduledDelay).toBe(60_000);
      expect(results).toContainEqual(
        expect.objectContaining({ operation: "lease.arm", outcome: "armed" }),
      );
    }),
  ),
);

it.effect(
  "rejects a sibling provider profile instead of exposing two profiles to one agent uid",
  () =>
    fixture(({ root, workspace }) =>
      Effect.gen(function* () {
        const executor = yield* makeWorkerProviderCredentialExecutor({
          privateRoot: root,
          workspaceDirectory: workspace,
          agentUid: restrictedUid,
          agentGid: restrictedGid,
          identityRuntime: testIdentityRuntime,
          now: Effect.succeed(now),
        });
        const materialize = (operationId: AgentMaterializationId) => {
          const credentialPayload = bundle([{ path: "auth.json", contents: "credential" }]);
          return executor.execute(
            {
              type: "provider.credentials.command",
              operation: "materialize",
              operationId,
              routeGeneration: 1,
              profileId: "profile-a" as AgentProfileId,
              profileGeneration: 1,
              providerInstanceId,
              providerDriver,
              authorizationExpiresAt: futureAuthorization(),
              credentialPayloadBytes: credentialPayload.byteLength,
            },
            credentialPayload,
            () => Effect.void,
          );
        };
        const firstId = "materialization-first" as AgentMaterializationId;
        const secondId = "materialization-second" as AgentMaterializationId;
        yield* materialize(firstId);
        expect((yield* Effect.exit(materialize(secondId)))._tag).toBe("Failure");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(root, "profiles", `materialization-${firstId}`, "auth.json"),
              "utf8",
            ),
          ),
        ).toBe("credential");
        expect(
          (yield* Effect.tryPromise(() =>
            NodeFSP.lstat(NodePath.join(root, "profiles", `materialization-${secondId}`)),
          ).pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect("rejects traversal and leaves a post-rename write discoverable for cleanup", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      const executor = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: workspace,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        now: Effect.succeed(now),
      });
      const traversalPayload = bundle([{ path: "../escape", contents: "secret" }]);
      const traversal = yield* Effect.exit(
        executor.execute(
          {
            type: "provider.credentials.command",
            operation: "materialize",
            operationId: "materialization-traversal" as AgentMaterializationId,
            routeGeneration: 1,
            profileId: "profile-a" as AgentProfileId,
            profileGeneration: 1,
            providerInstanceId,
            providerDriver,
            authorizationExpiresAt: futureAuthorization(),
            credentialPayloadBytes: traversalPayload.byteLength,
          },
          traversalPayload,
          () => Effect.void,
        ),
      );
      expect(traversal._tag).toBe("Failure");

      const operationId = "materialization-crash" as AgentMaterializationId;
      const crashPayload = bundle([{ path: "auth.json", contents: "secret" }]);
      const afterRename = yield* Effect.exit(
        executor.execute(
          {
            type: "provider.credentials.command",
            operation: "materialize",
            operationId,
            routeGeneration: 1,
            profileId: "profile-a" as AgentProfileId,
            profileGeneration: 1,
            providerInstanceId,
            providerDriver,
            authorizationExpiresAt: futureAuthorization(),
            credentialPayloadBytes: crashPayload.byteLength,
          },
          crashPayload,
          () =>
            Effect.fail(
              new WorkerProviderCredentialError({
                code: "writeFailed",
                operation: "simulated-relay-crash",
              }),
            ),
        ),
      );
      expect(afterRename._tag).toBe("Failure");
      const path = NodePath.join(root, "profiles", `materialization-${operationId}`, "auth.json");
      expect(yield* Effect.promise(() => NodeFSP.readFile(path, "utf8"))).toBe("secret");
      yield* executor.execute(
        {
          type: "provider.credentials.command",
          operation: "cleanup",
          operationId,
          routeGeneration: 1,
          profileId: "profile-a" as AgentProfileId,
          profileGeneration: 1,
          providerInstanceId,
          providerDriver,
        },
        undefined,
        () => Effect.void,
      );
      expect((yield* Effect.tryPromise(() => NodeFSP.lstat(path)).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
    }),
  ),
);

it.effect("rejects a symlinked credential root", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      const target = `${root}-target`;
      yield* Effect.promise(() => NodeFSP.mkdir(target, { mode: 0o700 }));
      yield* Effect.promise(() => NodeFSP.symlink(target, root));
      const result = yield* Effect.exit(
        makeWorkerProviderCredentialExecutor({
          privateRoot: root,
          workspaceDirectory: workspace,
          agentUid: restrictedUid,
          agentGid: restrictedGid,
          identityRuntime: testIdentityRuntime,
          now: Effect.succeed(now),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("WorkerProviderCredentialError");
      }
    }),
  ),
);

it.effect(
  "fails startup before filesystem creation when restricted identity cannot be applied",
  () =>
    fixture(({ root, workspace }) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(
          makeWorkerProviderCredentialExecutor({
            privateRoot: root,
            workspaceDirectory: workspace,
            agentUid: restrictedUid,
            agentGid: restrictedGid,
            identityRuntime: {
              ...testIdentityRuntime,
              verify: async () => {
                throw Object.assign(new Error("setuid denied"), { code: "EPERM" });
              },
            },
            now: Effect.succeed(now),
          }),
        );
        expect(result._tag).toBe("Failure");
        expect((yield* Effect.tryPromise(() => NodeFSP.lstat(root)).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
      }),
    ),
);

it.effect("rejects a symlinked root ancestor without writing into the checkout", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      const alias = NodePath.join(NodePath.dirname(root), "alias");
      yield* Effect.promise(() => NodeFSP.symlink(workspace, alias));
      const escapedRoot = NodePath.join(alias, "credentials");
      const result = yield* Effect.exit(
        makeWorkerProviderCredentialExecutor({
          privateRoot: escapedRoot,
          workspaceDirectory: workspace,
          agentUid: restrictedUid,
          agentGid: restrictedGid,
          identityRuntime: testIdentityRuntime,
          now: Effect.succeed(now),
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(
        (yield* Effect.tryPromise(() => NodeFSP.lstat(NodePath.join(workspace, "auth.json"))).pipe(
          Effect.exit,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.tryPromise(() =>
          NodeFSP.lstat(NodePath.join(workspace, "credentials")),
        ).pipe(Effect.exit))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect("rejects a checkout contained by the private credential root", () =>
  fixture(({ root }) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(root, { mode: 0o711 });
      });
      const containedCheckout = NodePath.join(root, "checkout");
      yield* Effect.promise(() => NodeFSP.mkdir(containedCheckout, { mode: 0o700 }));

      const result = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: containedCheckout,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        now: Effect.succeed(now),
      }).pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(
        (yield* Effect.tryPromise(() =>
          NodeFSP.lstat(NodePath.join(containedCheckout, "auth.json")),
        ).pipe(Effect.exit))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect("rejects a renamed private root before writing to its replacement", () =>
  fixture(({ root, workspace }) =>
    Effect.gen(function* () {
      const executor = yield* makeWorkerProviderCredentialExecutor({
        privateRoot: root,
        workspaceDirectory: workspace,
        agentUid: restrictedUid,
        agentGid: restrictedGid,
        identityRuntime: testIdentityRuntime,
        now: Effect.succeed(now),
      });
      yield* Effect.promise(async () => {
        await NodeFSP.rename(root, `${root}-original`);
        await NodeFSP.mkdir(root, { mode: 0o711 });
      });

      const rootRacePayload = bundle([{ path: "auth.json", contents: "secret" }]);
      const result = yield* executor
        .execute(
          {
            type: "provider.credentials.command",
            operation: "materialize",
            operationId: "materialization-root-race" as AgentMaterializationId,
            routeGeneration: 1,
            profileId: "profile-a" as AgentProfileId,
            profileGeneration: 1,
            providerInstanceId,
            providerDriver,
            authorizationExpiresAt: futureAuthorization(),
            credentialPayloadBytes: rootRacePayload.byteLength,
          },
          rootRacePayload,
          () => Effect.void,
        )
        .pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(
        (yield* Effect.tryPromise(() => NodeFSP.lstat(NodePath.join(root, "profiles"))).pipe(
          Effect.exit,
        ))._tag,
      ).toBe("Failure");
    }),
  ),
);
