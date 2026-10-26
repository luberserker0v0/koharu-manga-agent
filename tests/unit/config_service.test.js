const fs = require("fs");
const os = require("os");
const path = require("path");
const { ConfigService } = require("../../backend/src/config_service");

describe("runtime config service", () => {
  let root;
  let configPath;
  let defaults;
  let effectiveConfig;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-config-service-"));
    configPath = path.join(root, "koharu.json");
    defaults = {
      api: { baseUrl: "http://127.0.0.1:4000" },
      translation: { defaultTarget: { modelId: "default-model", providerId: "default-provider" },
        generationOptions: { temperature: 0.7, reasoning: "off" }, lmStudio: {
          baseUrl: "http://127.0.0.1:25555",
          koharuProxyBaseUrl: "http://127.0.0.1:4001/api/v1/lmstudio-openai/v1" } },
      workflow: { qualityCheck: { enabled: true }, knowledgeBuilder: { enabled: false } },
      agent: { baseUrl: "http://127.0.0.1:32768", model: "provider/default", messageTimeoutMs: 1000 },
      pipeline: { defaultProfile: "quality", modeProfiles: { quick: "fast" }, profiles: {
        fast: { engines: { clean: "lama-manga" } }, quality: { engines: { clean: "flux2-klein" } },
      } },
      paths: { reports: "reports" },
    };
    effectiveConfig = JSON.parse(JSON.stringify(defaults));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("persists editable values while preserving unrelated project settings", () => {
    fs.writeFileSync(configPath, JSON.stringify({ paths: { reports: "custom" } }), "utf8");
    const applied = jest.fn();
    const service = new ConfigService({ configPath, defaults, effectiveConfig, onApply: applied });
    service.update({ agent: { model: "new/model", messageTimeoutMs: 2000 }, translation: {
      defaultTarget: { modelId: "gemma", providerId: "lmstudio" },
      generationOptions: { temperature: 0.5, reasoning: "off" },
    }, pipeline: { modeProfiles: { quick: "quality" } } });
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(expect.objectContaining({
      paths: { reports: "custom" }, pipeline: { modeProfiles: { quick: "quality" } },
    }));
    expect(effectiveConfig.agent.model).toBe("new/model");
    expect(effectiveConfig.translation.generationOptions.temperature).toBe(0.5);
    expect(applied).toHaveBeenCalledWith(effectiveConfig);
  });

  test("rejects invalid values without changing the settings file", () => {
    fs.writeFileSync(configPath, "{}", "utf8");
    const service = new ConfigService({ configPath, defaults, effectiveConfig });
    expect(() => service.update({ agent: { baseUrl: "invalid" } })).toThrow("agent.baseUrl");
    expect(() => service.update({ agent: { messageTimeoutMs: 0 } })).toThrow("positive integer");
    expect(() => service.update({ agent: { model: "model-without-provider" } })).toThrow("provider_id/model_id");
    expect(() => service.update({ translation: { defaultTarget: { providerId: "deepl" } } })).toThrow("requires providerId and modelId");
    expect(() => service.update({ translation: { generationOptions: {
      temperature: 3, reasoning: "off" } } })).toThrow("between 0 and 1");
    expect(() => service.update({ translation: { lmStudio: { baseUrl: "invalid" } } })).toThrow("valid HTTP URL");
    expect(() => service.update({ pipeline: { profiles: { fast: { engines: { invalid: "engine" } } } } }))
      .toThrow("unsupported engine key");
    expect(() => service.update({ pipeline: { modeProfiles: { quick: "missing" } } }))
      .toThrow("Pipeline profile is unavailable");
    expect(fs.readFileSync(configPath, "utf8")).toBe("{}");
  });

  test("resets managed settings and retains unrelated settings", () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agent: { model: "custom/model", storyContextAgentName: "story-agent" },
      translation: { defaultTarget: { modelId: "custom", providerId: "custom-provider" } },
      workflow: { qualityCheck: { enabled: false }, knowledgeBuilder: { enabled: true } },
      pipeline: { modeProfiles: { quick: "quality" } },
      engines: { ocr: "obsolete" },
      paths: { reports: "custom" },
    }), "utf8");
    const service = new ConfigService({ configPath, defaults, effectiveConfig });
    service.reset();
    expect(effectiveConfig.agent.model).toBe("provider/default");
    expect(effectiveConfig.agent.storyContextAgentName).toBe("story-agent");
    expect(effectiveConfig.workflow.qualityCheck.enabled).toBe(true);
    expect(effectiveConfig.workflow.knowledgeBuilder.enabled).toBe(true);
    expect(effectiveConfig.pipeline.modeProfiles.quick).toBe("fast");
    expect(effectiveConfig.engines).toBeUndefined();
    expect(effectiveConfig.paths.reports).toBe("custom");
  });
});
