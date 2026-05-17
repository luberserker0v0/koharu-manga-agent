const path = require("path");
const koharu = require(path.join(__dirname, "../helpers/koharu"));
const fs = require("fs");

describe("pipeline.test.js - 完整翻譯管線端到端測試", () => {
  let projectId;

  beforeAll(async () => {
    const available = await global.checkKoharu();
    if (!available) {
      console.warn("Koharu 服務未運行，跳過 E2E 管線測試");
    }
  });

  describe("專案管理", () => {
    test("應能列出專案", async () => {
      if (!global.KOHARU_AVAILABLE) return;

      const projects = await koharu.listProjects();
      expect(Array.isArray(projects)).toBe(true);
      expect(projects.length).toBeGreaterThan(0);

      // Save first project ID for later tests
      projectId = projects[0].id;
    });

    test("應能開啟專案", async () => {
      if (!global.KOHARU_AVAILABLE || !projectId) return;

      const result = await koharu.openProject(projectId);
      expect(result).toBeDefined();
    });

    test("開啟專案後應能取得場景", async () => {
      if (!global.KOHARU_AVAILABLE || !projectId) return;

      const scene = await koharu.getScene();
      expect(scene).toBeDefined();
      expect(scene.scene).toBeDefined();
    });
  });

  describe("管線操作", () => {
    test("應能取得引擎列表", async () => {
      if (!global.KOHARU_AVAILABLE) return;

      const engines = await koharu.getEngines();
      expect(engines).toBeDefined();
      expect(engines.detectors || engines.ocr || engines.translators).toBeDefined();
    });

    test("應能取得 LLM 狀態", async () => {
      if (!global.KOHARU_AVAILABLE) return;

      const status = await koharu.getLLMStatus();
      expect(status).toBeDefined();
    });
  });

  describe("配置驗證", () => {
    test("koharu.json 應有有效配置", () => {
      const configPath = path.join(__dirname, "../../.opencode/koharu.json");
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(config.api.baseUrl).toBeDefined();
      expect(config.defaults.targetLanguage).toBe("zh-TW");
    });

    test("shared/config.js 應正確載入 koharu.json", () => {
      const config = require(path.join(__dirname, "../../.opencode/skills/shared/config"));
      expect(config.DEFAULT_BASE_URL).toBeDefined();
      expect(config.DEFAULTS.targetLanguage).toBe("zh-TW");
    });
  });
});
