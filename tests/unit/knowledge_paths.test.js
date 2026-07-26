const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createMangaRecord,
  createTranslatorProfile,
  isValidMangaId,
  knowledgeIndexPath,
  loadKnowledgeIndex,
  reconcileReferenceBindings,
  resolveKnowledgePaths,
  syncMangaManagementBinding,
  upsertKnowledgeIndexEntry,
} = require("../../backend/src/modules/knowledge_paths");

describe("knowledge path helpers", () => {
  let originalIndex = null;

  beforeEach(() => {
    const indexPath = knowledgeIndexPath();
    originalIndex = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, "utf-8")
      : null;
  });

  afterEach(() => {
    const indexPath = knowledgeIndexPath();
    if (originalIndex === null) {
      if (fs.existsSync(indexPath)) {
        fs.unlinkSync(indexPath);
      }
      return;
    }
    fs.writeFileSync(indexPath, originalIndex);
  });

  test("validates mangaId format", () => {
    expect(isValidMangaId("phantom_fantasy")).toBe(true);
    expect(isValidMangaId("phantom-fantasy")).toBe(false);
    expect(isValidMangaId("幻影")).toBe(false);
  });

  test("resolves scoped knowledge paths from mangaId", () => {
    const resolved = resolveKnowledgePaths({ mangaId: "phantom_fantasy" });

    expect(resolved.mangaId).toBe("phantom_fantasy");
    expect(resolved.mode).toBe("scoped");
    expect(resolved.knowledgeBasePath.replace(/\\/g, "/")).toContain(
      "knowledge_base/self/phantom_fantasy/knowledge.json"
    );
    expect(resolved.reportPath.replace(/\\/g, "/")).toContain(
      "knowledge_base/reports/phantom_fantasy/extract_report.json"
    );
  });

  test("upserts index entries for manga-scoped knowledge bases", () => {
    const scoped = resolveKnowledgePaths({ mangaId: "phantom_fantasy" });
    const entry = upsertKnowledgeIndexEntry({
      mangaId: "phantom_fantasy",
      label: "Phantom Fantasy",
      knowledgeBasePath: scoped.knowledgeBasePath,
      reportPath: scoped.reportPath,
    });

    const index = loadKnowledgeIndex();
    const matched = index.series.find((series) => series.mangaId === "phantom_fantasy");
    const translator = matched?.translators?.find(
      (candidate) => candidate.translatorId === "translator_default"
    );

    expect(entry.label).toBe("Phantom Fantasy");
    expect(matched).toBeDefined();
    expect(translator).toBeDefined();
    expect(translator.knowledgePath).toBe(
      "knowledge_base/self/phantom_fantasy/knowledge.json"
    );
    expect(translator.reportPath).toBe(
      "knowledge_base/reports/phantom_fantasy/extract_report.json"
    );
    expect(fs.existsSync(knowledgeIndexPath())).toBe(true);
  });

  test("does not replace a human manga label with its generated id", () => {
    const manga = createMangaRecord({ label: "Stable Human Label" });
    reconcileReferenceBindings([{
      mangaId: manga.mangaId,
      mangaLabel: manga.mangaId,
      translatorId: "translator_original",
      translatorLabel: "Original",
      chapterId: "chapter_1",
      chapterTitle: "1",
      language: "ja-JP",
    }]);
    const stored = loadKnowledgeIndex().series.find((entry) => entry.mangaId === manga.mangaId);
    expect(stored.label).toBe("Stable Human Label");
  });

  test("persists a learning clone and its Reference translator lineage", () => {
    const manga = createMangaRecord({ label: "Clone Lineage Manga" });
    const source = createTranslatorProfile({
      mangaId: manga.mangaId,
      label: "Reference Team",
      language: "zh-TW",
    });
    const clone = createTranslatorProfile({
      mangaId: manga.mangaId,
      label: "Reference Team Learning Clone",
      language: "zh-TW",
      styleSourceTranslatorId: source.translatorId,
    });

    expect(clone.profileKind).toBe("learning_clone");
    expect(clone.styleSourceTranslatorId).toBe(source.translatorId);
    const stored = loadKnowledgeIndex().series
      .find((entry) => entry.mangaId === manga.mangaId)
      .translators.find((entry) => entry.translatorId === clone.translatorId);
    expect(stored).toEqual(expect.objectContaining({
      profileKind: "learning_clone",
      styleSourceTranslatorId: source.translatorId,
    }));
  });

  test("translation binding creates a missing output profile as a learning clone", () => {
    const manga = createMangaRecord({ label: "Translation Clone Binding" });
    const source = createTranslatorProfile({
      mangaId: manga.mangaId,
      label: "Reference Translator",
      language: "zh-TW",
    });

    syncMangaManagementBinding({
      mangaId: manga.mangaId,
      translatorId: "translator_translation_clone",
      translatorLabel: "Translation Clone",
      language: "zh-TW",
      chapterId: "chapter_4",
      chapterTitle: "第4話",
      profileKind: "learning_clone",
      styleSourceTranslatorId: source.translatorId,
    });

    const stored = loadKnowledgeIndex().series
      .find((entry) => entry.mangaId === manga.mangaId)
      .translators.find((entry) => entry.translatorId === "translator_translation_clone");
    expect(stored).toEqual(expect.objectContaining({
      profileKind: "learning_clone",
      styleSourceTranslatorId: source.translatorId,
    }));
    expect(stored.chapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ chapterId: "chapter_4", chapterTitle: "第4話" }),
    ]));
  });

  test("rejects reusing a standard translator name for a learning clone", () => {
    const manga = createMangaRecord({ label: "Clone Collision Manga" });
    const source = createTranslatorProfile({
      mangaId: manga.mangaId,
      label: "Reference Source",
      language: "zh-TW",
    });
    createTranslatorProfile({
      mangaId: manga.mangaId,
      label: "Existing Output",
      language: "zh-TW",
    });

    expect(() => createTranslatorProfile({
      mangaId: manga.mangaId,
      label: "Existing Output",
      language: "zh-TW",
      styleSourceTranslatorId: source.translatorId,
    })).toThrow("is not the requested learning clone");
  });

  test("rebuilds missing translator and chapter registry from reference bindings", () => {
    const manga = createMangaRecord({ label: "Reference Registry Repair" });
    const series = reconcileReferenceBindings([{
      mangaId: manga.mangaId,
      mangaLabel: "Reference Registry Repair",
      translatorId: "translator_original",
      translatorLabel: "Original",
      chapterId: "chapter_1",
      chapterTitle: "Chapter 1",
      language: "ja-JP",
    }]);
    const repaired = series.find((entry) => entry.mangaId === manga.mangaId);
    expect(repaired.label).toBe("Reference Registry Repair");
    const translator = repaired.translators.find(
      (entry) => entry.translatorId === "translator_original"
    );
    expect(translator).toBeDefined();
    expect(translator.chapterCount).toBe(1);
    expect(translator.chapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ chapterId: "chapter_1", chapterTitle: "Chapter 1" }),
    ]));
  });

  test("listKnowledgeSeries recovers chapter registry from story context assets", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kb-recover-"));
    const originalCwd = process.cwd();
    process.chdir(tempRoot);

    jest.resetModules();
    jest.doMock("../../backend/src/config", () => ({
      PROJECT_ROOT: tempRoot,
      paths: {
        knowledgeBase: path.join(tempRoot, "knowledge_base", "self", "my-manga.json"),
        reports: path.join(tempRoot, "knowledge_base", "reports", "extract_report.json"),
        referenceImages: path.join(tempRoot, "references", "other_images"),
        referenceExtracted: path.join(tempRoot, "references", "extracted"),
        legacyReferenceDiagnostics: path.join(tempRoot, "references", "comparisons"),
        referenceComparisons: path.join(tempRoot, "references", "comparisons"),
        referenceManifests: path.join(tempRoot, "references", "manifests"),
        sourcePreflight: path.join(tempRoot, "cache", "source-preflight"),
        logs: path.join(tempRoot, "logs"),
        todoList: path.join(tempRoot, "TODO_LIST.md"),
        database: path.join(tempRoot, "cache", "process-agent.sqlite"),
        workspaceRoot: path.join(tempRoot, "cache", "workspaces"),
      },
    }));

    const {
      listKnowledgeSeries: recoveredListKnowledgeSeries,
      writeKnowledgeIndex,
    } = require("../../backend/src/modules/knowledge_paths");

    const manifestsDir = path.join(tempRoot, "references", "manifests");
    const translatorDir = path.join(
      tempRoot,
      "knowledge_base",
      "self",
      "manga_demo",
      "translator_source"
    );
    fs.mkdirSync(manifestsDir, { recursive: true });
    fs.mkdirSync(translatorDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestsDir, "ref_a.json"),
      JSON.stringify({ id: "ref_a", label: "第1話", enabled: true })
    );
    fs.writeFileSync(
      path.join(manifestsDir, "ref_b.json"),
      JSON.stringify({ id: "ref_b", label: "第2話", enabled: true })
    );
    fs.writeFileSync(
      path.join(translatorDir, "story_context.json"),
      JSON.stringify({
        metadata: {},
        global: {},
        chapters: {
          reference_ref_a: {
            chapterId: null,
            referenceSetIds: ["ref_a"],
            updatedAt: "2026-07-14T10:00:00.000Z",
          },
          reference_ref_b: {
            chapterId: null,
            referenceSetIds: ["ref_b"],
            updatedAt: "2026-07-14T10:05:00.000Z",
          },
        },
      })
    );
    writeKnowledgeIndex({
      series: [
        {
          mangaId: "manga_demo",
          label: "Demo",
          language: "ja-JP",
          translators: [
            {
              translatorId: "translator_source",
              label: "原文",
              language: "ja-JP",
              chapters: [],
            },
          ],
        },
      ],
    });

    const series = recoveredListKnowledgeSeries();
    const manga = series.find((entry) => entry.mangaId === "manga_demo");
    const translator = manga.translators.find((entry) => entry.translatorId === "translator_source");

    expect(translator.chapterCount).toBe(2);
    expect(translator.chapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chapterId: "chapter_ref_a",
          chapterTitle: "第1話",
        }),
        expect.objectContaining({
          chapterId: "chapter_ref_b",
          chapterTitle: "第2話",
        }),
      ])
    );

    process.chdir(originalCwd);
    jest.dontMock("../../backend/src/config");
  });
});
