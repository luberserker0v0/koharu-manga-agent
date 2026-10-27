const { resolveTranslationModePolicy } = require("../../translation/modes/translation_modes");
const {
  isMachineTranslationTarget,
  resolveTranslationTarget,
} = require("../../../integrations/koharu/translation/translation_targets");

function createTranslationJob(manager, payload) {
  const translationTarget = payload?.translationTarget || manager.resolvedConfig.translation?.defaultTarget || null;
  const policy = resolveTranslationModePolicy(payload?.translationMode, payload?.qualityCheck === true);
  const obsoleteFields = ["referenceSetId", "ingestReference", "knowledgeBuilder", "sourceFolder"].filter((field) =>
    Object.prototype.hasOwnProperty.call(payload, field),
  );
  if (obsoleteFields.length > 0) {
    throw new Error(`Obsolete translation payload fields are not supported: ${obsoleteFields.join(", ")}.`);
  }
  if (policy.useReferenceMemory && !payload?.referenceTranslatorId) {
    throw new Error(`${payload.translationMode} requires referenceTranslatorId.`);
  }
  if (payload?.translationMode === "learning_style" && payload.translatorId === payload.referenceTranslatorId) {
    throw new Error("Learning Style requires a separate learning clone profile.");
  }
  return manager.createJob("translation", {
    ...payload,
    ...(translationTarget ? { translationTarget } : {}),
  });
}

