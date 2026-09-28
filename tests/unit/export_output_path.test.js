const path = require("path");
const { paths } = require("../../backend/src/config");
const {
  resolveExportOutputDir,
  safePathSegment,
} = require("../../backend/src/domains/translation/execution/export_output_path");

describe("backend-owned export output paths", () => {
  test("generates a job-specific path below paths.translated", () => {
    const outputDir = resolveExportOutputDir({
      mangaId: "manga_one",
      translatorId: "translator_a",
      chapterId: "chapter_001",
      jobId: "job-123",
    });

    expect(outputDir).toBe(path.join(
      paths.translated,
      "manga_one",
      "translator_a",
      "chapter_001",
      "translation-job-123"
    ));
    expect(path.relative(paths.translated, outputDir)).not.toMatch(/^\.\./);
  });

  test("sanitizes identifiers instead of allowing path traversal", () => {
    const segment = safePathSegment("../../unsafe manga", "fallback");
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("\\");
    expect(segment).not.toBe("..");
  });

  test("keeps the trusted desktop output override", () => {
    expect(resolveExportOutputDir({ outputDir: " C:\\Exports\\Chapter " })).toBe("C:\\Exports\\Chapter");
  });

  test("uses a separate job-specific post-edit directory", () => {
    expect(resolveExportOutputDir({
      mangaId: "manga_one",
      translatorId: "translator_a",
      chapterId: "chapter_001",
      jobId: "post-edit-job",
      variant: "post-edit",
    })).toBe(path.join(
      paths.translated,
      "manga_one",
      "translator_a",
      "chapter_001",
      "post-edit-post-edit-job"
    ));
  });
});
