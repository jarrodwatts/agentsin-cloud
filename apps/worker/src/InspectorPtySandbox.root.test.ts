// @effect-diagnostics nodeBuiltinImport:off -- Linux root Bubblewrap integration proof.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { describe, expect, it } from "@effect/vitest";
import type { IPty } from "node-pty";
import * as Effect from "effect/Effect";

import { makeLinuxBubblewrapPtySandbox } from "./InspectorPtySandbox.ts";

const agentUid = 65_534;
const agentGid = 65_534;
const providerUid = 65_533;
const providerGid = 65_533;
const marker = "AIC_PTY_SECURITY_PROBE";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const runProbe = (
  pty: IPty,
  protectedPaths: ReadonlyArray<string>,
  workerLoopbackPort: number,
): Promise<ReadonlyArray<string>> =>
  new Promise((resolve, reject) => {
    let output = "";
    let receipt: ReadonlyArray<string> | undefined;
    const parse = () => {
      for (const line of output.split(/\r?\n/u)) {
        if (!line.startsWith(`${marker}|`)) continue;
        const fields = line.split("|").slice(1);
        if (
          fields.length === 12 &&
          /^\d+$/u.test(fields[0] ?? "") &&
          /^\d+$/u.test(fields[1] ?? "") &&
          /^\d+(?: \d+)*$/u.test(fields[2] ?? "") &&
          /^[a-fA-F0-9]+$/u.test(fields[3] ?? "") &&
          /^[01]$/u.test(fields[4] ?? "") &&
          /^net:\[\d+\]$/u.test(fields[5] ?? "") &&
          fields.slice(6).every((field) => /^[01]$/u.test(field))
        ) {
          receipt = fields;
        }
      }
    };
    const dataSubscription = pty.onData((chunk) => {
      output += chunk;
      parse();
    });
    let exitSubscription: { readonly dispose: () => void } = { dispose: () => undefined };
    exitSubscription = pty.onExit(({ exitCode, signal }) => {
      parse();
      dataSubscription.dispose();
      exitSubscription.dispose();
      if (receipt !== undefined) resolve(receipt);
      else
        reject(
          new Error(
            `sandbox probe exited before receipt (${String(exitCode)}/${String(signal)}): ${output}`,
          ),
        );
    });
    const sensitiveChecks = protectedPaths
      .map((path) => `[ ! -e ${shellQuote(path)} ] && [ ! -r ${shellQuote(path)} ]`)
      .join(" && ");
    pty.write(
      [
        `cap_eff=$(/usr/bin/awk '/^CapEff:/{print $2}' /proc/self/status)`,
        `no_new_privs=$(/usr/bin/awk '/^NoNewPrivs:/{print $2}' /proc/self/status)`,
        `net_ns=$(/usr/bin/readlink /proc/self/ns/net)`,
        `if /usr/bin/mount -o remount,rw /usr >/dev/null 2>&1; then remount=1; else remount=0; fi`,
        `if /usr/bin/touch /usr/agentsin-host-write-probe >/dev/null 2>&1; then host_write=1; else host_write=0; fi`,
        `if [ -x /usr/bin/unshare ]; then unshare_present=1; else unshare_present=0; fi`,
        `if /usr/bin/unshare -Ur /bin/true >/dev/null 2>&1; then nested_userns=1; else nested_userns=0; fi`,
        `if ${sensitiveChecks}; then secrets_hidden=1; else secrets_hidden=0; fi`,
        `if /usr/bin/python3 -c 'import socket; socket.create_connection(("127.0.0.1", ${String(workerLoopbackPort)}), 1)' >/dev/null 2>&1; then loopback_reached=1; else loopback_reached=0; fi`,
        `printf '\n${marker}|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$(/usr/bin/id -u)" "$(/usr/bin/id -g)" "$(/usr/bin/id -G)" "$cap_eff" "$no_new_privs" "$net_ns" "$remount" "$host_write" "$unshare_present" "$nested_userns" "$secrets_hidden" "$loopback_reached"`,
        "exit",
      ].join("; ") + "\r",
    );
  });

