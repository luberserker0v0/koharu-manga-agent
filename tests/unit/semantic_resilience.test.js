const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildAoFailureDiagnostics,
  classifyAoError,
  isRetryableAoError,
} = require("../../backend/src/integrations/ao/errors/ao_error_classifier");
const { summarizeJobOutcome } = require("../../backend/src/integrations/ao/contracts/semantic_result");
const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");

describe("semantic resilience infrastructure", () => {
  test("does not retry quota and retries transient service failures", () => {
    expect(classifyAoError(new Error("HTTP 429 quota exhausted"))).toBe("quota");
    expect(isRetryableAoError(new Error("HTTP 429 quota exhausted"))).toBe(false);
    expect(classifyAoError(new Error("HTTP 503 fetch failed"))).toBe("transient_network");
    expect(isRetryableAoError(new Error("HTTP 503 fetch failed"))).toBe(true);
  });

  test("marks resource failures resumable only when checkpoints exist", () => {
    expect(buildAoFailureDiagnostics(new Error("request timed out"), { checkpointPaths: ["checkpoint.json"] }))
      .toEqual(expect.objectContaining({ resourceFailureType: "timeout", resumeAvailable: true }));
    expect(buildAoFailureDiagnostics(new Error("request timed out"), { checkpointPaths: [] }).resumeAvailable).toBe(false);
    const noTokens = new Error("AO model produced no tokens or message parts for 60000ms.");
    noTokens.code = "AO_MODEL_NO_OUTPUT";
    expect(buildAoFailureDiagnostics(noTokens, {
      checkpointPaths: ["checkpoint.json"],
      failedWindowId: "quality_observation_002_a_b_a",
    })).toEqual(expect.objectContaining({
      resourceFailureType: "timeout",
      resumeAvailable: true,
      failedWindowId: "quality_observation_002_a_b_a",
    }));
  });

  test("identifies AO connectivity failures at the locale projection stage", () => {
    expect(buildAoFailureDiagnostics(new Error("fetch failed"), {
      stage: "reference_locale_projection",
    })).toEqual(expect.objectContaining({
      resourceFailureType: "transient_network",
      failureSource: "ao",
      failureStage: "reference_locale_projection",
      recommendedAction: "start_ao_and_retry",
    }));
  });

  test("distinguishes Koharu connectivity failures from AO failures", () => {
    expect(buildAoFailureDiagnostics(new Error("fetch failed"), {
      stage: "setup_project",
    })).toEqual(expect.objectContaining({
      resourceFailureType: "transient_network",
      failureSource: "koharu",
      recommendedAction: "restart_koharu_and_retry",
    }));
  });

  test("aggregates nested semantic results into one job outcome", () => {
    const summary = summarizeJobOutcome({
      observation: { semanticResult: { outcome: "warnings", acceptedRecordCount: 4, quarantinedRecordCount: 1, warnings: ["one"] } },
      knowledge: { semanticResult: { outcome: "partial", acceptedRecordCount: 0, quarantinedRecordCount: 2, warnings: ["two"] } },
    });
    expect(summary).toEqual(expect.objectContaining({
      outcome: "partial",
      acceptedRecordCount: 4,
      quarantinedRecordCount: 3,
    }));
  });

  test("persists outcome diagnostics and resume metadata without changing lifecycle status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-job-store-"));
    const store = new JobStore(path.join(root, "jobs.sqlite"));
    store.createJob({ id: "job-1", type: "translation", status: "queued", stage: "queued", payload: {} });
    store.updateJob({
      id: "job-1",
      status: "failed",
      stage: "failed",
      outcome: null,
      diagnostics: { resourceFailureType: "timeout", resumeAvailable: true },
      resumeMetadata: { resumeAvailable: true, checkpointPaths: ["checkpoint.json"] },
    });
    expect(store.getJob("job-1")).toEqual(expect.objectContaining({
      status: "failed",
      outcome: null,
      diagnostics: expect.objectContaining({ resourceFailureType: "timeout" }),
      resumeMetadata: expect.objectContaining({ resumeAvailable: true }),
    }));
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
