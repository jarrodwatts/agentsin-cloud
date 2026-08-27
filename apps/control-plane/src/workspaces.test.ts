import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ensureWorkspaceForUser,
  ensureWorkspaceSql,
  type Workspace,
  type WorkspaceRepositoryService,
  WorkspaceRepository,
} from "./workspaces.ts";

const makeRepository = () => {
  const records = new Map<string, Workspace>();
  let insertCount = 0;

  const service: WorkspaceRepositoryService = {
    ensureForUser: (user) =>
      Effect.sync(() => {
        const existing = records.get(user.id);
        if (existing !== undefined) {
          return existing;
        }

        insertCount += 1;
        const workspace: Workspace = {
          id: `workspace-${user.id}`,
          ownerUserId: user.id,
          name: `${user.name}'s workspace`,
          createdAt: "2026-08-27T00:00:00.000Z",
        };
        records.set(user.id, workspace);
        return workspace;
      }),
    findForUser: (userId) => Effect.succeed(records.get(userId)),
  };

  return {
    service,
    get insertCount() {
      return insertCount;
    },
  };
};

it.effect("creates one personal workspace and reuses it idempotently", () => {
  const repository = makeRepository();

  return Effect.gen(function* () {
    const first = yield* ensureWorkspaceForUser({ id: "user-1", name: "Ada" });
    const second = yield* ensureWorkspaceForUser({ id: "user-1", name: "Ada Lovelace" });

    expect(second).toEqual(first);
    expect(second.ownerUserId).toBe("user-1");
    expect(repository.insertCount).toBe(1);
  }).pipe(Effect.provideService(WorkspaceRepository, repository.service));
});

it.effect("keeps workspaces isolated by owner", () => {
  const repository = makeRepository();

  return Effect.gen(function* () {
    const first = yield* ensureWorkspaceForUser({ id: "user-1", name: "Ada" });
    const second = yield* ensureWorkspaceForUser({ id: "user-2", name: "Grace" });

    expect(first.ownerUserId).toBe("user-1");
    expect(second.ownerUserId).toBe("user-2");
    expect(first.id).not.toBe(second.id);
    expect(repository.insertCount).toBe(2);
  }).pipe(Effect.provideService(WorkspaceRepository, repository.service));
});

it("keeps the database upsert scoped to the authenticated owner", () => {
  expect(ensureWorkspaceSql).toContain("ON CONFLICT (owner_user_id)");
  expect(ensureWorkspaceSql).toContain("WHERE owner_user_id = $1");
  expect(ensureWorkspaceSql).toContain("NOT EXISTS (SELECT 1 FROM inserted)");
  expect(ensureWorkspaceSql).not.toContain("owner_user_id = user.id");
});
