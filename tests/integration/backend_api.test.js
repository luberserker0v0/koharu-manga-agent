const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/storage/job_store");
const { JobManager } = require("../../backend/src/job_manager");
const { createApiServer } = require("../../backend/src/http/api_server");
const { PROJECT_ROOT, paths } = require("../../backend/src/config");
const {
  createChapterRecord,
  createMangaRecord,
  createTranslatorProfile,
  knowledgeIndexPath,
  loadKnowledgeIndex,
  writeKnowledgeIndex,
} = require("../../backend/src/modules/knowledge_paths");
const { referenceSetPaths } = require("../../backend/src/modules/reference_sets");
const { SourcePreflightModule } = require("../../backend/src/modules/source_preflight");

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-api-"));
  return path.join(dir, "jobs.sqlite");
}

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XnYQAAAAASUVORK5CYII=";

function writePng(targetPath) {
  fs.writeFileSync(targetPath, Buffer.from(PNG_1X1_BASE64, "base64"));
}

async function waitForJobTerminal(baseUrl, jobId, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${baseUrl}/jobs/${jobId}`);
    const job = await response.json();
    if (["succeeded", "failed", "canceled"].includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach a terminal state.`);
}

describe("backend api", () => {
  let api;
  let baseUrl;
  let originalKnowledgeIndex = null;

  beforeAll(() => {
    const indexPath = knowledgeIndexPath();
    originalKnowledgeIndex = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, "utf8")
      : null;
  });

  afterAll(() => {
    const indexPath = knowledgeIndexPath();
    if (originalKnowledgeIndex === null) {
      fs.rmSync(indexPath, { force: true });
      return;
    }
    fs.writeFileSync(indexPath, originalKnowledgeIndex, "utf8");
  });

  afterEach(async () => {
    if (api) {
      await api.close();
      api = null;
    }
  });

  test("POST /jobs/translation rejects a missing explicit translation mode", async () => {
    const store = new JobStore(createTempDbPath());
    const jobManager = new JobManager({
      store,
      engine: { runTranslationJob: jest.fn() },
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: {},
    });
    api = createApiServer({ jobManager, host: "127.0.0.1", port: 0 });
    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetLanguage: "zh-TW" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining("translationMode"),
    }));
    expect(jobManager.listJobs()).toEqual([]);
  });

  test("POST /jobs/translation creates a job and GET /jobs/:id returns it", async () => {
    const store = new JobStore(createTempDbPath());
    const engine = {
      runTranslationJob: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          projectName: "translate_api",
          operationId: "op-api",
          artifact: { path: "C:\\translated\\api.zip", size: 11 },
        };
      }),
    };

    const jobManager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });

    api = createApiServer({
      jobManager,
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "quick",
        targetLanguage: "zh-TW",
        mangaId: "phantom_fantasy",
        mangaLabel: "Phantom Fantasy",
        chapterId: "ch_001",
        outputDir: "C:\\exports\\api-translation",
      }),
    });
    expect(createRes.status).toBe(202);

    const created = await createRes.json();
    expect(created.status).toBe("queued");

    await new Promise((resolve) => setTimeout(resolve, 30));

    const getRes = await fetch(`${baseUrl}/jobs/${created.id}`);
    expect(getRes.status).toBe(200);
    const stored = await getRes.json();
    expect(stored.status).toBe("succeeded");
    expect(stored.result.operationId).toBe("op-api");
    expect(stored.payload.mangaId).toBe("phantom_fantasy");
    expect(stored.payload.mangaLabel).toBe("Phantom Fantasy");
    expect(stored.payload.chapterId).toBe("ch_001");
  });

  test("translation jobs without a baseUrl override ensure managed Koharu first", async () => {
    const store = new JobStore(createTempDbPath());
    const koharuRuntimeManager = {
      ensureRunning: jest.fn().mockResolvedValue({ status: "running", baseUrl: "http://127.0.0.1:4000" }),
      inspect: jest.fn().mockResolvedValue({ status: "running", baseUrl: "http://127.0.0.1:4000" }),
    };
    const engine = {
      runTranslationJob: jest.fn().mockResolvedValue({
        projectName: "translate_managed",
        operationId: "op-managed",
      }),
    };
    const jobManager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { api: { baseUrl: "http://127.0.0.1:4000" }, workflow: { qualityCheck: { enabled: true } } },
      koharuRuntimeManager,
    });
    api = createApiServer({ jobManager, host: "127.0.0.1", port: 0 });
    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "quick",
        outputDir: "C:\\exports\\managed",
      }),
    });
    const created = await createRes.json();
    const job = await waitForJobTerminal(baseUrl, created.id);

    expect(job.status).toBe("succeeded");
    expect(koharuRuntimeManager.ensureRunning).toHaveBeenCalledTimes(1);
    expect(engine.runTranslationJob).toHaveBeenCalledTimes(1);
  });

  test("translation jobs with a baseUrl override do not start managed Koharu", async () => {
    const store = new JobStore(createTempDbPath());
    const koharuRuntimeManager = {
      ensureRunning: jest.fn(),
      inspect: jest.fn().mockResolvedValue({ status: "installed", baseUrl: "http://127.0.0.1:4000" }),
    };
    const engine = {
      runTranslationJob: jest.fn().mockResolvedValue({
        projectName: "translate_external",
        operationId: "op-external",
      }),
    };
    const jobManager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { api: { baseUrl: "http://127.0.0.1:4000" }, workflow: { qualityCheck: { enabled: true } } },
      koharuRuntimeManager,
    });
    api = createApiServer({ jobManager, host: "127.0.0.1", port: 0 });
    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "quick",
        outputDir: "C:\\exports\\external",
        baseUrl: "http://127.0.0.1:4999",
      }),
    });
    const created = await createRes.json();
    const job = await waitForJobTerminal(baseUrl, created.id);

    expect(job.status).toBe("succeeded");
    expect(koharuRuntimeManager.ensureRunning).not.toHaveBeenCalled();
    expect(engine.runTranslationJob).toHaveBeenCalledTimes(1);
  });

  test("GET /references returns enabled reference manifest summaries", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reference-list-"));
    const originalReferenceManifests = paths.referenceManifests;
    paths.referenceManifests = path.join(tempRoot, "references", "manifests");
    fs.mkdirSync(paths.referenceManifests, { recursive: true });
    fs.writeFileSync(
      path.join(paths.referenceManifests, "ref_test_001.json"),
      JSON.stringify({
        id: "ref_test_001",
        label: "Episode 1",
        source: "imported_folder",
        language: "zh-TW",
        pageCount: 3,
        imageDir: "references/other_images/ref_test_001",
        extractedDir: "references/extracted/ref_test_001",
        enabled: true,
      })
    );

    try {
      const store = new JobStore(createTempDbPath());
      const jobManager = new JobManager({
        store,
        engine: { runTranslationJob: jest.fn() },
        runtimeConfig: { host: "127.0.0.1", port: 0 },
        resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
      });

      api = createApiServer({
        jobManager,
        host: "127.0.0.1",
        port: 0,
      });

      await api.listen();
      const address = api.server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;

      const referencesRes = await fetch(`${baseUrl}/references`);
      expect(referencesRes.status).toBe(200);
      const referencesPayload = await referencesRes.json();
      expect(Array.isArray(referencesPayload.referenceSets)).toBe(true);
      expect(referencesPayload.referenceSets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "ref_test_001",
            label: "Episode 1",
            enabled: true,
          }),
        ])
      );
    } finally {
      paths.referenceManifests = originalReferenceManifests;
    }
  });

  test("POST /references/import imports a translated manga folder into a new reference set", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reference-import-"));
    const originalReferenceImages = paths.referenceImages;
    const originalReferenceExtracted = paths.referenceExtracted;
    const originalReferenceManifests = paths.referenceManifests;

    const importedFolder = path.join(tempRoot, "translated_reference");
    fs.mkdirSync(importedFolder, { recursive: true });
    writePng(path.join(importedFolder, "001.png"));
    writePng(path.join(importedFolder, "002.png"));

    paths.referenceImages = path.join(tempRoot, "references", "other_images");
    paths.referenceExtracted = path.join(tempRoot, "references", "extracted");
    paths.referenceManifests = path.join(tempRoot, "references", "manifests");

    try {
      const store = new JobStore(createTempDbPath());
      const jobManager = new JobManager({
        store,
        engine: { runTranslationJob: jest.fn() },
        runtimeConfig: { host: "127.0.0.1", port: 0 },
        resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
      });

      api = createApiServer({
        jobManager,
        host: "127.0.0.1",
        port: 0,
      });

      await api.listen();
      const address = api.server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/references/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceFolder: importedFolder,
          label: "Imported Volume",
          language: "zh-TW",
        }),
      });

      expect(response.status).toBe(201);
      const payload = await response.json();
      expect(payload.referenceSet).toEqual(
        expect.objectContaining({
          id: expect.stringMatching(/^ref_/),
          label: "Imported Volume",
          pageCount: 2,
          enabled: true,
        })
      );

      const manifestPath = path.join(paths.referenceManifests, `${payload.referenceSet.id}.json`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      expect(manifest.label).toBe("Imported Volume");
      expect(manifest.pageCount).toBe(2);
      expect(fs.existsSync(path.join(paths.referenceImages, payload.referenceSet.id, "001.png"))).toBe(true);
      expect(fs.existsSync(path.join(paths.referenceImages, payload.referenceSet.id, "002.png"))).toBe(true);
    } finally {
      paths.referenceImages = originalReferenceImages;
      paths.referenceExtracted = originalReferenceExtracted;
      paths.referenceManifests = originalReferenceManifests;
    }
  });

  test("POST /references/import syncs bound manga, translator, and chapter into manga management", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reference-import-bind-"));
    const originalReferenceImages = paths.referenceImages;
    const originalReferenceExtracted = paths.referenceExtracted;
    const originalReferenceManifests = paths.referenceManifests;

    const importedFolder = path.join(tempRoot, "translated_reference");
    fs.mkdirSync(importedFolder, { recursive: true });
    writePng(path.join(importedFolder, "001.png"));

    paths.referenceImages = path.join(tempRoot, "references", "other_images");
    paths.referenceExtracted = path.join(tempRoot, "references", "extracted");
    paths.referenceManifests = path.join(tempRoot, "references", "manifests");

    writeKnowledgeIndex({ series: [] });
    const indexedManga = createMangaRecord({ label: "Bound Series", language: "zh-TW" });

    try {
      const store = new JobStore(createTempDbPath());
      const jobManager = new JobManager({
        store,
        engine: { runTranslationJob: jest.fn() },
        runtimeConfig: { host: "127.0.0.1", port: 0 },
        resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
      });

      api = createApiServer({
        jobManager,
        host: "127.0.0.1",
        port: 0,
      });

      await api.listen();
      const address = api.server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/references/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceFolder: importedFolder,
          label: "Imported Bound Volume",
          language: "zh-TW",
          mangaId: indexedManga.mangaId,
          mangaLabel: indexedManga.mangaId,
          translatorId: "translator_bound_team",
          translatorLabel: "Bound Team",
          chapterId: "chapter_bound_001",
          chapterTitle: "Chapter 001",
        }),
      });

      expect(response.status).toBe(201);
      const imported = await response.json();
      expect(imported.referenceSet.mangaLabel).toBe("Bound Series");

      const mangaResponse = await fetch(`${baseUrl}/manga`);
      expect(mangaResponse.status).toBe(200);
      const mangaPayload = await mangaResponse.json();
      expect(mangaPayload.series).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mangaId: "manga_bound_series",
            label: "Bound Series",
            translators: expect.arrayContaining([
              expect.objectContaining({
                translatorId: "translator_bound_team",
                label: "Bound Team",
                chapters: expect.arrayContaining([
                  expect.objectContaining({
                    chapterId: "chapter_bound_001",
                    chapterTitle: "Chapter 001",
                  }),
                ]),
              }),
            ]),
          }),
        ])
      );
    } finally {
      paths.referenceImages = originalReferenceImages;
      paths.referenceExtracted = originalReferenceExtracted;
      paths.referenceManifests = originalReferenceManifests;
    }
  });

  test("DELETE /references/:id removes imported reference material assets", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reference-delete-"));
    const originalReferenceImages = paths.referenceImages;
    const originalReferenceExtracted = paths.referenceExtracted;
    const originalReferenceManifests = paths.referenceManifests;
    const originalLegacyReferenceDiagnostics = paths.legacyReferenceDiagnostics;
    const originalReferenceComparisons = paths.referenceComparisons;

    paths.referenceImages = path.join(tempRoot, "references", "other_images");
    paths.referenceExtracted = path.join(tempRoot, "references", "extracted");
    paths.referenceManifests = path.join(tempRoot, "references", "manifests");
    paths.legacyReferenceDiagnostics = path.join(tempRoot, "references", "comparisons");
    paths.referenceComparisons = paths.legacyReferenceDiagnostics;

    const referenceId = "ref_delete_test";
    const manifestDir = paths.referenceManifests;
    const imageDir = path.join(paths.referenceImages, referenceId);
    const extractedDir = path.join(paths.referenceExtracted, referenceId);
    const comparisonsDir = path.join(paths.legacyReferenceDiagnostics, referenceId);

    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(imageDir, { recursive: true });
    fs.mkdirSync(extractedDir, { recursive: true });
    fs.mkdirSync(comparisonsDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, `${referenceId}.json`),
      JSON.stringify({
        id: referenceId,
        label: "Delete Test",
        source: "imported_folder",
        language: "zh-TW",
        pageCount: 1,
        imageDir: `references/other_images/${referenceId}`,
        extractedDir: `references/extracted/${referenceId}`,
        enabled: true,
      })
    );
    writePng(path.join(imageDir, "001.png"));
    fs.writeFileSync(path.join(extractedDir, "scene.json"), JSON.stringify({ ok: true }));
    fs.writeFileSync(path.join(comparisonsDir, "legacy.json"), JSON.stringify({ ok: true }));

    try {
      const store = new JobStore(createTempDbPath());
      store.createJob({
        id: "reference-delete-terminal-job",
        type: "reference_extraction",
        status: "succeeded",
        stage: "succeeded",
        payload: { referenceSetId: referenceId },
      });
      const jobManager = new JobManager({
        store,
        engine: { runTranslationJob: jest.fn() },
        runtimeConfig: { host: "127.0.0.1", port: 0 },
        resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
      });

      api = createApiServer({
        jobManager,
        host: "127.0.0.1",
        port: 0,
      });

      await api.listen();
      const address = api.server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;

      const response = await fetch(`${baseUrl}/references/${referenceId}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.deleted).toEqual({
        id: referenceId,
        label: "Delete Test",
        deleted: true,
      });
      expect(payload.deletedJobs).toEqual([
        expect.objectContaining({
          id: "reference-delete-terminal-job",
          type: "reference_extraction",
        }),
      ]);
      expect(jobManager.getJob("reference-delete-terminal-job")).toBeNull();

      expect(fs.existsSync(path.join(manifestDir, `${referenceId}.json`))).toBe(false);
      expect(fs.existsSync(imageDir)).toBe(false);
      expect(fs.existsSync(extractedDir)).toBe(false);
      expect(fs.existsSync(comparisonsDir)).toBe(false);
    } finally {
      paths.referenceImages = originalReferenceImages;
      paths.referenceExtracted = originalReferenceExtracted;
      paths.referenceManifests = originalReferenceManifests;
      paths.legacyReferenceDiagnostics = originalLegacyReferenceDiagnostics;
      paths.referenceComparisons = originalReferenceComparisons;
    }
  });

  test("GET /manga returns stored manga series summaries", async () => {
    writeKnowledgeIndex({
      series: [
        {
          mangaId: "phantom_fantasy",
          label: "Phantom Fantasy",
          language: "zh-TW",
          knowledgePath: "knowledge_base/self/phantom_fantasy/knowledge.json",
          reportPath: "knowledge_base/reports/phantom_fantasy/extract_report.json",
          updatedAt: "2026-05-27T10:00:00.000Z",
        },
      ],
    });

    const store = new JobStore(createTempDbPath());
    const jobManager = new JobManager({
      store,
      engine: { runTranslationJob: jest.fn() },
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });

    api = createApiServer({
      jobManager,
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/manga`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    const entry = payload.series.find((series) => series.mangaId === "phantom_fantasy");
    expect(entry).toMatchObject({
      mangaId: "phantom_fantasy",
      label: "Phantom Fantasy",
      language: "zh-TW",
    });
    expect(Array.isArray(entry.translators)).toBe(true);
  });

  test("manga management endpoints create translators and chapters with stable ordering", async () => {
    const store = new JobStore(createTempDbPath());
    const jobManager = new JobManager({
      store,
      engine: { runTranslationJob: jest.fn() },
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });

    api = createApiServer({
      jobManager,
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const mangaRes = await fetch(`${baseUrl}/manga`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "API Managed Manga" }),
    });
    expect(mangaRes.status).toBe(201);
    const mangaPayload = await mangaRes.json();
    const mangaId = mangaPayload.manga.mangaId;

    const translatorRes = await fetch(`${baseUrl}/manga/${mangaId}/translators`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "譯者甲" }),
    });
    expect(translatorRes.status).toBe(201);
    const translatorPayload = await translatorRes.json();
    const translatorId = translatorPayload.translator.translatorId;

    const chapterOneRes = await fetch(`${baseUrl}/manga/${mangaId}/translators/${translatorId}/chapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterTitle: "第 1 話" }),
    });
    expect(chapterOneRes.status).toBe(201);
    const chapterOne = await chapterOneRes.json();

    const chapterTwoRes = await fetch(`${baseUrl}/manga/${mangaId}/translators/${translatorId}/chapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterTitle: "第 2 話" }),
    });
    expect(chapterTwoRes.status).toBe(201);
    const chapterTwo = await chapterTwoRes.json();

    const chapterListRes = await fetch(`${baseUrl}/manga/${mangaId}/translators/${translatorId}/chapters`);
    expect(chapterListRes.status).toBe(200);
    const chapterListPayload = await chapterListRes.json();
    expect(chapterListPayload.chapters.map((entry) => entry.chapterId)).toEqual([
      chapterOne.chapter.chapterId,
      chapterTwo.chapter.chapterId,
    ]);

    const reorderRes = await fetch(`${baseUrl}/manga/${mangaId}/translators/${translatorId}/chapters/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderedChapterIds: [chapterTwo.chapter.chapterId, chapterOne.chapter.chapterId],
      }),
    });
    expect(reorderRes.status).toBe(200);
    const reorderedPayload = await reorderRes.json();
    expect(reorderedPayload.chapters.map((entry) => entry.chapterId)).toEqual([
      chapterTwo.chapter.chapterId,
      chapterOne.chapter.chapterId,
    ]);

    const deleteChapterRes = await fetch(
      `${baseUrl}/manga/${mangaId}/translators/${translatorId}/chapters/${chapterOne.chapter.chapterId}`,
      {
        method: "DELETE",
      }
    );
    expect(deleteChapterRes.status).toBe(200);

    const afterDeleteChapterRes = await fetch(`${baseUrl}/manga/${mangaId}/translators/${translatorId}/chapters`);
    const afterDeleteChapterPayload = await afterDeleteChapterRes.json();
    expect(afterDeleteChapterPayload.chapters.map((entry) => entry.chapterId)).toEqual([
      chapterTwo.chapter.chapterId,
    ]);

    const deleteTranslatorRes = await fetch(`${baseUrl}/manga/${mangaId}/translators/${translatorId}`, {
      method: "DELETE",
    });
    expect(deleteTranslatorRes.status).toBe(200);

    const mangaListAfterTranslatorDeleteRes = await fetch(`${baseUrl}/manga`);
    const mangaListAfterTranslatorDeletePayload = await mangaListAfterTranslatorDeleteRes.json();
    expect(
      mangaListAfterTranslatorDeletePayload.series.find((entry) => entry.mangaId === mangaId).translators
    ).toEqual([]);

    const deleteMangaRes = await fetch(`${baseUrl}/manga/${mangaId}`, {
      method: "DELETE",
    });
    expect(deleteMangaRes.status).toBe(200);

    const mangaListAfterDeleteRes = await fetch(`${baseUrl}/manga`);
    const mangaListAfterDeletePayload = await mangaListAfterDeleteRes.json();
    expect(mangaListAfterDeletePayload.series.some((entry) => entry.mangaId === mangaId)).toBe(false);
  });

  test("POST /source-preflight and /source-preflight/:id/reorder expose staged source-image results", async () => {
    const store = new JobStore(createTempDbPath());
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-source-api-"));
    const preflightRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manga-preflight-api-"));
    writePng(path.join(sourceDir, "002.png"));
    writePng(path.join(sourceDir, "001.png"));
    fs.writeFileSync(path.join(sourceDir, "notes.txt"), "ignore");

    api = createApiServer({
      jobManager: new JobManager({
        store,
        engine: { runTranslationJob: jest.fn() },
        runtimeConfig: { host: "127.0.0.1", port: 0 },
        resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
      }),
      sourcePreflightModule: new SourcePreflightModule({ root: preflightRoot }),
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createRes = await fetch(`${baseUrl}/source-preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceFolder: sourceDir }),
    });
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.summary.acceptedCount).toBe(2);
    expect(created.summary.rejectedCount).toBe(1);

    const reorderedIds = created.images.map((image) => image.id).reverse();
    const reorderRes = await fetch(`${baseUrl}/source-preflight/${created.preflightId}/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedImageIds: reorderedIds }),
    });
    expect(reorderRes.status).toBe(200);
    const reordered = await reorderRes.json();
    expect(reordered.orderChanged).toBe(true);
    expect(reordered.images[0].id).toBe(reorderedIds[0]);
  });

  test("GET /jobs, /jobs/:id/events, /jobs/:id/artifacts, and /runtime/status expose gui-friendly data", async () => {
    const store = new JobStore(createTempDbPath());
    const engine = {
      runTranslationJob: jest.fn().mockImplementation(async (payload, hooks) => {
        const qualityArtifactsDir = path.join(
          paths.workspaceRoot,
          hooks.jobId,
          "quality_review",
          "artifacts"
        );
        fs.mkdirSync(qualityArtifactsDir, { recursive: true });
        fs.writeFileSync(
          path.join(qualityArtifactsDir, "import_manifest.json"),
          JSON.stringify({ stage: "quality_review", accepted: [] })
        );
        fs.writeFileSync(
          path.join(qualityArtifactsDir, "export_manifest.json"),
          JSON.stringify({ stage: "quality_review", accepted: [] })
        );
        hooks.emit("pipeline.completed", {
          operationId: "op-gui",
          projectName: "translate_gui",
        });
        return {
          projectName: "translate_gui",
          operationId: "op-gui",
          artifact: {
            path: "C:\\translated\\gui.zip",
            size: 22,
          },
          quality: {
            reportPath: "C:\\logs\\quality_reports\\gui_quality_report.json",
          },
        };
      }),
    };

    const resolvedConfig = {
      api: { baseUrl: "http://127.0.0.1:9999" },
      agent: {
        baseUrl: "http://127.0.0.1:32768",
        model: "openai/gpt-5",
        agentName: "quality-optimizer",
      },
      llm: {
        defaultModel: "gemma-test",
        defaultProvider: "openai-compatible",
      },
      workflow: { qualityCheck: { enabled: true } },
    };

    const jobManager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig,
    });

    api = createApiServer({
      jobManager,
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createRes = await fetch(`${baseUrl}/jobs/translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "quick",
        targetLanguage: "zh-TW",
        mangaId: "gui_series",
      }),
    });
    const created = await createRes.json();

    await new Promise((resolve) => setTimeout(resolve, 30));

    const jobsRes = await fetch(`${baseUrl}/jobs`);
    expect(jobsRes.status).toBe(200);
    const jobsPayload = await jobsRes.json();
    expect(Array.isArray(jobsPayload.jobs)).toBe(true);
    expect(jobsPayload.jobs[0].id).toBe(created.id);

    const eventsRes = await fetch(`${baseUrl}/jobs/${created.id}/events`);
    expect(eventsRes.status).toBe(200);
    const eventsPayload = await eventsRes.json();
    expect(eventsPayload.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["job.created", "pipeline.completed", "job.completed"])
    );

    const artifactsRes = await fetch(`${baseUrl}/jobs/${created.id}/artifacts`);
    expect(artifactsRes.status).toBe(200);
    const artifactsPayload = await artifactsRes.json();
    expect(artifactsPayload.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        "export",
        "quality_validation_report",
        "workspace_import_manifest",
        "workspace_export_manifest",
      ])
    );
    const workspaceImportManifest = artifactsPayload.artifacts.find(
      (artifact) => artifact.kind === "workspace_import_manifest"
    );
    expect(workspaceImportManifest.metadata.stage).toBe("quality_review");

    const runtimeRes = await fetch(`${baseUrl}/runtime/status`);
    expect(runtimeRes.status).toBe(200);
    const runtimePayload = await runtimeRes.json();
    expect(runtimePayload.backend.status).toBe("ready");
    expect(runtimePayload.koharu.baseUrl).toBe("http://127.0.0.1:9999");
    expect(runtimePayload.agent.baseUrl).toBe("http://127.0.0.1:32768");
    expect(runtimePayload.agent.agentName).toBe("quality-optimizer");
    expect(runtimePayload.translation.defaultModel).toBe("gemma-test");

    fs.rmSync(path.join(paths.workspaceRoot, created.id), { recursive: true, force: true });
  });

  test("DELETE /jobs/:id moves terminal jobs to trash and restore endpoints recover them", async () => {
    const store = new JobStore(createTempDbPath());
    const engine = {
      runTranslationJob: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          projectName: "translate_delete",
          operationId: "op-delete",
          artifact: { path: "C:\\translated\\delete.zip", size: 10 },
        };
      }),
    };

    const jobManager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });

    api = createApiServer({
      jobManager,
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createJob = async (mangaId) => {
      const response = await fetch(`${baseUrl}/jobs/translation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ translationMode: "quick", mangaId }),
      });
      return response.json();
    };

    const first = await createJob("delete_one");
    const second = await createJob("delete_two");
    const third = await createJob("delete_three");

    await waitForJobTerminal(baseUrl, first.id);
    await waitForJobTerminal(baseUrl, second.id);
    await waitForJobTerminal(baseUrl, third.id);

    const deleteSingleRes = await fetch(`${baseUrl}/jobs/${first.id}`, {
      method: "DELETE",
    });
    expect(deleteSingleRes.status).toBe(200);
    const deleteSinglePayload = await deleteSingleRes.json();
    expect(deleteSinglePayload.deleted.id).toBe(first.id);

    const firstLookup = await fetch(`${baseUrl}/jobs/${first.id}`);
    expect(firstLookup.status).toBe(200);
    const firstLookupPayload = await firstLookup.json();
    expect(typeof firstLookupPayload.deletedAt).toBe("string");

    const visibleJobsAfterSingleDeleteRes = await fetch(`${baseUrl}/jobs`);
    const visibleJobsAfterSingleDelete = await visibleJobsAfterSingleDeleteRes.json();
    expect(visibleJobsAfterSingleDelete.jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining([second.id, third.id])
    );
    expect(visibleJobsAfterSingleDelete.jobs.map((job) => job.id)).not.toContain(first.id);

    const allJobsAfterSingleDeleteRes = await fetch(`${baseUrl}/jobs?includeDeleted=1`);
    const allJobsAfterSingleDelete = await allJobsAfterSingleDeleteRes.json();
    const trashedFirst = allJobsAfterSingleDelete.jobs.find((job) => job.id === first.id);
    expect(typeof trashedFirst.deletedAt).toBe("string");

    const restoreSingleRes = await fetch(`${baseUrl}/jobs/${first.id}/restore`, {
      method: "POST",
    });
    expect(restoreSingleRes.status).toBe(200);
    const restoreSinglePayload = await restoreSingleRes.json();
    expect(restoreSinglePayload.restored.id).toBe(first.id);

    const batchDeleteRes = await fetch(`${baseUrl}/jobs/delete-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: [second.id, third.id, "missing-job"] }),
    });
    expect(batchDeleteRes.status).toBe(200);
    const batchDeletePayload = await batchDeleteRes.json();
    expect(batchDeletePayload.deleted.map((entry) => entry.id)).toEqual([second.id, third.id]);
    expect(batchDeletePayload.missing).toEqual(["missing-job"]);

    const jobsRes = await fetch(`${baseUrl}/jobs`);
    const jobsPayload = await jobsRes.json();
    expect(jobsPayload.jobs).toHaveLength(1);
    expect(jobsPayload.jobs[0].id).toBe(first.id);

    const restoreBatchRes = await fetch(`${baseUrl}/jobs/restore-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: [second.id, third.id] }),
    });
    expect(restoreBatchRes.status).toBe(200);
    const restoreBatchPayload = await restoreBatchRes.json();
    expect(restoreBatchPayload.restored.map((entry) => entry.id)).toEqual([second.id, third.id]);

    const finalJobsRes = await fetch(`${baseUrl}/jobs`);
    const finalJobsPayload = await finalJobsRes.json();
    expect(finalJobsPayload.jobs).toHaveLength(3);

    const purgeSingleRes = await fetch(`${baseUrl}/jobs/${third.id}`, {
      method: "DELETE",
    });
    expect(purgeSingleRes.status).toBe(200);

    const purgeRestoreRes = await fetch(`${baseUrl}/jobs/${third.id}/permanent`, {
      method: "DELETE",
    });
    expect(purgeRestoreRes.status).toBe(200);
    const purgeRestorePayload = await purgeRestoreRes.json();
    expect(purgeRestorePayload.purged.id).toBe(third.id);

    const lookupPurgedRes = await fetch(`${baseUrl}/jobs/${third.id}`);
    expect(lookupPurgedRes.status).toBe(404);

    const secondTrashRes = await fetch(`${baseUrl}/jobs/${second.id}`, {
      method: "DELETE",
    });
    expect(secondTrashRes.status).toBe(200);
    const purgeBatchRes = await fetch(`${baseUrl}/jobs/purge-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: [second.id, "missing-job"] }),
    });
    expect(purgeBatchRes.status).toBe(200);
    const purgeBatchPayload = await purgeBatchRes.json();
    expect(purgeBatchPayload.purged.map((entry) => entry.id)).toEqual([second.id]);
    expect(purgeBatchPayload.missing).toEqual(["missing-job"]);
  });

  test("POST /jobs/reference-extraction creates a reference extraction job", async () => {
    const store = new JobStore(createTempDbPath());
    const engine = {
      runReferenceExtractionJob: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          referenceSetId: "ref_001",
          projectName: "reference_ref_001_20260521",
          operationId: "op-ref",
          scenePath: "C:\\references\\extracted\\ref_001\\scene.json",
          textsPath: "C:\\references\\extracted\\ref_001\\texts.json",
          closed: true,
        };
      }),
      runTranslationJob: jest.fn(),
    };

    const jobManager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });

    api = createApiServer({
      jobManager,
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createRes = await fetch(`${baseUrl}/jobs/reference-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referenceSetId: "ref_001" }),
    });
    expect(createRes.status).toBe(202);

    const created = await createRes.json();
    expect(created.type).toBe("reference_extraction");
    expect(created.status).toBe("queued");

    await new Promise((resolve) => setTimeout(resolve, 30));

    const getRes = await fetch(`${baseUrl}/jobs/${created.id}`);
    expect(getRes.status).toBe(200);
    const stored = await getRes.json();
    expect(stored.status).toBe("succeeded");
    expect(stored.result.referenceSetId).toBe("ref_001");
    expect(stored.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["reference_scene", "reference_texts"])
    );
  });

  test("POST /jobs/reference-ingestion creates an ingestion job and knowledge asset endpoints expose results", async () => {
    const referenceSetId = `ref_api_ingestion_${Date.now()}`;
    const manifestPath = path.join(paths.referenceManifests, `${referenceSetId}.json`);
    fs.mkdirSync(paths.referenceManifests, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
      id: referenceSetId,
      label: "API original",
      source: "test",
      language: "ja-JP",
      referenceKind: "source",
      pageCount: 1,
      imageDir: `references/other_images/${referenceSetId}`,
      extractedDir: `references/extracted/${referenceSetId}`,
      enabled: true,
    }));
    const extractionPaths = referenceSetPaths(referenceSetId);
    fs.mkdirSync(extractionPaths.extractedDir, { recursive: true });
    fs.writeFileSync(extractionPaths.reviewMetadataPath, JSON.stringify({
      schemaVersion: 1,
      referenceSetId,
      status: "reviewed",
      currentFingerprint: "api-test-fingerprint",
      reviewRevision: 1,
      reviewedAt: new Date().toISOString(),
    }));
    const store = new JobStore(createTempDbPath());
    const ingestionResult = {
      referenceSetId: "ref_001",
      mangaId: "phantom_fantasy",
      chapterId: "ch_001",
      glossaryPath: "C:\\knowledge_base\\self\\phantom_fantasy\\canonical_glossary.json",
      storyContextPath: "C:\\knowledge_base\\self\\phantom_fantasy\\story_context.json",
      styleProfilePath: "C:\\knowledge_base\\self\\phantom_fantasy\\style_profile.json",
      translationContextPath: "C:\\knowledge_base\\self\\phantom_fantasy\\translation_context.json",
    };
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { phase: "analysis", ...ingestionResult };
      }),
      runReferenceIngestionPrepareJob: jest.fn().mockResolvedValue({ phase: "prepare" }),
      runReferenceIngestionStoryJob: jest.fn().mockResolvedValue({ phase: "story" }),
      runReferenceIngestionCommitJob: jest.fn().mockResolvedValue({ phase: "commit", ...ingestionResult }),
      runReferenceIngestionJob: jest.fn().mockResolvedValue(ingestionResult),
      runReferenceExtractionJob: jest.fn(),
      runTranslationJob: jest.fn(),
    };

    api = createApiServer({
      jobManager: new JobManager({
        store,
        engine,
        runtimeConfig: { host: "127.0.0.1", port: 0 },
        resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
      }),
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createRes = await fetch(`${baseUrl}/jobs/reference-ingestion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        referenceSetId,
        mangaId: "phantom_fantasy",
        chapterId: "ch_001",
      }),
    });

    expect(createRes.status).toBe(202);
    const created = await createRes.json();
    expect(created.type).toBe("reference_ingestion");

    await new Promise((resolve) => setTimeout(resolve, 30));

    const getRes = await fetch(`${baseUrl}/jobs/${created.id}`);
    const stored = await getRes.json();
    expect(stored.status).toBe("succeeded");
    expect(stored.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["glossary", "story_context", "style_profile", "translation_context"])
    );
    fs.rmSync(manifestPath, { force: true });
    fs.rmSync(extractionPaths.extractedDir, { recursive: true, force: true });
  });

  test("POST /jobs/reference-ingestion rejects requests without chapterId", async () => {
    const store = new JobStore(createTempDbPath());
    const engine = {
      runReferenceIngestionJob: jest.fn(),
      runReferenceExtractionJob: jest.fn(),
      runTranslationJob: jest.fn(),
    };

    api = createApiServer({
      jobManager: new JobManager({
        store,
        engine,
        runtimeConfig: { host: "127.0.0.1", port: 0 },
        resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
      }),
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const createRes = await fetch(`${baseUrl}/jobs/reference-ingestion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        referenceSetId: "ref_001",
        mangaId: "phantom_fantasy",
      }),
    });

    expect(createRes.status).toBe(400);
    const payload = await createRes.json();
    expect(payload.error).toBe("chapterId is required for reference ingestion jobs.");
    expect(engine.runReferenceIngestionJob).not.toHaveBeenCalled();
  });

  test("GET /knowledge/:mangaId endpoints expose stored assets and honor translatorId", async () => {
    const mangaId = "test_api_series";
    const seriesDir = path.join(PROJECT_ROOT, "knowledge_base", "self", mangaId);
    const translatorDir = path.join(seriesDir, "translator_alpha");
    fs.mkdirSync(seriesDir, { recursive: true });
    fs.mkdirSync(translatorDir, { recursive: true });
    fs.writeFileSync(
      path.join(seriesDir, "canonical_glossary.json"),
      JSON.stringify({ entries: [{ canonical_translation: "魔力回路" }] })
    );
    fs.writeFileSync(
      path.join(seriesDir, "story_context.json"),
      JSON.stringify({ chapters: { ch_001: { keyLines: ["艾莉絲登場"] } } })
    );
    fs.writeFileSync(
      path.join(seriesDir, "style_profile.json"),
      JSON.stringify({ rules: { register: "formal" } })
    );
    fs.writeFileSync(
      path.join(translatorDir, "canonical_glossary.json"),
      JSON.stringify({ entries: [{ canonical_translation: "譯者版詞彙" }] })
    );
    fs.writeFileSync(
      path.join(translatorDir, "story_context.json"),
      JSON.stringify({ chapters: { ch_001: { keyLines: ["譯者版上下文"] } } })
    );
    fs.writeFileSync(
      path.join(translatorDir, "style_profile.json"),
      JSON.stringify({ rules: { register: "casual" } })
    );

    const store = new JobStore(createTempDbPath());
    const engine = {
      runTranslationJob: jest.fn(),
      runReferenceExtractionJob: jest.fn(),
      runReferenceIngestionJob: jest.fn(),
    };

    const jobManager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });

    api = createApiServer({
      jobManager,
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const glossary = await (await fetch(`${baseUrl}/knowledge/${mangaId}/glossary`)).json();
    const style = await (await fetch(`${baseUrl}/knowledge/${mangaId}/style-profile`)).json();
    const story = await (await fetch(`${baseUrl}/knowledge/${mangaId}/story-context`)).json();
    const scopedGlossary = await (
      await fetch(`${baseUrl}/knowledge/${mangaId}/glossary?translatorId=translator_alpha`)
    ).json();
    const scopedStyle = await (
      await fetch(`${baseUrl}/knowledge/${mangaId}/style-profile?translatorId=translator_alpha`)
    ).json();
    const scopedStory = await (
      await fetch(`${baseUrl}/knowledge/${mangaId}/story-context?translatorId=translator_alpha`)
    ).json();

    expect(glossary.entries[0].canonical_translation).toBe("魔力回路");
    expect(style.rules.register).toBe("formal");
    expect(story.chapters.ch_001.keyLines[0]).toBe("艾莉絲登場");
    expect(scopedGlossary.entries[0].canonical_translation).toBe("譯者版詞彙");
    expect(scopedStyle.rules.register).toBe("casual");
    expect(scopedStory.chapters.ch_001.keyLines[0]).toBe("譯者版上下文");

    fs.rmSync(seriesDir, { recursive: true, force: true });
  });

  test("DELETE /manga cascades bound reference, extraction, ingestion scope, and jobs", async () => {
    const suffix = Date.now().toString(36);
    const manga = createMangaRecord({ label: `Cascade Test ${suffix}`, language: "ja-JP" });
    const translator = createTranslatorProfile({
      mangaId: manga.mangaId,
      label: `Translator ${suffix}`,
      language: "zh-TW",
    });
    const chapter = createChapterRecord({
      mangaId: manga.mangaId,
      translatorId: translator.translatorId,
      chapterTitle: "Chapter 1",
    });
    const referenceSetId = `ref_cascade_${suffix}`;
    const referencePaths = referenceSetPaths(referenceSetId);
    fs.mkdirSync(referencePaths.imagesDir, { recursive: true });
    fs.mkdirSync(referencePaths.extractedDir, { recursive: true });
    fs.mkdirSync(path.dirname(referencePaths.manifestPath), { recursive: true });
    fs.writeFileSync(referencePaths.manifestPath, JSON.stringify({
      id: referenceSetId,
      label: "Chapter 1",
      source: "test",
      referenceKind: "translator",
      language: "zh-TW",
      pageCount: 1,
      imageDir: referencePaths.imagesDir,
      extractedDir: referencePaths.extractedDir,
      enabled: true,
      mangaId: manga.mangaId,
      mangaLabel: manga.label,
      translatorId: translator.translatorId,
      translatorLabel: translator.label,
      chapterId: chapter.chapterId,
      chapterTitle: chapter.chapterTitle,
    }));
    fs.writeFileSync(referencePaths.textsPath, JSON.stringify({ pages: [] }));

    const store = new JobStore(createTempDbPath());
    store.createJob({
      id: `extraction-${suffix}`,
      type: "reference_extraction",
      status: "succeeded",
      stage: "succeeded",
      payload: { referenceSetId, mangaId: manga.mangaId, translatorId: translator.translatorId },
    });
    const jobManager = new JobManager({
      store,
      engine: { runReferenceExtractionJob: jest.fn() },
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });
    api = createApiServer({ jobManager, host: "127.0.0.1", port: 0 });
    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/manga/${manga.mangaId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.deletedReferences).toHaveLength(1);
    expect(result.deletedJobs).toHaveLength(1);
    expect(fs.existsSync(referencePaths.manifestPath)).toBe(false);
    expect(fs.existsSync(referencePaths.extractedDir)).toBe(false);
    expect(loadKnowledgeIndex().series.some((entry) => entry.mangaId === manga.mangaId)).toBe(false);
    expect(jobManager.getJob(`extraction-${suffix}`)).toBeNull();
  });

  test("expired trashed jobs are auto-cleaned before listing", async () => {
    const store = new JobStore(createTempDbPath());
    store.createJob({
      id: "expired-trash-job",
      type: "translation",
      status: "succeeded",
      stage: "succeeded",
      payload: { mangaId: "cleanup_series" },
    });
    store.softDeleteJob("expired-trash-job");
    store.db
      .prepare(`UPDATE jobs SET deleted_at = ?, updated_at = ? WHERE id = ?`)
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "expired-trash-job");

    const jobManager = new JobManager({
      store,
      engine: { runTranslationJob: jest.fn() },
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: {
        defaults: { trashRetentionDays: 30 },
        workflow: { qualityCheck: { enabled: true } },
      },
    });

    api = createApiServer({
      jobManager,
      host: "127.0.0.1",
      port: 0,
    });

    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const jobsRes = await fetch(`${baseUrl}/jobs?includeDeleted=1`);
    expect(jobsRes.status).toBe(200);
    const jobsPayload = await jobsRes.json();
    expect(jobsPayload.jobs.find((job) => job.id === "expired-trash-job")).toBeUndefined();

    const lookupRes = await fetch(`${baseUrl}/jobs/expired-trash-job`);
    expect(lookupRes.status).toBe(404);
  });
});
