jest.mock("../../backend/src/domains/reference/review/reference_extraction_review", () => ({
  ensureLegacyReviewMetadata: () => ({ status: "awaiting_review" }),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { JobManager } = require("../../backend/src/domains/jobs/job_manager");
const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");

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
