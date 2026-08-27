import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { Database } from "./database.ts";

export interface Workspace {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface WorkspaceUser {
  readonly id: string;
  readonly name: string;
}

export class WorkspaceRepositoryError extends Schema.TaggedErrorClass<WorkspaceRepositoryError>()(
  "WorkspaceRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface WorkspaceRepositoryService {
  /**
   * The unique owner constraint and this INSERT ... ON CONFLICT statement
   * make workspace creation safe when OAuth/password/passkey callbacks race
   * or Better Auth retries a request.
   */
  readonly ensureForUser: (
    user: WorkspaceUser,
  ) => Effect.Effect<Workspace, WorkspaceRepositoryError>;
  readonly findForUser: (
    userId: string,
  ) => Effect.Effect<Workspace | undefined, WorkspaceRepositoryError>;
}

export class WorkspaceRepository extends Context.Service<
  WorkspaceRepository,
  WorkspaceRepositoryService
>()("@agentsin-cloud/control-plane/workspaces/WorkspaceRepository") {}

const WorkspaceDbRow = Schema.Struct({
  id: Schema.String,
  owner_user_id: Schema.String,
  name: Schema.String,
  created_at: Schema.String,
});

type WorkspaceDbRow = typeof WorkspaceDbRow.Type;

const decodeWorkspaceDbRow = Schema.decodeUnknownEffect(WorkspaceDbRow);

const selectColumns = `
  SELECT
    id,
    owner_user_id,
    name,
    created_at::text AS created_at
  FROM workspace`;

const toWorkspace = (row: WorkspaceDbRow): Workspace => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  name: row.name,
  createdAt: row.created_at,
});

/**
 * Keep the upsert statement named so its ownership and race-safety contract is
 * easy to review without needing a live Postgres instance.
 */
export const ensureWorkspaceSql = `WITH inserted AS (
  INSERT INTO workspace (owner_user_id, name)
  VALUES ($1, $2)
  ON CONFLICT (owner_user_id) DO UPDATE
    SET owner_user_id = EXCLUDED.owner_user_id
  RETURNING id, owner_user_id, name, created_at::text AS created_at
)
SELECT id, owner_user_id, name, created_at FROM inserted
UNION ALL
SELECT id, owner_user_id, name, created_at::text AS created_at
FROM workspace
WHERE owner_user_id = $1
  AND NOT EXISTS (SELECT 1 FROM inserted)
LIMIT 1`;

const decodeRow = (operation: string, row: unknown) =>
  decodeWorkspaceDbRow(row).pipe(
    Effect.map(toWorkspace),
    Effect.mapError((cause) => new WorkspaceRepositoryError({ operation, cause })),
  );

const requireFirstRow = (operation: string, rows: ReadonlyArray<unknown>) => {
  const row = rows[0];
  return row === undefined
    ? Effect.fail(
        new WorkspaceRepositoryError({
          operation,
          cause: "The workspace query returned no rows",
        }),
      )
    : decodeRow(operation, row);
};

export const make = Effect.fn("WorkspaceRepository.make")(function* () {
  const database = yield* Database;

  const ensureForUser: WorkspaceRepositoryService["ensureForUser"] = (user) => {
    const operation = "ensure-workspace";
    const name =
      user.name.trim().length > 0 ? `${user.name.trim()}'s workspace` : "Personal workspace";

    return database.query<WorkspaceDbRow>(ensureWorkspaceSql, [user.id, name]).pipe(
      Effect.mapError((cause) => new WorkspaceRepositoryError({ operation, cause })),
      Effect.flatMap((rows) => requireFirstRow(operation, rows)),
    );
  };

  const findForUser: WorkspaceRepositoryService["findForUser"] = (userId) => {
    const operation = "find-workspace";
    return database
      .query<WorkspaceDbRow>(`${selectColumns} WHERE owner_user_id = $1 LIMIT 1`, [userId])
      .pipe(
        Effect.mapError((cause) => new WorkspaceRepositoryError({ operation, cause })),
        Effect.flatMap((rows) => {
          const row = rows[0];
          return row === undefined
            ? Effect.void.pipe(Effect.as(undefined))
            : decodeRow(operation, row);
        }),
      );
  };

  return WorkspaceRepository.of({ ensureForUser, findForUser });
});

export const layer = Layer.effect(WorkspaceRepository, make());

/** Ensure a workspace through the repository service, used by auth hooks and routes. */
export const ensureWorkspaceForUser = Effect.fn("Workspace.ensureForUser")(function* (
  user: WorkspaceUser,
) {
  const repository = yield* WorkspaceRepository;
  return yield* repository.ensureForUser(user);
});
