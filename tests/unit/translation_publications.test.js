const fs = require("fs");
const os = require("os");
const path = require("path");
const { TranslationPublicationService } = require("../../backend/src/modules/translation_publications");

describe("TranslationPublicationService", () => {
  let root;
  let service;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "translation-publications-"));
    service = new TranslationPublicationService({ resolveBaseDir: () => root });
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
      learningEvidenceSnapshotPath: "learning.json",
    });
    service.updateKnowledgeStatus({
      mangaId: "manga_a",
      translatorId: "translator_a",
      chapterId: "chapter_4",
      revisionId: revision.revisionId,
      status: "committed",
      knowledgeJobId: "knowledge_1",
    });

    const chapter = service.getChapter("manga_a", "translator_a", "chapter_4");
    expect(chapter.activeRevisionId).toBe(revision.revisionId);
    expect(chapter.revisions[0]).toMatchObject({
      knowledgeStatus: "committed",
      knowledgeJobId: "knowledge_1",
    });
  });
});
