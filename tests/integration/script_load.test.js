const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = path.join(__dirname, "../../.opencode/skills");

const SCRIPT_PATHS = [
  "manga-translate-zhtw/scripts/one_click_translate.js",
  "manga-translate-zhtw/scripts/quality_check.js",
  "manga-translate-zhtw/scripts/apply_fixes.js",
  "manga-translate-zhtw/scripts/delete_page.js",
  "manga-translate-zhtw/scripts/extract_references.js",
  "manga-translate-zhtw/scripts/build_knowledge_base.js",
  "manga-translate-zhtw/scripts/update_knowledge_base.js",
  "manga-translate-zhtw/scripts/self_reflection.js",
  "manga-translate-zhtw/scripts/export_project.js",
  "koharu-pipeline-launcher/scripts/start_pipeline.js",
  "koharu-pipeline-launcher/scripts/listen_events.js",
  "koharu-project-lister/scripts/list-projects.js",
  "clean-logs/scripts/clean_logs.js",
];

describe("script_load.test.js", () => {
  test.each(SCRIPT_PATHS)("%s exists", (scriptPath) => {
    expect(fs.existsSync(path.join(SCRIPTS_DIR, scriptPath))).toBe(true);
  });

  test.each(SCRIPT_PATHS)("%s has non-empty source", (scriptPath) => {
    const content = fs.readFileSync(path.join(SCRIPTS_DIR, scriptPath), "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  test.each(SCRIPT_PATHS)("%s no longer depends on shared/", (scriptPath) => {
    const content = fs.readFileSync(path.join(SCRIPTS_DIR, scriptPath), "utf-8");
    expect(content).not.toContain("shared/config");
    expect(content).not.toContain("shared/api");
  });

  test.each([
    "manga-translate-zhtw/scripts/one_click_translate.js",
    "manga-translate-zhtw/scripts/export_project.js",
    "manga-translate-zhtw/scripts/quality_check.js",
  ])("%s uses manga local lib modules", (scriptPath) => {
    const content = fs.readFileSync(path.join(SCRIPTS_DIR, scriptPath), "utf-8");
    expect(content).toContain('../lib/config');
  });

  test.each([
    "koharu-pipeline-launcher/scripts/start_pipeline.js",
    "koharu-pipeline-launcher/scripts/listen_events.js",
  ])("%s uses pipeline-launcher local lib modules", (scriptPath) => {
    const content = fs.readFileSync(path.join(SCRIPTS_DIR, scriptPath), "utf-8");
    expect(content).toContain('../lib/config');
    expect(content).toContain('../lib/api');
  });

  test("scripts do not hardcode the default API URL constant", () => {
    const hardcodedValues = [
      'const DEFAULT_BASE_URL = "http://127.0.0.1:9999"',
      "const DEFAULT_API_URL = 'http://127.0.0.1:9999'",
    ];

    for (const scriptPath of SCRIPT_PATHS) {
      const content = fs.readFileSync(path.join(SCRIPTS_DIR, scriptPath), "utf-8");
      for (const hardcodedValue of hardcodedValues) {
        expect(content).not.toContain(hardcodedValue);
      }
    }
  });
});
