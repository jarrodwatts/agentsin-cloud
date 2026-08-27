// @effect-diagnostics nodeBuiltinImport:off -- Bubblewrap is the hosted Linux process-isolation boundary.
import * as NodeFS from "node:fs";

import type { IPty } from "node-pty";

export interface InspectorPtySandbox {
  /** True only when the adapter creates a separate filesystem/mount namespace. */
  readonly filesystemIsolated: boolean;
  /** True only when the adapter creates a network namespace separate from the worker. */
  readonly networkIsolated: boolean;
  readonly spawn: (input: {
    /** Descriptor-backed source pinned by ContainedWorkspace. */
    readonly workspaceMountSource: string;
    readonly workspaceMountIdentity: { readonly dev: number; readonly ino: number };
    readonly shell: "/bin/bash" | "/bin/sh" | "/bin/zsh";
    readonly columns: number;
    readonly rows: number;
  }) => IPty;
}

/**
 * Hosted PTYs run under bubblewrap with a new mount/process namespace. Only the
 * checkout and OS runtime are mounted; worker bootstrap, provider credentials,
 * mTLS material, and the host `/run`, `/tmp`, and home directory are absent.
 */
export const makeLinuxBubblewrapPtySandbox = (options: {
  readonly loadPty: typeof import("node-pty");
  readonly hostPlatform: NodeJS.Platform;
  /** Dedicated identity used only for untrusted interactive inspector shells. */
  readonly agentUid: number;
  readonly agentGid: number;
  readonly bubblewrapPath?: string;
  readonly setprivPath?: string;
  readonly launcherPath?: string;
}): InspectorPtySandbox => {
  const bubblewrap = options.bubblewrapPath ?? "/usr/bin/bwrap";
  const setpriv = options.setprivPath ?? "/usr/bin/setpriv";
  const launcher = options.launcherPath ?? "/bin/bash";
  if (
    !Number.isSafeInteger(options.agentUid) ||
    options.agentUid < 1 ||
    !Number.isSafeInteger(options.agentGid) ||
    options.agentGid < 1
  ) {
    throw new Error("hosted inspector PTY requires a dedicated untrusted uid and gid");
  }
  return {
    filesystemIsolated: true,
    networkIsolated: true,
    spawn: ({ workspaceMountSource, workspaceMountIdentity, shell, columns, rows }) => {
      if (
        options.hostPlatform !== "linux" ||
        !NodeFS.existsSync(bubblewrap) ||
        !NodeFS.existsSync(setpriv) ||
        !NodeFS.existsSync(launcher)
      ) {
        throw new Error("hosted inspector PTY isolation is unavailable");
      }
      const mountStat = NodeFS.statSync(workspaceMountSource);
      if (
        !mountStat.isDirectory() ||
        mountStat.dev !== workspaceMountIdentity.dev ||
        mountStat.ino !== workspaceMountIdentity.ino
      ) {
        throw new Error("hosted inspector PTY workspace anchor changed before spawn");
      }
      const readOnlySystem: Array<string> = ["/bin", "/lib", "/lib64", "/usr"];
      const args: Array<string> = [];
      for (const path of readOnlySystem) {
        if (NodeFS.existsSync(path)) args.push("--ro-bind", path, path);
      }
      args.push(
        "--chdir",
        "/workspace",
        "--setenv",
        "HOME",
        "/home/agent",
        "--setenv",
        "PATH",
        "/usr/local/bin:/usr/bin:/bin",
        "--setenv",
        "LANG",
        "C.UTF-8",
        "--setenv",
        "TERM",
        "xterm-256color",
        shell,
        "-l",
      );
      const launchScript = `
workspace_source=$1
setpriv=$2
uid=$3
gid=$4
bubblewrap=$5
shift 5
exec 9<"$workspace_source"
exec "$setpriv" "--reuid=$uid" "--regid=$gid" --clear-groups --no-new-privs -- "$bubblewrap" \
  --die-with-parent --new-session --unshare-user --unshare-pid --unshare-ipc --unshare-uts \
  --unshare-net --disable-userns --uid "$uid" --gid "$gid" --cap-drop ALL --clearenv \
  --proc /proc --dev /dev --tmpfs /run --tmpfs /tmp --dir /home --dir /home/agent \
  --bind /proc/self/fd/9 /workspace "$@"
`;
      return options.loadPty.spawn(
        launcher,
        [
          "-ceu",
          launchScript,
          "agentsin-inspector-launch",
          workspaceMountSource,
          setpriv,
          String(options.agentUid),
          String(options.agentGid),
          bubblewrap,
          ...args,
        ],
        {
          cwd: "/",
          cols: columns,
          rows,
          name: "xterm-256color",
          env: {},
        },
      );
    },
  };
};
