const fs = require("node:fs");
const path = require("node:path");

const validateTreeRecords = ({ tree, baseRoot, readBlob }) => {
  for (const record of tree.toString("utf8").split("\0")) {
    if (record === "") continue;
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t(.+)$/u.exec(record);
    if (match === null) throw new Error("pull request Git tree contains an invalid entry");
    const [, mode, type, object, file] = match;
    if (path.isAbsolute(file) || file.split("/").includes("..")) {
      throw new Error(`pull request path is unsafe: ${file}`);
    }
    if (file === ".repos" || file.startsWith(".repos/")) continue;
    if (type === "blob" && mode === "120000") {
      const baseLink = path.join(baseRoot, file);
      const target = readBlob(object);
      const resolvedTarget = path.resolve(path.dirname(baseLink), target);
      if (
        !fs.existsSync(baseLink) ||
        !fs.lstatSync(baseLink).isSymbolicLink() ||
        fs.readlinkSync(baseLink) !== target ||
        path.isAbsolute(target) ||
        (!resolvedTarget.startsWith(`${baseRoot}${path.sep}`) && resolvedTarget !== baseRoot)
      ) {
        throw new Error(`new, changed, or external symlink is denied: ${file}`);
      }
      continue;
    }
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`submodules and special files are denied: ${file}`);
    }
  }
};

module.exports = { validateTreeRecords };
