const fs = require("fs");

const { collectQualityCheckpoints } = require("../artifacts/job_artifact_collection");

function isBilingualRetry(job) {
  return [
    "reference_bilingual_enrichment",
    "reference_bilingual_evidence_window",
    "reference_bilingual_commit",
  ].includes(job.type);
}

function retryBilingualEnrichment(manager, current) {
  const parent = current.type === "reference_bilingual_enrichment"
    ? current
    : manager.store.getJob(current.parentJobId);
  if (!parent?.payload?.mangaId || !parent?.payload?.translatorId) {
    throw new Error("Bilingual enrichment retry requires its parent workflow context.");
  }
  return manager.createReferenceBilingualEnrichmentJob({
    mangaId: parent.payload.mangaId,
    translatorId: parent.payload.translatorId,
    trigger: "retry",
    retryOf: parent.id,
  });
}

function retrySelectiveTranslation(manager, current, jobId) {
  return manager.createJob(
    "translation",
    {
      ...current.payload,
      revision: { ...current.payload.revision, parentJobId: current.id },
    },
    { retryOf: jobId, parentJobId: current.id },
  );
}

function getReusableReferenceAnalysis(manager, workflow) {
  const analysis = manager.store.listChildJobs(workflow.id).find((child) => {
    const artifactPath = child.result?.analysisArtifactPath || child.payload?.analysisArtifactPath || "";
    return child.type === "reference_observation" &&
      child.status === "succeeded" &&
      fs.existsSync(artifactPath);
  });
  if (!analysis) return null;
  return {
    path: analysis.result?.analysisArtifactPath || analysis.payload.analysisArtifactPath,
    jobId: analysis.id,
  };
}

function buildReferenceIngestionRetryPayload(manager, workflow) {
  const analysis = getReusableReferenceAnalysis(manager, workflow);
  return {
    ...workflow.payload,
    retryOf: workflow.id,
    reuseAnalysisArtifactPath: analysis?.path || null,
    reuseAnalysisFromJobId: analysis?.jobId || null,
  };
}

function collectEarlierIngestionWorkflows(manager, current) {
  const latestBySequence = new Map();
  for (const workflow of manager.store.listJobs({ includeDeleted: false })) {
    const isEarlierInLane = workflow.executionKind === "workflow" &&
      workflow.type === "reference_ingestion" &&
      workflow.laneKey === current.laneKey &&
      Number.isFinite(workflow.sequenceNumber) &&
      workflow.sequenceNumber < current.sequenceNumber;
    if (!isEarlierInLane) continue;
    const existing = latestBySequence.get(workflow.sequenceNumber);
    if (!existing || workflow.createdAt > existing.createdAt) {
      latestBySequence.set(workflow.sequenceNumber, workflow);
    }
  }
  return [...latestBySequence.values()];
}

function retryOrderedReferenceIngestion(manager, current) {
  const retryChain = collectEarlierIngestionWorkflows(manager, current)
    .filter((workflow) => ["failed", "blocked"].includes(workflow.status))
    .concat(current)
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  if (retryChain.length <= 1) return null;
  const retried = manager.createReferenceIngestionJobs(
    retryChain.map((workflow) => buildReferenceIngestionRetryPayload(manager, workflow)),
  );
  return retried[retried.length - 1];
}

function retryReferenceIngestion(manager, current) {
  const isOrderedReference = current.laneKey && Number.isFinite(current.sequenceNumber);
  if (isOrderedReference) {
    const retried = retryOrderedReferenceIngestion(manager, current);
    if (retried) return retried;
  }
  const payload = buildReferenceIngestionRetryPayload(manager, current);
  return manager.createReferenceIngestionJob(payload);
}

function retryKnowledgeOrAudit(manager, current, jobId) {
  return manager.createJob(
    current.type,
    { ...current.payload },
    {
      retryOf: jobId,
      parentJobId: current.parentJobId || null,
      laneKey: current.laneKey || null,
    },
  );
}

function existingPaths(paths) {
  return [...new Set(paths)].filter(
    (checkpointPath) => typeof checkpointPath === "string" && fs.existsSync(checkpointPath),
  );
}

