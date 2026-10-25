const { summarizeJobOutcome } = require("../../../integrations/ao/contracts/semantic_result");
const { listReferenceSets } = require("../../reference/sets/reference_sets");

function buildRunJobDiagnostics(outcomeSummary) {
  return {
    warningCount: outcomeSummary.warnings.length,
    acceptedRecordCount: outcomeSummary.acceptedRecordCount,
    quarantinedRecordCount: outcomeSummary.quarantinedRecordCount,
    degradedStages: outcomeSummary.degradedStages,
    warnings: outcomeSummary.warnings,
  };
}

async function synchronizePageRevisions(manager, job, jobId, diagnostics) {
  if (job.type !== "translation" || !manager.pageRevisionService) return;
  try {
    await manager.pageRevisionService.synchronizeJob(jobId, { allowRunning: true });
  } catch (error) {
    if (job.payload?.revision?.reason === "selective_retranslation") throw error;
    diagnostics.warningCount += 1;
    diagnostics.warnings.push({
      code: error.code || "page_revision_index_unavailable",
      message: error.message,
    });
    manager.publish(jobId, "page_revisions.unavailable", {
      code: error.code || "page_revision_index_unavailable",
      message: error.message,
    });
  }
}

function updateQueuedKnowledgeStatus(manager, payload, knowledgeJob) {
  if (!payload.publicationRevisionId) return;
  manager.engine.translationPublicationService?.updateKnowledgeStatus({
    mangaId: payload.mangaId,
    translatorId: payload.translatorId,
    chapterId: payload.chapterId,
    revisionId: payload.publicationRevisionId,
    status: "queued",
    knowledgeJobId: knowledgeJob.id,
  });
}

function scheduleRunJobKnowledge(manager, job, jobId, result) {
  const supportsKnowledge = [
    "translation",
    "translation_quality_repair",
    "translation_deep_audit_apply",
  ].includes(job.type);
  if (!supportsKnowledge || !result?.knowledgePayload) return result;
  const payload = result.knowledgePayload;
  const knowledgeJob = manager.createJob("translation_knowledge_commit", payload, {
    parentJobId: jobId,
    laneKey: `translation_knowledge:${payload.mangaId || "none"}:${payload.translatorId || "none"}`,
  });
  updateQueuedKnowledgeStatus(manager, payload, knowledgeJob);
  const completedResult = { ...result, knowledgeJobId: knowledgeJob.id };
  manager.store.updateJob({ id: jobId, result: completedResult });
  manager.publish(jobId, "knowledge.scheduled", {
    knowledgeJobId: knowledgeJob.id,
    learningEvidenceSnapshotPath: payload.learningEvidenceSnapshotPath,
  });
  return completedResult;
}

function publishOutcomeEvents(manager, job, jobId, outcomeSummary, diagnostics) {
  if (outcomeSummary.outcome === "partial") {
    manager.publish(jobId, "job.partial", diagnostics);
  } else if (outcomeSummary.outcome === "warnings") {
    manager.publish(jobId, "job.completed_with_warnings", diagnostics);
  }
  if (outcomeSummary.outcome !== "clean") {
    manager.publish(jobId, "stage.degraded", {
      stage: job.type,
      outcome: outcomeSummary.outcome,
      ...diagnostics,
    });
  }
  if (outcomeSummary.quarantinedRecordCount > 0) {
    manager.publish(jobId, "evidence.quarantined", {
      stage: job.type,
      count: outcomeSummary.quarantinedRecordCount,
    });
  }
}

function publishRunJobCompletion(manager, job, jobId, completedResult, outcomeSummary, diagnostics) {
  publishOutcomeEvents(manager, job, jobId, outcomeSummary, diagnostics);
  manager.publish(jobId, "job.completed", {
    ...completedResult,
    outcome: outcomeSummary.outcome,
    diagnostics,
  });
}

function handleDeepAuditApplySuccess(manager, job, jobId, result) {
  if (job.type !== "translation_deep_audit_apply" || !job.parentJobId) return;
  const source = manager.store.getJob(result.sourceTranslationJobId || job.parentJobId);
  if (!source) return;
  manager.store.updateJob({
    id: source.id,
    status: "succeeded",
    stage: "succeeded",
    result: { ...(source.result || {}), ...result, deepAuditAppliedByJobId: jobId },
    error: null,
  });
  manager.publish(source.id, "deep_audit.applied", {
    applyJobId: jobId,
    publication: result.publication || null,
  });
}

function getActiveIngestionWorkflows(manager, job) {
  return manager.store.listJobs({ includeDeleted: false }).filter(
    (workflow) =>
      workflow.executionKind === "workflow" &&
      workflow.type === "reference_ingestion" &&
      workflow.id !== job.workflowId &&
      ["queued", "running", "waiting_dependency", "cancel_requested"].includes(workflow.status),
  );
}

