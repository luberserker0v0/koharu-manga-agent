const { normalizeLanguageTag } = require("../../../language_codes");
const {
  deleteReferenceExtraction,
  deleteReferenceSet,
  importReferenceFolder,
  loadReferenceManifest,
  listReferenceSets,
} = require("../../../domains/reference/sets/reference_sets");
const { inspectChapterObservation } = require("../../../domains/reference/observation/reference_observation");
const {
  assertNoActiveJobs,
  hydrateReferenceDisplayLabels,
  matchingReferenceJobs,
  permanentlyDeleteMatchingJobs,
  resolveMangaDisplayLabel,
} = require("./reference_management");
const { applyManagedKoharuBaseUrl } = require("../runtime/runtime_context");
const { badRequest, notFound, readJsonBody, sendJson } = require("../../server/http_helpers");
const { publicSourcePreflight, streamPreflightImage } = require("./source_preflight_http");
const { publicJob, withoutInternalLocations } = require("../jobs/job_http");

async function handleReferenceList(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/references") return false;
  sendJson(ctx.res, 200, { referenceSets: withoutInternalLocations(hydrateReferenceDisplayLabels(listReferenceSets())) });
  return true;
}

function referenceImportOptions(ctx, body) {
  const mangaId = body.mangaId || null;
  return {
    sourceFolder: ctx.uploadService.resolveDirectory(body.uploadId, "reference"),
    label: body.label,
    language: normalizeLanguageTag(body.language),
    source: body.source || "imported_folder",
    referenceKind: body.referenceKind || "translator",
    mangaId,
    mangaLabel: resolveMangaDisplayLabel(mangaId, body.mangaLabel || null),
    translatorId: body.translatorId || null,
    translatorLabel: body.translatorLabel || body.translator || null,
    chapterId: body.chapterId || null,
    chapterTitle: body.chapterTitle || body.chapterLabel || null,
  };
}

async function handleReferenceImport(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/references/import") return false;
  const body = await readJsonBody(ctx.req);
  if (!validUploadRequest(ctx, body)) return true;
  const referenceSet = importReferenceFolder(referenceImportOptions(ctx, body));
  releaseUpload(ctx, body.uploadId);
  sendJson(ctx.res, 201, { referenceSet: withoutInternalLocations(referenceSet) });
  return true;
}

function validUploadRequest(ctx, body) {
  if (!String(body.uploadId || "").trim() || Object.prototype.hasOwnProperty.call(body, "sourceFolder")) {
    badRequest(ctx.res, "uploadId is required; sourceFolder is not accepted by this API.");
    return false;
  }
  if (!ctx.uploadService) {
    badRequest(ctx.res, "Upload service is unavailable.");
    return false;
  }
  return true;
}

function releaseUpload(ctx, uploadId) {
  try {
    ctx.uploadService.remove(uploadId);
  } catch (error) {
    console.warn(`Failed to release upload ${uploadId}: ${error.message}`);
  }
}

function sendPublicJson(res, status, payload) {
  sendJson(res, status, withoutInternalLocations(payload));
}

function requireExtractionReviewService(ctx) {
  if (ctx.extractionReviewService) return ctx.extractionReviewService;
  throw new Error("Extraction review service is not configured.");
}

async function prepareExtractionReviewRuntime(ctx) {
  if (!ctx.jobManager.koharuRuntimeManager) return;
  const status = await ctx.jobManager.koharuRuntimeManager.ensureRunning();
  applyManagedKoharuBaseUrl(ctx, status?.baseUrl);
  if (status?.baseUrl && ctx.extractionReviewService) ctx.extractionReviewService.baseUrl = status.baseUrl;
}

async function handleExtractionReviewRead(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/extraction-review$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const review = requireExtractionReviewService(ctx).get(match[1]);
  if (!review) notFound(ctx.res);
  else sendPublicJson(ctx.res, 200, { review });
  return true;
}

async function handleExtractionReviewSession(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/extraction-review\/session$/);
  if (!match || !["POST", "DELETE"].includes(ctx.req.method)) return false;
  const service = requireExtractionReviewService(ctx);
  if (ctx.req.method === "POST") {
    await prepareExtractionReviewRuntime(ctx);
    sendPublicJson(ctx.res, 201, { review: await service.start(match[1]) });
  } else {
    const body = await readJsonBody(ctx.req);
    sendPublicJson(ctx.res, 200, { review: await service.cancel(match[1], body.sessionId) });
  }
  return true;
}

async function handleExtractionReviewSync(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/extraction-review\/session\/sync$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const review = await requireExtractionReviewService(ctx).sync(match[1], body.sessionId);
  sendPublicJson(ctx.res, 200, { review });
  return true;
}

async function handleExtractionReviewFinish(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/extraction-review\/session\/finish$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const review = await requireExtractionReviewService(ctx).finish(match[1], body.sessionId);
  sendPublicJson(ctx.res, 200, { review });
  return true;
}