function retryQualityRepair(manager, current, jobId) {
  const reusable = collectQualityCheckpoints(manager.store, [current]);
  const { allowPendingLocalRevalidation: _obsoleteFlag, ...retryPayload } = current.payload || {};
  const previousResume = current.payload?.resumeFromTranslation || {};
  const resumeFromTranslation = {
    ...previousResume,
    qualityCheckpointPaths: existingPaths([
      ...(previousResume.qualityCheckpointPaths || []), ...reusable.qualityCheckpointPaths,
    ]),
    qualityObservationCheckpointPaths: existingPaths([
      ...(previousResume.qualityObservationCheckpointPaths || []),
      ...reusable.qualityObservationCheckpointPaths,
    ]),
  };
  return manager.createJob(
    "translation_quality_repair",
    { ...retryPayload, resumeFromTranslation },
    { retryOf: jobId, parentJobId: current.parentJobId || null, laneKey: current.laneKey || null },
  );
}

function collectEventCheckpointPaths(events, eventTypes) {
  return events
    .filter((event) => eventTypes.includes(event.type))
    .map((event) => event.payload?.checkpointPath)
    .filter((checkpointPath) => typeof checkpointPath === "string" && fs.existsSync(checkpointPath));
}

function collectTranslationRetryCheckpointPaths(events, previousResume) {
  const qualityEvents = ["quality.window.completed", "quality.window.reused"];
  const observationEvents = [
    "quality_observation.window_completed",
    "quality_observation.window_reused",
  ];
  const partialQualityCheckpointPaths = [...new Set([
    ...(previousResume?.qualityCheckpointPaths || []),
    ...collectEventCheckpointPaths(events, qualityEvents),
  ])];
  const qualityObservationCheckpointPaths = [...new Set([
    ...(previousResume?.qualityObservationCheckpointPaths || []),
    ...collectEventCheckpointPaths(events, observationEvents),
  ])];
  return { partialQualityCheckpointPaths, qualityObservationCheckpointPaths };
}

function collectTranslationRetryContext(manager, current, jobId) {
  const events = manager.store.getEvents(jobId);
  const eventPayload = (type) => events.find((event) => event.type === type)?.payload || null;
  const previousResume = current.payload?.resumeFromTranslation || null;
  const setup = eventPayload("setup.completed");
  const memory = eventPayload("translation_memory.built");
  return {
    setup,
    previousResume,
    quality: eventPayload("quality.completed"),
    projectName: setup?.projectName || previousResume?.projectName || null,
    memoryPath: memory?.path || previousResume?.translationMemorySnapshotPath || null,
    checkpointPaths: collectTranslationRetryCheckpointPaths(events, previousResume),
    hasPipelineState: events.some((event) => event.type === "pipeline.completed") || previousResume,
  };
}

function canResumeTranslation(context) {
  return Boolean(
    context.hasPipelineState &&
    typeof context.projectName === "string" &&
    context.projectName.length > 0 &&
    typeof context.memoryPath === "string" &&
    fs.existsSync(context.memoryPath),
  );
}

function buildTranslationResumePayload(jobId, input) {
  const qualityCanBeReused = Boolean(
    input.quality?.reportPath &&
    fs.existsSync(input.quality.reportPath) &&
    input.quality?.projectionPath &&
    fs.existsSync(input.quality.projectionPath),
  );
  return {
    sourceJobId: jobId,
    projectName: input.projectName,
    operationId: input.setup?.operationId || input.previousResume?.operationId || null,
    engines: input.setup?.engines || input.previousResume?.engines || {},
    steps: input.setup?.steps || input.previousResume?.steps || [],
    translationMemorySnapshotPath: input.memoryPath,
    resumeAtStage: qualityCanBeReused ? "learning_evidence" : "quality_context",
    qualityReportPath: qualityCanBeReused ? input.quality.reportPath : null,
    qualityProjectionPath: qualityCanBeReused ? input.quality.projectionPath : null,
    qualityCheckpointPaths: qualityCanBeReused
      ? input.quality.checkpointPaths || input.checkpointPaths.partialQualityCheckpointPaths
      : input.checkpointPaths.partialQualityCheckpointPaths,
    qualityObservationCheckpointPaths: input.checkpointPaths.qualityObservationCheckpointPaths,
  };
}

function createTranslationRetryJob(manager, current, jobId, input) {
  return manager.createJob(
    "translation",
    {
      ...current.payload,
      resumeFromTranslation: buildTranslationResumePayload(jobId, input),
    },
    { retryOf: jobId },
  );
}

function retryTranslation(manager, current, jobId) {
  const context = collectTranslationRetryContext(manager, current, jobId);
  return canResumeTranslation(context)
    ? createTranslationRetryJob(manager, current, jobId, context)
    : null;
}

