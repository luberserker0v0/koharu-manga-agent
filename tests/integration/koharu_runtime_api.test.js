const os = require("os");
const path = require("path");
const fs = require("fs");

const { createApiServer } = require("../../backend/src/http/api_server");
const { JobManager } = require("../../backend/src/job_manager");
const { JobStore } = require("../../backend/src/storage/job_store");

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koharu-runtime-api-"));
  return path.join(dir, "jobs.sqlite");
}

describe("Koharu runtime API", () => {
  let api;
  let baseUrl;
  let koharuRuntimeManager;
  let koharuClient;

  beforeEach(async () => {
    koharuRuntimeManager = {
      inspect: jest.fn().mockResolvedValue({
        status: "installed",
        mode: "managed",
        baseUrl: "http://127.0.0.1:4000",
        version: "0.61.2",
        installed: true,
        managedPid: null,
        lastError: null,
      }),
      ensureInstalled: jest.fn().mockResolvedValue({ status: "installed", installed: true }),
      ensureRunning: jest.fn().mockResolvedValue({ status: "running", installed: true, managedPid: 123 }),
      prepareRuntime: jest.fn().mockResolvedValue({ status: "installed", installed: true, lastPrepare: {} }),
      stopManaged: jest.fn().mockResolvedValue({ status: "installed", installed: true, managedPid: null }),
      inspectPaths: jest.fn().mockResolvedValue({
        dataRoot: "C:\\Users\\tester\\AppData\\Local\\Koharu",
        projectsRoot: "C:\\Users\\tester\\AppData\\Local\\Koharu\\projects",
        modelsRoot: "C:\\Users\\tester\\AppData\\Local\\Koharu\\models",
        runtimeRoot: "C:\\Users\\tester\\AppData\\Local\\Koharu\\runtime",
        fontsRoot: "C:\\Users\\tester\\AppData\\Local\\Koharu\\fonts",
        configPath: "C:\\Users\\tester\\AppData\\Local\\Koharu\\config.toml",
        executablePath: "C:\\repo\\cache\\koharu-runtime\\0.61.2\\koharu.exe",
        managedInstallRoot: "C:\\repo\\cache\\koharu-runtime",
        versionDir: "C:\\repo\\cache\\koharu-runtime\\0.61.2",
        baseUrl: "http://127.0.0.1:4000",
        exists: {},
        projectSamples: [],
        projectApiError: null,
      }),
    };
    koharuClient = {
      getEngines: jest.fn().mockResolvedValue({
        ocr: [{ id: "paddle-ocr-vl-1.6" }],
        inpainters: [{ id: "aot-inpainting" }],
      }),
    };
    const jobManager = new JobManager({
      store: new JobStore(createTempDbPath()),
      engine: { runTranslationJob: jest.fn(), projectLifecycle: { client: koharuClient } },
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { api: { baseUrl: "http://127.0.0.1:4000" }, workflow: { qualityCheck: { enabled: true } } },
      koharuRuntimeManager,
    });
    api = createApiServer({ jobManager, host: "127.0.0.1", port: 0 });
    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  test("GET /runtime/status includes managed Koharu fields", async () => {
    const response = await fetch(`${baseUrl}/runtime/status`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.koharu).toEqual(expect.objectContaining({
      status: "installed",
      mode: "managed",
      version: "0.61.2",
      installed: true,
      managedPid: null,
      lastError: null,
    }));
  });

  test.each([
    ["/runtime/koharu/install", "ensureInstalled"],
    ["/runtime/koharu/start", "ensureRunning"],
    ["/runtime/koharu/prepare", "prepareRuntime"],
    ["/runtime/koharu/stop", "stopManaged"],
  ])("POST %s returns a stable Koharu envelope", async (pathname, methodName) => {
    const response = await fetch(`${baseUrl}${pathname}`, { method: "POST" });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.koharu).toEqual(expect.any(Object));
    expect(koharuRuntimeManager[methodName]).toHaveBeenCalledTimes(1);
  });

  test("GET /runtime/koharu/engines returns live engine catalog", async () => {
    const response = await fetch(`${baseUrl}/runtime/koharu/engines`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(koharuRuntimeManager.ensureRunning).toHaveBeenCalledTimes(1);
    expect(koharuClient.getEngines).toHaveBeenCalledWith("http://127.0.0.1:4000");
    expect(payload.engines).toEqual(expect.objectContaining({
      ocr: [{ id: "paddle-ocr-vl-1.6" }],
      inpainters: [{ id: "aot-inpainting" }],
    }));
  });

  test("GET /runtime/koharu/paths returns Koharu storage locations", async () => {
    const response = await fetch(`${baseUrl}/runtime/koharu/paths`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(koharuRuntimeManager.inspectPaths).toHaveBeenCalledWith({
      client: koharuClient,
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(payload.koharu).toEqual(expect.objectContaining({
      dataRoot: expect.stringContaining("Koharu"),
      projectsRoot: expect.stringContaining("projects"),
      modelsRoot: expect.stringContaining("models"),
      runtimeRoot: expect.stringContaining("runtime"),
      configPath: expect.stringContaining("config.toml"),
    }));
  });
});
