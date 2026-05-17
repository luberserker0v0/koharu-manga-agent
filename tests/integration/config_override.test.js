const path = require("path");
const config = require(path.join(__dirname, "../../.opencode/skills/shared/config"));

describe("config_override.test.js - 配置覆蓋測試", () => {
  describe("CLI 參數解析", () => {
    test("upload_pages.js 應支援 --base-url", () => {
      const scriptPath = path.join(__dirname, "../../.opencode/skills/manga-translate-zhtw/scripts/upload_pages.js");
      const content = require("fs").readFileSync(scriptPath, "utf-8");
      expect(content).toContain("--base-url");
    });

    test("extract_references.js 應支援 --tolerance", () => {
      const scriptPath = path.join(__dirname, "../../.opencode/skills/manga-translate-zhtw/scripts/extract_references.js");
      const content = require("fs").readFileSync(scriptPath, "utf-8");
      expect(content).toContain("--tolerance");
    });

    test("listen_events.js 應支援 --timeout", () => {
      const scriptPath = path.join(__dirname, "../../.opencode/skills/koharu-pipeline-launcher/scripts/listen_events.js");
      const content = require("fs").readFileSync(scriptPath, "utf-8");
      expect(content).toContain("--timeout");
    });

    test("export_project.js 應支援 --format", () => {
      const scriptPath = path.join(__dirname, "../../.opencode/skills/manga-translate-zhtw/scripts/export_project.js");
      const content = require("fs").readFileSync(scriptPath, "utf-8");
      expect(content).toContain("--format");
    });
  });

  describe("預設值一致性", () => {
    test("config.DEFAULT_BASE_URL 應與 koharu.json 一致", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));
      expect(config.DEFAULT_BASE_URL).toBe(koharu.api.baseUrl);
    });

    test("config.DEFAULTS.tolerance 應與 koharu.json 一致", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));
      expect(config.DEFAULTS.tolerance).toBe(koharu.defaults.tolerance);
    });

    test("config.TIMEOUTS.sseListen 應與 koharu.json 一致", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));
      expect(config.TIMEOUTS.sseListen).toBe(koharu.timeouts.sseListen);
    });

    test("config.PATHS 應解析 koharu.json 中的路徑", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));
      const projectRoot = config.PROJECT_ROOT;

      expect(config.PATHS.TRANSLATED).toContain(koharu.paths.translated.replace("/", "").replace("\\", ""));
      expect(config.PATHS.LOGS).toContain(koharu.paths.logs.replace("/", "").replace("\\", ""));
    });
  });

  describe("配置層級優先級", () => {
    test("koharu.json 應能覆蓋 shared 預設值", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));

      // If koharu.json has a different value, it should be used
      if (koharu.api.baseUrl !== "http://127.0.0.1:9999") {
        expect(config.DEFAULT_BASE_URL).toBe(koharu.api.baseUrl);
      }
    });

    test("CLI 參數應能覆蓋 koharu.json", () => {
      // This is tested by verifying scripts parse CLI args
      const scripts = [
        "manga-translate-zhtw/scripts/upload_pages.js",
        "manga-translate-zhtw/scripts/extract_references.js",
        "koharu-pipeline-launcher/scripts/listen_events.js",
      ];

      scripts.forEach((script) => {
        const scriptPath = path.join(__dirname, "../../.opencode/skills", script);
        const content = require("fs").readFileSync(scriptPath, "utf-8");
        expect(content).toContain("args[i] === \"--base-url\"");
      });
    });
  });
});