function normalizeLanguage(value, fieldName) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${fieldName} must be a non-empty BCP 47 language tag.`);
    error.statusCode = 400;
    error.code = "invalid_language";
    throw error;
  }
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    const error = new Error(`${fieldName} must be a valid BCP 47 language tag.`);
    error.statusCode = 422;
    error.code = "invalid_language";
    throw error;
  }
}

function validateTranslationRevisionSourceJob(sourceJob) {
  if (!sourceJob || sourceJob.type !== "translation") {
    const error = new Error("Translation revision requires a Translation Job.");
    error.statusCode = sourceJob ? 409 : 404;
    error.code = sourceJob ? "invalid_retranslation_source" : "translation_job_not_found";
    throw error;
  }
  if (sourceJob.status !== "succeeded") {
    const error = new Error("Translation revision requires a succeeded Translation Job.");
    error.statusCode = 409;
    error.code = "translation_job_not_completed";
    throw error;
  }
}

function validateTranslationRevisionImageIds(request) {
  if (!Array.isArray(request.sourceImageIds) || request.sourceImageIds.length === 0) {
    const error = new Error("sourceImageIds must be a non-empty array.");
    error.statusCode = 400;
    error.code = "invalid_source_image_selection";
    throw error;
  }
  const sourceImageIds = request.sourceImageIds.map(
    (value) => (typeof value === "string" ? value.trim() : ""),
  );
  if (sourceImageIds.some((value) => !value)) {
    const error = new Error("Every sourceImageId must be a non-empty string.");
    error.statusCode = 400;
    error.code = "invalid_source_image_selection";
    throw error;
  }
  if (new Set(sourceImageIds).size !== sourceImageIds.length) {
    const error = new Error("sourceImageIds must be unique.");
    error.statusCode = 400;
    error.code = "duplicate_source_image_selection";
    throw error;
  }
  return sourceImageIds;
}

function resolveTranslationRevisionSource(manager, sourceJob, sourceImageIds) {
  const rootJobId = sourceJob.payload?.revision?.rootJobId || sourceJob.id;
  const rootJob = manager.store.getJob(rootJobId);
  const sourcePreflightId = rootJob?.payload?.sourcePreflightId;
  if (!rootJob || rootJob.type !== "translation" || !sourcePreflightId) {
    const error = new Error("The translation revision root no longer retains a source preflight.");
    error.statusCode = 409;
    error.code = "source_preflight_unavailable";
    throw error;
  }
  const sourceSelection = manager.engine.sourcePreflightModule?.resolveSourceSelection(
    sourcePreflightId,
    sourceImageIds,
  );
  if (!sourceSelection) {
    const error = new Error("Source preflight support is unavailable.");
    error.statusCode = 503;
    error.code = "source_preflight_service_unavailable";
    throw error;
  }
  return { rootJobId, sourcePreflightId, sourceSelection };
}

function buildTranslationRevisionBasePayload(sourceJob, sourceContext, options) {
  const { sourceSelection, rootJobId, sourcePreflightId } = sourceContext;
  const sourceImageIds = sourceSelection.images.map((image) => image.id);
  const inheritedPayload = { ...sourceJob.payload };
  delete inheritedPayload.regionCorrections;
  const payload = {
    ...inheritedPayload,
    sourcePreflightId,
    sourceImageIds,
    revision: {
      rootJobId,
      parentJobId: sourceJob.id,
      reason: options.reason,
      sourceImageIds,
      ...(options.revision || {}),
    },
    ...(options.payload || {}),
  };
  delete payload.outputDir;
  delete payload.baseUrl;
  delete payload.resumeFromTranslation;
  delete payload.sourceImagePaths;
  return payload;
}

function validateRetranslationRequestFields(payload, request) {
  for (const field of ["targetLanguage", "sourceLanguage"]) {
    if (Object.prototype.hasOwnProperty.call(request, field) && request[field] == null) {
      const error = new Error(`${field} must be a non-empty BCP 47 language tag.`);
      error.statusCode = 400;
      error.code = "invalid_language";
      throw error;
    }
  }
  if (payload.instructions == null && !Object.prototype.hasOwnProperty.call(request, "instructions")) return;
  if (typeof payload.instructions !== "string" || !payload.instructions.trim()) {
    const error = new Error("instructions must be a non-empty string when provided.");
    error.statusCode = 400;
    error.code = "invalid_retranslation_instructions";
    throw error;
  }
  payload.instructions = payload.instructions.trim();
}

function applyTranslationRevisionRequestFields(manager, payload, request) {
  for (const field of ["translationTarget", "generationOptions", "targetLanguage", "sourceLanguage", "instructions"]) {
    if (Object.prototype.hasOwnProperty.call(request, field)) payload[field] = request[field];
  }
  validateRetranslationRequestFields(payload, request);
  payload.sourceLanguage = normalizeLanguage(payload.sourceLanguage, "sourceLanguage");
  payload.targetLanguage = normalizeLanguage(
    payload.targetLanguage || manager.resolvedConfig.defaults?.targetLanguage,
    "targetLanguage",
  );
}

function buildTranslationRevisionPayload(manager, sourceJob, request, sourceContext, options) {
  const payload = buildTranslationRevisionBasePayload(sourceJob, sourceContext, options);
  applyTranslationRevisionRequestFields(manager, payload, request);
  return payload;
}

async function getTranslationRevisionCatalog(manager, client, payload) {
  try {
    return await client.getTranslationCatalog(payload.baseUrl || manager.resolvedConfig.api?.baseUrl);
  } catch (cause) {
    const error = new Error("Koharu translation-provider catalog is unavailable.");
    error.statusCode = 503;
    error.code = "translation_provider_catalog_unavailable";
    error.cause = cause;
    throw error;
  }
}

function assertRetranslationInstructionsSupported(payload, resolvedTarget) {
  if (!payload.instructions || resolvedTarget.kind !== "machine_translation") return;
  const error = new Error(
    `Translation target ${resolvedTarget.providerId}/${resolvedTarget.modelId} does not support retranslation instructions.`,
  );
  error.statusCode = 422;
  error.code = "unsupported_retranslation_instructions";
  throw error;
}

async function resolveTranslationRevisionTarget(manager, payload) {
  const translationTarget = payload.translationTarget || manager.resolvedConfig.translation?.defaultTarget || null;
  const client = manager.engine?.projectLifecycle?.client;
  if (!client?.getTranslationCatalog) {
    const error = new Error("Koharu translation-provider validation is unavailable.");
    error.statusCode = 503;
    error.code = "translation_provider_catalog_unavailable";
    throw error;
  }
  const catalog = await getTranslationRevisionCatalog(manager, client, payload);
  const resolvedTarget = resolveTranslationTarget({
    catalog,
    requestedTarget: translationTarget,
    defaultTarget: manager.resolvedConfig.translation?.defaultTarget || null,
    targetLanguage: payload.targetLanguage,
  });
  assertRetranslationInstructionsSupported(payload, resolvedTarget);
  payload.translationTarget = { providerId: resolvedTarget.providerId, modelId: resolvedTarget.modelId };
}

async function assertAgentAvailableForTranslation(manager, payload) {
  const policy = resolveTranslationModePolicy(payload?.translationMode, payload?.qualityCheck === true);
  const translationTarget = payload?.translationTarget || manager.resolvedConfig.translation?.defaultTarget || null;
  const machineSettings = manager.resolvedConfig.translation?.machineTranslation || {};
  const machineTranslationPostEdit = isMachineTranslationTarget(translationTarget) &&
    ((payload?.translationMode === "reference_style" && machineSettings.referencePostEdit !== false) ||
      (["local_style", "learning_style"].includes(payload?.translationMode) &&
        machineSettings.learningPostEdit !== false));
  const requiresAgent = policy.useReferenceMemory ||
    policy.runQuality ||
    policy.commitKnowledge ||
    machineTranslationPostEdit;
  if (!requiresAgent || !manager.aoClient?.checkAvailability) {
    return { required: requiresAgent, available: null };
  }
  await manager.aoClient.checkAvailability({ timeoutMs: 3000 });
  return { required: true, available: true };
}

async function createTranslationRevisionJob(manager, sourceJobId, request, options) {
  const sourceJob = manager.store.getJob(sourceJobId);
  validateTranslationRevisionSourceJob(sourceJob);
  const prepared = options.prepare ? await options.prepare(sourceJob, request) : options;
  const sourceImageIds = validateTranslationRevisionImageIds({ sourceImageIds: prepared.sourceImageIds });
  const sourceContext = resolveTranslationRevisionSource(manager, sourceJob, sourceImageIds);
  const payload = buildTranslationRevisionPayload(manager, sourceJob, request, sourceContext, prepared);
  await resolveTranslationRevisionTarget(manager, payload);
  await assertAgentAvailableForTranslation(manager, payload);
  await manager.assertKoharuAvailableForJobType("translation", payload);
  return manager.createJob("translation", payload, { parentJobId: sourceJob.id });
}

async function createTextRegionCorrectionJob(manager, sourceJobId, request = {}) {
  if (!manager.textRegionCorrectionService) {
    const error = new Error("Text-region correction service is unavailable.");
    error.statusCode = 503;
    error.code = "text_region_service_unavailable";
    throw error;
  }
  return createTranslationRevisionJob(manager, sourceJobId, request, {
    prepare: (sourceJob, input) => manager.textRegionCorrectionService.prepare(sourceJob, input),
  });
}

async function createSelectiveRetranslationJob(manager, sourceJobId, request = {}) {
  return createTranslationRevisionJob(manager, sourceJobId, request, {
    reason: "selective_retranslation",
    sourceImageIds: request.sourceImageIds,
  });
}

module.exports = {
  assertAgentAvailableForTranslation,
  createSelectiveRetranslationJob,
  createTextRegionCorrectionJob,
  createTranslationRevisionJob,
  createTranslationJob,
  normalizeLanguage,
};
