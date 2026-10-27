const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");
const { JobManager } = require("../../backend/src/domains/jobs/job_manager");

describe("selective retranslation Job creation", () => {
  let root;
  let store;
  let manager;
  let sourcePreflightModule;
  let client;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "selective-retranslation-"));
    store = new JobStore(path.join(root, "jobs.sqlite"));
    sourcePreflightModule = {
      resolveSourceSelection: jest.fn().mockImplementation((_preflightId, selectedIds) => {
        const images = [
          { id: "source-3", orderIndex: 2, orderedPath: "page-3.png" },
          { id: "source-7", orderIndex: 6, orderedPath: "page-7.png" },
        ];
        return {
          manifest: { preflightId: "preflight-1" },
          images: selectedIds ? images.filter((image) => selectedIds.includes(image.id)) : images,
        };
      }),
    };
    client = {
      getTranslationCatalog: jest.fn().mockResolvedValue({
        providers: [{
          id: "openai",
          status: "ready",
          models: [{ target: { providerId: "openai", modelId: "gpt-5" }, languages: ["zh-TW"] }],
        }, {
          id: "deepl",
          status: "ready",
          models: [{ target: { providerId: "deepl", modelId: "mt" }, languages: ["zh-TW"] }],
        }],
      }),
    };
    const engine = {
      sourcePreflightModule,
      projectLifecycle: { client },
      runTranslationJob: jest.fn(),
    };
    manager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: {
        api: { baseUrl: "http://127.0.0.1:4000" },
        defaults: { targetLanguage: "zh-TW" },
        translation: { defaultTarget: { providerId: "openai", modelId: "gpt-5" } },
        workflow: { qualityCheck: { enabled: true } },
      },
      aoClient: { checkAvailability: jest.fn().mockResolvedValue({ available: true }) },
      koharuRuntimeManager: {
        ensureRunning: jest.fn().mockResolvedValue({ status: "running", baseUrl: "http://127.0.0.1:4000" }),
      },
    });
    manager.scheduleQueueDrain = jest.fn();
    store.createJob({
      id: "root-job",
      type: "translation",
      status: "succeeded",
      stage: "succeeded",
      payload: {
        mangaId: "manga-1",
        translatorId: "translator-1",
        chapterId: "chapter-1",
        sourcePreflightId: "preflight-1",
        translationMode: "quick",
        translationTarget: { providerId: "openai", modelId: "gpt-5" },
        sourceLanguage: "ja",
        targetLanguage: "zh-TW",
        outputDir: "must-not-be-reused",
      },
    });
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("inherits settings and records immutable ordered lineage", async () => {
    const created = await manager.createSelectiveRetranslationJob("root-job", {
      sourceImageIds: ["source-7", "source-3"],
      instructions: "Keep Koharu untranslated.",
    });

    expect(created).toEqual(expect.objectContaining({
      status: "queued",
      type: "translation",
      parentJobId: "root-job",
      revision: {
        rootJobId: "root-job",
        parentJobId: "root-job",
        reason: "selective_retranslation",
        sourceImageIds: ["source-3", "source-7"],
      },
    }));
    expect(created.payload).toEqual(expect.objectContaining({
      mangaId: "manga-1",
      sourcePreflightId: "preflight-1",
      sourceImageIds: ["source-3", "source-7"],
      instructions: "Keep Koharu untranslated.",
      translationTarget: { providerId: "openai", modelId: "gpt-5" },
    }));
    expect(created.payload).not.toHaveProperty("outputDir");
    expect(sourcePreflightModule.resolveSourceSelection)
      .toHaveBeenCalledWith("preflight-1", ["source-7", "source-3"]);
    expect(client.getTranslationCatalog).toHaveBeenCalledTimes(1);
  });

  test("rejects duplicate IDs before creating a Job", async () => {
    await expect(manager.createSelectiveRetranslationJob("root-job", {
      sourceImageIds: ["source-3", "source-3"],
    })).rejects.toMatchObject({ statusCode: 400, code: "duplicate_source_image_selection" });
    expect(store.listJobs()).toHaveLength(1);
  });

  test("rejects instructions for a machine-translation target", async () => {
    await expect(manager.createSelectiveRetranslationJob("root-job", {
      sourceImageIds: ["source-3"],
      translationTarget: { providerId: "deepl", modelId: "mt" },
      instructions: "Use a formal tone.",
    })).rejects.toMatchObject({
      statusCode: 422,
      code: "unsupported_retranslation_instructions",
    });
    expect(store.listJobs()).toHaveLength(1);
  });

  test("creates an inactive text-region correction revision with immutable patch data", async () => {
    const regionCorrections = { sourceJobId: "root-job", pages: [{
      sourceImageId: "source-3", baseRegionSetRevisionId: "region-set-1",
      regions: [{ regionId: "region-1", sourceText: "corrected OCR" }],
    }] };
    manager.textRegionCorrectionService = { prepare: jest.fn().mockReturnValue({
      reason: "text_region_correction",
      sourceImageIds: ["source-3"],
      revision: { baseRegionSetRevisionIds: ["region-set-1"] },
      payload: { regionCorrections },
    }) };

    const created = await manager.createTextRegionCorrectionJob("root-job", {
      pages: regionCorrections.pages,
    });

    expect(created).toEqual(expect.objectContaining({
      status: "queued", type: "translation", parentJobId: "root-job",
      revision: expect.objectContaining({ reason: "text_region_correction" }),
    }));
    expect(created.payload.regionCorrections).toEqual(regionCorrections);
    expect(created.payload.sourceImageIds).toEqual(["source-3"]);

    store.updateJob({ id: created.id, status: "failed", stage: "failed" });
    const retried = manager.retryJob(created.id);
    expect(retried).toEqual(expect.objectContaining({
      parentJobId: created.id,
      retryOf: created.id,
      revision: expect.objectContaining({
        rootJobId: "root-job",
        parentJobId: created.id,
        reason: "text_region_correction",
      }),
    }));
    expect(retried.payload.regionCorrections).toEqual(regionCorrections);
  });
});
