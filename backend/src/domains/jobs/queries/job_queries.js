function withJobDetails(store, job) {
  return {
    ...job,
    events: store.getEvents(job.id),
    artifacts: store.getArtifacts(job.id),
  };
}

function getJob(manager, jobId) {
  manager.cleanupExpiredTrash();
  const job = manager.store.getJob(jobId);
  if (!job) return null;
  const children = typeof manager.store.listChildJobs === "function"
    ? manager.store.listChildJobs(jobId).map((child) => withJobDetails(manager.store, child))
    : [];
  return { ...withJobDetails(manager.store, job), children };
}

function listJobs(manager, includeDeleted = false) {
  manager.cleanupExpiredTrash();
  return manager.store
    .listJobs(includeDeleted ? { includeDeleted: true } : undefined)
    .map((job) => withJobDetails(manager.store, job));
}

function getJobEvents(manager, jobId) {
  return manager.store.getJob(jobId) ? manager.store.getEvents(jobId) : null;
}

function getJobArtifacts(manager, jobId) {
  return manager.store.getJob(jobId) ? manager.store.getArtifacts(jobId) : null;
}

module.exports = { getJob, getJobArtifacts, getJobEvents, listJobs };
