const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = async function globalTeardown() {
  const testRoot = process.env.MANGA_TRANSLATION_TEST_ROOT;
  if (!testRoot) return;

  const resolvedRoot = path.resolve(testRoot);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolvedRoot);
  const isManagedTestRoot = relative
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && path.basename(resolvedRoot).startsWith("koharu-manga-agent-jest-");

  if (!isManagedTestRoot) {
    throw new Error(`Refusing to delete unexpected Jest data root: ${resolvedRoot}`);
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
};
