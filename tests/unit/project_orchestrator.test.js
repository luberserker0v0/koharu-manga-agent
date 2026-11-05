const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = "../../backend/src/config";
const PREFLIGHT_PATH = "../../backend/src/domains/reference/extraction/reference_image_conversion";
const ORCHESTRATOR_PATH = "../../backend/src/integrations/koharu/pipeline/project_orchestrator";

function loadOrchestrator(processor, config = { api: {}, translation: {}, engines: {} }) {
  jest.doMock(CONFIG_PATH, () => ({ config }));
  jest.doMock(PREFLIGHT_PATH, () => ({
    preflightImagesForKoharuUpload: (paths) => ({ uploadPaths: paths, converted: [] }),
  }));
  const { createProjectOrchestrator } = require(ORCHESTRATOR_PATH);
  return createProjectOrchestrator(processor);
}

describe("Koharu project orchestrator", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test("multipart mode delegates upload without exposing HTTP details", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koharu-multipart-"));
    const imagePath = path.join(directory, "001.png");
    fs.writeFileSync(imagePath, Buffer.from("image"));
    const processor = {
      getScene: jest.fn().mockResolvedValue({ scene: { pages: {} } }),
      uploadPagesMultipart: jest.fn().mockResolvedValue({ uploaded: ["001.png"] }),
    };
    try {
      const orchestrator = loadOrchestrator(processor, {
        api: { pageUploadMode: "multipart" }, translation: {}, engines: {},
      });
      const result = await orchestrator.uploadPages([imagePath], "http://host.docker.internal:4000");
      expect(result.method).toBe("multipart");
      expect(processor.uploadPagesMultipart).toHaveBeenCalledWith(
        [imagePath], "http://host.docker.internal:4000",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("automatic engine selection never schedules the same engine twice", async () => {
    const processor = { getEngines: jest.fn().mockResolvedValue({
      detectors: [{ id: "comic-text-detector" }],
      segmenters: [{ id: "comic-text-detector" }, { id: "comic-text-detector-seg" }],
      ocr: [{ id: "manga-ocr" }, { id: "paddle-ocr-vl-1.5" }], translators: [{ id: "llm" }],
      inpainters: [{ id: "aot-inpainting" }], renderers: [{ id: "koharu-renderer" }],
    }) };
    const engines = await loadOrchestrator(processor).resolveEngines("http://example.test");
    expect(engines.detect).toBe("comic-text-detector");
    expect(engines.segment).toBe("comic-text-detector-seg");
    expect(engines.ocr).toBe("paddle-ocr-vl-1.5");
    expect(new Set(Object.values(engines)).size).toBe(Object.values(engines).length);
  });

  test("selects OCR from ordered source languages instead of catalog order", async () => {
    const processor = { getEngines: jest.fn().mockResolvedValue({
      detectors: [{ id: "comic-text-detector" }],
      ocr: [{ id: "manga-ocr" }, { id: "paddle-ocr-vl-1.5" }],
      translators: [{ id: "llm" }], inpainters: [{ id: "aot-inpainting" }],
      renderers: [{ id: "koharu-renderer" }],
    }) };
    const orchestrator = loadOrchestrator(processor);
    await expect(orchestrator.resolveEngines("http://example.test", null, ["en", "ja"]))
      .resolves.toEqual(expect.objectContaining({ ocr: "paddle-ocr-vl-1.5" }));
    await expect(orchestrator.resolveEngines("http://example.test", null, "ja"))
      .resolves.toEqual(expect.objectContaining({ ocr: "manga-ocr" }));
  });

  test("rejects a Japanese-only configured OCR engine for English", async () => {
    const processor = { getEngines: jest.fn().mockResolvedValue({
      detectors: [{ id: "comic-text-detector" }],
      ocr: [{ id: "manga-ocr" }, { id: "paddle-ocr-vl-1.5" }],
      translators: [{ id: "llm" }], inpainters: [{ id: "aot-inpainting" }],
      renderers: [{ id: "koharu-renderer" }],
    }) };
    await expect(loadOrchestrator(processor).resolveEngines(
      "http://example.test", { ocr: "manga-ocr" }, "en",
    )).rejects.toMatchObject({ code: "unsupported_ocr_language_combination", statusCode: 422 });
  });

  test("threads ordered source languages to the adapter boundary", async () => {
    const processor = { startPipeline: jest.fn().mockResolvedValue("operation-1") };
    await loadOrchestrator(processor).startPipeline(
      ["detect", "ocr"], "zh-TW", "http://example.test", null, ["en", "ja"],
    );
    expect(processor.startPipeline).toHaveBeenCalledWith({
      steps: ["detect", "ocr"], targetLanguage: "zh-TW", systemPrompt: null,
      sourceLanguages: ["en", "ja"], baseUrl: "http://example.test",
    });
  });

  test("fails when an explicitly profiled engine is missing", async () => {
    const processor = { getEngines: jest.fn().mockResolvedValue({
      detectors: [{ id: "comic-text-detector" }],
      ocr: [{ id: "manga-ocr" }, { id: "paddle-ocr-vl-1.5" }],
      translators: [{ id: "llm" }], inpainters: [{ id: "aot-inpainting" }],
      renderers: [{ id: "koharu-renderer" }],
    }) };
    await expect(loadOrchestrator(processor).resolveEngines(
      "http://example.test", { clean: "lama-manga" },
    )).rejects.toThrow("clean=lama-manga");
  });

  test("applies generation options through the processing port", async () => {
    const processor = {
      getTranslationCatalog: jest.fn().mockResolvedValue({ providers: [{
        id: "openai-compatible", status: "ready", models: [{ target: {
          kind: "provider", providerId: "openai-compatible", modelId: "gemma",
        } }],
      }] }),
      setTranslationTarget: jest.fn().mockResolvedValue({ status: "ready" }),
    };
    const result = await loadOrchestrator(processor).loadTranslationTarget(
      "http://example.test", { providerId: "openai-compatible", modelId: "gemma" },
      "zh-TW", { temperature: 0.7 },
    );
    expect(processor.setTranslationTarget).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "openai-compatible", modelId: "gemma",
    }), "http://example.test", { temperature: 0.7 });
    expect(result.generationOptions).toEqual({ temperature: 0.7 });
  });

  test("routes the configured provider through the backend proxy", async () => {
    const processor = {
      getConfig: jest.fn().mockResolvedValue({ providers: [{
        id: "openai-compatible", base_url: "http://127.0.0.1:25555/v1", api_key: "[REDACTED]",
      }] }),
      patchConfig: jest.fn().mockResolvedValue(null),
    };
    const result = await loadOrchestrator(processor).ensureTranslationProviderProxy(
      "http://koharu:4000", {
        providerId: "openai-compatible", baseUrl: "http://127.0.0.1:4001/api/v1/lmstudio-openai/v1",
      },
    );
    expect(result.changed).toBe(true);
    expect(processor.patchConfig).toHaveBeenCalledWith({ providers: [{
      id: "openai-compatible", baseUrl: "http://127.0.0.1:4001/api/v1/lmstudio-openai/v1",
      apiKey: "[REDACTED]",
    }] }, "http://koharu:4000");
  });
});