function retrySpecializedJob(manager, current, jobId) {
  if (isBilingualRetry(current)) return retryBilingualEnrichment(manager, current);
  if (current.type === "translation" && current.payload?.revision?.reason === "selective_retranslation") {
    return retrySelectiveTranslation(manager, current, jobId);
  }
  if (current.executionKind === "workflow" && current.type === "reference_ingestion") {
    return retryReferenceIngestion(manager, current);
  }
  if (["translation_knowledge_commit", "translation_deep_audit"].includes(current.type)) {
    return retryKnowledgeOrAudit(manager, current, jobId);
  }
  if (current.type === "translation_quality_repair") return retryQualityRepair(manager, current, jobId);
  return current.type === "translation" ? retryTranslation(manager, current, jobId) : null;
}

function retryJob(manager, jobId) {
  const current = manager.store.getJob(jobId);
  if (!current) return null;
  const specialized = retrySpecializedJob(manager, current, jobId);
  if (specialized) return specialized;
  return manager.createJob(current.type, { ...current.payload }, { retryOf: jobId });
}

function resumeJob(manager, jobId) {
  const current = manager.store.getJob(jobId);
  if (!current) return null;
  if (current.status !== "failed" || current.resumeMetadata?.resumeAvailable !== true) {
    const error = new Error("Only a failed job with compatible checkpoints can be resumed.");
    error.statusCode = 409;
    throw error;
  }
  return retryJob(manager, jobId);
}

function getKnowledgeRetryPayload(source) {
  const payload = source.result?.knowledgePayload;
  if (!payload?.publicationRevisionId || !payload?.learningEvidenceSnapshotPath) {
    throw new Error("Knowledge retry requires persisted learning evidence and a publication revision.");
  }
  if (!fs.existsSync(payload.learningEvidenceSnapshotPath)) {
    throw new Error("Knowledge retry learning evidence file is missing.");
  }
  return payload;
}

function resolveKnowledgeRetryRevision(manager, payload) {
  const publication = manager.engine.translationPublicationService?.getChapter(
    payload.mangaId,
    payload.translatorId,
    payload.chapterId,
  );
  const revision = publication?.revisions?.find(
    (entry) => entry.revisionId === payload.publicationRevisionId,
  );
  if (!revision || publication.activeRevisionId !== revision.revisionId || revision.qualityStatus !== "passed") {
    throw new Error("Knowledge retry requires the active, Quality-passed publication revision.");
  }
  return revision;
}

function findExistingKnowledgeRetryJob(manager, revisionId) {
  return manager.store.listJobs({ includeDeleted: true }).find(
    (job) =>
      job.type === "translation_knowledge_commit" &&
      job.payload?.publicationRevisionId === revisionId &&
      ["queued", "waiting_dependency", "running", "succeeded"].includes(job.status),
  );
}

function validateKnowledgeRetry(manager, source) {
  const payload = getKnowledgeRetryPayload(source);
  const revision = resolveKnowledgeRetryRevision(manager, payload);
  if (revision.knowledgeStatus === "committed") {
    throw new Error("Knowledge is already committed for this publication revision.");
  }
  const existing = findExistingKnowledgeRetryJob(manager, revision.revisionId);
  if (existing) {
    throw new Error(`Knowledge job ${existing.id} already exists for this publication revision.`);
  }
  return payload;
}

function updateQueuedKnowledgeStatus(manager, payload, knowledgeJob) {
  manager.engine.translationPublicationService.updateKnowledgeStatus({
    mangaId: payload.mangaId,
    translatorId: payload.translatorId,
    chapterId: payload.chapterId,
    revisionId: payload.publicationRevisionId,
    status: "queued",
    knowledgeJobId: knowledgeJob.id,
  });
}

function createTranslationKnowledgeRetryJob(manager, sourceJobId) {
  const source = manager.store.getJob(sourceJobId);
  const supportedTypes = ["translation", "translation_quality_repair", "translation_deep_audit_apply"];
  if (!source || !supportedTypes.includes(source.type) || source.status !== "succeeded") {
    throw new Error("Knowledge retry requires a completed translation publication job.");
  }
  const payload = validateKnowledgeRetry(manager, source);
  const knowledgeJob = manager.createJob("translation_knowledge_commit", payload, {
    parentJobId: source.id,
    laneKey: `translation_knowledge:${payload.mangaId}:${payload.translatorId}`,
  });
  updateQueuedKnowledgeStatus(manager, payload, knowledgeJob);
  return knowledgeJob;
}

module.exports = {
  createTranslationKnowledgeRetryJob,
  resumeJob,
  retryJob,
};
