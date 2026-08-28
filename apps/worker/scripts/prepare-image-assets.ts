// @effect-diagnostics nodeBuiltinImport:off -- Build artifact hashing is a Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const artifacts = ["entrypoint.mjs", "ProviderRuntimeChild.mjs"] as const;
const dist = NodePath.resolve(NodeProcess.cwd(), "dist");
const rows: Array<string> = [];

for (const artifact of artifacts) {
  const bytes = await NodeFSP.readFile(NodePath.join(dist, artifact));
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  rows.push(`${digest}  ${artifact}`);
  await NodeFSP.chmod(NodePath.join(dist, artifact), 0o755);
}

await NodeFSP.writeFile(NodePath.join(dist, "SHA256SUMS"), `${rows.join("\n")}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
