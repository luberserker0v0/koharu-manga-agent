const crypto = require("crypto");

const { assertJobStatus, assertJobType } = require("../contracts/job_contracts");

function createJobRecord(manager, jobId, type, status, payload, options, executionKind) {
  manager.store.createJob({
    id: jobId,
    type,
    status,
    stage: options.stage || "queued",
    payload,
    retryOf: options.retryOf || null,
    executionKind,
    workflowId: options.workflowId || null,
    parentJobId: options.parentJobId || null,
    dependencyIds: options.dependencyIds || [],
    laneKey: options.laneKey || null,
    sequenceNumber: options.sequenceNumber ?? null,
  });
}

function publishCreatedJob(manager, jobId, type, payload, options) {
  manager.publish(jobId, "job.created", {
    jobId,
    type,
    payload,
    retryOf: options.retryOf || null,
    workflowId: options.workflowId || null,
    parentJobId: options.parentJobId || null,
    dependencyIds: options.dependencyIds || [],
  });
}

function enqueueCreatedJob(manager, jobId, executionKind, options) {
  if (executionKind === "workflow" || options.enqueue === false) return;
  manager.pendingQueue.push(jobId);
  manager.scheduleQueueDrain();
}

function createJob(manager, type, payload, options = {}) {
  const executionKind = options.executionKind || "job";
  const status = options.status || "queued";
  assertJobType(type, executionKind);
  assertJobStatus(status);
  const jobId = crypto.randomUUID();
  createJobRecord(manager, jobId, type, status, payload, options, executionKind);
  publishCreatedJob(manager, jobId, type, payload, options);
  enqueueCreatedJob(manager, jobId, executionKind, options);
  return manager.getJob(jobId);
}

function resolveWorkflowDependencies(childIdsByKey, definition) {
  return (definition.dependsOn || []).map((key) => {
    const dependencyId = childIdsByKey.get(key);
    if (!dependencyId) throw new Error(`Workflow child dependency not found: ${key}`);
    return dependencyId;
  });
}

function createWorkflowChildren(manager, parent, payload, childDefinitions) {
  const childIdsByKey = new Map();
  for (const [index, definition] of childDefinitions.entries()) {
    const dependencyIds = resolveWorkflowDependencies(childIdsByKey, definition);
    const child = manager.createJob(definition.type, definition.payload || payload, {
      workflowId: parent.id,
      parentJobId: parent.id,
      dependencyIds: [...dependencyIds, ...(definition.dependencyIds || [])],
      laneKey: definition.laneKey || null,
      sequenceNumber: definition.sequenceNumber ?? index,
    });
    childIdsByKey.set(definition.key, child.id);
  }
  return [...childIdsByKey.values()];
}

function createWorkflow(manager, type, payload, childDefinitions) {
  const parent = manager.createJob(type, payload, {
    executionKind: "workflow",
    status: "running",
    stage: "waiting_children",
  });
  const childJobIds = createWorkflowChildren(manager, parent, payload, childDefinitions);
  manager.publish(parent.id, "workflow.created", { workflowId: parent.id, childJobIds });
  return manager.getJob(parent.id);
}

module.exports = { createJob, createWorkflow };
