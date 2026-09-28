const fs = require("fs");
const os = require("os");
const path = require("path");
const { ConfigService } = require("../../backend/src/config_service");
const { createApiServer } = require("../../backend/src/http/server/api_server");

describe("runtime configuration API", () => {
  let directory;
  let configPath;
  let api;
  let baseUrl;
  let effectiveConfig;
  let aoClient;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "manga-config-api-"));
    configPath = path.join(directory, "koharu.json");
    const defaults = {
      api: { baseUrl: "http://127.0.0.1:4000" },
      translation: { defaultTarget: { providerId: "default-provider", modelId: "default-model" } },
      workflow: { qualityCheck: { enabled: true }, knowledgeBuilder: { enabled: false } },
      agent: { baseUrl: "http://127.0.0.1:32768", model: "provider/default", messageTimeoutMs: 1000 },
      engines: null,
      paths: { reports: "reports" },
    };
    effectiveConfig = structuredClone(defaults);
    aoClient = {
      checkAvailability: jest.fn().mockResolvedValue({ available: true, baseUrl: defaults.agent.baseUrl }),
      createConversation: jest.fn().mockResolvedValue({ id: "settings-model-catalog" }),
      writeConfig: jest.fn().mockResolvedValue({}),
      startConversation: jest.fn().mockResolvedValue({}),
      waitUntilReady: jest.fn().mockResolvedValue({ ready: true }),
      listProviders: jest.fn().mockResolvedValue({
        providers: [{ id: "my_local_lmstudio", name: "LM Studio", models: ["gemma-4", "qwen"] }],
        default: { my_local_lmstudio: "gemma-4" },
      }),
      deleteConversation: jest.fn().mockResolvedValue({}),
    };
    fs.writeFileSync(configPath, JSON.stringify({ paths: { reports: "preserved" } }), "utf8");
    const configService = new ConfigService({ configPath, defaults, effectiveConfig });
    api = createApiServer({
      jobManager: { getConfig: () => effectiveConfig },
      configService,
      aoClientFactory: jest.fn(() => aoClient),
      aoAssetsLoader: () => ({ opencodeConfig: { provider: {} } }),
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    baseUrl = `http://127.0.0.1:${api.server.address().port}`;
  });

  afterEach(async () => {
    if (api) await api.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("PATCH /config updates the effective and persisted runtime configuration", async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api: { baseUrl: "http://127.0.0.1:4100" },
        translation: { defaultTarget: { modelId: "gemma", providerId: "lmstudio" } },
        agent: { model: "provider/next", messageTimeoutMs: 2000 },
        workflow: { qualityCheck: { enabled: false } },
        engines: { ocr: "ocr-engine" },
      }),
    });
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.agent.model).toBe("provider/next");
    expect(updated.translation.defaultTarget).toEqual({ modelId: "gemma", providerId: "lmstudio" });
    expect(updated.workflow.qualityCheck.enabled).toBe(false);
    expect((await (await fetch(`${baseUrl}/config`)).json()).agent.model).toBe("provider/next");
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).paths.reports).toBe("preserved");
  });

  test("invalid updates return the field error without changing stored settings", async () => {
    const original = fs.readFileSync(configPath, "utf8");
    const response = await fetch(`${baseUrl}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { readyTimeoutMs: 0 } }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("agent.readyTimeoutMs");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  test("POST /config/reset restores defaults without deleting unmanaged settings", async () => {
    await fetch(`${baseUrl}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { model: "provider/custom" }, engines: { ocr: "custom" } }),
    });
    const response = await fetch(`${baseUrl}/config/reset`, { method: "POST" });
    expect(response.status).toBe(200);
    const reset = await response.json();
    expect(reset.agent.model).toBe("provider/default");
    expect(reset.engines).toBeNull();
    expect(reset.paths.reports).toBe("preserved");
  });

  test("POST /runtime/ao/connect checks an unsaved AO address without updating configuration", async () => {
    const response = await fetch(`${baseUrl}/runtime/ao/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:32769", apiKey: null }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).available).toBe(true);
    expect(effectiveConfig.agent.baseUrl).toBe("http://127.0.0.1:32768");
    expect(aoClient.checkAvailability).toHaveBeenCalled();
  });

  test("POST /runtime/ao/providers starts and cleans a temporary provider-catalog conversation", async () => {
    const response = await fetch(`${baseUrl}/runtime/ao/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:32768", apiKey: null }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).models.map((model) => model.id)).toEqual([
      "my_local_lmstudio/gemma-4",
      "my_local_lmstudio/qwen",
    ]);
    expect(aoClient.writeConfig).toHaveBeenCalledWith("settings-model-catalog", { provider: {} });
    expect(aoClient.listProviders).toHaveBeenCalledWith("settings-model-catalog");
    expect(aoClient.deleteConversation).toHaveBeenCalledWith("settings-model-catalog");
  });

  test("provider catalog errors still clean up the temporary conversation", async () => {
    aoClient.listProviders.mockRejectedValue(new Error("Provider catalog unavailable"));
    const response = await fetch(`${baseUrl}/runtime/ao/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:32768" }),
    });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("Provider catalog unavailable");
    expect(aoClient.deleteConversation).toHaveBeenCalledWith("settings-model-catalog");
  });
});
