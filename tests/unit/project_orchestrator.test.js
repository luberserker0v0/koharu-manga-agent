const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = "../../backend/src/config";
const CLIENT_PATH = "../../backend/src/integrations/koharu/client/koharu_client";
const PREFLIGHT_PATH = "../../backend/src/domains/reference/extraction/reference_image_conversion";
const ORCHESTRATOR_PATH = "../../backend/src/integrations/koharu/pipeline/project_orchestrator";

describe("Koharu project orchestrator uploads", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test("multipart mode never sends container paths to host Koharu", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koharu-multipart-"));
    const imagePath = path.join(directory, "001.png");
    fs.writeFileSync(imagePath, Buffer.from("image"));
    const apiFetch = jest.fn(async (endpoint) => {
      if (endpoint === "/api/v1/scene.json") {
        return { ok: true, json: async () => ({ scene: { pages: {} } }) };
      }
      throw new Error(`Unexpected API fetch: ${endpoint}`);
    });
    const fetchImpl = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ uploaded: ["001.png"] }),
      text: async () => "",
    });

    jest.doMock(CONFIG_PATH, () => ({
      config: { api: { pageUploadMode: "multipart" }, translation: {}, engines: {} },
    }));
    jest.doMock(CLIENT_PATH, () => ({
      apiFetch,
      buildUrl: (endpoint, baseUrl) => `${baseUrl}${endpoint}`,
      ENDPOINTS: {
        SCENE: "/api/v1/scene.json",
        PAGES: "/api/v1/pages",
        PAGES_FROM_PATHS: "/api/v1/pages/from-paths",
      },
    }));
    jest.doMock(PREFLIGHT_PATH, () => ({
      preflightImagesForKoharuUpload: (paths) => ({ uploadPaths: paths, converted: [] }),
    }));

    try {
      const { uploadPages } = require(ORCHESTRATOR_PATH);
      const result = await uploadPages([imagePath], "http://host.docker.internal:4000");

      expect(result.method).toBe("multipart");
      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        "http://host.docker.internal:4000/api/v1/pages",
        expect.objectContaining({ method: "POST", body: expect.any(FormData) })
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("automatic engine selection never schedules the same engine twice", async () => {
    const apiFetch = jest.fn(async (endpoint) => {
      if (endpoint === "/api/v1/engines") {
        return {
          ok: true,
          json: async () => ({
            detectors: [{ id: "comic-text-detector" }],
            segmenters: [
              { id: "comic-text-detector" },
              { id: "comic-text-detector-seg" },
            ],
            ocr: [{ id: "manga-ocr" }],
            translators: [{ id: "llm" }],
            inpainters: [{ id: "aot-inpainting" }],
            renderers: [{ id: "koharu-renderer" }],
          }),
        };
      }
      throw new Error(`Unexpected API fetch: ${endpoint}`);
    });

    jest.doMock(CONFIG_PATH, () => ({ config: { api: {}, translation: {}, engines: {} } }));
    jest.doMock(CLIENT_PATH, () => ({
      apiFetch,
      buildUrl: (endpoint, baseUrl) => `${baseUrl}${endpoint}`,
      ENDPOINTS: { ENGINES: "/api/v1/engines" },
    }));
    jest.doMock(PREFLIGHT_PATH, () => ({
      preflightImagesForKoharuUpload: (paths) => ({ uploadPaths: paths, converted: [] }),
    }));

    const { resolveEngines } = require(ORCHESTRATOR_PATH);
    const engines = await resolveEngines("http://example.test");

    expect(engines.detect).toBe("comic-text-detector");
    expect(engines.segment).toBe("comic-text-detector-seg");
    expect(new Set(Object.values(engines)).size).toBe(Object.values(engines).length);
  });

  test("fails when an explicitly profiled engine is missing from Koharu", async () => {
    const apiFetch = jest.fn(async () => ({ ok: true, json: async () => ({
      detectors: [{ id: "comic-text-detector" }], ocr: [{ id: "manga-ocr" }],
      translators: [{ id: "llm" }], inpainters: [{ id: "aot-inpainting" }],
      renderers: [{ id: "koharu-renderer" }],
    }) }));
    jest.doMock(CONFIG_PATH, () => ({ config: { api: {}, translation: {} } }));
    jest.doMock(CLIENT_PATH, () => ({ apiFetch, buildUrl: (endpoint, baseUrl) => `${baseUrl}${endpoint}`,
      ENDPOINTS: { ENGINES: "/api/v1/engines" } }));
    jest.doMock(PREFLIGHT_PATH, () => ({ preflightImagesForKoharuUpload: () => ({ uploadPaths: [] }) }));

    const { resolveEngines } = require(ORCHESTRATOR_PATH);
    await expect(resolveEngines("http://example.test", { clean: "lama-manga" }))
      .rejects.toThrow("clean=lama-manga");
  });

  test("applies LLM generation options while loading the selected model", async () => {
    const apiFetch = jest.fn(async (endpoint, options = {}) => {
      if (endpoint === "/api/v1/llm/catalog") return { ok: true, json: async () => ({ providers: [{
        id: "openai-compatible", status: "ready", models: [{ target: {
          kind: "provider", providerId: "openai-compatible", modelId: "gemma",
        } }],
      }] }) };
      if (endpoint === "/api/v1/llm/current") return { ok: true,
        text: async () => JSON.stringify({ status: "ready", target: options.body.target }) };
      throw new Error(`Unexpected API fetch: ${endpoint}`);
    });
    jest.doMock(CONFIG_PATH, () => ({ config: { api: {}, translation: {}, engines: {} } }));
    jest.doMock(CLIENT_PATH, () => ({ apiFetch, buildUrl: (endpoint, baseUrl) => `${baseUrl}${endpoint}`,
      ENDPOINTS: { LLM_CATALOG: "/api/v1/llm/catalog", LLM_CURRENT: "/api/v1/llm/current" } }));
    jest.doMock(PREFLIGHT_PATH, () => ({ preflightImagesForKoharuUpload: () => ({ uploadPaths: [] }) }));

    const { loadTranslationTarget } = require(ORCHESTRATOR_PATH);
    const result = await loadTranslationTarget("http://example.test", {
      providerId: "openai-compatible", modelId: "gemma",
    }, "zh-TW", { temperature: 0.7 });

    expect(apiFetch).toHaveBeenLastCalledWith("/api/v1/llm/current", expect.objectContaining({
      method: "PUT", body: expect.objectContaining({ options: { temperature: 0.7 } }),
    }));
    expect(result.generationOptions).toEqual({ temperature: 0.7 });
  });

  test("routes the configured Koharu provider through the backend proxy", async () => {
    const apiFetch = jest.fn(async (endpoint, options = {}) => {
      if (endpoint === "/api/v1/config" && !options.method) return { ok: true, json: async () => ({ providers: [{
        id: "openai-compatible", base_url: "http://127.0.0.1:25555/v1", api_key: "[REDACTED]",
      }] }) };
      if (endpoint === "/api/v1/config" && options.method === "PATCH") return { ok: true };
      throw new Error(`Unexpected API fetch: ${endpoint}`);
    });
    jest.doMock(CONFIG_PATH, () => ({ config: { api: {}, translation: {}, engines: {} } }));
    jest.doMock(CLIENT_PATH, () => ({ apiFetch, buildUrl: (endpoint, baseUrl) => `${baseUrl}${endpoint}`,
      ENDPOINTS: { CONFIG: "/api/v1/config" } }));
    jest.doMock(PREFLIGHT_PATH, () => ({ preflightImagesForKoharuUpload: () => ({ uploadPaths: [] }) }));

    const { ensureTranslationProviderProxy } = require(ORCHESTRATOR_PATH);
    const result = await ensureTranslationProviderProxy("http://koharu:4000", {
      providerId: "openai-compatible", baseUrl: "http://127.0.0.1:4001/api/v1/lmstudio-openai/v1",
    });

    expect(result.changed).toBe(true);
    expect(result.providerId).toBe("openai-compatible");
    expect(apiFetch).toHaveBeenLastCalledWith("/api/v1/config", expect.objectContaining({
      method: "PATCH", body: { providers: [{ id: "openai-compatible",
        baseUrl: "http://127.0.0.1:4001/api/v1/lmstudio-openai/v1", apiKey: "[REDACTED]" }] },
    }));
  });
});
