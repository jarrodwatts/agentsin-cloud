// @effect-diagnostics nodeBuiltinImport:off -- This is the unprivileged provider subprocess boundary.
// @effect-diagnostics globalProcess:off -- The child owns stdin/stdout and signal termination.
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { WorkerProviderSession } from "./ports.ts";
import {
  RestrictedProviderRuntimeMessage,
  RestrictedProviderRuntimeRequest,
  type RestrictedProviderRuntimeMessage as RuntimeMessage,
} from "./ProviderRuntimeProtocol.ts";
import { makeT3ProviderFactory, type T3ProviderService } from "./T3ProviderRuntime.ts";

const MAX_PROTOCOL_BUFFER_BYTES = 2 * 1024 * 1024;
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(RestrictedProviderRuntimeRequest),
);
const encodeMessage = Schema.encodeUnknownSync(
  Schema.fromJsonString(RestrictedProviderRuntimeMessage),
);

const providerServiceMethods = [
  "startSession",
  "sendTurn",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "stopSession",
  "listSessions",
  "getInstanceInfo",
  "rollbackConversation",
] as const;

const isProviderService = (value: unknown): value is T3ProviderService<unknown> =>
  typeof value === "object" &&
  value !== null &&
  providerServiceMethods.every((method) => typeof Reflect.get(value, method) === "function") &&
  Reflect.has(value, "streamEvents");

const send = (message: RuntimeMessage) => {
  NodeProcess.stdout.write(`${encodeMessage(message)}\n`);
};

const modulePath = NodeProcess.argv[2];
if (modulePath === undefined || !NodePath.isAbsolute(modulePath)) NodeProcess.exit(70);

const loaded = (await import(NodeURL.pathToFileURL(modulePath).href)) as {
  readonly createT3ProviderService?: () => unknown | Promise<unknown>;
};
if (typeof loaded.createT3ProviderService !== "function") NodeProcess.exit(70);
const service = await loaded.createT3ProviderService();
if (!isProviderService(service)) NodeProcess.exit(70);
const provider = makeT3ProviderFactory(service);
let session: WorkerProviderSession | undefined;
let sessionScope: Scope.Closeable | undefined;
let inputBuffer = "";
let processing = Promise.resolve();

const closeSession = async () => {
  const current = session;
  session = undefined;
  if (current !== undefined) await Effect.runPromise(current.stop);
  const scope = sessionScope;
  sessionScope = undefined;
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
};

const handleLine = async (line: string) => {
  const request = decodeRequest(line);
  try {
    if (request.type === "provider.start") {
      if (session !== undefined) throw new Error("provider session already started");
      const scope = await Effect.runPromise(Scope.make("sequential"));
      sessionScope = scope;
      session = await Effect.runPromise(
        provider
          .start({
            identity: request.identity,
            materialization: {
              ...request.materialization,
              scrub: Effect.void,
            },
            emit: (event) =>
              Effect.sync(() => send({ type: "provider.event", event })).pipe(Effect.as(undefined)),
          })
          .pipe(Effect.provideService(Scope.Scope, scope)),
      );
      send({ type: "provider.result", requestId: request.requestId, success: true });
      return;
    }
    if (session === undefined) throw new Error("provider session is not started");
    if (request.type === "provider.dispatch") {
      await Effect.runPromise(session.dispatch(request.command));
      send({ type: "provider.result", requestId: request.requestId, success: true });
      return;
    }
    if (request.type === "provider.health") {
      const health = await Effect.runPromise(session.health);
      send({ type: "provider.result", requestId: request.requestId, success: true, health });
      return;
    }
    await closeSession();
    send({ type: "provider.result", requestId: request.requestId, success: true });
  } catch {
    send({
      type: "provider.result",
      requestId: request.requestId,
      success: false,
      errorCode: "operation_failed",
    });
  }
};

NodeProcess.stdin.setEncoding("utf8");
NodeProcess.stdin.on("data", (chunk: string) => {
  inputBuffer += chunk;
  if (Buffer.byteLength(inputBuffer, "utf8") > MAX_PROTOCOL_BUFFER_BYTES) NodeProcess.exit(71);
  let newline = inputBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    processing = processing.then(() => handleLine(line)).catch(() => NodeProcess.exit(71));
    newline = inputBuffer.indexOf("\n");
  }
});
NodeProcess.stdin.once("end", () => {
  void processing.finally(async () => {
    await closeSession().catch(() => undefined);
    NodeProcess.exit(0);
  });
});

send({ type: "provider.ready" });
