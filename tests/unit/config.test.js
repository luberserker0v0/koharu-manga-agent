const path = require("path");
const { config, paths } = require("../../backend/src/config");

describe("backend config", () => {
  test("loads default API URL and defaults", () => {
    expect(config.api.baseUrl).toBe("http://127.0.0.1:4000");
    expect(config.defaults.targetLanguage).toBe("zh-TW");
    expect(config.defaults.exportFormat).toBe("rendered");
    expect(config.defaults.tolerance).toBe(10);
    expect(config.defaults.autoDeleteProject).toBe(false);
  });

  test("exposes resolved paths", () => {
    expect(path.isAbsolute(paths.knowledgeBase)).toBe(true);
    expect(path.isAbsolute(paths.reports)).toBe(true);
    expect(path.isAbsolute(paths.translated)).toBe(true);
    expect(path.isAbsolute(paths.logs)).toBe(true);
  });

  test("exposes workflow and runtime defaults", () => {
    expect(config.workflow.qualityCheck.enabled).toBe(true);
    expect(config.workflow.knowledgeBuilder.enabled).toBe(false);
    expect(config.runtime).toEqual(expect.objectContaining({ host: "127.0.0.1", port: 4001 }));
    expect(config.koharuRuntime).toEqual(expect.objectContaining({ managed: true, port: 4000 }));
  });
});
