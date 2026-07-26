const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(
  __dirname,
  "../../.opencode/skills/manga-translate-zhtw/lib/config.js"
);
const WORKFLOW_POLICY_PATH = path.join(
  __dirname,
  "../../.opencode/skills/manga-translate-zhtw/lib/workflow_policy.js"
);
const KOHARU_JSON_PATH = path.join(__dirname, "../../.opencode/koharu.json");

describe("manga config", () => {
  test("loads default API URL and defaults", () => {
    const config = require(CONFIG_PATH);
    expect(config.DEFAULT_BASE_URL).toBe("http://127.0.0.1:4000");
    expect(config.DEFAULTS.targetLanguage).toBe("zh-TW");
    expect(config.DEFAULTS.exportFormat).toBe("rendered");
    expect(config.DEFAULTS.tolerance).toBe(10);
    expect(config.DEFAULTS.autoDeleteProject).toBe(false);
  });

  test("exposes resolved paths", () => {
    const config = require(CONFIG_PATH);
    expect(path.isAbsolute(config.PATHS.KNOWLEDGE_BASE)).toBe(true);
    expect(path.isAbsolute(config.PATHS.REPORTS)).toBe(true);
    expect(path.isAbsolute(config.PATHS.TRANSLATED)).toBe(true);
    expect(path.isAbsolute(config.PATHS.LOGS)).toBe(true);
  });

  test("reads engines and workflow flags from koharu.json", () => {
    const config = require(CONFIG_PATH);
    const koharuJson = JSON.parse(fs.readFileSync(KOHARU_JSON_PATH, "utf-8"));

    expect(config.ENGINES).toEqual(koharuJson.engines);
    expect(config.WORKFLOW.qualityCheck.enabled).toBe(
      koharuJson.workflow.qualityCheck.enabled
    );
    expect(config.WORKFLOW.knowledgeBuilder.enabled).toBe(
      koharuJson.workflow.knowledgeBuilder.enabled
    );
  });

  test("retains manga workflow metadata used by scripts", () => {
    const config = require(CONFIG_PATH);
    expect(config.STEP_MAP.detect).toBeDefined();
    expect(config.STEP_LABELS.render).toBe("Render");
    expect(config.KNOWN_STEPS).toContain("translate");
    expect(config.TERMINAL_STATES).toContain("completed");
    expect(config.VALID_EXPORT_FORMATS).toContain("rendered");
  });
});

describe("workflow policy", () => {
  test("quality-check defaults to enabled unless explicitly disabled", () => {
    const policy = require(WORKFLOW_POLICY_PATH);
    expect(policy.shouldRunQualityCheck()).toBe(true);
    expect(
      policy.shouldRunQualityCheck({ qualityCheck: { enabled: false } })
    ).toBe(false);
  });

  test("knowledge-builder runs on config enable or explicit request", () => {
    const policy = require(WORKFLOW_POLICY_PATH);
    expect(
      policy.shouldRunKnowledgeBuilder({ knowledgeBuilder: { enabled: false } })
    ).toBe(false);
    expect(
      policy.shouldRunKnowledgeBuilder(
        { knowledgeBuilder: { enabled: false } },
        true
      )
    ).toBe(true);
    expect(
      policy.shouldRunKnowledgeBuilder({ knowledgeBuilder: { enabled: true } })
    ).toBe(true);
  });

  test("close-project policy follows export and knowledge-builder state", () => {
    const policy = require(WORKFLOW_POLICY_PATH);
    expect(policy.shouldCloseProject({ exportSucceeded: false })).toBe(false);
    expect(
      policy.shouldCloseProject({
        exportSucceeded: true,
        knowledgeBuilderRequested: false,
      })
    ).toBe(true);
    expect(
      policy.shouldCloseProject({
        exportSucceeded: true,
        knowledgeBuilderRequested: true,
        knowledgeBuilderSucceeded: false,
      })
    ).toBe(false);
    expect(
      policy.shouldCloseProject({
        exportSucceeded: true,
        knowledgeBuilderRequested: true,
        knowledgeBuilderSucceeded: true,
      })
    ).toBe(true);
  });
});