describe.skipIf(NodeProcess.env.AGENTSIN_ROOT_SECURITY_TEST !== "1")(
  "hosted inspector Bubblewrap boundary",
  () => {
    it.effect("drops identity and caps, isolates network, and hides worker credentials", () =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          if (NodeProcess.platform !== "linux" || NodeProcess.getuid?.() !== 0)
            throw new Error("this security proof must run as root on Linux");
          const root = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "aic-inspector-pty-root-"),
          );
          await NodeFSP.chmod(root, 0o711);
          const workspace = NodePath.join(root, "checkout");
          const mtls = NodePath.join(root, "worker-mtls", "client-key.pem");
          const bootstrap = NodePath.join(root, "bootstrap.json");
          const provider = NodePath.join(root, "provider", "auth.json");
          await NodeFSP.mkdir(workspace, { mode: 0o755 });
          await NodeFSP.chown(workspace, providerUid, providerGid);
          await NodeFSP.mkdir(NodePath.dirname(mtls), { mode: 0o700 });
          await NodeFSP.mkdir(NodePath.dirname(provider), { mode: 0o700 });
          await Promise.all([
            NodeFSP.writeFile(mtls, "worker-key", { mode: 0o600 }),
            NodeFSP.writeFile(bootstrap, "bootstrap", { mode: 0o600 }),
            NodeFSP.writeFile(provider, "provider-token", { mode: 0o600 }),
          ]);
          const handle = await NodeFSP.open(workspace, 0);
          const identity = await handle.stat();
          expect(identity.uid).toBe(providerUid);
          expect(identity.gid).toBe(providerGid);
          expect(providerUid).not.toBe(agentUid);
          expect(providerGid).not.toBe(agentGid);
          const server = NodeNet.createServer((socket) => socket.destroy());
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (address === null || typeof address === "string")
            throw new Error("worker loopback probe did not bind a TCP port");
          return {
            root,
            handle,
            identity,
            protectedPaths: [mtls, bootstrap, provider],
            server,
            workerLoopbackPort: address.port,
            state: {} as { pty?: IPty },
          };
        }),
        ({ handle, identity, protectedPaths, workerLoopbackPort, state }) =>
          Effect.gen(function* () {
            const loadPty = yield* Effect.promise(() => import("node-pty"));
            const hostNetworkNamespace = yield* Effect.promise(() =>
              NodeFSP.readlink("/proc/self/ns/net"),
            );
            const sandbox = makeLinuxBubblewrapPtySandbox({
              loadPty,
              hostPlatform: "linux",
              agentUid,
              agentGid,
            });
            const pty = sandbox.spawn({
              workspaceMountSource: `/proc/${String(NodeProcess.pid)}/fd/${String(handle.fd)}`,
              workspaceMountIdentity: { dev: identity.dev, ino: identity.ino },
              shell: "/bin/sh",
              columns: 120,
              rows: 30,
            });
            state.pty = pty;
            const [
              uid,
              gid,
              groups,
              capEff,
              noNewPrivs,
              networkNamespace,
              remount,
              hostWrite,
              unsharePresent,
              nestedUserns,
              secretsHidden,
              loopbackReached,
            ] = yield* Effect.promise(() => runProbe(pty, protectedPaths, workerLoopbackPort));
            expect(uid).toBe(String(agentUid));
            expect(gid).toBe(String(agentGid));
            expect(groups).toBe(String(agentGid));
            expect(capEff).toMatch(/^0+$/u);
            expect(noNewPrivs).toBe("1");
            expect(networkNamespace).not.toBe(hostNetworkNamespace);
            expect(remount).toBe("0");
            expect(hostWrite).toBe("0");
            expect(unsharePresent).toBe("1");
            expect(nestedUserns).toBe("0");
            expect(secretsHidden).toBe("1");
            expect(loopbackReached).toBe("0");
          }),
        ({ root, handle, server, state }) =>
          Effect.promise(async () => {
            try {
              state.pty?.kill();
            } catch {
              // The normal probe path already exited.
            }
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            await handle.close();
            await NodeFSP.rm(root, { recursive: true, force: true });
          }),
      ),
    );
  },
);
