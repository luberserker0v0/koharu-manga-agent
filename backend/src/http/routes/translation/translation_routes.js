const fs = require("fs");
const { config } = require("../../../config");
const {
  isMachineTranslationTarget,
  validateTranslationTargetShape,
} = require("../../../integrations/koharu/translation/translation_targets");
const { assertTranslationMemoryReady } = require("../../../domains/translation/memory/translation_memory");
const { buildLearningEvidenceSnapshot } = require("../../../domains/knowledge/learning/learning_evidence");
const { badRequest, conflict, notFound, readJsonBody, sendJson } = require("../../server/http_helpers");
const { publicJob } = require("../jobs/job_http");

const TRANSLATION_MODES = ["quick", "reference_style", "local_style", "learning_style"];
const SELECTIVE_RETRANSLATION_FIELDS = new Set([
  "sourceImageIds",
  "translationTarget",
  "targetLanguage",
  "sourceLanguage",
  "instructions",
]);

function normalizeQualityPreviewTranslations(translations) {
  return (Array.isArray(translations) ? translations : []).map((entry) => ({
    nodeId:
      typeof entry?.nodeId === "string" && entry.nodeId
        ? entry.nodeId
        : typeof entry?.id === "string" && entry.id
          ? entry.id
          : null,
    pageName: typeof entry?.pageName === "string" ? entry.pageName : null,
    original: typeof entry?.original === "string" ? entry.original : null,
    currentTranslation:
      typeof entry?.currentTranslation === "string"
        ? entry.currentTranslation
        : typeof entry?.translation === "string"
          ? entry.translation
          : null,
  }));
}

function hasInvalidTranslationPayload(res, body) {
  if (!TRANSLATION_MODES.includes(body.translationMode)) {
    badRequest(res, "translationMode must be quick, reference_style, local_style, or learning_style.");
    return true;
  }
  const obsolete = ["referenceSetId", "ingestReference", "knowledgeBuilder", "sourceFolder", "outputDir"].filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (obsolete.length > 0) {
    badRequest(res, `Obsolete translation payload fields are not supported: ${obsolete.join(", ")}.`);
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "generationOptions")) {
    badRequest(res, "generationOptions is runtime configuration; update it through PATCH /config before creating a job.");
    return true;
  }
  const missing = ["mangaId", "translatorId", "chapterId"].filter((field) => !String(body[field] || "").trim());
  if (missing.length > 0) {
    badRequest(res, `Translation jobs require output bindings: ${missing.join(", ")}.`);
    return true;
  }
  return false;
}

function findActiveTranslationJob(jobManager, body) {
  return jobManager.listJobs().find(
    (job) =>
      job.type === "translation" &&
      job.payload?.mangaId === body.mangaId &&
      job.payload?.translatorId === body.translatorId &&
      job.payload?.chapterId === body.chapterId &&
      !["succeeded", "failed", "canceled", "blocked"].includes(job.status),
  );
}

async function createTranslationJob(ctx) {
  const body = await readJsonBody(ctx.req);
  if (hasInvalidTranslationPayload(ctx.res, body)) return;
  body.translationTarget =
    validateTranslationTargetShape(body.translationTarget) ||
    ctx.jobManager.resolvedConfig?.translation?.defaultTarget ||
    null;
  body.generationOptions =
    ctx.jobManager.resolvedConfig?.translation?.generationOptions ||
    null;
  const duplicate = findActiveTranslationJob(ctx.jobManager, body);
  if (duplicate) {
    conflict(ctx.res, `Translation job ${duplicate.id} is already active for this chapter.`);
    return;
  }
  await ctx.jobManager.assertAgentAvailableForTranslation?.(body);
  await ctx.jobManager.assertKoharuAvailableForJobType?.("translation", body);
  sendJson(ctx.res, 202, publicJob(ctx.jobManager.createTranslationJob(body)));
}

async function handleTranslationCreate(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/jobs/translation") return false;
  await createTranslationJob(ctx);
  return true;
}

function hasInvalidSelectiveRetranslationPayload(res, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    badRequest(res, "Selective retranslation body must be a JSON object.");
    return true;
  }
  const unknown = Object.keys(body).filter((field) => !SELECTIVE_RETRANSLATION_FIELDS.has(field));
  if (unknown.length > 0) {
    badRequest(res, `Unsupported selective retranslation fields: ${unknown.join(", ")}.`);
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "translationTarget")) {
    body.translationTarget = validateTranslationTargetShape(body.translationTarget);
  }
  return false;
}

