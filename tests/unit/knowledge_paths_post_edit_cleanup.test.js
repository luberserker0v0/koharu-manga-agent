const fs = require("fs");
const os = require("os");
const path = require("path");

function buildTempConfig(rootDir) {
  return {
    PROJECT_ROOT: rootDir,
    paths: {
      knowledgeBase: path.join(rootDir, "knowledge_base", "self", "my-manga.json"),
      reports: path.join(rootDir, "knowledge_base", "reports", "extract_report.json"),
      postEditDocuments: path.join(rootDir, "post_edit"),
    },
  };
}

describe("knowledge path post-edit cleanup", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("deleting a translator profile also removes matching post-edit documents", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-paths-cleanup-"));
    const deleteByBinding = jest.fn().mockReturnValue([{ jobId: "job-001" }]);

    jest.doMock("../../backend/src/config", () => buildTempConfig(rootDir));
    jest.doMock("../../backend/src/modules/post_edit_workspace", () => ({
      PostEditWorkspaceModule: jest.fn().mockImplementation(() => ({
        deleteByBinding,
      })),
    }));

    const {
      syncMangaManagementBinding,
      deleteTranslatorProfile,
    } = require("../../backend/src/modules/knowledge_paths");

    syncMangaManagementBinding({
      mangaId: "phantom_fantasy",
      label: "Phantom Fantasy",
      translatorId: "translator_ai",
      translatorLabel: "AI",
      chapterId: "chapter_001",
      chapterTitle: "1",
    });

    const deleted = deleteTranslatorProfile({
      mangaId: "phantom_fantasy",
      translatorId: "translator_ai",
    });

    expect(deleteByBinding).toHaveBeenCalledWith({
      mangaId: "phantom_fantasy",
      translatorId: "translator_ai",
    });
    expect(deleted.deletedPostEditDocuments).toEqual([{ jobId: "job-001" }]);
  });

  test("deleting a manga also removes all matching post-edit documents", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-paths-cleanup-"));
    const deleteByBinding = jest.fn().mockReturnValue([{ jobId: "job-002" }]);

    jest.doMock("../../backend/src/config", () => buildTempConfig(rootDir));
    jest.doMock("../../backend/src/modules/post_edit_workspace", () => ({
      PostEditWorkspaceModule: jest.fn().mockImplementation(() => ({
        deleteByBinding,
      })),
    }));

    const {
      syncMangaManagementBinding,
      deleteMangaRecord,
    } = require("../../backend/src/modules/knowledge_paths");

    syncMangaManagementBinding({
      mangaId: "phantom_fantasy",
      label: "Phantom Fantasy",
      translatorId: "translator_ai",
      translatorLabel: "AI",
      chapterId: "chapter_001",
      chapterTitle: "1",
    });

    const deleted = deleteMangaRecord({
      mangaId: "phantom_fantasy",
    });

    expect(deleteByBinding).toHaveBeenCalledWith({
      mangaId: "phantom_fantasy",
    });
    expect(deleted.deletedPostEditDocuments).toEqual([{ jobId: "job-002" }]);
  });
});
