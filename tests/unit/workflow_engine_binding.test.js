const fs = require("fs");
const os = require("os");
const path = require("path");

describe("workflow engine manga-management binding sync", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("translation job syncs manga and translator binding after success", async () => {
    const syncMangaManagementBinding = jest.fn();
    jest.doMock("../../backend/src/modules/knowledge_paths", () => ({
      syncMangaManagementBinding,
    }));

    const { WorkflowEngine } = require("../../backend/src/workflow_engine");

    const engine = new WorkflowEngine({
      sourcePreflightModule: {
        get: jest.fn().mockReturnValue({
          preflightId: "preflight_001",
          sourceFolder: "C:\\source",
          summary: { acceptedCount: 1, convertedCount: 0 },
          orderChanged: false,
        }),
        resolveSourceImages: jest.fn().mockReturnValue(["C:\\source\\001.png"]),
      },
      projectSetup: {
        run: jest.fn().mockResolvedValue({
          projectName: "translate_binding",
          operationId: "op-binding",
          engines: {},
          steps: [],
        }),
      },
      pipelineMonitor: {
        run: jest.fn().mockResolvedValue({
          summary: { finalStatus: "completed", totalPages: 1, steps: {} },
          recovered: false,
        }),
      },
      referenceExtractionModule: null,
      referenceIngestionModule: {
        buildTranslationContext: jest.fn().mockReturnValue({
          mangaGlobal: { glossary: [], fallbackTerminology: [] },
        }),
        formatTranslationSystemPrompt: jest.fn().mockReturnValue("prompt"),
      },
      qualityModule: {
        run: jest.fn().mockResolvedValue({
          overall: "pass",
          score: 1,
          totalTranslations: 1,
          issues: [],
          warnings: [],
          passedChecks: [],
          failedChecks: [],
        }),
      },
      knowledgeModule: {
        run: jest.fn().mockResolvedValue({ translationPairs: 0 }),
      },
      exportModule: {
        run: jest.fn().mockResolvedValue({
          path: "C:\\translated\\binding.zip",
          size: 10,
          format: "rendered",
        }),
      },
      projectLifecycle: {
        client: { getScene: jest.fn().mockResolvedValue({ scene: { pages: {} } }) },
        closeCurrentProject: jest.fn().mockResolvedValue({ success: true }),
      },
      translationMemoryComposer: () => ({
        translationMode: "quick",
        policy: { useReferenceMemory: false, useLocalMemory: false, runQuality: false, commitKnowledge: false },
        readiness: { reference: true, local: true },
        effective: { glossary: [], sourceIdentity: [], story: null, style: null, localKnowledge: null },
        usage: {}, warnings: [], revisions: [], layers: { reference: null, local: null }, fingerprint: "test-quick",
      }),
      postEditWorkspaceModule: null,
      jobStore: null,
    });

    const hooks = {
      jobId: "job_translation_001",
      setStage: jest.fn(),
      emit: jest.fn(),
      isCanceled: jest.fn().mockReturnValue(false),
    };

    await engine.runTranslationJob(
      {
        translationMode: "quick",
        sourcePreflightId: "preflight_001",
        mangaId: "manga_phantom_fantasy",
        mangaLabel: "Phantom Fantasy",
        translatorId: "translator_self_team",
        translatorLabel: "Self Team",
        chapterId: "chapter_001",
        chapterTitle: "Chapter 001",
        targetLanguage: "zh-TW",
        outputDir: "C:\\exports\\binding-translation",
      },
      hooks
    );

    expect(syncMangaManagementBinding).toHaveBeenCalledWith({
      mangaId: "manga_phantom_fantasy",
      label: "Phantom Fantasy",
      translatorId: "translator_self_team",
      translatorLabel: "Self Team",
      language: "zh-TW",
      chapterId: "chapter_001",
      chapterTitle: "Chapter 001",
      profileKind: null,
      styleSourceTranslatorId: null,
    });
  });

  test("translation retry resumes from a completed Koharu project without rerunning the pipeline", async () => {
    jest.doMock("../../backend/src/modules/knowledge_paths", () => ({
      syncMangaManagementBinding: jest.fn(),
    }));
    const { WorkflowEngine } = require("../../backend/src/workflow_engine");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "translation-resume-"));
    const memoryPath = path.join(root, "translation_memory_snapshot.json");
    fs.writeFileSync(memoryPath, JSON.stringify({
      schemaVersion: 1,
      translationMode: "quick",
      mangaId: "manga_resume",
      translatorId: "translator_resume",
      chapterId: "chapter_004",
      policy: { useReferenceMemory: false, useLocalMemory: false, runQuality: false, commitKnowledge: false },
      readiness: { reference: true, local: true },
      effective: { glossary: [], sourceIdentity: [], story: null, style: null, localKnowledge: null },
      usage: {}, warnings: [], revisions: [], layers: { reference: null, local: null }, fingerprint: "resume-memory",
    }));
    const projectSetup = { run: jest.fn() };
    const pipelineMonitor = { run: jest.fn() };
    const projectClient = {
      listProjects: jest.fn().mockResolvedValue([{ id: "project-resume", name: "translate_resume" }]),
      openProject: jest.fn().mockResolvedValue({ success: true }),
      getScene: jest.fn().mockResolvedValue({ scene: { pages: {} } }),
    };
    const engine = new WorkflowEngine({
      sourcePreflightModule: null,
      projectSetup,
      pipelineMonitor,
      referenceExtractionModule: null,
      referenceIngestionModule: null,
      qualityModule: { run: jest.fn() },
      knowledgeModule: null,
      exportModule: { run: jest.fn().mockResolvedValue({ path: "resume.zip", size: 1, format: "rendered" }) },
      projectLifecycle: {
        client: projectClient,
        closeCurrentProject: jest.fn().mockResolvedValue({ success: true }),
      },
      translationMemoryComposer: jest.fn(),
      postEditWorkspaceModule: null,
      jobStore: null,
    });
    const hooks = {
      jobId: "job_translation_resume",
      setStage: jest.fn(),
      emit: jest.fn(),
      isCanceled: jest.fn().mockReturnValue(false),
    };

    const result = await engine.runTranslationJob({
      translationMode: "quick",
      mangaId: "manga_resume",
      translatorId: "translator_resume",
      chapterId: "chapter_004",
      targetLanguage: "zh-TW",
      outputDir: root,
      resumeFromTranslation: {
        sourceJobId: "failed_translation",
        projectName: "translate_resume",
        operationId: "operation_resume",
        translationMemorySnapshotPath: memoryPath,
      },
    }, hooks);

    expect(projectSetup.run).not.toHaveBeenCalled();
    expect(pipelineMonitor.run).not.toHaveBeenCalled();
    expect(projectClient.openProject).toHaveBeenCalledWith("project-resume", expect.any(String));
    expect(hooks.emit).toHaveBeenCalledWith("translation.resumed", expect.objectContaining({
      sourceJobId: "failed_translation",
      resumedAtStage: "quality_context",
    }));
    expect(result.pipeline).toEqual(expect.objectContaining({ resumed: true }));
  });

  test("reference extraction job syncs manga and translator binding after success", async () => {
    const syncMangaManagementBinding = jest.fn();
    jest.doMock("../../backend/src/modules/knowledge_paths", () => ({
      syncMangaManagementBinding,
    }));

    const { WorkflowEngine } = require("../../backend/src/workflow_engine");

    const engine = new WorkflowEngine({
      sourcePreflightModule: null,
      projectSetup: null,
      pipelineMonitor: null,
      referenceExtractionModule: {
        run: jest.fn().mockResolvedValue({
          referenceSetId: "ref_001",
          projectName: "reference_ref_001",
          operationId: "op-ref",
          scenePath: "C:\\references\\scene.json",
          textsPath: "C:\\references\\texts.json",
          closed: true,
        }),
      },
      referenceIngestionModule: null,
      qualityModule: null,
      knowledgeModule: null,
      exportModule: null,
      projectLifecycle: null,
      postEditWorkspaceModule: null,
      jobStore: null,
    });

    const hooks = {
      setStage: jest.fn(),
      emit: jest.fn(),
    };

    await engine.runReferenceExtractionJob(
      {
        referenceSetId: "ref_001",
        mangaId: "manga_phantom_fantasy",
        mangaLabel: "Phantom Fantasy",
        translatorId: "translator_other_team",
        translatorLabel: "Other Team",
        chapterId: "chapter_001",
        chapterTitle: "Chapter 001",
        targetLanguage: "zh-TW",
      },
      hooks
    );

    expect(syncMangaManagementBinding).toHaveBeenCalledWith({
      mangaId: "manga_phantom_fantasy",
      label: "Phantom Fantasy",
      translatorId: "translator_other_team",
      translatorLabel: "Other Team",
      language: "zh-TW",
      chapterId: "chapter_001",
      chapterTitle: "Chapter 001",
    });
  });
});
