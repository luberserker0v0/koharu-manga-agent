const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIRECTORIES = [
  "workspaces/jobs",
  "cache/source-preflight",
  "cache/translated-images",
  "domains/knowledge/reports",
  "domains/knowledge/self",
  "domains/post-edit",
  "domains/reference/extraction",
  "domains/reference/images",
  "domains/reference/manifests",
  "ingress/uploads",
  "logs/backend",
  "outputs/translated",
  "runtime/koharu",
  "state",
];

function createDataDirectories(dataRoot) {
  for (const relativePath of DATA_DIRECTORIES) {
    fs.mkdirSync(path.join(dataRoot, relativePath), { recursive: true });
  }
}

module.exports = async function globalSetup() {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koharu-manga-agent-jest-"));
  const dataRoot = path.join(testRoot, "data");
  const configPath = path.join(testRoot, "config", "koharu.json");

  createDataDirectories(dataRoot);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{}\n", "utf8");

  process.env.MANGA_TRANSLATION_TEST_ROOT = testRoot;
  process.env.MANGA_TRANSLATION_DATA_ROOT = dataRoot;
  process.env.MANGA_TRANSLATION_CONFIG_PATH = configPath;
};
