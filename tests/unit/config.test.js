const path = require("path");
const fs = require("fs");

const CONFIG_PATH = path.join(__dirname, "../../.opencode/skills/shared/config.js");
const KOHARU_JSON_PATH = path.join(__dirname, "../../.opencode/koharu.json");

describe("config.js - 三層配置系統", () => {
  let originalKoharuJson;
  let hasKoharuJson;

  beforeAll(() => {
    // Backup original koharu.json if exists
    hasKoharuJson = fs.existsSync(KOHARU_JSON_PATH);
    if (hasKoharuJson) {
      originalKoharuJson = fs.readFileSync(KOHARU_JSON_PATH, "utf-8");
    }
  });

  afterAll(() => {
    // Restore original koharu.json
    if (hasKoharuJson) {
      fs.writeFileSync(KOHARU_JSON_PATH, originalKoharuJson, "utf-8");
    }
  });

  describe("預設值載入", () => {
    test("應有預設 API URL", () => {
      const config = require(CONFIG_PATH);
      expect(config.DEFAULT_BASE_URL).toBe("http://127.0.0.1:9999");
    });

    test("應有預設超時值", () => {
      const config = require(CONFIG_PATH);
      expect(config.TIMEOUTS.sseListen).toBe(600);
      expect(config.TIMEOUTS.llmRetry).toBe(3);
      expect(config.TIMEOUTS.qualityCheck).toBe(300);
      expect(config.TIMEOUTS.kbUpdate).toBe(300);
    });

    test("應有預設路徑", () => {
      const config = require(CONFIG_PATH);
      expect(config.PATHS.KNOWLEDGE_BASE).toContain("knowledge_base");
      expect(config.PATHS.TRANSLATED).toContain("translated");
      expect(config.PATHS.LOGS).toContain("logs");
    });

    test("應有預設值", () => {
      const config = require(CONFIG_PATH);
      expect(config.DEFAULTS.targetLanguage).toBe("zh-TW");
      expect(config.DEFAULTS.exportFormat).toBe("rendered");
      expect(config.DEFAULTS.tolerance).toBe(10);
    });
  });

  describe("專案配置覆蓋", () => {
    test("koharu.json 應存在且有效", () => {
      expect(fs.existsSync(KOHARU_JSON_PATH)).toBe(true);
      const json = JSON.parse(fs.readFileSync(KOHARU_JSON_PATH, "utf-8"));
      expect(json.api).toBeDefined();
      expect(json.timeouts).toBeDefined();
      expect(json.paths).toBeDefined();
      expect(json.defaults).toBeDefined();
    });

    test("深層合併應保留未覆蓋的欄位", () => {
      const config = require(CONFIG_PATH);
      // If koharu.json only overrides some timeouts, others should remain default
      expect(config.TIMEOUTS.sseListen).toBeDefined();
      expect(config.TIMEOUTS.llmRetry).toBeDefined();
    });

    test("引擎配置應從 koharu.json 讀取", () => {
      const config = require(CONFIG_PATH);
      const koharuJson = JSON.parse(fs.readFileSync(KOHARU_JSON_PATH, "utf-8"));
      if (koharuJson.engines) {
        expect(config.ENGINES).toEqual(koharuJson.engines);
      } else {
        expect(config.ENGINES).toBeNull();
      }
    });
  });

  describe("常數完整性", () => {
    test("STEP_MAP 應包含 5 個步驟", () => {
      const config = require(CONFIG_PATH);
      expect(Object.keys(config.STEP_MAP)).toHaveLength(5);
      expect(config.STEP_MAP.detect).toBeDefined();
      expect(config.STEP_MAP.ocr).toBeDefined();
      expect(config.STEP_MAP.translate).toBeDefined();
      expect(config.STEP_MAP.clean).toBeDefined();
      expect(config.STEP_MAP.render).toBeDefined();
    });

    test("STEP_LABELS 應包含所有步驟標籤", () => {
      const config = require(CONFIG_PATH);
      expect(config.STEP_LABELS.detect).toBeDefined();
      expect(config.STEP_LABELS.ocr).toBeDefined();
      expect(config.STEP_LABELS.translate).toBeDefined();
      expect(config.STEP_LABELS.inpaint).toBeDefined();
      expect(config.STEP_LABELS.render).toBeDefined();
    });

    test("KNOWN_STEPS 應為陣列且非空", () => {
      const config = require(CONFIG_PATH);
      expect(Array.isArray(config.KNOWN_STEPS)).toBe(true);
      expect(config.KNOWN_STEPS.length).toBeGreaterThan(0);
    });

    test("TERMINAL_STATES 應包含所有終端狀態", () => {
      const config = require(CONFIG_PATH);
      expect(config.TERMINAL_STATES).toContain("completed");
      expect(config.TERMINAL_STATES).toContain("failed");
      expect(config.TERMINAL_STATES).toContain("completed_with_errors");
      expect(config.TERMINAL_STATES).toContain("cancelled");
    });

    test("VALID_EXPORT_FORMATS 應包含所有格式", () => {
      const config = require(CONFIG_PATH);
      expect(config.VALID_EXPORT_FORMATS).toContain("khr");
      expect(config.VALID_EXPORT_FORMATS).toContain("psd");
      expect(config.VALID_EXPORT_FORMATS).toContain("rendered");
      expect(config.VALID_EXPORT_FORMATS).toContain("inpainted");
    });

    test("SUBAGENTS 應包含 3 個子代理", () => {
      const config = require(CONFIG_PATH);
      expect(config.SUBAGENTS).toHaveLength(3);
      expect(config.SUBAGENTS).toContain("pipeline-runner");
      expect(config.SUBAGENTS).toContain("quality-checker");
      expect(config.SUBAGENTS).toContain("knowledge-builder");
    });
  });

  describe("路徑解析", () => {
    test("PROJECT_ROOT 應為有效路徑", () => {
      const config = require(CONFIG_PATH);
      expect(fs.existsSync(config.PROJECT_ROOT)).toBe(true);
    });

    test("PATHS 應為絕對路徑", () => {
      const config = require(CONFIG_PATH);
      expect(path.isAbsolute(config.PATHS.KNOWLEDGE_BASE)).toBe(true);
      expect(path.isAbsolute(config.PATHS.TRANSLATED)).toBe(true);
      expect(path.isAbsolute(config.PATHS.LOGS)).toBe(true);
    });
  });
});
