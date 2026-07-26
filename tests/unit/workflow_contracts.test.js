const fs = require("fs");
const path = require("path");

const WORKFLOW_POLICY_PATH = path.join(
  __dirname,
  "../../.opencode/skills/manga-translate-zhtw/lib/workflow_policy.js"
);
const MAIN_AGENT_DOC_PATH = path.join(__dirname, "../../AGENTS.md");
const README_PATH = path.join(__dirname, "../../README.md");
const RUNTIME_CONFIG_PATH = path.join(__dirname, "../../backend/src/config.js");

describe("workflow contracts", () => {
  test("legacy one_click result contract shape remains available for migration", () => {
    const payload = {
      success: true,
      projectName: "translate_20260520230000",
      operationId: "op-123",
      engines: { detect: "detector-a", render: "render-a" },
      steps: ["detector-a", "render-a"],
      nextStep: "Monitor the pipeline operation inside the backend workflow.",
    };

    expect(payload.success).toBe(true);
    expect(typeof payload.projectName).toBe("string");
    expect(typeof payload.operationId).toBe("string");
    expect(payload.engines).toBeTruthy();
    expect(Array.isArray(payload.steps)).toBe(true);
    expect(typeof payload.nextStep).toBe("string");
  });

  test("main agent doc defines backend as the official runtime", () => {
    const content = fs.readFileSync(MAIN_AGENT_DOC_PATH, "utf-8").toLowerCase();

    expect(content).toContain("node backend/server.js");
    expect(content).toContain("the backend is the workflow and persistence owner");
    expect(content).toContain("ao http api is the only llm execution boundary");
    expect(content).toContain("do not restore `agent_sdk`");
    expect(content).not.toContain("dispatch subagents with the task tool");
  });

  test("readme exposes the local backend api instead of the old skill entrypoint", () => {
    const content = fs.readFileSync(README_PATH, "utf-8").toLowerCase();

    expect(content).toContain("manga translation process backend");
    expect(content).toContain("post /jobs/translation");
    expect(content).toContain("get /jobs/:jobid/stream");
    expect(content).not.toContain("node .opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js");
  });

  test("runtime config exposes host, port, and sqlite database path", () => {
    const runtimeConfig = require(RUNTIME_CONFIG_PATH);

    expect(runtimeConfig.runtime.host).toBe("127.0.0.1");
    expect(runtimeConfig.runtime.port).toBe(4001);
    expect(runtimeConfig.paths.database).toContain("process-agent.sqlite");
  });

  test("legacy workflow policy still covers all four config branches during migration", () => {
    const policy = require(WORKFLOW_POLICY_PATH);

    const scenarios = [
      {
        quality: true,
        knowledge: false,
        expectQuality: true,
        expectKnowledge: false,
      },
      {
        quality: false,
        knowledge: false,
        expectQuality: false,
        expectKnowledge: false,
      },
      {
        quality: true,
        knowledge: true,
        expectQuality: true,
        expectKnowledge: true,
      },
      {
        quality: false,
        knowledge: true,
        expectQuality: false,
        expectKnowledge: true,
      },
    ];

    for (const scenario of scenarios) {
      const workflow = {
        qualityCheck: { enabled: scenario.quality },
        knowledgeBuilder: { enabled: scenario.knowledge },
      };

      expect(policy.shouldRunQualityCheck(workflow)).toBe(
        scenario.expectQuality
      );
      expect(policy.shouldRunKnowledgeBuilder(workflow)).toBe(
        scenario.expectKnowledge
      );
    }
  });

  test("legacy close policy still depends on export success and knowledge completion", () => {
    const policy = require(WORKFLOW_POLICY_PATH);

    expect(
      policy.shouldCloseProject({
        exportSucceeded: false,
        knowledgeBuilderRequested: false,
      })
    ).toBe(false);

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
