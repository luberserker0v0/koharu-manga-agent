const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "../..");
const KB_PATH = path.join(PROJECT_ROOT, "knowledge_base/self/my-manga.json");
const REPORTS_PATH = path.join(PROJECT_ROOT, "knowledge_base/reports/extract_report.json");

describe("knowledge_base.test.js - 知識庫流程端到端測試", () => {
  beforeAll(async () => {
    const available = await global.checkKoharu();
    if (!available) {
      console.warn("Koharu 服務未運行，跳過 E2E 知識庫測試");
    }
  });

  describe("知識庫檔案", () => {
    test("知識庫目錄應存在", () => {
      const kbDir = path.join(PROJECT_ROOT, "knowledge_base/self");
      expect(fs.existsSync(kbDir)).toBe(true);
    });

    test("報告目錄應存在", () => {
      const reportsDir = path.join(PROJECT_ROOT, "knowledge_base/reports");
      expect(fs.existsSync(reportsDir)).toBe(true);
    });

    test("知識庫檔案格式應正確", () => {
      if (!fs.existsSync(KB_PATH)) return;

      const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf-8"));
      expect(kb).toHaveProperty("translation_pairs");
      expect(Array.isArray(kb.translation_pairs)).toBe(true);
    });
  });

  describe("配置路徑驗證", () => {
    test("config.PATHS.KNOWLEDGE_BASE 應指向正確路徑", () => {
      const config = require(path.join(PROJECT_ROOT, ".opencode/skills/shared/config"));
      expect(config.PATHS.KNOWLEDGE_BASE).toBe(KB_PATH);
    });

    test("config.PATHS.REPORTS 應指向正確路徑", () => {
      const config = require(path.join(PROJECT_ROOT, ".opencode/skills/shared/config"));
      expect(config.PATHS.REPORTS).toBe(REPORTS_PATH);
    });
  });

  describe("知識庫內容", () => {
    test("知識庫應有基本結構", () => {
      if (!fs.existsSync(KB_PATH)) return;

      const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf-8"));
      expect(kb).toHaveProperty("project_name");
      expect(kb).toHaveProperty("source");
      expect(kb).toHaveProperty("created_at");
      expect(kb).toHaveProperty("updated_at");
    });

    test("翻譯配對應有正確格式", () => {
      if (!fs.existsSync(KB_PATH)) return;

      const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf-8"));
      const pairs = kb.translation_pairs || [];

      if (pairs.length > 0) {
        const firstPair = pairs[0];
        expect(firstPair).toHaveProperty("original");
        expect(firstPair).toHaveProperty("translation");
        expect(firstPair).toHaveProperty("pageName");
      }
    });
  });

  describe("TODO_LIST.md", () => {
    test("TODO_LIST.md 應存在", () => {
      const todoPath = path.join(PROJECT_ROOT, "TODO_LIST.md");
      expect(fs.existsSync(todoPath)).toBe(true);
    });

    test("config.PATHS.TODO_LIST 應指向 TODO_LIST.md", () => {
      const config = require(path.join(PROJECT_ROOT, ".opencode/skills/shared/config"));
      const todoPath = path.join(PROJECT_ROOT, "TODO_LIST.md");
      expect(config.PATHS.TODO_LIST).toBe(todoPath);
    });
  });
});
