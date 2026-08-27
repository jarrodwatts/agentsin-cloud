// @effect-diagnostics nodeBuiltinImport:off -- Security fixture exercises the real provider subprocess path.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSendTurnInput,
  TurnId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { T3ProviderService } from "../T3ProviderRuntime.ts";

interface ProbeConfiguration {
  readonly ownCredential: string;
  readonly mtlsKey: string;
  readonly bootstrap: string;
  readonly siblingCredential: string;
  readonly output: string;
}

const credentialDirectory = NodeProcess.env.AGENTSIN_PROVIDER_CREDENTIAL_DIRECTORY;
if (credentialDirectory === undefined) throw new Error("credential directory is required");

const configuration = JSON.parse(
  await NodeFSP.readFile(NodePath.join(credentialDirectory, "probe.json"), "utf8"),
) as ProbeConfiguration;
let sessions: ReadonlyArray<ProviderSession> = [];

class SecurityProviderError extends Data.TaggedError("SecurityProviderError")<{
  readonly cause: unknown;
}> {}

const runOrdinaryProviderCommand = (input: ProviderSendTurnInput) =>
  new Promise<void>((resolve, reject) => {
    const script = [
      'const fs=require("node:fs");',
      'const denied=(path)=>{try{fs.readFileSync(path);return false;}catch(error){return error.code==="EACCES";}};',
      "const sensitive=new Set([process.env.MTLS_KEY,process.env.BOOTSTRAP,process.env.SIBLING]);",
      'const inherited=fs.existsSync("/proc/self/fd")&&fs.readdirSync("/proc/self/fd").some((fd)=>{try{return sensitive.has(fs.readlinkSync("/proc/self/fd/"+fd));}catch{return false;}});',
      'const proof={uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),own:fs.readFileSync(process.env.OWN,"utf8"),mtlsDenied:denied(process.env.MTLS_KEY),bootstrapDenied:denied(process.env.BOOTSTRAP),siblingDenied:denied(process.env.SIBLING),privilegedFdInherited:inherited};',
      "fs.writeFileSync(process.env.OUTPUT,JSON.stringify(proof),{mode:0o600});",
    ].join("");
    const child = NodeChildProcess.spawn(NodeProcess.execPath, ["-e", script], {
      cwd: NodePath.dirname(configuration.output),
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        PATH: NodeProcess.env.PATH ?? "/usr/bin:/bin",
        OWN: configuration.ownCredential,
        MTLS_KEY: configuration.mtlsKey,
        BOOTSTRAP: configuration.bootstrap,
        SIBLING: configuration.siblingCredential,
        OUTPUT: configuration.output,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`ordinary provider command failed: ${String(code)}:${String(signal)}`));
    });
  }).then(() => ({ threadId: input.threadId, turnId: "turn-security" as TurnId }));

export const createT3ProviderService = (): T3ProviderService<SecurityProviderError> => ({
  startSession: (threadId, input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-08-27T12:00:00.000Z";
      const session = {
        provider: "codex" as ProviderDriverKind,
        providerInstanceId: "codex-root-security" as ProviderInstanceId,
        status: "ready" as const,
        runtimeMode: input.runtimeMode,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        threadId,
        createdAt: now,
        updatedAt: now,
      } satisfies ProviderSession;
      sessions = [session];
      return session;
    }),
  sendTurn: (input) =>
    Effect.tryPromise({
      try: () => runOrdinaryProviderCommand(input),
      catch: (cause) => new SecurityProviderError({ cause }),
    }),
  interruptTurn: () => Effect.void,
  respondToRequest: () => Effect.void,
  respondToUserInput: () => Effect.void,
  stopSession: () =>
    Effect.sync(() => {
      sessions = [];
    }),
  listSessions: () => Effect.succeed(sessions),
  getInstanceInfo: (instanceId) =>
    Effect.succeed({
      instanceId,
      driverKind: "codex" as ProviderDriverKind,
      enabled: true,
    }),
  rollbackConversation: () => Effect.void,
  streamEvents: Stream.empty,
});