function filterStaleReplayRevisions(job, result, activeWorkflows) {
  const currentSequence = job.payload.chapterSortOrder;
  return result.staleKnowledgeRevisions
    .filter(
      (revision) =>
        revision.sequenceNumber != null &&
        currentSequence != null &&
        revision.sequenceNumber > currentSequence &&
        !activeWorkflows.some(
          (workflow) =>
            workflow.laneKey === job.laneKey &&
            workflow.sequenceNumber === revision.sequenceNumber &&
            workflow.payload?.chapterId === revision.chapterId,
        ),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function toStaleReplayPayload(revision) {
  return {
    ...revision.payload,
    isReplay: true,
    replayedFromRevisionId: revision.id,
    reuseAnalysisArtifactPath: revision.analysisArtifactPath || revision.payload?.analysisArtifactPath || null,
  };
}

function buildStaleKnowledgeReplayPayloads(manager, job, result) {
  const activeWorkflows = getActiveIngestionWorkflows(manager, job);
  const replayRevisionByChapter = new Map();
  for (const revision of filterStaleReplayRevisions(job, result, activeWorkflows)) {
    replayRevisionByChapter.set(revision.chapterId, revision);
  }
  return [...replayRevisionByChapter.values()]
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber)
    .map(toStaleReplayPayload);
}

function handleStaleKnowledgeReplay(manager, job, result) {
  const shouldReplay = job.type === "reference_knowledge_commit" &&
    Array.isArray(result?.staleKnowledgeRevisions) &&
    result.staleKnowledgeRevisions.length > 0 &&
    job.payload?.isReplay !== true;
  if (!shouldReplay) return;
  const replayPayloads = buildStaleKnowledgeReplayPayloads(manager, job, result);
  if (replayPayloads.length === 0) return;
  setImmediate(() => {
    const replayJobs = manager.createReferenceIngestionJobs(replayPayloads);
    manager.publishSystem("knowledge.replay_scheduled", {
      sourceWorkflowId: job.workflowId || job.parentJobId || null,
      replayWorkflowIds: replayJobs.map((entry) => entry.id),
    });
  });
}

function hasPendingIngestion(manager, payload, translatorId) {
  return manager.store.listJobs({ includeDeleted: false }).some(
    (workflow) =>
      workflow.executionKind === "workflow" &&
      workflow.type === "reference_ingestion" &&
      workflow.id !== payload.workflowId &&
      workflow.payload?.mangaId === payload.mangaId &&
      ["queued", "running", "waiting_dependency", "cancel_requested"].includes(workflow.status) &&
      (workflow.payload?.referenceKind === "source" || workflow.payload?.translatorId === translatorId),
  );
}

function scheduleOneBilingualEnrichment(manager, payload, module, translatorId) {
  if (hasPendingIngestion(manager, payload, translatorId)) return null;
  const prerequisites = module.inspectPrerequisites({ mangaId: payload.mangaId, translatorId });
  if (!prerequisites.ready) return null;
  return manager.createReferenceBilingualEnrichmentJob({
    mangaId: payload.mangaId,
    translatorId,
    sourceFingerprint: prerequisites.source.fingerprint,
    targetFingerprint: prerequisites.target.fingerprint,
    trigger: "ingestion_commit",
  });
}

function getBilingualTranslatorIds(payload) {
  if (payload.referenceKind === "translator" && payload.translatorId) {
    return [payload.translatorId];
  }
  return listReferenceSets()
    .filter((entry) => entry.mangaId === payload.mangaId && entry.referenceKind === "translator")
    .map((entry) => entry.translatorId)
    .filter(Boolean);
}

function scheduleBilingualEnrichmentAfterCommit(manager, payload) {
  const module = manager.engine.referenceBilingualEnrichmentModule;
  if (!module || !payload?.mangaId) return [];
  const jobs = [];
  for (const translatorId of [...new Set(getBilingualTranslatorIds(payload))]) {
    const job = scheduleOneBilingualEnrichment(manager, payload, module, translatorId);
    if (job) jobs.push(job);
  }
  return jobs;
}

function runJobPostSuccess(manager, job, jobId, result) {
  handleDeepAuditApplySuccess(manager, job, jobId, result);
  if (["reference_knowledge_commit", "reference_style_commit"].includes(job.type)) {
    scheduleBilingualEnrichmentAfterCommit(manager, job.payload);
  }
  handleStaleKnowledgeReplay(manager, job, result);
}

async function handleJobSuccess(manager, job, jobId, result) {
  const outcomeSummary = summarizeJobOutcome(result);
  const diagnostics = buildRunJobDiagnostics(outcomeSummary);
  manager.store.updateJob({ id: jobId, status: "running", stage: "finalizing" });
  manager.persistArtifacts(jobId, result);
  await synchronizePageRevisions(manager, job, jobId, diagnostics);
  manager.store.updateJob({
    id: jobId,
    status: "succeeded",
    stage: "succeeded",
    result,
    error: null,
    outcome: outcomeSummary.outcome,
    diagnostics,
    resumeMetadata: null,
  });
  const completedResult = scheduleRunJobKnowledge(manager, job, jobId, result);
  publishRunJobCompletion(manager, job, jobId, completedResult, outcomeSummary, diagnostics);
  runJobPostSuccess(manager, job, jobId, result);
}

module.exports = {
  handleJobSuccess,
  scheduleBilingualEnrichmentAfterCommit,
};
