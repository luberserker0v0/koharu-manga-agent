const fs = require("fs");
const os = require("os");
const path = require("path");
const { JobManager } = require("../../backend/src/domains/jobs/job_manager");
const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");

function createManager(pageRevisionService, translationRevisionPromotionService = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-completion-"));
  const store = new JobStore(path.join(directory, "jobs.sqlite"));
  const engine = { runTranslationJob: jest.fn().mockResolvedValue({ closed: true }) };
  return new JobManager({
    store,
    engine,
    pageRevisionService,
    translationRevisionPromotionService,
    runtimeConfig: { host: "127.0.0.1", port: 0 },
    resolvedConfig: {},
  });
}

describe("job completion validation", () => {
  test("fails translation when exported image mapping is incomplete", async () => {
    const error = Object.assign(new Error("Translated output count 1 does not match selected source count 2."), {
      code: "translated_image_mapping_mismatch",
    });
    const manager = createManager({ synchronizeJob: jest.fn().mockRejectedValue(error) });
    const created = manager.createJob("translation", {});

    await new Promise((resolve) => setTimeout(resolve, 30));

    const stored = manager.getJob(created.id);
    expect(stored.status).toBe("failed");
    expect(stored.error).toContain("Translated output count 1");
  });

  test("promotes a successful revision before marking it succeeded", async () => {
    const pageRevisionService = { synchronizeJob: jest.fn().mockResolvedValue([]) };
    const promotion = { promote: jest.fn().mockImplementation((jobId, result) => Promise.resolve({
      ...result,
      publication: { revisionId: `publication-${jobId}` },
      currentChapter: { rootJobId: "root-job", pageCount: 2, promotedSourceImageIds: ["source-2"],
        exportArtifact: { path: "current.zip" } },
    })) };
    const manager = createManager(pageRevisionService, promotion);
    const created = manager.createJob("translation", {
      revision: { rootJobId: "root-job", reason: "text_region_correction" },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(promotion.promote).toHaveBeenCalledWith(created.id, { closed: true });
    expect(manager.getJob(created.id)).toEqual(expect.objectContaining({
      status: "succeeded",
      result: expect.objectContaining({ publication: { revisionId: `publication-${created.id}` } }),
    }));
  });
});
