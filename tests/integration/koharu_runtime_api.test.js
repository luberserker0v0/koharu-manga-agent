const os = require("os");
const path = require("path");
const fs = require("fs");
const http = require("http");

const { createApiServer } = require("../../backend/src/http/server/api_server");
const { JobManager } = require("../../backend/src/domains/jobs/job_manager");
const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koharu-runtime-api-"));
  return path.join(dir, "jobs.sqlite");
}

function requestHttp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method || "GET",
      headers: options.headers || {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          json: async () => JSON.parse(text),
          text: async () => text,
        });
      });
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

describe("Manga processor runtime API", () => {
  let api;
  let baseUrl;
  let mangaProcessingRuntime;
  let mangaProcessor;

  beforeEach(async () => {
    mangaProcessingRuntime = {
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
        hostAccessible: true,
        exists: {},
        projectSamples: [],
        projectApiError: null,
      }),
    };
    mangaProcessor = {
      getEngines: jest.fn().mockResolvedValue({
        ocr: [{ id: "paddle-ocr-vl-1.6" }],
        inpainters: [{ id: "aot-inpainting" }],
      }),
      getTranslationCatalog: jest.fn().mockResolvedValue({
        providers: [{
          id: "deepl",
          name: "DeepL",
          requiresApiKey: true,
          hasApiKey: true,
          status: "ready",
          models: [{ target: { kind: "provider", providerId: "deepl", modelId: "mt" }, languages: ["zh-TW"] }],
        }],
      }),
    };
    const jobManager = new JobManager({
      store: new JobStore(createTempDbPath()),
      engine: { runTranslationJob: jest.fn(), mangaProcessor },
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { api: { baseUrl: "http://127.0.0.1:4000" }, workflow: { qualityCheck: { enabled: true } } },
      mangaProcessingRuntime,
    });
    api = createApiServer({ jobManager, host: "127.0.0.1", port: 0 });
    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  test("GET /runtime/status includes managed manga processor fields", async () => {
    const response = await requestHttp(`${baseUrl}/runtime/status`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.mangaProcessor).toEqual(expect.objectContaining({
      status: "installed",
      mode: "managed",
      version: "0.61.2",
      installed: true,
      managedPid: null,
      lastError: null,
    }));
  });

  test("GET /ready returns 503 with a manga processor blocker when the service is not running", async () => {
    const response = await requestHttp(`${baseUrl}/ready`);
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      services: expect.objectContaining({
        backend: expect.objectContaining({ ready: true }),
        mangaProcessor: expect.objectContaining({ ready: false, status: "installed" }),
      }),
      capabilities: expect.objectContaining({ mangaProcessingJobs: false }),
      blockers: [expect.objectContaining({
        service: "manga_processor",
        code: "manga_processor_unavailable",
      })],
    }));
  });

  test("GET /ready returns degraded success when the processor runs but optional AO is unavailable", async () => {
    mangaProcessingRuntime.inspect.mockResolvedValue({
      status: "running",
      mode: "external",
      baseUrl: "http://127.0.0.1:4000",
      installed: false,
      managedPid: null,
      lastError: null,
    });

    const response = await requestHttp(`${baseUrl}/ready`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      status: "degraded",
      capabilities: { mangaProcessingJobs: true, aoJobs: false },
      warnings: [expect.objectContaining({ service: "ao", code: "ao_unavailable" })],
    }));
  });

  test("manga processing job creation returns actionable 503 before creating a job", async () => {
    mangaProcessingRuntime.ensureRunning.mockRejectedValue(new Error(
      "External Koharu service is unavailable at http://127.0.0.1:4000."
    ));
    mangaProcessingRuntime.inspect.mockResolvedValue({
      status: "unavailable",
      mode: "external",
      baseUrl: "http://127.0.0.1:4000",
      installed: false,
      managedPid: null,
      lastError: "Connection refused.",
    });

    const response = await requestHttp(`${baseUrl}/jobs/reference-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceFolder: "C:\\manga\\chapter-1" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: "External Koharu service is unavailable at http://127.0.0.1:4000.",
      code: "manga_processor_unavailable",
      details: {
        service: "manga_processor",
        jobType: "reference_extraction",
        status: "unavailable",
        mode: "external",
        baseUrl: "http://127.0.0.1:4000",
        retrySafe: true,
      },
    });
    expect(mangaProcessingRuntime.ensureRunning).toHaveBeenCalledTimes(1);
    expect(mangaProcessingRuntime.inspect).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["/runtime/manga-processor/install", "ensureInstalled"],
    ["/runtime/manga-processor/start", "ensureRunning"],
    ["/runtime/manga-processor/prepare", "prepareRuntime"],
    ["/runtime/manga-processor/stop", "stopManaged"],
  ])("POST %s returns a stable manga processor envelope", async (pathname, methodName) => {
    const response = await requestHttp(`${baseUrl}${pathname}`, { method: "POST" });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.mangaProcessor).toEqual(expect.any(Object));
    expect(mangaProcessingRuntime[methodName]).toHaveBeenCalledTimes(1);
  });

  test("GET /runtime/manga-processor/engines returns live engine catalog", async () => {
    const response = await requestHttp(`${baseUrl}/runtime/manga-processor/engines`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mangaProcessingRuntime.ensureRunning).toHaveBeenCalledTimes(1);
    expect(mangaProcessor.getEngines).toHaveBeenCalledWith("http://127.0.0.1:4000");
    expect(payload.engines).toEqual(expect.objectContaining({
      ocr: [{ id: "paddle-ocr-vl-1.6" }],
      inpainters: [{ id: "aot-inpainting" }],
    }));
  });

  test("GET /runtime/manga-processor/translation-providers returns a sanitized catalog", async () => {
    const response = await requestHttp(`${baseUrl}/runtime/manga-processor/translation-providers`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mangaProcessor.getTranslationCatalog).toHaveBeenCalledWith("http://127.0.0.1:4000");
    expect(payload.providers).toEqual([
      expect.objectContaining({ providerId: "deepl", kind: "machine_translation", hasCredential: true }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("apiKey");
  });

  test("GET /runtime/manga-processor/paths returns processor storage locations", async () => {
    const response = await requestHttp(`${baseUrl}/runtime/manga-processor/paths`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mangaProcessingRuntime.inspectPaths).toHaveBeenCalledWith({
      client: mangaProcessor,
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(payload.backend).toEqual(expect.objectContaining({
      dataRoot: expect.any(String),
      configPath: expect.any(String),
      databasePath: expect.any(String),
      translatedRoot: expect.any(String),
      referencesRoot: expect.any(String),
      hostAccessible: expect.any(Boolean),
    }));
    expect(payload.mangaProcessor).toEqual(expect.objectContaining({
      dataRoot: expect.stringContaining("Koharu"),
      projectsRoot: expect.stringContaining("projects"),
      modelsRoot: expect.stringContaining("models"),
      runtimeRoot: expect.stringContaining("runtime"),
      configPath: expect.stringContaining("config.toml"),
      hostAccessible: true,
    }));
  });
});
