const fs = require("fs");
const path = require("path");
const { paths } = require("../../backend/src/config");

const KB_PATH = path.join(TEST_DATA_ROOT, "domains/knowledge/self/default.json");
const REPORTS_PATH = path.join(TEST_DATA_ROOT, "domains/knowledge/reports/extract_report.json");

describe("knowledge_base.test.js", () => {
  beforeAll(async () => {
    const available = await global.checkKoharu();
    if (!available) {
      console.warn("Koharu unavailable, skipping E2E knowledge-base assertions.");
    }
  });

  test("knowledge-base directories exist", () => {
    expect(fs.existsSync(path.join(TEST_DATA_ROOT, "domains/knowledge/self"))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_ROOT, "domains/knowledge/reports"))).toBe(true);
  });

  test("backend config resolves knowledge-base paths", () => {
    expect(paths.knowledgeBase).toBe(KB_PATH);
    expect(paths.reports).toBe(REPORTS_PATH);
    expect(paths.todoList).toBe(path.join(TEST_DATA_ROOT, "state/knowledge-tasks.md"));
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
});
