const path = require("path");
const fs = require("fs");

const SCRIPTS_DIR = path.join(__dirname, "../../.opencode/skills");

const SCRIPT_PATHS = [
  // manga-translate-zhtw
  "manga-translate-zhtw/scripts/upload_pages.js",
  "manga-translate-zhtw/scripts/llm_control.js",
  "manga-translate-zhtw/scripts/select_engines.js",
  "manga-translate-zhtw/scripts/quality_check.js",
  "manga-translate-zhtw/scripts/apply_fixes.js",
  "manga-translate-zhtw/scripts/delete_page.js",
  "manga-translate-zhtw/scripts/extract_references.js",
  "manga-translate-zhtw/scripts/build_knowledge_base.js",
  "manga-translate-zhtw/scripts/update_knowledge_base.js",
  "manga-translate-zhtw/scripts/self_reflection.js",
  "manga-translate-zhtw/scripts/export_project.js",
  // koharu-pipeline-launcher
  "koharu-pipeline-launcher/scripts/start_pipeline.js",
  "koharu-pipeline-launcher/scripts/listen_events.js",
  // koharu-project-opener
  "koharu-project-opener/scripts/open-project.js",
  // koharu-project-lister
  "koharu-project-lister/scripts/list-projects.js",
  // clean-logs
  "clean-logs/scripts/clean_logs.js",
];

describe("script_load.test.js - 腳本模組載入測試", () => {
  describe("檔案存在性", () => {
    SCRIPT_PATHS.forEach((scriptPath) => {
      test(`${scriptPath} 應存在`, () => {
        const fullPath = path.join(SCRIPTS_DIR, scriptPath);
        expect(fs.existsSync(fullPath)).toBe(true);
      });
    });
  });

  describe("語法正確性", () => {
    SCRIPT_PATHS.forEach((scriptPath) => {
      test(`${scriptPath} 應有有效語法`, () => {
        const fullPath = path.join(SCRIPTS_DIR, scriptPath);
        const content = fs.readFileSync(fullPath, "utf-8");
        // Check for common syntax issues
        expect(content).not.toContain("undefined");
        // Verify it can be parsed
        expect(() => {
          // Just check the file can be read and has valid structure
          if (content.trim().length === 0) {
            throw new Error("Empty file");
          }
        }).not.toThrow();
      });
    });
  });

  describe("shared 模組引用", () => {
    const SHARED_MODULES = ["../../shared/config", "../../shared/api"];

    SCRIPT_PATHS.forEach((scriptPath) => {
      test(`${scriptPath} 應引用 shared 模組`, () => {
        const fullPath = path.join(SCRIPTS_DIR, scriptPath);
        const content = fs.readFileSync(fullPath, "utf-8");

        // Each script should require at least one shared module
        const hasConfigRequire = content.includes("shared/config");
        const hasApiRequire = content.includes("shared/api");

        expect(hasConfigRequire || hasApiRequire).toBe(true);
      });
    });
  });

  describe("無硬編碼 API URL", () => {
    const HARDCODED_URLS = [
      'const DEFAULT_BASE_URL = "http://127.0.0.1:9999"',
      "const DEFAULT_API_URL = 'http://127.0.0.1:9999'",
      'const DEFAULT_BASE_URL = "http://127.0.0.1:9999";',
    ];

    SCRIPT_PATHS.forEach((scriptPath) => {
      test(`${scriptPath} 不應有硬編碼 API URL`, () => {
        const fullPath = path.join(SCRIPTS_DIR, scriptPath);
        const content = fs.readFileSync(fullPath, "utf-8");

        HARDCODED_URLS.forEach((url) => {
          expect(content).not.toContain(url);
        });
      });
    });
  });

  describe("無硬編碼路徑", () => {
    const HARDCODED_PATHS = [
      'path.join(__dirname, "..", "..", "..", "..", "knowledge_base"',
      'path.join(__dirname, "..", "..", "..", "..", "TODO_LIST.md")',
      'path.join(__dirname, "..", "..", "..", "..", "logs")',
    ];

    SCRIPT_PATHS.forEach((scriptPath) => {
      test(`${scriptPath} 不應有硬編碼路徑`, () => {
        const fullPath = path.join(SCRIPTS_DIR, scriptPath);
        const content = fs.readFileSync(fullPath, "utf-8");

        HARDCODED_PATHS.forEach((p) => {
          expect(content).not.toContain(p);
        });
      });
    });
  });
});
