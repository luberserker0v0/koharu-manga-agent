const path = require("path");
const koharu = require(path.join(__dirname, "../helpers/koharu"));
const { config, PROJECT_CONFIG_PATH } = require("../../backend/src/config");

describe("pipeline.test.js", () => {
  let projectId;
  let projectOpened = false;

  beforeAll(async () => {
    const available = await global.checkKoharu();
    if (!available) {
      console.warn("Koharu unavailable, skipping E2E pipeline assertions.");
    }
  });

  describe("project access", () => {
    test("can list projects", async () => {
      if (!global.KOHARU_AVAILABLE) return;

      const projects = await koharu.listProjects();
      expect(Array.isArray(projects)).toBe(true);
      expect(projects.length).toBeGreaterThan(0);
      projectId = projects[0].id;
    });

    test("can open a project", async () => {
      if (!global.KOHARU_AVAILABLE || !projectId) return;
      try {
        const result = await koharu.openProject(projectId);
        expect(result).toBeDefined();
        projectOpened = true;
      } catch (error) {
        console.warn(`Skipping scene access because test project could not be opened: ${error.message}`);
      }
    });

    test("open project exposes a scene", async () => {
      if (!global.KOHARU_AVAILABLE || !projectId || !projectOpened) return;
      const scene = await koharu.getScene();
      expect(scene).toBeDefined();
      expect(scene.scene).toBeDefined();
    });
  });

  describe("pipeline dependencies", () => {
    test("can fetch engine catalog", async () => {
      if (!global.KOHARU_AVAILABLE) return;
      const engines = await koharu.getEngines();
      expect(engines).toBeDefined();
      expect(engines.detectors || engines.ocr || engines.translators).toBeDefined();
    });

    test("can fetch current LLM state", async () => {
      if (!global.KOHARU_AVAILABLE) return;
      const status = await koharu.getLLMStatus();
      expect(status).toBeDefined();
    });
  });

  describe("config wiring", () => {
    test("backend loads the isolated user configuration", () => {
      expect(PROJECT_CONFIG_PATH).toBe(path.resolve(global.TEST_CONFIG_PATH));
      expect(config.api.baseUrl).toBeDefined();
      expect(config.defaults.targetLanguage).toBe("zh-TW");
    });
  });
});
