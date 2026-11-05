const { MANGA_PROCESSING_JOB_TYPES } = require("../runtime/manga_processing_job_types");

function scheduleQueueDrain(manager) {
  if (manager.queueDrainScheduled) return;
  manager.queueDrainScheduled = true;
  setImmediate(() => {
    manager.queueDrainScheduled = false;
    void manager.drainQueue();
  });
}

function updateWaitingDependency(manager, job, reason) {
  if (job.status === "waiting_dependency" && job.blockedReason === reason) return;
  manager.store.updateJob({
    id: job.id,
    status: "waiting_dependency",
    stage: "waiting_dependency",
    blockedReason: reason,
  });
  manager.publish(job.id, "job.waiting_dependency", { reason });
}

function updateWaitingProcessorReview(manager, job) {
  const reason = `Waiting for Extraction review ${manager.mangaProcessorReviewLease.referenceSetId} to finish.`;
  if (job.status === "waiting_dependency" && job.blockedReason === reason) return;
  manager.store.updateJob({
    id: job.id,
    status: "waiting_dependency",
    stage: "waiting_manga_processor_review",
    blockedReason: reason,
  });
  manager.publish(job.id, "job.waiting_manga_processor_review", { reason });
}

function handlePendingQueueEntry(manager, index) {
  const job = manager.store.getJob(manager.pendingQueue[index]);
  if (!job || !["queued", "waiting_dependency"].includes(job.status)) {
    manager.pendingQueue.splice(index, 1);
    return "removed";
  }
  const dependencyState = manager.resolveDependencyState(job);
  if (dependencyState.kind === "failed") {
    manager.pendingQueue.splice(index, 1);
    manager.blockJob(job, dependencyState.reason);
    return "removed";
  }
  if (dependencyState.kind === "waiting") {
    updateWaitingDependency(manager, job, dependencyState.reason);
    return "waiting";
  }
  if (manager.mangaProcessorReviewLease && MANGA_PROCESSING_JOB_TYPES.has(job.type)) {
    updateWaitingProcessorReview(manager, job);
    return "waiting";
  }
  return "runnable";
}

function scanPendingQueue(manager) {
  for (let index = 0; index < manager.pendingQueue.length; index += 1) {
    const outcome = handlePendingQueueEntry(manager, index);
    if (outcome === "removed") {
      index -= 1;
      continue;
    }
    if (outcome === "runnable") return index;
  }
  return -1;
}

async function drainQueue(manager) {
  if (manager.queueRunning) return;
  manager.queueRunning = true;
  try {
    while (manager.pendingQueue.length > 0) {
      const runnableIndex = scanPendingQueue(manager);
      if (runnableIndex < 0) break;
      const [nextJobId] = manager.pendingQueue.splice(runnableIndex, 1);
      await manager.runJob(nextJobId);
    }
  } finally {
    manager.queueRunning = false;
    if (manager.pendingQueue.length > 0 && !manager.mangaProcessorReviewLease) manager.scheduleQueueDrain();
  }
}

function acquireMangaProcessorReviewLease(manager, { sessionId, referenceSetId }) {
  if (manager.mangaProcessorReviewLease) {
    const error = new Error(
      `Manga processor is already reserved by Extraction review ${manager.mangaProcessorReviewLease.referenceSetId}.`,
    );
    error.statusCode = 409;
    throw error;
  }
  const activeJob = [...manager.activeJobs]
    .map((jobId) => manager.store.getJob(jobId))
    .find((job) => job && MANGA_PROCESSING_JOB_TYPES.has(job.type));
  if (activeJob) {
    const error = new Error(`Manga processing job ${activeJob.id} is still running.`);
    error.statusCode = 409;
    throw error;
  }
  manager.mangaProcessorReviewLease = { sessionId, referenceSetId, acquiredAt: new Date().toISOString() };
  return manager.mangaProcessorReviewLease;
}

function releaseMangaProcessorReviewLease(manager, sessionId) {
  if (!manager.mangaProcessorReviewLease || manager.mangaProcessorReviewLease.sessionId !== sessionId) return false;
  manager.mangaProcessorReviewLease = null;
  for (const jobId of manager.pendingQueue) {
    const job = manager.store.getJob(jobId);
    if (job?.stage !== "waiting_manga_processor_review") continue;
    manager.store.updateJob({ id: job.id, status: "queued", stage: "queued", blockedReason: null });
  }
  manager.scheduleQueueDrain();
  return true;
}

module.exports = {
  acquireMangaProcessorReviewLease,
  drainQueue,
  releaseMangaProcessorReviewLease,
  scheduleQueueDrain,
};
