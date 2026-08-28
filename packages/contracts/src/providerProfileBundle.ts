/**
 * Canonical binary bundle for an opaque provider profile.
 *
 * The credential-only login job creates this value, the control plane stores
 * and relays it without inspecting file contents, and the worker expands it
 * beneath its private credential root. Callers own returned mutable bytes and
 * must wipe them after sealing or materialization.
 */
const MAGIC = 0x41494350;
const PREFIX_BYTES = 6;
const FILE_PREFIX_BYTES = 6;

export const MAX_PROVIDER_PROFILE_BUNDLE_BYTES = 1024 * 1024;
export const MAX_PROVIDER_PROFILE_BUNDLE_FILES = 32;
export const MAX_PROVIDER_PROFILE_PATH_CHARS = 1024;

export interface ProviderProfileBundleFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

export interface ProviderProfileBundle {
  readonly format: 1;
  readonly files: ReadonlyArray<ProviderProfileBundleFile>;
}

export class ProviderProfileBundleError extends Error {
  readonly code:
    | "size"
    | "format"
    | "fileCount"
    | "truncated"
    | "path"
    | "duplicatePath"
    | "trailingData";

  constructor(code: ProviderProfileBundleError["code"]) {
    super(`invalid provider profile bundle: ${code}`);
    this.name = "ProviderProfileBundleError";
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const normalizeRelativePath = (value: string) => {
  if (
    value.length < 1 ||
    value.length > MAX_PROVIDER_PROFILE_PATH_CHARS ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.includes("\0")
  ) {
    throw new ProviderProfileBundleError("path");
  }
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ProviderProfileBundleError("path");
  }
  return parts.join("/");
};

export const encodeProviderProfileBundle = (
  files: ReadonlyArray<ProviderProfileBundleFile>,
): Uint8Array => {
  if (files.length < 1 || files.length > MAX_PROVIDER_PROFILE_BUNDLE_FILES) {
    throw new ProviderProfileBundleError("fileCount");
  }
  const paths = new Set<string>();
  const encoded = files.map((file) => {
    const path = normalizeRelativePath(file.path);
    if (paths.has(path)) throw new ProviderProfileBundleError("duplicatePath");
    paths.add(path);
    const pathBytes = textEncoder.encode(path);
    if (pathBytes.byteLength > 0xffff) throw new ProviderProfileBundleError("path");
    return { pathBytes, contents: file.contents };
  });
  const size =
    PREFIX_BYTES +
    encoded.reduce(
      (total, file) =>
        total + FILE_PREFIX_BYTES + file.pathBytes.byteLength + file.contents.byteLength,
      0,
    );
  if (size > MAX_PROVIDER_PROFILE_BUNDLE_BYTES) {
    for (const file of encoded) file.pathBytes.fill(0);
    throw new ProviderProfileBundleError("size");
  }
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(0, MAGIC, false);
  view.setUint16(4, encoded.length, false);
  let offset = PREFIX_BYTES;
  for (const file of encoded) {
    view.setUint16(offset, file.pathBytes.byteLength, false);
    view.setUint32(offset + 2, file.contents.byteLength, false);
    offset += FILE_PREFIX_BYTES;
    output.set(file.pathBytes, offset);
    offset += file.pathBytes.byteLength;
    output.set(file.contents, offset);
    offset += file.contents.byteLength;
    file.pathBytes.fill(0);
  }
  return output;
};

/** Returned file contents are views into `bytes`; they do not copy secret data. */
export const decodeProviderProfileBundle = (bytes: Uint8Array): ProviderProfileBundle => {
  if (bytes.byteLength < PREFIX_BYTES || bytes.byteLength > MAX_PROVIDER_PROFILE_BUNDLE_BYTES) {
    throw new ProviderProfileBundleError("size");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== MAGIC) throw new ProviderProfileBundleError("format");
  const count = view.getUint16(4, false);
  if (count < 1 || count > MAX_PROVIDER_PROFILE_BUNDLE_FILES) {
    throw new ProviderProfileBundleError("fileCount");
  }
  let offset = PREFIX_BYTES;
  const files: Array<ProviderProfileBundleFile> = [];
  const paths = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    if (offset + FILE_PREFIX_BYTES > bytes.byteLength) {
      throw new ProviderProfileBundleError("truncated");
    }
    const pathLength = view.getUint16(offset, false);
    const contentsLength = view.getUint32(offset + 2, false);
    offset += FILE_PREFIX_BYTES;
    if (pathLength < 1 || offset + pathLength + contentsLength > bytes.byteLength) {
      throw new ProviderProfileBundleError("truncated");
    }
    let path: string;
    try {
      path = normalizeRelativePath(textDecoder.decode(bytes.subarray(offset, offset + pathLength)));
    } catch (cause) {
      if (cause instanceof ProviderProfileBundleError) throw cause;
      throw new ProviderProfileBundleError("path");
    }
    if (paths.has(path)) throw new ProviderProfileBundleError("duplicatePath");
    paths.add(path);
    offset += pathLength;
    files.push({ path, contents: bytes.subarray(offset, offset + contentsLength) });
    offset += contentsLength;
  }
  if (offset !== bytes.byteLength) throw new ProviderProfileBundleError("trailingData");
  return { format: 1, files };
};

export const isProviderProfileBundle = (bytes: Uint8Array): boolean => {
  try {
    decodeProviderProfileBundle(bytes);
    return true;
  } catch {
    return false;
  }
};
