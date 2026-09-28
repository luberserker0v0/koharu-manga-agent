const MACHINE_TRANSLATION_PROVIDERS = new Set([
  "deepl",
  "google-translate",
  "google-cloud-translation",
  "caiyun",
]);

function targetError(message, statusCode = 422, code = "invalid_translation_target") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeModel(model, fallbackProviderId, fallbackKind = "provider") {
  const target = model?.target || {};
  const modelId = target.modelId || model?.modelId || model?.id;
  if (!modelId) return null;
  return {
    modelId,
    name: model?.name || modelId,
    languages: Array.isArray(model?.languages) ? model.languages : [],
    targetKind: target.kind || fallbackKind,
    providerId: target.providerId || fallbackProviderId,
  };
}

function normalizeTranslationCatalog(catalog) {
  const providers = [];
  const localModels = (Array.isArray(catalog?.localModels) ? catalog.localModels : [])
    .map((model) => normalizeModel(model, "local", "local"))
    .filter(Boolean);
  if (localModels.length > 0) {
    providers.push({
      providerId: "local",
      name: "Local",
      kind: "local_llm",
      status: "ready",
      hasCredential: null,
      models: localModels,
    });
  }

  for (const provider of Array.isArray(catalog?.providers) ? catalog.providers : []) {
    const providerId = provider?.id || provider?.providerId;
    if (!providerId) continue;
    const models = (Array.isArray(provider.models) ? provider.models : [])
      .map((model) => normalizeModel(model, providerId))
      .filter(Boolean);
    providers.push({
      providerId,
      name: provider.name || providerId,
      kind: MACHINE_TRANSLATION_PROVIDERS.has(providerId)
        ? "machine_translation"
        : "hosted_llm",
      status: provider.status || (provider.requiresApiKey && !provider.hasApiKey
        ? "missing_configuration"
        : "ready"),
      hasCredential: typeof provider.hasApiKey === "boolean" ? provider.hasApiKey : null,
      requiresCredential: provider.requiresApiKey === true,
      models,
      error: provider.error || null,
    });
  }

  return { providers };
}

function resolveTranslationTarget({ catalog, requestedTarget, defaultTarget, targetLanguage }) {
  const selected = requestedTarget || defaultTarget;
  if (!selected || typeof selected !== "object") {
    throw targetError("A translation target is required.");
  }
  const providerId = typeof selected.providerId === "string" ? selected.providerId.trim() : "";
  const modelId = typeof selected.modelId === "string" ? selected.modelId.trim() : "";
  if (!providerId || !modelId) {
    throw targetError("translationTarget requires providerId and modelId.");
  }

  const normalized = normalizeTranslationCatalog(catalog);
  const provider = normalized.providers.find((entry) => entry.providerId === providerId);
  if (!provider) {
    throw targetError(`Unknown translation provider: ${providerId}.`);
  }
  const model = provider.models.find((entry) => entry.modelId === modelId);
  if (!model) {
    throw targetError(`Unknown translation model ${modelId} for provider ${providerId}.`);
  }
  if (provider.status !== "ready") {
    throw targetError(
      `Translation provider ${providerId} is not ready (${provider.status}).`,
      409,
      "translation_provider_not_ready"
    );
  }
  if (targetLanguage && model.languages.length > 0 && !model.languages.includes(targetLanguage)) {
    throw targetError(
      `Translation target ${providerId}/${modelId} does not support ${targetLanguage}.`,
      422,
      "unsupported_translation_language"
    );
  }

  return {
    kind: provider.kind,
    providerId,
    modelId,
    targetKind: model.targetKind || (providerId === "local" ? "local" : "provider"),
    name: model.name,
    languages: model.languages,
  };
}

function validateTranslationTargetShape(target) {
  if (target == null) return null;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw targetError("translationTarget must be an object.", 400);
  }
  const keys = Object.keys(target);
  if (keys.some((key) => !["providerId", "modelId"].includes(key))) {
    throw targetError("translationTarget only accepts providerId and modelId.", 400);
  }
  const providerId = typeof target.providerId === "string" ? target.providerId.trim() : "";
  const modelId = typeof target.modelId === "string" ? target.modelId.trim() : "";
  if (!providerId || !modelId) {
    throw targetError("translationTarget requires providerId and modelId.", 400);
  }
  return { providerId, modelId };
}

function isMachineTranslationTarget(target) {
  return Boolean(target && MACHINE_TRANSLATION_PROVIDERS.has(target.providerId));
}

module.exports = {
  MACHINE_TRANSLATION_PROVIDERS,
  normalizeTranslationCatalog,
  resolveTranslationTarget,
  validateTranslationTargetShape,
  isMachineTranslationTarget,
};