async function handleSelectiveRetranslation(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/retranslations$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  if (hasInvalidSelectiveRetranslationPayload(ctx.res, body)) return true;
  const job = await ctx.jobManager.createSelectiveRetranslationJob(match[1], body);
  sendJson(ctx.res, 202, publicJob(job));
  return true;
}

function requirePageRevisionService(ctx) {
  if (ctx.pageRevisionService) return ctx.pageRevisionService;
  throw Object.assign(new Error("Page revision service is unavailable."), {
    statusCode: 503,
  });
}

async function handlePageRevisionActivation(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/page-revisions\/activate$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const service = requirePageRevisionService(ctx);
  const body = await readJsonBody(ctx.req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    badRequest(ctx.res, "Page revision activation body must be a JSON object.");
    return true;
  }
  const unknown = Object.keys(body).filter((field) => field !== "selections");
  if (unknown.length > 0) {
    badRequest(ctx.res, `Unsupported page revision activation fields: ${unknown.join(", ")}.`);
    return true;
  }
  sendJson(ctx.res, 200, await service.activate(match[1], body.selections));
  return true;
}

async function handlePageRevisionList(ctx) {
  const match = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/page-revisions$/);
  if (ctx.req.method !== "GET" || !match) return false;
  sendJson(ctx.res, 200, await requirePageRevisionService(ctx).list(match[1]));
  return true;
}

function sendDeepAuditReview(ctx, jobId) {
  const job = ctx.jobManager.getJob(jobId);
  if (!job) return notFound(ctx.res);
  const packagePath = job.result?.deepAuditReviewPackagePath;
  if (!packagePath || !fs.existsSync(packagePath)) return notFound(ctx.res);
  sendJson(ctx.res, 200, JSON.parse(fs.readFileSync(packagePath, "utf8")));
}

async function handleDeepAudit(ctx) {
  const createMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/deep-audit$/);
  const reviewMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/deep-audit\/review$/);
  if (ctx.req.method === "POST" && createMatch) {
    sendJson(ctx.res, 202, publicJob(ctx.jobManager.createTranslationDeepAuditJob(createMatch[1])));
    return true;
  }
  if (ctx.req.method === "GET" && reviewMatch) {
    sendDeepAuditReview(ctx, reviewMatch[1]);
    return true;
  }
  return false;
}

async function createQualityRepairJob(ctx, sourceJobId) {
  const sourceJob = ctx.jobManager.getJob(sourceJobId);
  if (!sourceJob) return notFound(ctx.res);
  await ctx.jobManager.assertAgentAvailableForTranslation?.(sourceJob.payload);
  await ctx.jobManager.preflightTranslationQualityRepair(sourceJobId);
  sendJson(ctx.res, 202, publicJob(ctx.jobManager.createTranslationQualityRepairJob(sourceJobId)));
}

async function handleTranslationFollowups(ctx) {
  if (ctx.req.method !== "POST") return false;
  const auditMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/deep-audit\/apply$/);
  const repairMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/quality-repair$/);
  const retryMatch = ctx.url.pathname.match(/^\/jobs\/([^/]+)\/knowledge-retry$/);
  if (auditMatch) {
    const body = await readJsonBody(ctx.req);
    await ctx.jobManager.assertKoharuAvailableForJobType?.("translation_deep_audit_apply", body);
    sendJson(ctx.res, 202, publicJob(ctx.jobManager.createTranslationDeepAuditApplyJob(auditMatch[1], body.decisions)));
    return true;
  }
  if (repairMatch) {
    await createQualityRepairJob(ctx, repairMatch[1]);
    return true;
  }
  if (!retryMatch) return false;
  sendJson(ctx.res, 202, publicJob(ctx.jobManager.createTranslationKnowledgeRetryJob(retryMatch[1])));
  return true;
}

function usesMachineTranslationPostEdit(ctx, body, translationTarget) {
  if (!isMachineTranslationTarget(translationTarget)) return false;
  const machineConfig = ctx.jobManager.resolvedConfig?.translation?.machineTranslation;
  if (body.translationMode === "reference_style") return machineConfig?.referencePostEdit !== false;
  return ["local_style", "learning_style"].includes(body.translationMode) && machineConfig?.learningPostEdit !== false;
}

