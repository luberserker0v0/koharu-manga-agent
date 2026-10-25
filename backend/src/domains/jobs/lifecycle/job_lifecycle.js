const TERMINAL_STATUSES = ["succeeded", "failed", "canceled", "blocked"];

function cancelInactiveJob(manager, jobId, recovered) {
  manager.store.updateJob({ id: jobId, status: "canceled", stage: "canceled", error: null });
  const payload = { jobId, status: "canceled" };
  if (recovered) payload.recovered = true;
  manager.publish(jobId, "job.canceled", payload);
  return manager.getJob(jobId);
}

function cancelWorkflowJob(manager, job) {
  let stopping = false;
  for (const child of manager.store.listChildJobs(job.id)) {
    if (TERMINAL_STATUSES.includes(child.status)) continue;
    manager.cancelJob(child.id);
    if (manager.activeJobs.has(child.id)) stopping = true;
  }
  const status = stopping ? "cancel_requested" : "canceled";
  manager.store.updateJob({ id: job.id, status, stage: status, error: null });
  manager.publish(job.id, stopping ? "workflow.cancel_requested" : "workflow.canceled", { workflowId: job.id });
  return manager.getJob(job.id);
}

function cancelJob(manager, jobId) {
  const job = manager.store.getJob(jobId);
  if (!job) return null;
  if (TERMINAL_STATUSES.includes(job.status)) return manager.getJob(jobId);
  if (job.executionKind === "workflow") return cancelWorkflowJob(manager, job);
  if (["queued", "waiting_dependency"].includes(job.status)) {
    manager.pendingQueue = manager.pendingQueue.filter((pendingId) => pendingId !== jobId);
    return cancelInactiveJob(manager, jobId, false);
  }
  if (!manager.activeJobs.has(jobId)) return cancelInactiveJob(manager, jobId, true);
  manager.cancellations.add(jobId);
  manager.store.updateJob({ id: jobId, status: "cancel_requested" });
  manager.publish(jobId, "job.cancel_requested", { jobId });
  return manager.getJob(jobId);
}

function deleteJob(manager, jobId) {
  const job = manager.store.getJob(jobId);
  if (!job) return null;
  if (!TERMINAL_STATUSES.includes(job.status)) manager.cancelJob(jobId);
  for (const child of manager.collectDescendantJobs(job.id)) {
    if (!TERMINAL_STATUSES.includes(child.status)) manager.cancelJob(child.id);
    manager.store.softDeleteJob(child.id);
  }
  const deleted = manager.store.softDeleteJob(jobId);
  manager.emitJobListUpdate("job.deleted", { jobId }, deleted);
  manager.publishSystem("job.deleted", { jobId, status: deleted.status, type: deleted.type });
  return deleted;
}

function summarizeMutation(job) {
  return { id: job.id, status: job.status, type: job.type };
}

function batchMutation(manager, jobIds, action, mutate) {
  if (!Array.isArray(jobIds) || jobIds.length === 0) return { [action]: [], missing: [] };
  const changed = [];
  const missing = [];
  for (const jobId of jobIds) {
    const job = manager.store.getJob(jobId);
    if (!job) {
      missing.push(jobId);
      continue;
    }
    const result = mutate(jobId);
    changed.push(summarizeMutation(result));
  }
  if (changed.length > 0) {
    manager.publishSystem(`job.batch_${action}`, { jobIds: changed.map((entry) => entry.id) });
  }
  return { [action]: changed, missing };
}

function deleteJobs(manager, jobIds) {
  return batchMutation(manager, jobIds, "deleted", (jobId) => {
    const deleted = manager.deleteJob(jobId);
    manager.emitJobListUpdate("job.deleted", { jobId }, deleted);
    return deleted;
  });
}

function restoreJob(manager, jobId) {
  const job = manager.store.getJob(jobId);
  if (!job) return null;
  if (!job.deletedAt) return job;
  const restored = manager.store.restoreJob(jobId);
  for (const child of manager.collectDescendantJobs(job.id)) manager.store.restoreJob(child.id);
  manager.emitJobListUpdate("job.restored", { jobId }, restored);
  manager.publishSystem("job.restored", { jobId, status: restored.status, type: restored.type });
  return restored;
}

function restoreJobs(manager, jobIds) {
  return batchMutation(manager, jobIds, "restored", (jobId) => {
    const restored = manager.restoreJob(jobId);
    manager.emitJobListUpdate("job.restored", { jobId }, restored);
    return restored;
  });
}

function ensurePurgeableJobStatus(manager, jobId, job) {
  if (TERMINAL_STATUSES.includes(job.status)) return;
  if (manager.activeJobs.has(jobId)) {
    manager.cancelJob(jobId);
    throw new Error("The job is still stopping. Try permanent deletion again after it becomes canceled.");
  }
  manager.store.updateJob({ id: jobId, status: "canceled", stage: "canceled", error: null });
}

function cancelPurgeDescendants(manager, descendants) {
  for (const child of descendants) {
    if (TERMINAL_STATUSES.includes(child.status)) continue;
    if (manager.activeJobs.has(child.id)) {
      manager.cancelJob(child.id);
      throw new Error(`Child job ${child.id} is still stopping. Try permanent deletion again after it becomes canceled.`);
    }
    manager.store.updateJob({ id: child.id, status: "canceled", stage: "canceled", error: null });
  }
}

function publishPurgedJob(manager, removed) {
  manager.publishSystem("job.purged", {
    jobId: removed.id,
    status: removed.status,
    type: removed.type,
  });
}

function deletePurgedDescendants(manager, descendants) {
  for (const child of descendants.slice().reverse()) {
    const removed = manager.store.deleteJob(child.id);
    if (removed) publishPurgedJob(manager, removed);
  }
}

function publishJobPurged(manager, jobId, purged) {
  manager.events.emit("jobs", {
    kind: "system",
    type: "job.purged",
    payload: { jobId, status: purged.status, type: purged.type },
    createdAt: new Date().toISOString(),
  });
  publishPurgedJob(manager, purged);
}

function purgeJob(manager, jobId) {
  const job = manager.store.getJob(jobId);
  if (!job) return null;
  if (!job.deletedAt) throw new Error("Only trashed jobs can be permanently deleted.");
  ensurePurgeableJobStatus(manager, jobId, job);
  const descendants = manager.collectDescendantJobs(job.id);
  cancelPurgeDescendants(manager, descendants);
  deletePurgedDescendants(manager, descendants);
  const purged = manager.store.deleteJob(jobId);
  publishJobPurged(manager, jobId, purged);
  return purged;
}

function purgeJobs(manager, jobIds) {
  return batchMutation(manager, jobIds, "purged", (jobId) => manager.purgeJob(jobId));
}

module.exports = {
  cancelJob,
  deleteJob,
  deleteJobs,
  purgeJob,
  purgeJobs,
  restoreJob,
  restoreJobs,
};
