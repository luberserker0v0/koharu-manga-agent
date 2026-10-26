const fs = require("fs");

const { buildAoFailureDiagnostics } = require("../../../integrations/ao/errors/ao_error_classifier");
const { assertJobType } = require("../contracts/job_contracts");
const { handleJobSuccess } = require("./job_completion");

function setRunJobStage(manager, jobId, job, status, stage) {
  manager.store.updateJob({ id: jobId, status, stage });
  manager.publish(jobId, "job.stage", { status, stage });
  if (!job.parentJobId) return;
  const parent = manager.store.getJob(job.parentJobId);
  if (parent?.executionKind === "workflow") {
    manager.store.updateJob({ id: job.parentJobId, status: "running", stage });
  }
  manager.publish(job.parentJobId, "workflow.progress", {
    childJobId: jobId,
    childJobType: job.type,
    status,
    stage,
  });
}

function emitRunJobEvent(manager, jobId, job, type, payload) {
  manager.emitJobEvent(jobId, type, payload);
  const publishToParent = job.parentJobId &&
    (["reference_ingestion.progress", "reference_bilingual_enrichment.progress"].includes(type) ||
      job.type === "translation_knowledge_commit");
  if (!publishToParent) return;
  manager.emitJobEvent(job.parentJobId, type, {
    ...payload,
    childJobId: jobId,
    childJobType: job.type,
  });
}

function createRunJobHooks(manager, jobId, job) {
  return {
    jobId,
    setStage: (status, stage) => setRunJobStage(manager, jobId, job, status, stage),
    emit: (type, payload) => emitRunJobEvent(manager, jobId, job, type, payload),
    isCanceled: () => manager.cancellations.has(jobId),
  };
}

async function prepareRunJob(manager, job, hooks, jobId) {
  manager.store.updateJob({ id: jobId, blockedReason: null });
  hooks.setStage("running", job.type);
  await manager.ensureKoharuReadyForJob(job, hooks);
  assertJobType(job.type, job.executionKind || "job");
  if (job.executionKind === "workflow") {
    throw new Error(`Workflow ${job.type} cannot run as an atomic job.`);
  }
}

async function runJobCore(manager, job, hooks, jobId) {
  await prepareRunJob(manager, job, hooks, jobId);
  const result = await manager.runAtomicJob(job, hooks);
  if (manager.cancellations.has(jobId)) throw new Error("Job canceled by user.");
  await handleJobSuccess(manager, job, jobId, result);
}

function collectFailureCheckpointPaths(manager, jobId) {
  return manager.store
    .getEvents(jobId)
    .map((event) => event.payload?.checkpointPath)
    .filter((checkpointPath) => typeof checkpointPath === "string" && fs.existsSync(checkpointPath));
}

function findFailedWindowId(manager, jobId, current) {
  const failedWindowEvent = [...manager.store.getEvents(jobId)]
    .reverse()
    .find(
      (event) =>
        typeof event.payload?.windowId === "string" &&
        (event.type.endsWith(".window_started") || event.type.endsWith(".window_retrying")),
    );
  return current?.payload?.windowId || failedWindowEvent?.payload?.windowId || null;
}

function buildRunJobFailureDiagnostics(manager, job, jobId, error, current) {
  const checkpointPaths = collectFailureCheckpointPaths(manager, jobId);
  const failureDiagnostics = buildAoFailureDiagnostics(error, {
    checkpointPaths: [...new Set(checkpointPaths)],
    failedWindowId: findFailedWindowId(manager, jobId, current),
    stage: current?.stage || job.stage || null,
    jobType: job.type,
  });
  const resumeMetadata = failureDiagnostics.resumeAvailable
    ? {
        resumeAvailable: true,
        checkpointPaths: failureDiagnostics.checkpointPaths,
        failedWindowId: failureDiagnostics.failedWindowId,
        resourceFailureType: failureDiagnostics.resourceFailureType,
      }
    : null;
  return { failureDiagnostics, resumeMetadata };
}

function updateFailedJobRecord(manager, input) {
  manager.store.updateJob({
    id: input.jobId,
    status: input.status,
    stage: input.status,
    error: input.canceled ? null : input.error.message,
    outcome: null,
    diagnostics: input.canceled ? null : input.failureDiagnostics,
    resumeMetadata: input.resumeMetadata,
  });
}

function publishKnowledgeFailure(manager, job, jobId, error, canceled) {
  if (job.type !== "translation_knowledge_commit" || !job.parentJobId) return;
  manager.publish(job.parentJobId, canceled ? "knowledge.canceled" : "knowledge.failed", {
    knowledgeJobId: jobId,
    error: canceled ? null : error.message,
  });
}

function publishRunJobFailure(manager, input) {
  if (!input.canceled && input.resumeMetadata) {
    manager.publish(input.jobId, "job.resume_available", input.resumeMetadata);
  }
  manager.persistArtifacts(input.jobId, input.current?.result || null);
  manager.publish(
    input.jobId,
    input.canceled ? "job.canceled" : "job.failed",
    input.canceled
      ? { status: input.status }
      : { error: input.error.message, status: input.status, diagnostics: input.failureDiagnostics },
  );
  publishKnowledgeFailure(manager, input.job, input.jobId, input.error, input.canceled);
}

function handleRunJobFailureSideEffects(manager, job, jobId, error, canceled, stage) {
  const isBilingual = [
    "reference_bilingual_evidence_window",
    "reference_bilingual_commit",
  ].includes(job.type);
  if (!canceled) {
    manager.store.addError(jobId, stage, error.message);
    if (isBilingual) manager.engine.referenceBilingualEnrichmentModule?.markRunFailed(job.payload, error);
    return;
  }
  if (isBilingual) manager.engine.referenceBilingualEnrichmentModule?.markRunStopped(job.payload);
}

async function handleRunJobFailure(manager, job, jobId, error) {
  const canceled = manager.cancellations.has(jobId) && error?.code !== "koharu_cancel_failed";
  const status = canceled ? "canceled" : "failed";
  const current = manager.store.getJob(jobId);
  manager.store.deleteTranslationPageRevisionsForJob?.(jobId);
  const diagnostics = buildRunJobFailureDiagnostics(manager, job, jobId, error, current);
  const input = { job, jobId, error, canceled, status, current, ...diagnostics };
  updateFailedJobRecord(manager, input);
  handleRunJobFailureSideEffects(manager, job, jobId, error, canceled, current?.stage || job.stage);
  publishRunJobFailure(manager, input);
}

function finalizeRunJob(manager, jobId, job) {
  manager.cancellations.delete(jobId);
  manager.activeJobs.delete(jobId);
  manager.updateParentWorkflow(job.parentJobId);
  manager.scheduleQueueDrain();
}

async function runJob(manager, jobId) {
  const job = manager.store.getJob(jobId);
  if (!job || !["queued", "waiting_dependency"].includes(job.status)) return;
  const hooks = createRunJobHooks(manager, jobId, job);
  manager.activeJobs.add(jobId);
  try {
    await runJobCore(manager, job, hooks, jobId);
  } catch (error) {
    await handleRunJobFailure(manager, job, jobId, error);
  } finally {
    finalizeRunJob(manager, jobId, job);
  }
}

module.exports = { runJob };
