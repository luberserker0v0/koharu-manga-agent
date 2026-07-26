const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "../..");
const KB_PATH = path.join(PROJECT_ROOT, "knowledge_base/self/my-manga.json");
const REPORTS_PATH = path.join(PROJECT_ROOT, "knowledge_base/reports/extract_report.json");

describe("knowledge_base.test.js", () => {
  beforeAll(async () => {
    const available = await global.checkKoharu();
    if (!available) {
      console.warn("Koharu unavailable, skipping E2E knowledge-base assertions.");
    }
  });

  test("knowledge-base directories exist", () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, "knowledge_base/self"))).toBe(true);
    expect(fs.existsSync(path.join(PROJECT_ROOT, "knowledge_base/reports"))).toBe(true);
  });

  test("manga local config resolves knowledge-base paths", () => {
    const config = require(path.join(
      PROJECT_ROOT,
      ".opencode/skills/manga-translate-zhtw/lib/config"
    ));
    expect(config.PATHS.KNOWLEDGE_BASE).toBe(KB_PATH);
    expect(config.PATHS.REPORTS).toBe(REPORTS_PATH);
    expect(config.PATHS.TODO_LIST).toBe(path.join(PROJECT_ROOT, "TODO_LIST.md"));
  });

  test("knowledge-base file shape is valid when present", () => {
    if (!fs.existsSync(KB_PATH)) return;

    const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf-8"));
    if (kb.metadata) {
      expect(kb.metadata).toHaveProperty("schema_version");
      expect(kb.metadata).toHaveProperty("project_name");
      expect(kb.metadata).toHaveProperty("source");
      expect(kb.metadata).toHaveProperty("created_at");
      expect(kb.metadata).toHaveProperty("updated_at");
    } else {
      expect(kb).toHaveProperty("project_name");
      expect(kb).toHaveProperty("source");
      expect(kb).toHaveProperty("created_at");
      expect(kb).toHaveProperty("updated_at");
    }
    expect(Array.isArray(kb.translation_pairs)).toBe(true);

    if (kb.translation_pairs.length > 0) {
      expect(kb.translation_pairs[0]).toHaveProperty("original");
      expect(kb.translation_pairs[0]).toHaveProperty("translation");
      expect(kb.translation_pairs[0]).toHaveProperty("pageName");
      if (kb.metadata) {
        expect(kb.translation_pairs[0]).toHaveProperty("id");
        expect(kb.translation_pairs[0]).toHaveProperty("sourceReference");
      }
    }
  });

  test("TODO_LIST.md exists", () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, "TODO_LIST.md"))).toBe(true);
  });
});