function composeTranslationMemoryInspection(ctx, body, postEdit) {
  return ctx.translationMemoryComposer({
    translationMode: body.translationMode,
    qualityCheck: body.qualityCheck === true || postEdit,
    mangaId: body.mangaId || null,
    translatorId: body.translatorId || null,
    referenceTranslatorId: body.referenceTranslatorId || null,
    chapterId: body.chapterId || null,
    chapterTitle: body.chapterTitle || null,
    sourceChapterId: body.sourceChapterId || null,
    glossaryMode: body.glossaryMode || "canonical",
    sourceLanguage: body.sourceLanguage || null,
    targetLanguage: body.targetLanguage || config.defaults.targetLanguage,
  });
}

function translationMemoryBlockingReason(snapshot) {
  try {
    assertTranslationMemoryReady(snapshot);
    return null;
  } catch (error) {
    return error.message;
  }
}

function translationMemoryInspection(snapshot, translationTarget, postEdit) {
  const blockingReason = translationMemoryBlockingReason(snapshot);
  return {
    ready: !blockingReason,
    blockingReason,
    translationMode: snapshot.translationMode,
    translationTarget,
    machineTranslationPostEdit: postEdit,
    policy: snapshot.policy,
    fingerprint: snapshot.fingerprint,
    chapterMapping: snapshot.chapterMapping,
    readiness: snapshot.readiness,
    usage: snapshot.usage,
    warnings: snapshot.warnings,
  };
}

async function inspectTranslationMemory(ctx) {
  const body = await readJsonBody(ctx.req);
  const target =
    validateTranslationTargetShape(body.translationTarget) ||
    ctx.jobManager.resolvedConfig?.translation?.defaultTarget ||
    null;
  const postEdit = usesMachineTranslationPostEdit(ctx, body, target);
  const snapshot = composeTranslationMemoryInspection(ctx, body, postEdit);
  sendJson(ctx.res, 200, translationMemoryInspection(snapshot, target, postEdit));
}

async function handleTranslationMemoryInspection(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/translation/memory/inspect") return false;
  await inspectTranslationMemory(ctx);
  return true;
}

function buildPreviewMemory(ctx, body) {
  return ctx.translationMemoryComposer({
    translationMode: body.translationMode || "learning_style",
    qualityCheck: body.qualityCheck === true,
    mangaId: body.mangaId || null,
    translatorId: body.translatorId || null,
    referenceTranslatorId: body.referenceTranslatorId || null,
    chapterId: body.chapterId || null,
    chapterTitle: body.chapterTitle || null,
    sourceChapterId: body.sourceChapterId || null,
    glossaryMode: body.glossaryMode || "canonical",
    sourceLanguage: body.sourceLanguage || null,
    targetLanguage: body.targetLanguage || config.defaults.targetLanguage,
  });
}

async function runTranslationPreviewQuality(ctx, body, translations, memory) {
  if (!memory.policy.runQuality) {
    return { originalTranslations: translations, revisedTranslations: translations, optimizedTranslations: [], skipped: true };
  }
  return ctx.qualityModule.runPreview({
    mangaId: body.mangaId || null,
    translatorId: body.translatorId || null,
    chapterId: body.chapterId || null,
    glossaryMode: body.glossaryMode || "canonical",
    jobId: body.jobId || `translation_preview_${Date.now()}`,
    translations,
    translationMemory: memory,
    sourceLanguage: body.sourceLanguage || memory.languages?.sourceLanguage || null,
    targetLanguage: body.targetLanguage || config.defaults.targetLanguage,
  });
}

function qualityWithProjection(quality) {
  if (!quality.projectionPath) return quality;
  return { ...quality, projection: JSON.parse(fs.readFileSync(quality.projectionPath, "utf8")) };
}

function buildPreviewLearningEvidence(body, quality, memory) {
  if (!memory.policy.commitKnowledge) return null;
  return buildLearningEvidenceSnapshot({
    sourceTranslationJobId: body.jobId || null,
    chapterId: body.chapterId || null,
    finalTranslationSnapshotPath: null,
    finalTranslations: quality.revisedTranslations,
    translationMemory: memory,
    quality: qualityWithProjection(quality),
  });
}

