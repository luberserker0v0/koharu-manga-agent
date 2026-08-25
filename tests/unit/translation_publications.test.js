const fs = require("fs");
const os = require("os");
const path = require("path");
const { TranslationPublicationService } = require("../../backend/src/domains/translation/publications/translation_publications");

describe("TranslationPublicationService", () => {
  let root;
  let service;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "translation-publications-"));
    service = new TranslationPublicationService({ resolveBaseDir: () => root });
  });

  test("deleting a chapter removes all of its publication revisions", () => {
    service.publish({
      mangaId: "manga_1",
      translatorId: "translator_1",
      chapterId: "chapter_1",
      chapterTitle: "1",
      jobId: "job_1",
      finalTranslationSnapshotPath: path.join(root, "snapshot.json"),
      finalTranslationSnapshotFingerprint: "fingerprint_1",
      qualityStatus: "passed",
    });

    expect(service.deleteChapter("manga_1", "translator_1", "chapter_1")).toEqual(expect.objectContaining({
      deleted: true,
      chapterId: "chapter_1",
      revisionCount: 1,
    }));
    expect(service.getChapter("manga_1", "translator_1", "chapter_1")).toBeNull();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("keeps one active revision while retaining prior attempts", () => {
    const first = service.publish({
      mangaId: "manga_a",
      translatorId: "translator_a",
      chapterId: "chapter_4",
      jobId: "job_1",
      finalTranslationSnapshotPath: "first.json",
      finalTranslationSnapshotFingerprint: "first-fingerprint",
      qualityStatus: "passed",
    });
    const second = service.publish({
      mangaId: "manga_a",
      translatorId: "translator_a",
      chapterId: "chapter_4",
      jobId: "job_2",
      finalTranslationSnapshotPath: "second.json",
      finalTranslationSnapshotFingerprint: "second-fingerprint",
      qualityStatus: "passed",
    });

    const chapter = service.getChapter("manga_a", "translator_a", "chapter_4");
    expect(chapter.activeRevisionId).toBe(second.revisionId);
    expect(chapter.revisions).toHaveLength(2);
    expect(chapter.revisions.find((entry) => entry.revisionId === first.revisionId).status).toBe("superseded");
    expect(second.previousActiveJobId).toBe("job_1");
  });

  test("publishing the same job is idempotent", () => {
    const payload = {
      mangaId: "manga_a",
      translatorId: "translator_a",
      chapterId: "chapter_4",
      jobId: "job_1",
      finalTranslationSnapshotPath: "first.json",
      finalTranslationSnapshotFingerprint: "first-fingerprint",
      qualityStatus: "passed",
    };
    const first = service.publish(payload);
    const repeated = service.publish(payload);

    expect(repeated.revisionId).toBe(first.revisionId);
    expect(service.getChapter("manga_a", "translator_a", "chapter_4").revisions).toHaveLength(1);
  });

  test("tracks knowledge status without changing the active revision", () => {
    const revision = service.publish({
      mangaId: "manga_a",
      translatorId: "translator_a",
      chapterId: "chapter_4",
      jobId: "job_1",
      finalTranslationSnapshotPath: "first.json",
      finalTranslationSnapshotFingerprint: "first-fingerprint",
      qualityStatus: "passed",
      qualityOutcome: "partial",
      learningEvidenceSnapshotPath: "learning.json",
    });
    service.updateKnowledgeStatus({
      mangaId: "manga_a",
      translatorId: "translator_a",
      chapterId: "chapter_4",
      revisionId: revision.revisionId,
      status: "committed",
      knowledgeJobId: "knowledge_1",
      outcome: "warnings",
    });

    const chapter = service.getChapter("manga_a", "translator_a", "chapter_4");
    expect(chapter.activeRevisionId).toBe(revision.revisionId);
    expect(chapter.revisions[0]).toMatchObject({
      knowledgeStatus: "committed",
      knowledgeJobId: "knowledge_1",
      knowledgeOutcome: "warnings",
      qualityOutcome: "partial",
    });
  });

  test("rejects legacy registries without rewriting them", () => {
    const registryPath = service.getRegistryPath("manga_a", "translator_a");
    const legacy = JSON.stringify({ schemaVersion: 1, chapters: {} }, null, 2);
    fs.writeFileSync(registryPath, legacy, "utf8");

    expect(() => service.load("manga_a", "translator_a")).toThrow(/schemaVersion 2/);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(legacy);
  });

  test("rejects invalid revision states and knowledge status updates", () => {
    const revision = service.publish({
      mangaId: "manga_a",
      translatorId: "translator_a",
      chapterId: "chapter_4",
      jobId: "job_1",
      finalTranslationSnapshotPath: "first.json",
      finalTranslationSnapshotFingerprint: "first-fingerprint",
      qualityStatus: "passed",
    });
    const registryPath = service.getRegistryPath("manga_a", "translator_a");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    registry.chapters.chapter_4.revisions[0].qualityStatus = "pending_revalidation";
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");

    expect(() => service.load("manga_a", "translator_a")).toThrow(/unknown qualityStatus/);
    expect(() => service.updateKnowledgeStatus({
      mangaId: "manga_a",
      translatorId: "translator_a",
      chapterId: "chapter_4",
      revisionId: revision.revisionId,
      status: "invented",
    })).toThrow(/Unknown publication knowledge status/);
  });
});
