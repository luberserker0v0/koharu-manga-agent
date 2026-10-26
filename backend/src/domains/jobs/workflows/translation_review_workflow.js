const { collectQualityCheckpoints } = require("../artifacts/job_artifact_collection");

function createTranslationDeepAuditJob(manager, sourceTranslationJobId) {
  const source = manager.store.getJob(sourceTranslationJobId);
  if (!source || source.type !== "translation" || source.status !== "succeeded") {
    throw new Error("Deep Audit requires a completed translation job.");
  }
  if (!source.result?.finalTranslationSnapshotPath) {
    throw new Error("Deep Audit requires a final translation snapshot.");
  }
  return manager.createJob(
    "translation_deep_audit",
    {
      sourceTranslationJobId,
      finalTranslationSnapshotPath: source.result.finalTranslationSnapshotPath,
      translationMemorySnapshotPath: source.result.translationMemorySnapshotPath || null,
      mangaId: source.payload?.mangaId || null,
      translatorId: source.payload?.translatorId || null,
      chapterId: source.payload?.chapterId || null,
    },
    { parentJobId: sourceTranslationJobId, laneKey: `translation_deep_audit:${sourceTranslationJobId}` },
  );
}

function validateDeepAuditApply(manager, deepAuditJobId, decisions) {
  const requested = manager.store.getJob(deepAuditJobId);
  const source = requested?.type === "translation_deep_audit"
    ? manager.store.getJob(requested.payload?.sourceTranslationJobId)
    : null;
  if (!source || source.type !== "translation" || requested.status !== "succeeded") {
    throw new Error("Deep Audit apply requires a completed Deep Audit job.");
  }
  if (!requested.result?.deepAuditReviewPackagePath) {
    throw new Error("Deep Audit apply requires a review package.");
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new Error("Deep Audit apply requires at least one user decision.");
  }
  return { requested, source };
}

function createTranslationDeepAuditApplyJob(manager, deepAuditJobId, decisions) {
  const { requested, source } = validateDeepAuditApply(manager, deepAuditJobId, decisions);
  return manager.createJob(
    "translation_deep_audit_apply",
    {
      sourceTranslationJobId: source.id,
      deepAuditJobId: requested.id,
      decisions: Array.isArray(decisions) ? decisions : [],
    },
    { parentJobId: requested.id, laneKey: `translation_deep_audit_apply:${source.id}` },
  );
}

function qualityRepairPayload(source, reusable) {
  return {
    ...source.payload,
    resumeFromTranslation: {
      sourceJobId: source.id,
      projectName: source.result.projectName,
      operationId: source.result.operationId || null,
      engines: source.result.engines || {},
      steps: source.result.steps || [],
      pipelineProfile: source.result.pipelineProfile || null,
      translationMemorySnapshotPath: source.result.translationMemorySnapshotPath,
      resumeAtStage: "quality_context",
      qualityCheckpointPaths: reusable.qualityCheckpointPaths,
      qualityObservationCheckpointPaths: reusable.qualityObservationCheckpointPaths,
    },
  };
}

function createTranslationQualityRepairJob(manager, sourceTranslationJobId) {
  const source = manager.store.getJob(sourceTranslationJobId);
  if (!source || source.type !== "translation" || source.status !== "succeeded") {
    throw new Error("Quality repair requires a completed translation job.");
  }
  if (!source.result?.projectName || !source.result?.translationMemorySnapshotPath) {
    throw new Error("Quality repair requires the original Koharu project and Translation Memory snapshot.");
  }
  const previousRepairs = manager.store.listChildJobs(source.id)
    .filter((job) => job.type === "translation_quality_repair");
  const reusable = collectQualityCheckpoints(manager.store, [source, ...previousRepairs]);
  return manager.createJob(
    "translation_quality_repair",
    qualityRepairPayload(source, reusable),
    {
      parentJobId: source.id,
      laneKey: `translation_quality_repair:${source.payload?.mangaId || "none"}:${source.payload?.translatorId || "none"}`,
    },
  );
}

async function listQualityRepairProjects(client, baseUrl) {
  try {
    return await client.listProjects(baseUrl);
  } catch (cause) {
    const error = new Error(
      `Koharu is unavailable at ${baseUrl}. Start Koharu before revalidating translation quality.`,
    );
    error.statusCode = 503;
    error.cause = cause;
    throw error;
  }
}

async function resolveQualityRepairBaseUrl(manager, source, client) {
  let baseUrl = source.payload?.baseUrl || manager.resolvedConfig?.api?.baseUrl || "http://127.0.0.1:4000";
  if (!source.payload?.baseUrl && manager.koharuRuntimeManager) {
    const status = await manager.koharuRuntimeManager.ensureRunning();
    if (status?.baseUrl) {
      baseUrl = status.baseUrl;
      manager.resolvedConfig.api = { ...(manager.resolvedConfig.api || {}), baseUrl };
      if (client) client.defaultBaseUrl = baseUrl;
    }
  }
  return baseUrl;
}

async function preflightTranslationQualityRepair(manager, sourceTranslationJobId) {
  const source = manager.store.getJob(sourceTranslationJobId);
  if (!source || source.type !== "translation" || source.status !== "succeeded") {
    const error = new Error("Quality repair requires a completed translation job.");
    error.statusCode = 409;
    throw error;
  }
  const client = manager.engine?.projectLifecycle?.client;
  const baseUrl = await resolveQualityRepairBaseUrl(manager, source, client);
  if (!client || typeof client.listProjects !== "function") {
    const error = new Error("Koharu project access is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const projects = await listQualityRepairProjects(client, baseUrl);
  if (!projects.some((project) => project.name === source.result?.projectName)) {
    const error = new Error(`Koharu project is unavailable: ${source.result?.projectName || "unknown"}.`);
    error.statusCode = 409;
    throw error;
  }
  return { baseUrl, projectName: source.result.projectName };
}

module.exports = {
  createTranslationDeepAuditApplyJob,
  createTranslationDeepAuditJob,
  createTranslationQualityRepairJob,
  preflightTranslationQualityRepair,
};
