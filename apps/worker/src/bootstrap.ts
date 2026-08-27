// @effect-diagnostics nodeBuiltinImport:off -- Sealed bootstrap files are a Node/E2B process boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { WorkerBootstrap } from "@t3tools/contracts/worker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { WorkerBootstrapError } from "./errors.ts";
import { containsForbiddenBootstrapMaterial } from "./redaction.ts";

export const WORKER_BOOTSTRAP_FILE_ENV = "AGENTSIN_WORKER_BOOTSTRAP_FILE";
export const WORKER_BOOTSTRAP_MAX_BYTES = 64 * 1024;
export const WORKER_BOOTSTRAP_MAX_LIFETIME_MS = 15 * 60 * 1_000;
export const WORKER_BOOTSTRAP_CLOCK_SKEW_MS = 60 * 1_000;

export interface WorkerBootstrapFileStat {
  readonly bytes: number;
  readonly mode: number;
  readonly ownerUid: number;
  readonly regularFile: boolean;
}

export interface WorkerBootstrapFileHandle {
  readonly stat: Effect.Effect<WorkerBootstrapFileStat, WorkerBootstrapError>;
  readonly readBounded: (maxBytes: number) => Effect.Effect<string, WorkerBootstrapError>;
}

export interface WorkerBootstrapFileSource {
  readonly currentUid: number;
  readonly openNoFollow: (
    path: string,
  ) => Effect.Effect<WorkerBootstrapFileHandle, WorkerBootstrapError, Scope.Scope>;
}

const readHandleBounded = async (handle: NodeFSP.FileHandle, maxBytes: number): Promise<string> => {
  const chunks: Array<Buffer> = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total).toString("utf8");
};

export const nodeBootstrapFileSource: WorkerBootstrapFileSource = {
  currentUid: typeof process.getuid === "function" ? process.getuid() : 0,
  openNoFollow: (path) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW),
        catch: (cause) =>
          new WorkerBootstrapError({ reason: "bootstrap file could not be opened safely", cause }),
      }),
      (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
    ).pipe(
      Effect.map((handle) => ({
        stat: Effect.tryPromise({
          try: async () => {
            const stat = await handle.stat();
            return {
              bytes: stat.size,
              mode: stat.mode,
              ownerUid: stat.uid,
              regularFile: stat.isFile(),
            };
          },
          catch: (cause) =>
            new WorkerBootstrapError({ reason: "bootstrap file metadata is unavailable", cause }),
        }),
        readBounded: (maxBytes) =>
          Effect.tryPromise({
            try: () => readHandleBounded(handle, maxBytes),
            catch: (cause) =>
              new WorkerBootstrapError({ reason: "bootstrap file could not be read", cause }),
          }),
      })),
    ),
};

const decodeJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWorkerBootstrap = Schema.decodeUnknownEffect(WorkerBootstrap);

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const parseInstant = (
  value: string,
): { readonly epochMillis: number; readonly canonical: string } | undefined => {
  const match = ISO_INSTANT.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8] ?? "Z";
  const maximumDay = daysInMonth(year, month);
  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maximumDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 14 ||
    offsetMinutes > 59 ||
    (offsetHours === 14 && offsetMinutes !== 0)
  ) {
    return undefined;
  }
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed)) return undefined;
  return {
    epochMillis: DateTime.toEpochMillis(parsed.value),
    canonical: DateTime.formatIso(parsed.value),
  };
};

export const decodeWorkerBootstrapText = (
  text: string,
  nowIso: string,
): Effect.Effect<WorkerBootstrap, WorkerBootstrapError> =>
  Effect.gen(function* () {
    if (Buffer.byteLength(text, "utf8") > WORKER_BOOTSTRAP_MAX_BYTES) {
      return yield* new WorkerBootstrapError({ reason: "bootstrap file exceeds the size limit" });
    }
    const raw = yield* decodeJsonUnknown(text).pipe(
      Effect.mapError(
        (cause) => new WorkerBootstrapError({ reason: "bootstrap file is not valid JSON", cause }),
      ),
    );
    if (containsForbiddenBootstrapMaterial(raw)) {
      return yield* new WorkerBootstrapError({
        reason: "bootstrap file contains forbidden wallet or signing material",
      });
    }
    const bootstrap = yield* decodeWorkerBootstrap(raw).pipe(
      Effect.mapError(
        (cause) => new WorkerBootstrapError({ reason: "bootstrap identity is invalid", cause }),
      ),
    );
    const issued = parseInstant(bootstrap.issuedAt);
    const expires = parseInstant(bootstrap.expiresAt);
    const now = parseInstant(nowIso);
    if (issued === undefined || expires === undefined || now === undefined) {
      return yield* new WorkerBootstrapError({
        reason: "bootstrap identity timestamps and worker clock must be valid ISO instants",
      });
    }
    if (expires.epochMillis <= issued.epochMillis) {
      return yield* new WorkerBootstrapError({
        reason: "bootstrap identity expires before issuance",
      });
    }
    if (expires.epochMillis - issued.epochMillis > WORKER_BOOTSTRAP_MAX_LIFETIME_MS) {
      return yield* new WorkerBootstrapError({
        reason: "bootstrap identity lifetime exceeds the limit",
      });
    }
    if (issued.epochMillis > now.epochMillis + WORKER_BOOTSTRAP_CLOCK_SKEW_MS) {
      return yield* new WorkerBootstrapError({
        reason: "bootstrap identity was issued in the future",
      });
    }
    if (expires.epochMillis <= now.epochMillis) {
      return yield* new WorkerBootstrapError({ reason: "bootstrap identity has expired" });
    }
    return {
      ...bootstrap,
      issuedAt: issued.canonical,
      expiresAt: expires.canonical,
    };
  });

export const loadWorkerBootstrap = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nowIso: string;
  readonly source?: WorkerBootstrapFileSource;
}): Effect.Effect<WorkerBootstrap, WorkerBootstrapError> =>
  Effect.gen(function* () {
    const path = input.env[WORKER_BOOTSTRAP_FILE_ENV]?.trim();
    if (!path) {
      return yield* new WorkerBootstrapError({
        reason: `${WORKER_BOOTSTRAP_FILE_ENV} must reference a sealed bootstrap file`,
      });
    }
    if (!NodePath.isAbsolute(path)) {
      return yield* new WorkerBootstrapError({ reason: "bootstrap file path must be absolute" });
    }
    const source = input.source ?? nodeBootstrapFileSource;
    const handle = yield* source.openNoFollow(path);
    const stat = yield* handle.stat;
    if (!stat.regularFile) {
      return yield* new WorkerBootstrapError({
        reason: "bootstrap reference must be a regular file",
      });
    }
    if (stat.bytes > WORKER_BOOTSTRAP_MAX_BYTES) {
      return yield* new WorkerBootstrapError({ reason: "bootstrap file exceeds the size limit" });
    }
    if (stat.ownerUid !== source.currentUid || (stat.mode & 0o077) !== 0) {
      return yield* new WorkerBootstrapError({
        reason: "bootstrap file must be owned by the worker and inaccessible to group/other users",
      });
    }
    return yield* handle
      .readBounded(WORKER_BOOTSTRAP_MAX_BYTES)
      .pipe(Effect.flatMap((text) => decodeWorkerBootstrapText(text, input.nowIso)));
  }).pipe(Effect.scoped);
