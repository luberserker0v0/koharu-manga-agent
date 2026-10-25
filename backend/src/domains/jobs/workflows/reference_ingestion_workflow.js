const fs = require("fs");
const path = require("path");

const { paths } = require("../../../config");
const { listChapterRegistry } = require("../../knowledge/registry/knowledge_paths");
const { loadReferenceManifest } = require("../../reference/sets/reference_sets");
const { ensureLegacyReviewMetadata } = require("../../reference/review/reference_extraction_review");

function buildIngestionArtifacts(payload, parent) {
  const artifactRoot = path.join(paths.workspaceRoot, parent.id, "reference_ingestion");
  const reusableAnalysisArtifactPath =
    payload.reuseAnalysisArtifactPath && fs.existsSync(payload.reuseAnalysisArtifactPath)
      ? payload.reuseAnalysisArtifactPath
      : null;
  return {
    reusableAnalysisArtifactPath,
    analysisArtifactPath: reusableAnalysisArtifactPath || path.join(artifactRoot, "analysis.json"),
    storyArtifactPath: path.join(artifactRoot, "story_delta.json"),
    revisionPlanPath: path.join(artifactRoot, "revision_plan.json"),
  };
}

function createIngestionParent(manager, payload, scheduling) {
  const workflowPayload = {
    ...payload,
    referenceKind: scheduling.referenceKind,
    chapterSortOrder: scheduling.sequenceNumber,
    schedulingWarnings: scheduling.warnings,
  };
  const parent = manager.createJob("reference_ingestion", workflowPayload, {
    executionKind: "workflow",
    status: "running",
    stage: "waiting_children",
    laneKey: scheduling.laneKey,
    sequenceNumber: scheduling.sequenceNumber,
  });
  const artifacts = buildIngestionArtifacts(payload, parent);
  const sharedPayload = { ...workflowPayload, workflowId: parent.id, ...artifacts };
  delete sharedPayload.reusableAnalysisArtifactPath;
  return { parent, artifacts, sharedPayload };
}

function createIngestionObservation(manager, parent, sharedPayload, reusablePath, scheduling) {
  return manager.createJob("reference_observation", sharedPayload, {
    workflowId: parent.id,
    parentJobId: parent.id,
    dependencyIds: scheduling.dependencyIds || [],
    laneKey: scheduling.laneKey,
    sequenceNumber: 0,
    status: reusablePath ? "succeeded" : "queued",
    stage: reusablePath ? "reused" : "queued",
    enqueue: !reusablePath,
  });
}

function reuseIngestionObservation(manager, observation, reusablePath, payload) {
  if (!reusablePath) return;
  const reusedResult = {
    phase: "observation",
    reused: true,
    reusedFromJobId: payload.reuseAnalysisFromJobId || null,
    analysisArtifactPath: reusablePath,
  };
  manager.store.updateJob({
    id: observation.id,
    status: "succeeded",
    stage: "reused",
    result: reusedResult,
    error: null,
  });
  manager.publish(observation.id, "job.reused", reusedResult);
}

function createIngestionChild(manager, type, parent, payload, scheduling, dependencyId, sequenceNumber) {
  return manager.createJob(type, payload, {
    workflowId: parent.id,
    parentJobId: parent.id,
    dependencyIds: [dependencyId],
    laneKey: scheduling.laneKey,
    sequenceNumber,
  });
}

function createIngestionCommit(manager, parent, payload, scheduling, dependencyId) {
  const isSource = scheduling.referenceKind === "source";
  return createIngestionChild(
    manager,
    isSource ? "reference_knowledge_commit" : "reference_style_commit",
    parent,
    payload,
    scheduling,
    dependencyId,
    isSource ? 2 : 1,
  );
}

function createReferenceIngestionWorkflow(manager, payload, scheduling) {
  const context = createIngestionParent(manager, payload, scheduling);
  const reusablePath = context.artifacts.reusableAnalysisArtifactPath;
  const observation = createIngestionObservation(
    manager, context.parent, context.sharedPayload, reusablePath, scheduling,
  );
  reuseIngestionObservation(manager, observation, reusablePath, payload);
  let dependencyId = observation.id;
  if (scheduling.referenceKind === "source") {
    const story = createIngestionChild(
      manager, "reference_story_update", context.parent, context.sharedPayload, scheduling, observation.id, 1,
    );
    dependencyId = story.id;
  }
  const commit = createIngestionCommit(
    manager, context.parent, context.sharedPayload, scheduling, dependencyId,
  );
  manager.publish(context.parent.id, "workflow.created", {
    workflowId: context.parent.id,
    childJobIds: manager.store.listChildJobs(context.parent.id).map((job) => job.id),
    commitJobId: commit.id,
  });
  return manager.getJob(context.parent.id);
}

function resolveIngestionReferenceKind(payload) {
  let referenceKind = payload.referenceKind === "source" ? "source" : "translator";
  try {
    const manifest = loadReferenceManifest(payload.referenceSetId);
    referenceKind = manifest.referenceKind === "source" ? "source" : "translator";
  } catch (_error) {
    // Ingestion performs authoritative manifest validation later.
  }
  return referenceKind;
}

