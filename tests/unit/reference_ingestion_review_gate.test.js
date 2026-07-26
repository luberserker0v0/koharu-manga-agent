jest.mock("../../backend/src/modules/reference_extraction_review", () => ({
  ensureLegacyReviewMetadata: () => ({ status: "awaiting_review" }),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { JobManager } = require("../../backend/src/job_manager");
const { JobStore } = require("../../backend/src/storage/job_store");

test("schedules Ingestion without mandatory Extraction review", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-gate-"));
  const manager = new JobManager({
    store: new JobStore(path.join(root, "jobs.sqlite")),
    engine: {},
    runtimeConfig: {},
    resolvedConfig: { defaults: {} },
  });
  const job = manager.createReferenceIngestionJob({ referenceSetId: "unreviewed" });
  expect(job.type).toBe("reference_ingestion");
  expect(manager.listJobs().length).toBeGreaterThan(0);
});
