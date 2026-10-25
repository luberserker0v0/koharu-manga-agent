const fs = require("fs");
const path = require("path");

const MAIN_AGENT_DOC_PATH = path.join(__dirname, "../../AGENTS.md");
const README_PATH = path.join(__dirname, "../../README.md");
const RUNTIME_CONFIG_PATH = path.join(__dirname, "../../backend/src/config.js");

describe("workflow contracts", () => {
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
    expect(runtimeConfig.paths.database).toContain(path.join("state", "jobs.sqlite"));
  });

});
