const INTERRUPTED_STATUSES = ["running", "cancel_requested"];
const RESUMABLE_STATUSES = ["queued", "waiting_dependency"];

function collectInterruptedWorkflowIds(jobs) {
  return new Set(
    jobs
      .filter((job) => job.executionKind === "workflow" && INTERRUPTED_STATUSES.includes(job.status))
      .map((job) => job.id),
  );
}

function recoveredCancellationEvent(job, interruptedWorkflowId) {
  return {
    jobId: job.id,
    status: "canceled",
    recoveredAfterRestart: true,
    ...(interruptedWorkflowId ? { interruptedWorkflowId } : {}),
  };
}

function cancelRecoveredJob(manager, job, interruptedWorkflowId = null) {
  manager.store.deleteTranslationPageRevisionsForJob?.(job.id);
  manager.store.updateJob({ id: job.id, status: "canceled", stage: "canceled", error: null });
  manager.store.addEvent(
    job.id,
    "job.canceled",
    recoveredCancellationEvent(job, interruptedWorkflowId),
    new Date().toISOString(),
  );
}

function cancelInterruptedWorkflowJob(manager, job, interruptedWorkflowIds) {
  const bilingual = ["reference_bilingual_evidence_window", "reference_bilingual_commit"].includes(job.type);
  if (INTERRUPTED_STATUSES.includes(job.status) && bilingual) {
    manager.engine.referenceBilingualEnrichmentModule?.markRunStopped(job.payload);
  }
  const workflowId = interruptedWorkflowIds.has(job.id) ? job.id : job.parentJobId;
  cancelRecoveredJob(manager, job, workflowId);
}

function recoverInterruptedJob(manager, job, interruptedWorkflowIds) {
  const interruptedWorkflow = interruptedWorkflowIds.has(job.id) || interruptedWorkflowIds.has(job.parentJobId);
  if (interruptedWorkflow && [...RESUMABLE_STATUSES, ...INTERRUPTED_STATUSES].includes(job.status)) {
    cancelInterruptedWorkflowJob(manager, job, interruptedWorkflowIds);
    return;
  }
  if (RESUMABLE_STATUSES.includes(job.status) && job.executionKind !== "workflow") {
    manager.pendingQueue.push(job.id);
    return;
  }
  if (INTERRUPTED_STATUSES.includes(job.status)) cancelRecoveredJob(manager, job);
}

function recoverInterruptedJobs(manager) {
  const jobs = typeof manager.store.listJobs === "function"
    ? manager.store.listJobs({ includeDeleted: true })
    : [];
  const interruptedWorkflowIds = collectInterruptedWorkflowIds(jobs);
  for (const job of jobs) recoverInterruptedJob(manager, job, interruptedWorkflowIds);
  if (manager.pendingQueue.length > 0) manager.scheduleQueueDrain();
}

module.exports = { recoverInterruptedJobs };
