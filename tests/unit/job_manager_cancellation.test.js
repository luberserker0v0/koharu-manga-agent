const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../backend/src/modules/reference_extraction_review", () => ({
  ensureLegacyReviewMetadata: () => ({ status: "reviewed", currentFingerprint: "test-fingerprint" }),
}));

const { JobManager } = require("../../backend/src/job_manager");
const { JobStore } = require("../../backend/src/storage/job_store");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForStatus(manager, jobId, status) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = manager.getJob(jobId);
    if (job?.status === status) return job;
    await nextTurn();
  }
  throw new Error(`Job ${jobId} did not reach ${status}.`);
}

function createManager(engine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-cancel-"));
  const store = new JobStore(path.join(root, "jobs.sqlite"));
  const manager = new JobManager({
    store,
    engine,
    runtimeConfig: {},
    resolvedConfig: { defaults: {} },
  });
  return { manager, store };
}

describe("JobManager cancellation", () => {
  test("translation retry reuses completed Quality artifacts after a learning failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "translation-learning-retry-"));
    const memoryPath = path.join(root, "translation_memory.json");
    const reportPath = path.join(root, "quality_report.json");
    const projectionPath = path.join(root, "quality_projection.json");
    fs.writeFileSync(memoryPath, "{}");
    fs.writeFileSync(reportPath, "{}");
    fs.writeFileSync(projectionPath, "{}");
    let attempt = 0;
    const engine = {
      runTranslationJob: jest.fn(async (payload, hooks) => {
        attempt += 1;
        if (attempt === 1) {
          hooks.emit("setup.completed", { projectName: "translate_retry", operationId: "op_retry" });
          hooks.emit("translation_memory.built", { path: memoryPath });
          hooks.emit("pipeline.completed", { summary: { finalStatus: "completed" } });
          hooks.emit("quality.completed", {
            reportPath,
            projectionPath,
            checkpointPaths: ["checkpoint.json"],
          });
          throw new Error("Learning Evidence failed");
        }
        return { resume: payload.resumeFromTranslation };
      }),
    };
    const { manager } = createManager(engine);
    const failed = manager.createTranslationJob({
      translationMode: "quick",
      outputDir: root,
    });
    await waitForStatus(manager, failed.id, "failed");

    const retried = manager.retryJob(failed.id);
    const succeeded = await waitForStatus(manager, retried.id, "succeeded");

    expect(succeeded.result.resume).toEqual(expect.objectContaining({
      sourceJobId: failed.id,
      projectName: "translate_retry",
      resumeAtStage: "learning_evidence",
      qualityReportPath: reportPath,
      qualityProjectionPath: projectionPath,
    }));
  });

  test("cancels a queued job before the engine starts", async () => {
    const engine = { runReferenceIngestionJob: jest.fn() };
    const { manager } = createManager(engine);
    const job = manager.createReferenceIngestionJob({ referenceSetId: "ref-1" });

    const canceled = manager.cancelJob(job.id);
    await nextTurn();

    expect(canceled.status).toBe("canceled");
    expect(manager.getJob(job.id).stage).toBe("canceled");
    expect(engine.runReferenceIngestionJob).not.toHaveBeenCalled();
  });

  test("marks a running job cancel_requested and finishes it as canceled", async () => {
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async (_payload, hooks) => {
        notifyStarted();
        while (!hooks.isCanceled()) await nextTurn();
        throw new Error("stopped");
      }),
    };
    const { manager } = createManager(engine);
    const job = manager.createReferenceIngestionJob({ referenceSetId: "ref-2" });
    await started;

    expect(manager.cancelJob(job.id).status).toBe("cancel_requested");
    const canceled = await waitForStatus(manager, job.id, "canceled");
    expect(canceled.error).toBeNull();
  });

  test("deleting an active job requests cancellation and moves it to trash", async () => {
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const engine = {
      runReferenceIngestionAnalysisJob: jest.fn(async (_payload, hooks) => {
        notifyStarted();
        while (!hooks.isCanceled()) await nextTurn();
        throw new Error("stopped");
      }),
    };
    const { manager } = createManager(engine);
    const job = manager.createReferenceIngestionJob({ referenceSetId: "ref-3" });
    await started;

    const deleted = manager.deleteJob(job.id);
    expect(deleted.deletedAt).toBeTruthy();
    expect(deleted.status).toBe("cancel_requested");

    const canceled = await waitForStatus(manager, job.id, "canceled");
    expect(canceled.deletedAt).toBeTruthy();
  });

  test("holds queued Koharu jobs during an interactive review lease and resumes them", async () => {
    const engine = {
      runReferenceExtractionJob: jest.fn(async () => ({ referenceSetId: "ref-lease" })),
    };
    const { manager } = createManager(engine);
    manager.acquireKoharuReviewLease({ sessionId: "session-lease", referenceSetId: "ref-review" });
    const job = manager.createReferenceExtractionJob({ referenceSetId: "ref-lease" });
    await nextTurn();

    expect(manager.getJob(job.id)).toEqual(expect.objectContaining({
      status: "waiting_dependency",
      stage: "waiting_koharu_review",
    }));
    expect(engine.runReferenceExtractionJob).not.toHaveBeenCalled();

    manager.releaseKoharuReviewLease("session-lease");
    await waitForStatus(manager, job.id, "succeeded");
    expect(engine.runReferenceExtractionJob).toHaveBeenCalledTimes(1);
  });

  test("rejects a review lease while a Koharu job is active", async () => {
    let notifyStarted;
    let finishExtraction;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const finishing = new Promise((resolve) => { finishExtraction = resolve; });
    const engine = {
      runReferenceExtractionJob: jest.fn(async () => {
        notifyStarted();
        await finishing;
        return { referenceSetId: "ref-running" };
      }),
    };
    const { manager } = createManager(engine);
    const job = manager.createReferenceExtractionJob({ referenceSetId: "ref-running" });
    await started;

    expect(() => manager.acquireKoharuReviewLease({
      sessionId: "session-blocked",
      referenceSetId: "ref-review",
    })).toThrow(/still running/);
    finishExtraction();
    await waitForStatus(manager, job.id, "succeeded");
  });

  test("recovers interrupted persisted jobs as canceled after restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-recover-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    store.createJob({
      id: "stale-running",
      type: "reference_ingestion",
      status: "running",
      stage: "reference_ingestion.story",
      payload: {},
    });

    const manager = new JobManager({
      store,
      engine: {},
      runtimeConfig: {},
      resolvedConfig: { defaults: {} },
    });

    expect(manager.getJob("stale-running").status).toBe("canceled");
  });

  test("cancels queued children of an interrupted workflow instead of resuming them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-workflow-recover-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    store.createJob({
      id: "interrupted-workflow",
      type: "reference_ingestion",
      status: "running",
      stage: "waiting_children",
      payload: {},
      executionKind: "workflow",
    });
    store.createJob({
      id: "queued-child",
      type: "reference_story_update",
      status: "queued",
      stage: "queued",
      payload: {},
      parentJobId: "interrupted-workflow",
      workflowId: "interrupted-workflow",
    });
    const engine = {
      runReferenceIngestionStoryJob: jest.fn(async () => ({ phase: "story" })),
    };

    new JobManager({
      store,
      engine,
      runtimeConfig: {},
      resolvedConfig: { defaults: {} },
    });

    expect(store.getJob("interrupted-workflow").status).toBe("canceled");
    expect(store.getJob("queued-child").status).toBe("canceled");
    expect(engine.runReferenceIngestionStoryJob).not.toHaveBeenCalled();
  });
});
