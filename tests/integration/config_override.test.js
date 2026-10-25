const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_MODULE_PATH = path.join(__dirname, "../../backend/src/config.js");

function loadConfigInChild(configPath, dataRoot) {
  const script = `const { config, paths } = require(${JSON.stringify(CONFIG_MODULE_PATH)});` +
    "process.stdout.write(JSON.stringify({ config, paths }));";
  const env = {
    ...process.env,
    MANGA_TRANSLATION_CONFIG_PATH: configPath,
    MANGA_TRANSLATION_DATA_ROOT: dataRoot,
  };
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8" }));
}

describe("backend config override precedence", () => {
  test("user config overrides defaults and resolves paths beneath the data root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-config-override-"));
    const configPath = path.join(root, "config", "koharu.json");
    const dataRoot = path.join(root, "data");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      api: { baseUrl: "http://127.0.0.1:4555" },
      defaults: { tolerance: 7 },
      paths: { translated: "custom-output" },
    }));

    try {
      const loaded = loadConfigInChild(configPath, dataRoot);
      expect(loaded.config.api.baseUrl).toBe("http://127.0.0.1:4555");
      expect(loaded.config.defaults.tolerance).toBe(7);
      expect(loaded.config.defaults.targetLanguage).toBe("zh-TW");
      expect(loaded.paths.translated).toBe(path.join(dataRoot, "custom-output"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
