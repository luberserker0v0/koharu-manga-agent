const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = async function globalSetup() {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koharu-manga-agent-jest-"));
  const dataRoot = path.join(testRoot, "data");
  const configPath = path.join(testRoot, "config", "koharu.json");
  const projectConfigPath = path.join(__dirname, "..", ".opencode", "koharu.json");

  for (const relativePath of [
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
  ]) {
    fs.mkdirSync(path.join(dataRoot, relativePath), { recursive: true });
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(projectConfigPath)) {
    fs.copyFileSync(projectConfigPath, configPath);
  } else {
    fs.writeFileSync(configPath, "{}\n", "utf8");
  }

  process.env.MANGA_TRANSLATION_TEST_ROOT = testRoot;
  process.env.MANGA_TRANSLATION_DATA_ROOT = dataRoot;
  process.env.MANGA_TRANSLATION_CONFIG_PATH = configPath;
};