function resolveIngestionSchedulingBasics(payload) {
  const referenceKind = resolveIngestionReferenceKind(payload);
  const chapters = payload.mangaId && payload.translatorId
    ? listChapterRegistry({ mangaId: payload.mangaId, translatorId: payload.translatorId })
    : [];
  const chapterIndex = chapters.findIndex((chapter) => chapter.chapterId === payload.chapterId);
  const sequenceNumber = chapterIndex >= 0
    ? chapters[chapterIndex].sortOrder
    : Number.isFinite(payload.chapterSortOrder) ? payload.chapterSortOrder : null;
  const laneKey = referenceKind === "source"
    ? `source-story:${payload.mangaId || "unknown"}`
    : `translator-reference:${payload.mangaId || "unknown"}:${payload.translatorId || "unknown"}`;
  const warnings = referenceKind === "source" && chapterIndex > 0 && !chapters[chapterIndex - 1]
    ? ["The previous source chapter could not be resolved from chapter order."]
    : [];
  return { referenceKind, chapters, chapterIndex, sequenceNumber, laneKey, warnings };
}

function findIngestionPredecessorJobs(manager, payload, scheduling, previousChapter) {
  return manager.store.listJobs({ includeDeleted: false })
    .filter((job) =>
      job.type === "reference_ingestion" &&
      job.payload?.mangaId === payload.mangaId &&
      job.payload?.chapterId === previousChapter.chapterId &&
      (job.payload?.referenceKind === "source" || job.laneKey === scheduling.laneKey),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function assertPreviousChapterCommitted(manager, payload, previousChapter) {
  const committed = manager.store.listKnowledgeRevisions({
    mangaId: payload.mangaId,
    translatorId: payload.translatorId || null,
    includeStale: false,
  }).some((revision) => revision.chapterId === previousChapter.chapterId);
  if (committed) return;
  const previousName = previousChapter.chapterTitle || previousChapter.chapterId;
  const currentName = payload.chapterTitle || payload.chapterId;
  const error = new Error(
    `Previous source chapter ${previousName} must complete Ingestion before ${currentName}.`,
  );
  error.statusCode = 409;
  throw error;
}

function findReferenceIngestionPredecessors(manager, payload, scheduling) {
  if (scheduling.chapterIndex <= 0) return [];
  const previousChapter = scheduling.chapters[scheduling.chapterIndex - 1];
  const candidates = findIngestionPredecessorJobs(manager, payload, scheduling, previousChapter);
  if (candidates.length > 0) return [candidates[0].id];
  if (scheduling.referenceKind === "source") {
    assertPreviousChapterCommitted(manager, payload, previousChapter);
  }
  return [];
}

function resolveReferenceIngestionScheduling(manager, payload, { findPredecessor = true } = {}) {
  const basics = resolveIngestionSchedulingBasics(payload);
  const scheduling = { ...basics, dependencyIds: [] };
  if (findPredecessor) {
    scheduling.dependencyIds = findReferenceIngestionPredecessors(manager, payload, scheduling);
  }
  return scheduling;
}

function prepareIngestionBatch(manager, payloads) {
  const prepared = payloads.map((payload) => ({
    payload,
    scheduling: resolveReferenceIngestionScheduling(manager, payload, { findPredecessor: false }),
  }));
  prepared.sort((left, right) => {
    if (left.scheduling.laneKey !== right.scheduling.laneKey) {
      return left.scheduling.laneKey.localeCompare(right.scheduling.laneKey);
    }
    return (left.scheduling.sequenceNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.scheduling.sequenceNumber ?? Number.MAX_SAFE_INTEGER);
  });
  return prepared;
}

function runIngestionBatch(manager, prepared) {
  const jobs = [];
  const lastJobByLane = new Map();
  for (const { payload, scheduling } of prepared) {
    const priorBatchJobId = lastJobByLane.get(scheduling.laneKey);
    const dependencyIds = priorBatchJobId
      ? [priorBatchJobId]
      : findReferenceIngestionPredecessors(manager, payload, scheduling);
    const job = createReferenceIngestionWorkflow(manager, payload, { ...scheduling, dependencyIds });
    jobs.push(job);
    lastJobByLane.set(scheduling.laneKey, job.id);
  }
  return jobs;
}

function createReferenceIngestionJob(manager, payload) {
  const review = ensureLegacyReviewMetadata(payload.referenceSetId);
  const preparedPayload = { ...payload, extractionFingerprint: review?.currentFingerprint || null };
  const scheduling = resolveReferenceIngestionScheduling(manager, preparedPayload);
  return createReferenceIngestionWorkflow(manager, preparedPayload, scheduling);
}

function createReferenceIngestionJobs(manager, payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error("Reference ingestion batch requires at least one item.");
  }
  return runIngestionBatch(manager, prepareIngestionBatch(manager, payloads));
}

module.exports = {
  createReferenceIngestionJob,
  createReferenceIngestionJobs,
  createReferenceIngestionWorkflow,
  findReferenceIngestionPredecessors,
  resolveReferenceIngestionScheduling,
};