async function handleExtractionReviewOrder(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/extraction-review\/order$/);
  if (ctx.req.method !== "PUT" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const review = requireExtractionReviewService(ctx).saveOrder(match[1], body.pages);
  sendPublicJson(ctx.res, 200, { review });
  return true;
}

async function handleExtractionReviewConfirm(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/extraction-review\/confirm$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const review = requireExtractionReviewService(ctx).confirm(match[1]);
  sendPublicJson(ctx.res, 200, { review });
  return true;
}

async function handleReferenceDelete(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)$/);
  if (ctx.req.method !== "DELETE" || !match) return false;
  const referenceSetId = match[1];
  const jobs = matchingReferenceJobs(ctx.jobManager, (job) => job.payload?.referenceSetId === referenceSetId);
  assertNoActiveJobs(jobs);
  const deletedJobs = permanentlyDeleteMatchingJobs(ctx.jobManager, (job) =>
    jobs.some((candidate) => candidate.id === job.id),
  );
  sendPublicJson(ctx.res, 200, { deleted: deleteReferenceSet(referenceSetId), deletedJobs });
  return true;
}

function deleteReferenceExtractionData(ctx, referenceSetId) {
  const deletedExtraction = deleteReferenceExtraction(referenceSetId);
  const deletedJobs = permanentlyDeleteMatchingJobs(
    ctx.jobManager,
    (job) =>
      job.type === "reference_extraction" &&
      typeof job.payload?.referenceSetId === "string" &&
      job.payload.referenceSetId === referenceSetId,
  );
  return { deletedExtraction, deletedJobs };
}

async function handleReferenceExtractionDelete(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/extraction$/);
  if (ctx.req.method !== "DELETE" || !match) return false;
  sendPublicJson(ctx.res, 200, deleteReferenceExtractionData(ctx, match[1]));
  return true;
}

async function handleReferenceObservation(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/observation$/);
  if (ctx.req.method !== "GET" || !match) return false;
  sendPublicJson(ctx.res, 200, inspectChapterObservation(match[1]));
  return true;
}

function observationJobInput(referenceSetId) {
  const manifest = loadReferenceManifest(referenceSetId);
  return {
    referenceSetId: manifest.id,
    mangaId: manifest.mangaId || null,
    translatorId: manifest.translatorId || null,
    chapterId: manifest.chapterId,
    chapterTitle: manifest.chapterTitle || manifest.label,
  };
}

async function handleReferenceObservationRebuild(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/observation\/rebuild$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const job = ctx.jobManager.createReferenceObservationJob({ ...observationJobInput(match[1]), force: true });
  sendJson(ctx.res, 202, publicJob(job));
  return true;
}