async function previewTranslationKnowledge(ctx, body, learningEvidence, memory) {
  if (!memory.policy.commitKnowledge) return { persisted: false, skipped: true, delta: null };
  return ctx.knowledgeModule.preview({
    mangaId: body.mangaId || null,
    translatorId: body.translatorId || null,
    chapterId: body.chapterId || null,
    jobId: body.jobId || `translation_preview_${Date.now()}`,
    translations: [],
    learningEvidence,
  });
}

function translationPreviewResponse(memory, quality, knowledge) {
  return {
    translationMode: memory.translationMode,
    contextUsage: {
      fingerprint: memory.fingerprint,
      policy: memory.policy,
      chapterMapping: memory.chapterMapping,
      usage: memory.usage,
    },
    originalTranslations: quality.originalTranslations,
    revisedTranslations: quality.revisedTranslations,
    qualityReport: quality,
    knowledgeDelta: knowledge,
    warnings: memory.warnings,
  };
}

async function runTranslationPreview(ctx) {
  if (!ctx.qualityModule || !ctx.knowledgeModule) {
    sendJson(ctx.res, 503, { error: "Translation preview is not available." });
    return;
  }
  const body = await readJsonBody(ctx.req);
  const translations = Array.isArray(body.translations) ? body.translations : [];
  if (translations.length === 0) return badRequest(ctx.res, "translations is required.");
  const memory = buildPreviewMemory(ctx, body);
  const quality = await runTranslationPreviewQuality(ctx, body, translations, memory);
  const evidence = buildPreviewLearningEvidence(body, quality, memory);
  const knowledge = await previewTranslationKnowledge(ctx, body, evidence, memory);
  sendJson(ctx.res, 200, translationPreviewResponse(memory, quality, knowledge));
}

async function handleTranslationPreview(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/translation/preview") return false;
  await runTranslationPreview(ctx);
  return true;
}

function qualityPreviewInput(body, translations) {
  return {
    mangaId: body.mangaId || null,
    translatorId: body.translatorId || null,
    chapterId: body.chapterId || null,
    glossaryMode: body.glossaryMode || "canonical",
    jobId: body.jobId || null,
    translations,
  };
}

async function runQualityPreview(ctx) {
  if (!ctx.qualityModule || typeof ctx.qualityModule.runPreview !== "function") {
    sendJson(ctx.res, 503, { error: "Quality preview is not available." });
    return;
  }
  const body = await readJsonBody(ctx.req);
  const translations = Array.isArray(body.translations) ? body.translations : [];
  if (translations.length === 0) return badRequest(ctx.res, "translations is required.");
  const preview = await ctx.qualityModule.runPreview(qualityPreviewInput(body, translations));
  sendJson(ctx.res, 200, {
    ...preview,
    inputPreview: normalizeQualityPreviewTranslations(preview.originalTranslations),
    revisedPreview: normalizeQualityPreviewTranslations(preview.revisedTranslations),
  });
}

async function handleQualityPreview(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/quality/preview") return false;
  await runQualityPreview(ctx);
  return true;
}

async function handleTranslationPublication(ctx) {
  const match = ctx.url.pathname.match(/^\/translation-publications\/([^/]+)$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const translatorId = ctx.url.searchParams.get("translatorId");
  if (!translatorId) {
    badRequest(ctx.res, "translatorId is required.");
    return true;
  }
  const service = ctx.jobManager.engine.translationPublicationService;
  const registry = service.load(decodeURIComponent(match[1]), translatorId);
  const chapterId = ctx.url.searchParams.get("chapterId");
  sendJson(ctx.res, 200, chapterId ? registry.chapters[chapterId] || null : registry);
  return true;
}

const TRANSLATION_ROUTE_HANDLERS = [
  handleTranslationPublication,
  handleTranslationCreate,
  handleSelectiveRetranslation,
  handlePageRevisionActivation,
  handlePageRevisionList,
  handleDeepAudit,
  handleTranslationFollowups,
  handleTranslationMemoryInspection,
  handleTranslationPreview,
  handleQualityPreview,
];

async function handleTranslationRoutes(ctx) {
  for (const handler of TRANSLATION_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handleTranslationRoutes };
