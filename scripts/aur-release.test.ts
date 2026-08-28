import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const packagingFiles = [
  "packaging/aur/scripts/release.sh",
  "packaging/aur/t3code-bin/PKGBUILD",
  "packaging/aur/t3code-nightly-bin/PKGBUILD",
] as const;

it.effect("sources compatibility AUR packages only from Agents in Cloud releases", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const contents = yield* Effect.forEach(packagingFiles, (relativePath) =>
      fs.readFileString(path.join(repoRoot, relativePath)),
    );

    for (const content of contents) {
      assert.include(content, "jarrodwatts/agentsin-cloud");
      assert.notInclude(content, "pingdotgg/t3code");
      assert.notInclude(content, "T3-Code-${");
    }

    assert.include(contents[0], 'asset_name="Agents-in-Cloud-${version}-x86_64.AppImage"');
    assert.include(contents[1], '_appimage="Agents-in-Cloud-${pkgver}-x86_64.AppImage"');
    assert.include(contents[2], '_appimage="Agents-in-Cloud-${_upstream_version}-x86_64.AppImage"');
  }).pipe(Effect.provide(NodeServices.layer)),
);