async function handleReferenceDeepReview(ctx) {
  const match = ctx.url.pathname.match(/^\/references\/([^/]+)\/deep-review$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const job = ctx.jobManager.createReferenceDeepReviewJob({
    ...observationJobInput(match[1]),
    nodeKeys: Array.isArray(body.nodeKeys) ? body.nodeKeys : [],
    reviewReason: body.reviewReason || "manual_review",
  });
  sendJson(ctx.res, 202, publicJob(job));
  return true;
}

function requireTranslatorId(ctx) {
  const translatorId = ctx.url.searchParams.get("translatorId");
  if (translatorId) return translatorId;
  badRequest(ctx.res, "translatorId is required.");
  return null;
}

async function handleBilingualEvidence(ctx) {
  const match = ctx.url.pathname.match(/^\/knowledge\/([^/]+)\/bilingual-evidence$/);
  if (ctx.req.method !== "GET" || !match) return false;
  const translatorId = requireTranslatorId(ctx);
  if (!translatorId) return true;
  const module = ctx.jobManager.engine.referenceBilingualEnrichmentModule;
  sendPublicJson(ctx.res, 200, module.load({ mangaId: match[1], translatorId }));
  return true;
}

async function handleBilingualEnrichment(ctx) {
  const match = ctx.url.pathname.match(/^\/knowledge\/([^/]+)\/bilingual-enrichment$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const translatorId = requireTranslatorId(ctx);
  if (!translatorId) return true;
  const module = ctx.jobManager.engine.referenceBilingualEnrichmentModule;
  const prerequisites = module.inspectPrerequisites({ mangaId: match[1], translatorId });
  const job = ctx.jobManager.createReferenceBilingualEnrichmentJob({
    mangaId: match[1],
    translatorId,
    sourceFingerprint: prerequisites.source.fingerprint,
    targetFingerprint: prerequisites.target.fingerprint,
    trigger: "manual",
  });
  sendJson(ctx.res, 202, publicJob(job));
  return true;
}

async function handleBilingualEvidenceLink(ctx) {
  const match = ctx.url.pathname.match(/^\/knowledge\/([^/]+)\/bilingual-evidence\/links\/([^/]+)$/);
  if (ctx.req.method !== "PUT" || !match) return false;
  const translatorId = requireTranslatorId(ctx);
  if (!translatorId) return true;
  const body = await readJsonBody(ctx.req);
  const result = ctx.jobManager.engine.referenceBilingualEnrichmentModule.updateLink({
    mangaId: match[1],
    translatorId,
    linkId: match[2],
    action: body.action,
    sourceNodeKeys: body.sourceNodeKeys,
    targetNodeKeys: body.targetNodeKeys,
  });
  sendPublicJson(ctx.res, 200, result);
  return true;
}

async function handleSourcePreflightCreate(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/source-preflight") return false;
  const body = await readJsonBody(ctx.req);
  if (!validUploadRequest(ctx, body)) return true;
  const sourceFolder = ctx.uploadService.resolveDirectory(body.uploadId, "source");
  const result = ctx.sourcePreflightModule.preflight({ sourceFolder });
  releaseUpload(ctx, body.uploadId);
  sendJson(ctx.res, 200, publicSourcePreflight(result));
  return true;
}

async function handleSourcePreflightReorder(ctx) {
  const match = ctx.url.pathname.match(/^\/source-preflight\/([^/]+)\/reorder$/);
  if (ctx.req.method !== "POST" || !match) return false;
  const body = await readJsonBody(ctx.req);
  const result = ctx.sourcePreflightModule.reorder({ preflightId: match[1], orderedImageIds: body.orderedImageIds });
  sendJson(ctx.res, 200, publicSourcePreflight(result));
  return true;
}

async function handleSourcePreflightImage(ctx) {
  const match = ctx.url.pathname.match(/^\/source-preflight\/([^/]+)\/images\/([^/]+)\/content$/);
  if (ctx.req.method !== "GET" || !match) return false;
  streamPreflightImage(ctx.res, ctx.sourcePreflightModule.resolvePreviewImage(match[1], match[2]));
  return true;
}

async function handleSourcePreflightRead(ctx) {
  const match = ctx.url.pathname.match(/^\/source-preflight\/([^/]+)$/);
  if (ctx.req.method !== "GET" || !match) return false;
  sendJson(ctx.res, 200, publicSourcePreflight(ctx.sourcePreflightModule.get(match[1])));
  return true;
}

async function handleReferenceExtractionJob(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/jobs/reference-extraction") return false;
  const body = await readJsonBody(ctx.req);
  await ctx.jobManager.assertKoharuAvailableForJobType?.("reference_extraction", body);
  sendJson(ctx.res, 202, publicJob(ctx.jobManager.createReferenceExtractionJob(body)));
  return true;
}

function invalidReferenceIngestion(res, input) {
  if (!input.chapterId || !String(input.chapterId).trim()) {
    badRequest(res, "chapterId is required for reference ingestion jobs.");
    return true;
  }
  if (input.useForTerminology === false && input.useForStyle === false) {
    badRequest(res, "Reference ingestion requires terminology or style usage to be enabled.");
    return true;
  }
  return false;
}

async function handleReferenceIngestionJob(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/jobs/reference-ingestion") return false;
  const body = await readJsonBody(ctx.req);
  if (invalidReferenceIngestion(ctx.res, body)) return true;
  sendJson(ctx.res, 202, publicJob(ctx.jobManager.createReferenceIngestionJob(body)));
  return true;
}

function invalidReferenceIngestionBatch(res, items) {
  if (items.length === 0) {
    badRequest(res, "Reference ingestion batch requires at least one item.");
    return true;
  }
  if (items.some((item) => !item.chapterId || !String(item.chapterId).trim())) {
    badRequest(res, "Every reference ingestion item requires chapterId.");
    return true;
  }
  if (items.some((item) => item.useForTerminology === false && item.useForStyle === false)) {
    badRequest(res, "Every reference ingestion item requires terminology or style usage.");
    return true;
  }
  return false;
}

async function handleReferenceIngestionBatch(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/jobs/reference-ingestion/batch") return false;
  const body = await readJsonBody(ctx.req);
  const items = Array.isArray(body.items) ? body.items : [];
  if (invalidReferenceIngestionBatch(ctx.res, items)) return true;
  sendJson(ctx.res, 202, { jobs: ctx.jobManager.createReferenceIngestionJobs(items).map(publicJob) });
  return true;
}

const REFERENCE_ROUTE_HANDLERS = [
  handleReferenceList,
  handleReferenceImport,
  handleExtractionReviewRead,
  handleExtractionReviewSession,
  handleExtractionReviewSync,
  handleExtractionReviewFinish,
  handleExtractionReviewOrder,
  handleExtractionReviewConfirm,
  handleReferenceDelete,
  handleReferenceExtractionDelete,
  handleReferenceObservation,
  handleReferenceObservationRebuild,
  handleReferenceDeepReview,
  handleBilingualEvidence,
  handleBilingualEnrichment,
  handleBilingualEvidenceLink,
  handleSourcePreflightCreate,
  handleSourcePreflightReorder,
  handleSourcePreflightImage,
  handleSourcePreflightRead,
  handleReferenceExtractionJob,
  handleReferenceIngestionJob,
  handleReferenceIngestionBatch,
];

async function handleReferenceRoutes(ctx) {
  for (const handler of REFERENCE_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handleReferenceRoutes };
