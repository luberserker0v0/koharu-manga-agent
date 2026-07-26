const path = require("path");
const config = require(path.join(__dirname, "../../.opencode/skills/manga-translate-zhtw/lib/config"));

describe("config_override.test.js - config override coverage", () => {
  describe("CLI arguments", () => {
    test("one_click_translate.js supports --base-url", () => {
      const scriptPath = path.join(
        __dirname,
        "../../.opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js"
      );
      const content = require("fs").readFileSync(scriptPath, "utf-8");
      expect(content).toContain("--base-url");
    });

    test("extract_references.js supports --tolerance", () => {
      const scriptPath = path.join(
        __dirname,
        "../../.opencode/skills/manga-translate-zhtw/scripts/extract_references.js"
      );
      const content = require("fs").readFileSync(scriptPath, "utf-8");
      expect(content).toContain("--tolerance");
    });

    test("listen_events.js supports --timeout", () => {
      const scriptPath = path.join(
        __dirname,
        "../../.opencode/skills/koharu-pipeline-launcher/scripts/listen_events.js"
      );
      const content = require("fs").readFileSync(scriptPath, "utf-8");
      expect(content).toContain("--timeout");
    });

    test("export_project.js supports --format", () => {
      const scriptPath = path.join(
        __dirname,
        "../../.opencode/skills/manga-translate-zhtw/scripts/export_project.js"
      );
      const content = require("fs").readFileSync(scriptPath, "utf-8");
      expect(content).toContain("--format");
    });
  });

  describe("shared config values", () => {
    test("config.DEFAULT_BASE_URL comes from koharu.json", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));
      expect(config.DEFAULT_BASE_URL).toBe(koharu.api.baseUrl);
    });

    test("config.DEFAULTS.tolerance comes from koharu.json", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));
      expect(config.DEFAULTS.tolerance).toBe(koharu.defaults.tolerance);
    });

    test("config.TIMEOUTS.sseListen comes from koharu.json", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));
      expect(config.TIMEOUTS.sseListen).toBe(koharu.timeouts.sseListen);
    });

    test("config.PATHS are resolved from koharu.json", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));

      expect(config.PATHS.TRANSLATED).toContain(
        koharu.paths.translated.replace("/", "").replace("\\", "")
      );
      expect(config.PATHS.LOGS).toContain(
        koharu.paths.logs.replace("/", "").replace("\\", "")
      );
    });

    test("config.WORKFLOW flags come from koharu.json", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));

      expect(config.WORKFLOW.qualityCheck.enabled).toBe(
        koharu.workflow.qualityCheck.enabled
      );
      expect(config.WORKFLOW.knowledgeBuilder.enabled).toBe(
        koharu.workflow.knowledgeBuilder.enabled
      );
    });
  });

  describe("override precedence", () => {
    test("koharu.json overrides shared defaults", () => {
      const fs = require("fs");
      const koharuPath = path.join(__dirname, "../../.opencode/koharu.json");
      const koharu = JSON.parse(fs.readFileSync(koharuPath, "utf-8"));

      if (koharu.api.baseUrl !== "http://127.0.0.1:9999") {
        expect(config.DEFAULT_BASE_URL).toBe(koharu.api.baseUrl);
      }
    });

    test("CLI-parsing scripts still expose --base-url", () => {
      const scripts = [
        "manga-translate-zhtw/scripts/one_click_translate.js",
        "manga-translate-zhtw/scripts/extract_references.js",
        "koharu-pipeline-launcher/scripts/listen_events.js",
      ];

      scripts.forEach((script) => {
        const scriptPath = path.join(__dirname, "../../.opencode/skills", script);
        const content = require("fs").readFileSync(scriptPath, "utf-8");
        expect(content).toContain("--base-url");
      });
    });
  });
});
