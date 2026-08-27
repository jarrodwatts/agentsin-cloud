// @effect-diagnostics nodeBuiltinImport:off -- Object keys use Node's RFC 4648 base64url encoder.
import * as NodeBuffer from "node:buffer";

import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts/cloud";

export const ARTIFACT_KINDS = [
  "terminal-chunk",
  "screenshot",
  "diff",
  "environment-build-log",
  "thread-export",
] as const;
export const MAX_OBJECT_KEY_BYTES = 1_024;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export class ArtifactKeyError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`${field} is not safe for an artifact object key`);
    this.name = "ArtifactKeyError";
    this.field = field;
  }
}

const traversalEscape = /%(?:2e|2f|5c)/i;
const pathSeparator = /[\\/]/u;
const isControlOrDirectionalOverride = (value: string) =>
  [...value].some((character) => {
    const point = character.codePointAt(0)!;
    return (
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    );
  });

export const validateArtifactKeyIdentity = (value: string, field: string): string => {
  if (
    value.length === 0 ||
    value.length > 256 ||
    !value.isWellFormed() ||
    value.normalize("NFC") !== value ||
    value === "." ||
    value === ".." ||
    pathSeparator.test(value) ||
    isControlOrDirectionalOverride(value) ||
    traversalEscape.test(value)
  ) {
    throw new ArtifactKeyError(field);
  }
  return value;
};

const encoded = (value: string, field: string) =>
  NodeBuffer.Buffer.from(validateArtifactKeyIdentity(value, field), "utf8").toString("base64url");

const boundedObjectKey = (value: string) => {
  if (NodeBuffer.Buffer.byteLength(value, "utf8") > MAX_OBJECT_KEY_BYTES) {
    throw new ArtifactKeyError("objectKey");
  }
  return value;
};

export const assertSha256 = (digest: string): string => {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new ArtifactKeyError("sha256");
  return digest;
};

export interface ArtifactKeyScope {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
}

export const artifactObjectKey = (
  scope: ArtifactKeyScope,
  kind: ArtifactKind,
  artifactId: string,
  sha256: string,
) => {
  if (!ARTIFACT_KINDS.includes(kind)) throw new ArtifactKeyError("kind");
  return boundedObjectKey(
    `v1/w/${encoded(scope.workspaceId, "workspaceId")}/t/${encoded(scope.threadId, "threadId")}/a/${kind}/${encoded(artifactId, "artifactId")}/${assertSha256(sha256)}`,
  );
};

export const threadExportObjectKey = (scope: ArtifactKeyScope, exportId: string, sha256: string) =>
  boundedObjectKey(
    `v1/w/${encoded(scope.workspaceId, "workspaceId")}/t/${encoded(scope.threadId, "threadId")}/x/${encoded(exportId, "exportId")}/${assertSha256(sha256)}.json`,
  );
