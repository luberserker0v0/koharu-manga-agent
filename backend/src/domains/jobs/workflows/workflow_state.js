const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "blocked"]);

function resolveDependencyState(store, job) {
  for (const dependencyId of job.dependencyIds || []) {
    const dependency = store.getJob(dependencyId);
    if (!dependency) return { kind: "failed", reason: `Missing dependency: ${dependencyId}` };
    if (["failed", "canceled", "blocked"].includes(dependency.status)) {
      return { kind: "failed", reason: `Dependency ${dependency.id} ended with status ${dependency.status}.` };
    }
    if (dependency.status !== "succeeded") {
      return { kind: "waiting", reason: `Waiting for dependency ${dependency.id}.` };
    }
  }
  return { kind: "ready", reason: null };
}

function blockJob(manager, job, reason) {
  manager.store.updateJob({
    id: job.id,
    status: "blocked",
    stage: "blocked_dependency",
    error: null,
    blockedReason: reason,
  });
  manager.publish(job.id, "job.blocked", { reason });
  manager.updateParentWorkflow(job.parentJobId);
}

function markParentWorkflowRunning(store, parentJobId, children) {
  const runningChild = children.find((child) => child.status === "running");
  store.updateJob({
    id: parentJobId,
    status: "running",
    stage: runningChild?.stage || "waiting_children",
  });
}

function parentOutcome(childOutcomes, status) {
  if (childOutcomes.some((child) => child.outcome === "partial")) return "partial";
  if (childOutcomes.some((child) => child.outcome === "warnings")) return "warnings";
  return status === "succeeded" ? "clean" : null;
}

function parentDiagnostics(failedChild, childOutcomes) {
  if (failedChild?.diagnostics) return failedChild.diagnostics;
  return {
    warningCount: childOutcomes.reduce((sum, child) => sum + (child.diagnostics?.warningCount || 0), 0),
    acceptedRecordCount: childOutcomes.reduce((sum, child) => sum + (child.diagnostics?.acceptedRecordCount || 0), 0),
    quarantinedRecordCount: childOutcomes.reduce(
      (sum, child) => sum + (child.diagnostics?.quarantinedRecordCount || 0),
      0,
    ),
    degradedStages: childOutcomes.flatMap((child) => child.diagnostics?.degradedStages || []),
  };
}

function updateFinalizedParent(store, parentJobId, status, parent, finalChild, failedChild, outcome, diagnostics) {
  store.updateJob({
    id: parentJobId,
    status,
    stage: status,
    result: status === "succeeded" ? finalChild?.result || null : parent.result,
    error: failedChild?.error || null,
    blockedReason: failedChild?.blockedReason || null,
    outcome,
    diagnostics,
    resumeMetadata: failedChild?.resumeMetadata || null,
  });
}

function propagateChildArtifacts(store, parentJobId, children) {
  for (const child of children) {
    for (const artifact of store.getArtifacts(child.id)) {
      store.addArtifact(parentJobId, artifact.kind, artifact.path, {
        ...(artifact.metadata || {}),
        childJobId: child.id,
        childJobType: child.type,
      });
    }
  }
}

function finalizeParentWorkflow(manager, parentJobId, parent, children) {
  const failedChild = children.find((child) => ["failed", "blocked"].includes(child.status));
  const canceledChild = children.find((child) => child.status === "canceled");
  const finalChild = children[children.length - 1] || null;
  const status = failedChild ? "failed" : canceledChild ? "canceled" : "succeeded";
  const childOutcomes = children.filter((child) => child.status === "succeeded");
  const outcome = parentOutcome(childOutcomes, status);
  const diagnostics = parentDiagnostics(failedChild, childOutcomes);
  updateFinalizedParent(manager.store, parentJobId, status, parent, finalChild, failedChild, outcome, diagnostics);
  propagateChildArtifacts(manager.store, parentJobId, children);
  manager.publish(parentJobId, `workflow.${status}`, {
    workflowId: parentJobId,
    childJobIds: children.map((child) => child.id),
    failedChildId: failedChild?.id || null,
  });
}

function updateParentWorkflow(manager, parentJobId) {
  if (!parentJobId || typeof manager.store.listChildJobs !== "function") return;
  const parent = manager.store.getJob(parentJobId);
  if (!parent || parent.executionKind !== "workflow" || TERMINAL_STATUSES.has(parent.status)) return;
  const children = manager.store.listChildJobs(parentJobId);
  if (children.some((child) => !TERMINAL_STATUSES.has(child.status))) {
    markParentWorkflowRunning(manager.store, parentJobId, children);
    return;
  }
  finalizeParentWorkflow(manager, parentJobId, parent, children);
}

function collectDescendantJobs(store, parentJobId) {
  if (!parentJobId || typeof store.listChildJobs !== "function") return [];
  const descendants = [];
  const pendingParentIds = [parentJobId];
  while (pendingParentIds.length > 0) {
    const currentParentId = pendingParentIds.shift();
    for (const child of store.listChildJobs(currentParentId)) {
      descendants.push(child);
      pendingParentIds.push(child.id);
    }
  }
  return descendants;
}

function toJobSummary(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    stage: job.stage,
    payload: job.payload,
    revision: job.revision || job.payload?.revision || null,
    result: job.result ?? null,
    error: job.error ?? null,
    retryOf: job.retryOf ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    deletedAt: job.deletedAt ?? null,
    executionKind: job.executionKind || "job",
    workflowId: job.workflowId || null,
    parentJobId: job.parentJobId || null,
    dependencyIds: job.dependencyIds || [],
    laneKey: job.laneKey || null,
    sequenceNumber: job.sequenceNumber ?? null,
    blockedReason: job.blockedReason || null,
  };
}

module.exports = {
  blockJob,
  collectDescendantJobs,
  resolveDependencyState,
  toJobSummary,
  updateParentWorkflow,
};
