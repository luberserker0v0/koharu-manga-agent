const fs = require("fs");
const os = require("os");
const path = require("path");

const { WorkflowEngine } = require("../../backend/src/workflow_engine");
const { JobStore } = require("../../backend/src/storage/job_store");
jest.mock("../../backend/src/modules/reference_extraction_review", () => ({
  ensureLegacyReviewMetadata: () => ({ status: "reviewed", currentFingerprint: "test-fingerprint" }),
}));

const { JobManager } = require("../../backend/src/job_manager");
const { PipelineMonitorModule } = require("../../backend/src/modules/pipeline_monitor");

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-process-"));
  return path.join(dir, "jobs.sqlite");
}

describe("process-trigger runtime", () => {
  test("workflow engine runs quality and skips knowledge by default", async () => {
    const setup = { run: jest.fn().mockResolvedValue({ projectName: "p1", operationId: "op-1", engines: {}, steps: [] }) };
    const monitor = { run: jest.fn().mockResolvedValue({ summary: { finalStatus: "completed", totalPages: 1, steps: {} } }) };
    const quality = {
      run: jest.fn().mockResolvedValue({
        overall: "pass",
        score: 1,
        totalTranslations: 1,
        issues: [],
        warnings: [],
        passedChecks: ["translations_present"],
        failedChecks: [],
      }),
    };
    const knowledge = { run: jest.fn().mockResolvedValue({ translationPairs: 1 }) };
    const exporter = { run: jest.fn().mockResolvedValue({ path: "C:\\translated\\out.zip", size: 123 }) };
    const lifecycle = {
      client: { getScene: jest.fn().mockResolvedValue({ scene: { pages: {} } }) },
      closeCurrentProject: jest.fn().mockResolvedValue({ success: true }),
    };

    const engine = new WorkflowEngine({
      projectSetup: setup,
      pipelineMonitor: monitor,
      qualityModule: quality,
      knowledgeModule: knowledge,
      exportModule: exporter,
      projectLifecycle: lifecycle,
      translationMemoryComposer: () => ({
        translationMode: "reference_style",
        policy: { useReferenceMemory: true, useLocalMemory: false, runQuality: true, commitKnowledge: false },
        readiness: { reference: true, local: true },
        effective: { glossary: [], sourceIdentity: [], story: null, style: null, localKnowledge: null },
        usage: {}, warnings: [], revisions: [], layers: { reference: {}, local: null }, fingerprint: "test-memory",
      }),
    });

    const result = await engine.runTranslationJob(
      {
        translationMode: "reference_style",
        targetLanguage: "zh-TW",
        qualityCheck: true,
        sourceImagePaths: ["C:\\source\\001.png"],
        outputDir: "C:\\exports\\runtime-default",
      },
      {
        setStage: jest.fn(),
        emit: jest.fn(),
        isCanceled: jest.fn().mockReturnValue(false),
      }
    );

    expect(result.closed).toBe(true);
    expect(quality.run).toHaveBeenCalledTimes(1);
    expect(knowledge.run).not.toHaveBeenCalled();
    expect(exporter.run).toHaveBeenCalledTimes(1);
    expect(lifecycle.closeCurrentProject).toHaveBeenCalledTimes(1);
  });

  test("workflow engine builds a translation system prompt from manga assets when available", async () => {
    const setup = { run: jest.fn().mockResolvedValue({ projectName: "p1", operationId: "op-1", engines: {}, steps: [] }) };
    const monitor = { run: jest.fn().mockResolvedValue({ summary: { finalStatus: "completed", totalPages: 1, steps: {} } }) };
    const engine = new WorkflowEngine({
      projectSetup: setup,
      pipelineMonitor: monitor,
      translationMemoryComposer: () => ({
        translationMode: "reference_style",
        policy: { useReferenceMemory: true, useLocalMemory: false, runQuality: true, commitKnowledge: false },
        readiness: { reference: true, local: true },
        effective: {
          glossary: [{ source_term: "Alice", canonical_translation: "Alice" }],
          sourceIdentity: [], story: null, style: null, localKnowledge: null,
        },
        usage: { glossaryEntries: 1 }, warnings: [], revisions: [], layers: { reference: {}, local: null }, fingerprint: "test-memory",
      }),
      qualityModule: {
        run: jest.fn().mockResolvedValue({
          overall: "pass",
          score: 1,
          totalTranslations: 1,
          issues: [],
          warnings: [],
          passedChecks: ["translations_present"],
          failedChecks: [],
        }),
      },
      knowledgeModule: { run: jest.fn().mockResolvedValue({ translationPairs: 1 }) },
      exportModule: { run: jest.fn().mockResolvedValue({ path: "C:\\translated\\out.zip", size: 123 }) },
      projectLifecycle: {
        client: { getScene: jest.fn().mockResolvedValue({ scene: { pages: {} } }) },
        closeCurrentProject: jest.fn().mockResolvedValue({ success: true }),
      },
    });

    await engine.runTranslationJob(
      {
        translationMode: "reference_style",
        qualityCheck: true,
        targetLanguage: "zh-TW",
        mangaId: "phantom_fantasy",
        chapterId: "ch_001",
        sourceImagePaths: ["C:\\source\\001.png"],
        outputDir: "C:\\exports\\runtime-context",
      },
      {
        setStage: jest.fn(),
        emit: jest.fn(),
        isCanceled: jest.fn().mockReturnValue(false),
      }
    );

    expect(setup.run).toHaveBeenCalledWith({
      targetLanguage: "zh-TW",
      baseUrl: "http://127.0.0.1:4000",
      sourceImagePaths: ["C:\\source\\001.png"],
      systemPrompt: expect.any(String),
    });
  });

  test("job manager persists a successful translation job", async () => {
    const store = new JobStore(createTempDbPath());
    const engine = {
      runTranslationJob: jest.fn().mockResolvedValue({
        projectName: "translate_1",
        operationId: "op-1",
        artifact: { path: "C:\\translated\\out.zip", size: 99 },
      }),
    };

    const manager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 4001 },
      resolvedConfig: { api: { baseUrl: "http://127.0.0.1:9999" } },
    });

    const created = manager.createTranslationJob({ translationMode: "quick", targetLanguage: "zh-TW" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = manager.getJob(created.id);
    expect(stored.status).toBe("succeeded");
    expect(stored.result.projectName).toBe("translate_1");
    expect(stored.artifacts[0].path).toContain("out.zip");
  });

  test("workflow engine runs reference extraction jobs through the dedicated module", async () => {
    const referenceExtractionModule = {
      run: jest.fn().mockResolvedValue({
        referenceSetId: "ref_001",
        projectName: "reference_ref_001_20260521",
        operationId: "op-ref-1",
        scenePath: "C:\\references\\extracted\\ref_001\\scene.json",
        textsPath: "C:\\references\\extracted\\ref_001\\texts.json",
        closed: true,
      }),
    };

    const engine = new WorkflowEngine({
      projectSetup: { run: jest.fn() },
      pipelineMonitor: { run: jest.fn() },
      referenceExtractionModule,
      qualityModule: { run: jest.fn() },
      knowledgeModule: { run: jest.fn() },
      exportModule: { run: jest.fn() },
      projectLifecycle: { closeCurrentProject: jest.fn() },
    });

    const result = await engine.runReferenceExtractionJob(
      { referenceSetId: "ref_001", targetLanguage: "zh-TW" },
      {
        setStage: jest.fn(),
        emit: jest.fn(),
        isCanceled: jest.fn().mockReturnValue(false),
      }
    );

    expect(referenceExtractionModule.run).toHaveBeenCalledWith({
      referenceSetId: "ref_001",
      baseUrl: "http://127.0.0.1:4000",
      targetLanguage: "zh-TW",
    });
    expect(result.referenceSetId).toBe("ref_001");
    expect(result.closed).toBe(true);
  });

  test("job manager persists a successful reference extraction job", async () => {
    const store = new JobStore(createTempDbPath());
    const engine = {
      runReferenceExtractionJob: jest.fn().mockResolvedValue({
        referenceSetId: "ref_001",
        projectName: "reference_ref_001_20260521",
        operationId: "op-ref-1",
        scenePath: "C:\\references\\extracted\\ref_001\\scene.json",
        textsPath: "C:\\references\\extracted\\ref_001\\texts.json",
        closed: true,
      }),
      runTranslationJob: jest.fn(),
    };

    const manager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 4001 },
      resolvedConfig: { api: { baseUrl: "http://127.0.0.1:9999" } },
    });

    const created = manager.createReferenceExtractionJob({ referenceSetId: "ref_001" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = manager.getJob(created.id);
    expect(stored.type).toBe("reference_extraction");
    expect(stored.status).toBe("succeeded");
    expect(stored.result.referenceSetId).toBe("ref_001");
    expect(stored.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["reference_scene", "reference_texts"])
    );
  });

  test("job manager persists a successful reference ingestion job", async () => {
    const store = new JobStore(createTempDbPath());
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn().mockResolvedValue({
        phase: "analysis",
      }),
      runReferenceKnowledgeCommitJob: jest.fn().mockResolvedValue({
        referenceSetId: "ref_001",
        mangaId: "phantom_fantasy",
        glossaryPath: "C:\\knowledge\\canonical_glossary.json",
        storyContextPath: "C:\\knowledge\\story_context.json",
        styleProfilePath: "C:\\knowledge\\style_profile.json",
        translationContextPath: "C:\\knowledge\\translation_context.json",
      }),
      runReferenceExtractionJob: jest.fn(),
      runTranslationJob: jest.fn(),
    };

    const manager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 4001 },
      resolvedConfig: { api: { baseUrl: "http://127.0.0.1:9999" } },
    });

    const created = manager.createReferenceIngestionJob({
      referenceSetId: "ref_001",
      mangaId: "phantom_fantasy",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const stored = manager.getJob(created.id);
    expect(stored.type).toBe("reference_ingestion");
    expect(stored.status).toBe("succeeded");
    expect(stored.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["glossary", "story_context", "style_profile", "translation_context"])
    );
  });

  test("pipeline monitor recovers when operation already disappeared but scene has translations", async () => {
    const monitor = new PipelineMonitorModule({
      listOperations: jest.fn().mockResolvedValue([]),
      getScene: jest.fn().mockResolvedValue({
        scene: {
          pages: {
            page1: {
              nodes: {
                n1: {
                  kind: { text: { translation: "translated" } },
                },
              },
            },
          },
        },
      }),
    });

    const result = await monitor.run({
      operationId: "op-fast",
      baseUrl: "http://127.0.0.1:9999",
      timeoutMs: 100,
    });

    expect(result.recovered).toBe(true);
    expect(result.summary.finalStatus).toBe("completed_before_listener_attached");
  });
});
