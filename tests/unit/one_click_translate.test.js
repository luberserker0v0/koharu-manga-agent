const path = require("path");

const SCRIPT_MODULE_PATH = path.join(
  __dirname,
  "../../.opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js"
);
const CONFIG_MODULE_PATH = path.join(
  __dirname,
  "../../.opencode/skills/manga-translate-zhtw/lib/config.js"
);
const API_MODULE_PATH = path.join(
  __dirname,
  "../../.opencode/skills/manga-translate-zhtw/lib/api.js"
);
const PREFLIGHT_MODULE_PATH = path.join(
  __dirname,
  "../../backend/src/modules/reference_image_conversion.js"
);

function loadScript({
  configOverride = {},
  apiFetchImpl,
  buildUrlImpl,
  fetchImpl,
  fsOverride = {},
} = {}) {
  jest.resetModules();

  const baseConfig = {
    DEFAULT_BASE_URL: "http://127.0.0.1:9999",
    DEFAULTS: { targetLanguage: "zh-TW" },
    PATHS: { ORIGINAL: "C:\\mock\\original" },
    LLM: { defaultProvider: "openai-compatible" },
    SKILL_CONFIG: {
      DEFAULT_MODEL: "C:\\mock\\.default-model",
      DEFAULT_ENGINES: "C:\\mock\\.default-engines",
    },
    ENGINES: null,
  };

  const config = {
    ...baseConfig,
    ...configOverride,
    DEFAULTS: { ...baseConfig.DEFAULTS, ...(configOverride.DEFAULTS || {}) },
    PATHS: { ...baseConfig.PATHS, ...(configOverride.PATHS || {}) },
    LLM: { ...baseConfig.LLM, ...(configOverride.LLM || {}) },
    SKILL_CONFIG: {
      ...baseConfig.SKILL_CONFIG,
      ...(configOverride.SKILL_CONFIG || {}),
    },
  };

  const apiFetch = jest.fn(apiFetchImpl);
  const buildUrl = jest.fn(buildUrlImpl || ((endpoint, baseUrl) => `${baseUrl}${endpoint}`));

  jest.doMock(CONFIG_MODULE_PATH, () => config, { virtual: false });
  jest.doMock(
    API_MODULE_PATH,
    () => ({
      apiFetch,
      buildUrl,
      ENDPOINTS: {
        PROJECTS: "/api/v1/projects",
        PROJECTS_CURRENT: "/api/v1/projects/current",
        SCENE: "/api/v1/scene.json",
        PAGES: "/api/v1/pages",
        PAGES_FROM_PATHS: "/api/v1/pages/from-paths",
        LLM_CURRENT: "/api/v1/llm/current",
        LLM_CATALOG: "/api/v1/llm/catalog",
        ENGINES: "/api/v1/engines",
        PIPELINES: "/api/v1/pipelines",
      },
    }),
    { virtual: false }
  );
  jest.doMock(
    PREFLIGHT_MODULE_PATH,
    () => ({
      preflightImagesForKoharuUpload: jest.fn((imagePaths) => ({
        uploadPaths: imagePaths,
        converted: [],
        tempDir: null,
      })),
    }),
    { virtual: false }
  );

  const originalFetch = global.fetch;
  if (fetchImpl) {
    global.fetch = jest.fn(fetchImpl);
  }

  if (fsOverride.existsSync) {
    jest.spyOn(require("fs"), "existsSync").mockImplementation(fsOverride.existsSync);
  }
  if (fsOverride.readdirSync) {
    jest.spyOn(require("fs"), "readdirSync").mockImplementation(fsOverride.readdirSync);
  }
  if (fsOverride.readFileSync) {
    jest.spyOn(require("fs"), "readFileSync").mockImplementation(fsOverride.readFileSync);
  }

  const script = require(SCRIPT_MODULE_PATH);

  function restore() {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.resetModules();
  }

  return { script, config, apiFetch, buildUrl, restore };
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(payload),
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

function emptySuccessResponse(status = 200) {
  return {
    ok: true,
    status,
    json: jest.fn().mockRejectedValue(new Error("Unexpected end of JSON input")),
    text: jest.fn().mockResolvedValue(""),
  };
}

describe("one_click_translate.js", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("parseArgs parses target and base URL", () => {
    const { script, restore } = loadScript();

    expect(
      script.parseArgs(["--target", "en-US", "--base-url", "http://localhost:3000/"])
    ).toEqual({
      targetLanguage: "en-US",
      baseUrl: "http://localhost:3000",
    });

    restore();
  });

  test("validateOriginalPages fails when original directory is missing", () => {
    const { script, restore } = loadScript({
      fsOverride: {
        existsSync: jest.fn().mockReturnValue(false),
      },
    });

    expect(() => script.validateOriginalPages("C:\\missing")).toThrow(
      "Source folder not found: C:\\missing"
    );

    restore();
  });

  test("validateOriginalPages fails when no images are present", () => {
    const { script, restore } = loadScript({
      fsOverride: {
        existsSync: jest.fn().mockReturnValue(true),
        readdirSync: jest.fn().mockReturnValue([
          { isFile: () => true, name: "notes.txt" },
        ]),
      },
    });

    expect(() => script.validateOriginalPages("C:\\empty")).toThrow(
      "No images found in source folder: C:\\empty"
    );

    restore();
  });

  test("resolveEngines validates configured engines against catalog", async () => {
    const { script, apiFetch, restore } = loadScript({
      configOverride: {
        ENGINES: {
          detect: "detector-a",
          fontDetect: "font-a",
          segment: "segment-a",
          bubbleSegment: "bubble-a",
          ocr: "ocr-a",
          translate: "translator-a",
          clean: "clean-a",
          render: "render-a",
        },
      },
      apiFetchImpl: async (endpoint) => {
        if (endpoint === "/api/v1/engines") {
          return jsonResponse({
            detectors: [{ id: "detector-a" }, { id: "font-a" }, { id: "segment-a" }, { id: "bubble-a" }],
            ocr: [{ id: "ocr-a" }],
            translators: [{ id: "translator-a" }],
            inpainters: [{ id: "clean-a" }],
            renderers: [{ id: "render-a" }],
          });
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
    });

    const engines = await script.resolveEngines("http://example.test");

    expect(engines.render).toBe("render-a");
    expect(apiFetch).toHaveBeenCalledTimes(1);

    restore();
  });

  test("resolveEngines falls back when a configured engine no longer exists", async () => {
    const { script, restore } = loadScript({
      configOverride: {
        ENGINES: {
          detect: "detector-a",
          ocr: "paddle-ocr-vl-1.5",
          translate: "translator-a",
          clean: "clean-a",
          render: "render-a",
        },
      },
      apiFetchImpl: async (endpoint) => {
        if (endpoint === "/api/v1/engines") {
          return jsonResponse({
            detectors: [{ id: "detector-a" }],
            ocr: [{ id: "paddle-ocr-vl-1.6" }],
            translators: [{ id: "translator-a" }],
            inpainters: [{ id: "clean-a" }],
            renderers: [{ id: "render-a" }],
          });
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
    });

    const engines = await script.resolveEngines("http://example.test");

    expect(engines.ocr).toBe("paddle-ocr-vl-1.6");

    restore();
  });

  test("resolveEngines fills missing values from saved defaults and catalog", async () => {
    const { script, apiFetch, restore } = loadScript({
      configOverride: {
        ENGINES: {
          detect: "detector-a",
          ocr: "ocr-a",
          translate: "translator-a",
        },
      },
      fsOverride: {
        readFileSync: jest.fn((filePath) => {
          if (String(filePath).endsWith(".default-model")) {
            return "mock-model";
          }
          if (String(filePath).endsWith(".default-engines")) {
            return JSON.stringify({ clean: "clean-saved" });
          }
          return jest.requireActual("fs").readFileSync(filePath);
        }),
      },
      apiFetchImpl: async (endpoint) => {
        if (endpoint === "/api/v1/engines") {
          return jsonResponse({
            detectors: [{ id: "detector-a" }],
            ocr: [{ id: "ocr-a" }],
            translators: [{ id: "translator-a" }],
            inpainters: [{ id: "clean-saved" }],
            renderers: [{ id: "render-fallback" }],
          });
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
    });

    const engines = await script.resolveEngines("http://example.test");

    expect(engines.detect).toBe("detector-a");
    expect(engines.clean).toBe("clean-saved");
    expect(engines.render).toBe("render-fallback");
    expect(apiFetch).toHaveBeenCalledTimes(1);

    restore();
  });

  test("loadDefaultLlm falls back to local when provider load fails", async () => {
    const { script, restore } = loadScript({
      fsOverride: {
        readFileSync: jest.fn(() => "mock-model"),
      },
      apiFetchImpl: async (endpoint, opts) => {
        if (endpoint !== "/api/v1/llm/current" && endpoint !== "/api/v1/llm/catalog") {
          throw new Error(`Unexpected endpoint: ${endpoint}`);
        }

        if (endpoint === "/api/v1/llm/current" && opts.method === "PUT" && opts.body.target.providerId) {
          return {
            ok: false,
            status: 500,
            text: jest.fn().mockResolvedValue("provider failed"),
          };
        }

        if (endpoint === "/api/v1/llm/catalog") {
          return jsonResponse({
            localModels: [{ id: "mock-model" }],
          });
        }

        expect(endpoint).toBe("/api/v1/llm/current");
        expect(opts.body.target.providerId).toBeNull();
        return jsonResponse({ loaded: true });
      },
    });

    const result = await script.loadDefaultLlm("http://example.test");

    expect(result.providerId).toBeNull();
    expect(result.fallbackFromProvider).toBe(true);

    restore();
  });

  test("loadDefaultLlm does not fall back to local when catalog has no matching local model", async () => {
    let callCount = 0;
    const { script, restore } = loadScript({
      fsOverride: {
        readFileSync: jest.fn(() => "provider-only-model"),
      },
      apiFetchImpl: async (endpoint) => {
        if (endpoint !== "/api/v1/llm/current" && endpoint !== "/api/v1/llm/catalog") {
          throw new Error(`Unexpected endpoint: ${endpoint}`);
        }

        callCount += 1;
        if (callCount === 1) {
          return {
            ok: false,
            status: 500,
            text: jest.fn().mockResolvedValue("provider failed"),
          };
        }

        return jsonResponse({
          localModels: [{ id: "some-other-model" }],
        });
      },
    });

    await expect(script.loadDefaultLlm("http://example.test")).rejects.toThrow(
      "Failed to load default LLM via provider: Load LLM failed (500): provider failed"
    );

    restore();
  });

  test("loadDefaultLlm accepts empty provider response when current target matches", async () => {
    let callCount = 0;
    const { script, restore } = loadScript({
      fsOverride: {
        readFileSync: jest.fn(() => "mock-model"),
      },
      apiFetchImpl: async (endpoint, opts) => {
        if (endpoint !== "/api/v1/llm/current") {
          throw new Error(`Unexpected endpoint: ${endpoint}`);
        }

        callCount += 1;
        if (callCount === 1) {
          expect(opts.method).toBe("PUT");
          return emptySuccessResponse();
        }

        expect(opts.method).toBe("GET");
        return jsonResponse({
          status: "ready",
          target: {
            kind: "provider",
            modelId: "mock-model",
            providerId: "openai-compatible",
          },
          error: null,
        });
      },
    });

    const result = await script.loadDefaultLlm("http://example.test");

    expect(result.providerId).toBe("openai-compatible");
    expect(result.fallbackFromProvider).toBeUndefined();
    expect(result.verifiedAfterEmptyBody).toBe(true);

    restore();
  });

  test("uploadPages falls back to multipart upload when from-paths fails", async () => {
    const { script, apiFetch, buildUrl, restore } = loadScript({
      apiFetchImpl: async (endpoint) => {
        if (endpoint === "/api/v1/scene.json") {
          return jsonResponse({ scene: { pages: {} } });
        }
        if (endpoint === "/api/v1/pages/from-paths") {
          return {
            ok: false,
            status: 500,
            text: jest.fn().mockResolvedValue("from-paths failed"),
          };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
      fetchImpl: async () => jsonResponse({ uploaded: true }),
      fsOverride: {
        readFileSync: jest.fn(() => Buffer.from("image")),
      },
    });

    const result = await script.uploadPages(
      ["C:\\mock\\original\\001.png"],
      "http://example.test"
    );

    expect(result.method).toBe("multipart");
    expect(buildUrl).toHaveBeenCalledWith("/api/v1/pages", "http://example.test");
    expect(apiFetch).toHaveBeenCalledTimes(2);

    restore();
  });

  test("orchestrate returns operationId, engines, and steps without child process usage", async () => {
    const { script, restore } = loadScript({
      configOverride: {
        ENGINES: {
          detect: "detector-a",
          fontDetect: "font-a",
          segment: "segment-a",
          bubbleSegment: "bubble-a",
          ocr: "ocr-a",
          translate: "translator-a",
          clean: "clean-a",
          render: "render-a",
        },
      },
      fsOverride: {
        existsSync: jest.fn().mockReturnValue(true),
        readdirSync: jest.fn().mockReturnValue([
          { isFile: () => true, name: "001.png" },
        ]),
        readFileSync: jest.fn((filePath) => {
          if (String(filePath).endsWith(".default-model")) {
            return "mock-model";
          }
          return Buffer.from("image");
        }),
      },
      apiFetchImpl: async (endpoint) => {
        if (endpoint === "/api/v1/projects") {
          return jsonResponse({ id: "project-1" });
        }
        if (endpoint === "/api/v1/projects/current") {
          return jsonResponse({ ok: true });
        }
        if (endpoint === "/api/v1/scene.json") {
          return jsonResponse({ scene: { pages: {} } });
        }
        if (endpoint === "/api/v1/pages/from-paths") {
          return jsonResponse({ uploaded: ["001.png"] });
        }
        if (endpoint === "/api/v1/llm/current") {
          return jsonResponse({ loaded: true });
        }
        if (endpoint === "/api/v1/engines") {
          return jsonResponse({
            detectors: [{ id: "detector-a" }, { id: "font-a" }, { id: "segment-a" }, { id: "bubble-a" }],
            ocr: [{ id: "ocr-a" }],
            translators: [{ id: "translator-a" }],
            inpainters: [{ id: "clean-a" }],
            renderers: [{ id: "render-a" }],
          });
        }
        if (endpoint === "/api/v1/pipelines") {
          return jsonResponse({ operationId: "op-123" });
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
    });

    const result = await script.orchestrate({
      targetLanguage: "zh-TW",
      baseUrl: "http://example.test",
    });

    expect(result.success).toBe(true);
    expect(result.operationId).toBe("op-123");
    expect(result.engines.render).toBe("render-a");
    expect(result.steps).toEqual([
      "detector-a",
      "font-a",
      "segment-a",
      "bubble-a",
      "ocr-a",
      "translator-a",
      "clean-a",
      "render-a",
    ]);

    restore();
  });

  test("script source no longer uses execSync or nested node commands", () => {
    const source = require("fs").readFileSync(SCRIPT_MODULE_PATH, "utf-8");

    expect(source).not.toContain("execSync(");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("node .opencode/skills");
  });
});
