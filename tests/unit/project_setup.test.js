const mockOrchestrate = jest.fn();
const mangaProcessor = { orchestrateProject: mockOrchestrate, prepareProject: jest.fn() };

const {
  ProjectSetupModule,
  buildSystemPromptMetadata,
} = require("../../backend/src/integrations/koharu/pipeline/project_setup");

describe("Koharu project setup prompt metadata", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const setupResult = {
      projectName: "project-a",
      operationId: "op-a",
      engines: { translate: "llm" },
      ocrLanguageResolution: {
        requestedSourceLanguages: ["en", "ja"],
        effectiveSourceLanguages: ["en", "ja"],
        primarySourceLanguage: "en",
        engineId: "paddle-ocr-vl-1.5",
        hintsSupported: false,
        hintsApplied: false,
      },
      steps: ["llm"],
      translationTarget: { kind: "hosted_llm", providerId: "openai-compatible", modelId: "model-a",
        generationOptions: { temperature: 0.7 } },
    };
    mockOrchestrate.mockResolvedValue(setupResult);
    mangaProcessor.prepareProject.mockResolvedValue(setupResult);
  });

  test("records prompt provenance without persisting the prompt text", async () => {
    const result = await new ProjectSetupModule({ mangaProcessor }).run({
      targetLanguage: "zh-TW",
      sourceLanguage: ["en", "ja"],
      baseUrl: "http://127.0.0.1:4000",
      systemPrompt: "private prompt",
      systemPromptSource: "translation_memory",
      sourceImagePaths: ["001.png"],
      generationOptions: { temperature: 0.7 },
    });

    expect(result.systemPromptApplied).toBe(true);
    expect(result.ocrLanguageResolution).toEqual(expect.objectContaining({
      engineId: "paddle-ocr-vl-1.5",
      requestedSourceLanguages: ["en", "ja"],
      hintsSupported: false,
      hintsApplied: false,
    }));
    expect(result.systemPromptMetadata).toEqual(expect.objectContaining({
      applied: true,
      source: "translation_memory",
      bytes: 14,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(JSON.stringify(result.systemPromptMetadata)).not.toContain("private prompt");
    expect(result.generationSettings).toEqual({
      temperature: 0.7,
      temperatureSource: "koharu_request",
      reasoning: null,
      thinkingEnabled: null,
      thinkingSource: "not_exposed_by_execution_api",
      reasoningCapability: null,
    });
    expect(mockOrchestrate).toHaveBeenCalledWith(expect.objectContaining({
      generationOptions: { temperature: 0.7 },
      sourceLanguage: ["en", "ja"],
    }));
  });

  test("describes an omitted prompt without a hash", () => {
    expect(buildSystemPromptMetadata(null, "translation_memory")).toEqual({
      applied: false,
      source: "none",
      bytes: 0,
      sha256: null,
    });
  });

  test("resolves quick translation to the fast Lama Manga profile", async () => {
    const result = await new ProjectSetupModule({ mangaProcessor }).run({
      targetLanguage: "zh-TW", baseUrl: "http://127.0.0.1:4000",
      sourceImagePaths: ["001.png"], translationMode: "quick",
    });

    expect(result.pipelineProfile).toEqual(expect.objectContaining({
      id: "fast", source: "translation_mode", engines: { clean: "lama-manga" },
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(mockOrchestrate).toHaveBeenCalledWith(expect.objectContaining({
      engines: { clean: "lama-manga" },
    }));
  });

  test("merges correction bootstrap engines over the mode profile", async () => {
    await new ProjectSetupModule({ mangaProcessor }).prepare({
      targetLanguage: "zh-TW", baseUrl: "http://127.0.0.1:4000",
      sourceImagePaths: ["001.png"], translationMode: "quick",
      engines: { detect: "original-detector", ocr: "manga-ocr" },
    });

    expect(mangaProcessor.prepareProject).toHaveBeenCalledWith(expect.objectContaining({
      engines: { clean: "lama-manga", detect: "original-detector", ocr: "manga-ocr" },
    }));
  });

  test("adds a non-blocking LM Studio capability snapshot", async () => {
    const lmStudioClient = { inspectModel: jest.fn().mockResolvedValue({
      available: true, modelKey: "model-a", loaded: true,
      reasoning: { allowedOptions: ["off", "on"], default: "on" },
    }) };
    const result = await new ProjectSetupModule({ mangaProcessor, lmStudioClient }).run({
      targetLanguage: "zh-TW", baseUrl: "http://127.0.0.1:4000",
      lmStudioBaseUrl: "http://127.0.0.1:25555", sourceImagePaths: ["001.png"],
    });

    expect(lmStudioClient.inspectModel).toHaveBeenCalledWith("model-a", "http://127.0.0.1:25555");
    expect(result.lmStudio).toEqual(expect.objectContaining({ loaded: true }));
    expect(result.generationSettings).toEqual(expect.objectContaining({
      thinkingEnabled: null,
      thinkingSource: "not_exposed_by_execution_api",
      reasoningCapability: { allowedOptions: ["off", "on"], default: "on" },
    }));
  });

  test("records reasoning as enforced when the native proxy is active", async () => {
    mockOrchestrate.mockResolvedValueOnce({
      projectName: "project-a", operationId: "op-a", engines: {}, steps: [],
      translationTarget: { kind: "hosted_llm", providerId: "openai-compatible", modelId: "model-a" },
      translationProxy: { providerId: "openai-compatible", baseUrl: "http://127.0.0.1:4001/proxy" },
    });
    const result = await new ProjectSetupModule({ mangaProcessor }).run({
      targetLanguage: "zh-TW", baseUrl: "http://127.0.0.1:4000", sourceImagePaths: ["001.png"],
      generationOptions: { temperature: 0.7, reasoning: "off" },
      translationProxy: { providerId: "openai-compatible", baseUrl: "http://127.0.0.1:4001/proxy" },
    });

    expect(result.generationSettings).toEqual(expect.objectContaining({
      temperature: 0.7, reasoning: "off", thinkingEnabled: false,
      thinkingSource: "backend_lmstudio_native_proxy",
    }));
  });
});
