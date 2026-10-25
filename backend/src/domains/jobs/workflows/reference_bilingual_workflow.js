function findExistingBilingualEnrichmentJob(manager, payload, prepared) {
  return manager.store
    .listJobs({ includeDeleted: false })
    .find(
      (job) =>
        job.type === "reference_bilingual_enrichment" &&
        job.payload?.mangaId === payload.mangaId &&
        job.payload?.translatorId === payload.translatorId &&
        job.payload?.planHash === prepared.plan.planHash &&
        ["queued", "running", "waiting_dependency"].includes(job.status),
    );
}

function buildBilingualParentPayload(payload, prepared) {
  return {
    ...payload,
    sourceFingerprint: prepared.plan.sourceFingerprint,
    targetFingerprint: prepared.plan.targetFingerprint,
    planHash: prepared.plan.planHash,
    planPath: prepared.paths.planPath,
    totalWindows: prepared.plan.windows.length,
    reusedWindows: prepared.completedWindowIds.length,
  };
}

function createBilingualWindow(manager, parent, parentPayload, window, dependencyId, sequenceNumber) {
  return manager.createJob(
    "reference_bilingual_evidence_window",
    {
      ...parentPayload,
      workflowId: parent.id,
      windowId: window.windowId,
      purpose: window.purpose,
      chapterId: window.chapterId,
      chapterTitle: window.chapterTitle,
    },
    {
      workflowId: parent.id,
      parentJobId: parent.id,
      dependencyIds: dependencyId ? [dependencyId] : [],
      laneKey: `reference_bilingual:${parentPayload.mangaId}:${parentPayload.translatorId}`,
      sequenceNumber,
    },
  );
}

function createBilingualWindowChildren(manager, parent, parentPayload, prepared) {
  let dependencyId = null;
  let sequenceNumber = 0;
  const childIds = [];
  for (const window of prepared.plan.windows) {
    if (prepared.completedWindowIds.includes(window.windowId)) continue;
    const child = createBilingualWindow(
      manager, parent, parentPayload, window, dependencyId, sequenceNumber++,
    );
    dependencyId = child.id;
    childIds.push(child.id);
  }
  return { dependencyId, childIds, sequenceNumber };
}

function createBilingualCommitJob(manager, parent, parentPayload, dependencyId, sequenceNumber) {
  return manager.createJob(
    "reference_bilingual_commit",
    { ...parentPayload, workflowId: parent.id },
    {
      workflowId: parent.id,
      parentJobId: parent.id,
      dependencyIds: dependencyId ? [dependencyId] : [],
      laneKey: `reference_bilingual:${parentPayload.mangaId}:${parentPayload.translatorId}`,
      sequenceNumber,
    },
  );
}

function createBilingualParent(manager, payload, parentPayload) {
  return manager.createJob("reference_bilingual_enrichment", parentPayload, {
    executionKind: "workflow",
    status: "running",
    stage: "waiting_children",
    laneKey: `reference_bilingual:${payload.mangaId}:${payload.translatorId}`,
  });
}

function publishBilingualWorkflow(manager, parent, childIds, prepared, commit) {
  manager.publish(parent.id, "workflow.created", {
    workflowId: parent.id,
    childJobIds: childIds,
    totalWindows: prepared.plan.windows.length,
    reusedWindows: prepared.completedWindowIds.length,
    commitJobId: commit.id,
  });
}

function createReferenceBilingualEnrichmentJob(manager, payload) {
  if (!payload?.mangaId || !payload?.translatorId) {
    throw new Error("Bilingual enrichment requires mangaId and translatorId.");
  }
  const prepared = manager.engine.referenceBilingualEnrichmentModule.prepareRun(payload);
  const existing = findExistingBilingualEnrichmentJob(manager, payload, prepared);
  if (existing) return manager.getJob(existing.id);
  const parentPayload = buildBilingualParentPayload(payload, prepared);
  const parent = createBilingualParent(manager, payload, parentPayload);
  const children = createBilingualWindowChildren(manager, parent, parentPayload, prepared);
  const commit = createBilingualCommitJob(
    manager, parent, parentPayload, children.dependencyId, children.sequenceNumber,
  );
  children.childIds.push(commit.id);
  publishBilingualWorkflow(manager, parent, children.childIds, prepared, commit);
  return manager.getJob(parent.id);
}

module.exports = { createReferenceBilingualEnrichmentJob };
