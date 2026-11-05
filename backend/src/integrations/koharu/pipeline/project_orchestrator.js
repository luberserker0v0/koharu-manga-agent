const path = require("path");
const { config } = require("../../../config");
const { preflightImagesForKoharuUpload } = require("../../../domains/reference/extraction/reference_image_conversion");
const { resolveTranslationTarget } = require("../../../domains/manga_processing/translation_targets");
const { sourceLanguageList } = require("../../../domains/manga_processing/source_languages");
const { resolveKoharuOcr } = require("./ocr_language_policy");

const ENGINE_ORDER = [
  { key: "detect", catalogKeys: ["detectors"], required: true },
  {
    key: "fontDetect",
    catalogKeys: ["fontDetectors", "detectors"],
    required: false,
  },
  { key: "segment", catalogKeys: ["segmenters", "detectors"], required: false },
  {
    key: "bubbleSegment",
    catalogKeys: ["bubbleSegmenters", "detectors"],
    required: false,
  },
  { key: "ocr", catalogKeys: ["ocr"], required: true },
  { key: "translate", catalogKeys: ["translators"], required: true },
  { key: "clean", catalogKeys: ["inpainters"], required: true },
  { key: "render", catalogKeys: ["renderers"], required: true },
];

function createProjectName(date = new Date()) {
  const timestamp = date
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);
  return `translate_${timestamp}`;
}

function collectExistingPageNames(scene) {
  const pages = scene?.scene?.pages || {};
  return new Set(
    Object.values(pages)
      .map((page) => page?.name)
      .filter(Boolean),
  );
}

async function uploadPagesWithFromPaths(processor, pathsToUpload, baseUrl) {
  const data = await processor.uploadPagesFromPaths(pathsToUpload, baseUrl, { replace: false });
  return data ? { method: "from-paths", data } : null;
}

async function uploadPagesWithMultipart(processor, pathsToUpload, baseUrl) {
  return { method: "multipart", data: await processor.uploadPagesMultipart(pathsToUpload, baseUrl) };
}

function buildSkippedUploadResult(imagePaths, preflight) {
  return {
    method: "skipped",
    uploaded: 0,
    skipped: imagePaths.map((filePath) => path.basename(filePath)),
    data: null,
    converted: preflight.converted,
  };
}

async function uploadByMode(processor, mode, pathsToUpload, baseUrl) {
  return mode === "multipart"
    ? await uploadPagesWithMultipart(processor, pathsToUpload, baseUrl)
    : mode === "from-paths"
      ? await uploadPagesWithFromPaths(processor, pathsToUpload, baseUrl)
      : (await uploadPagesWithFromPaths(processor, pathsToUpload, baseUrl)) ||
        (await uploadPagesWithMultipart(processor, pathsToUpload, baseUrl));
}

function buildUploadedResult(result, pathsToUpload, imagePaths, existingNames, preflight) {
  return {
    ...result,
    uploaded: pathsToUpload.length,
    skipped: imagePaths
      .filter((filePath) => existingNames.has(path.basename(filePath)))
      .map((filePath) => path.basename(filePath)),
    converted: preflight.converted,
  };
}

async function uploadPages(processor, imagePaths, baseUrl,
  { mode = config.api?.pageUploadMode || "auto" } = {}) {
  const existingNames = collectExistingPageNames(await processor.getScene(baseUrl));
  const pendingPaths = imagePaths.filter((filePath) => !existingNames.has(path.basename(filePath)));
  const preflight = preflightImagesForKoharuUpload(pendingPaths);
  const pathsToUpload = preflight.uploadPaths;
  if (pathsToUpload.length === 0) return buildSkippedUploadResult(imagePaths, preflight);
  if (!["auto", "multipart", "from-paths"].includes(mode))
    throw new Error(`Unsupported Koharu page upload mode: ${mode}`);
  const result = await uploadByMode(processor, mode, pathsToUpload, baseUrl);
  if (!result) throw new Error(`Koharu page upload failed in ${mode} mode.`);
  return buildUploadedResult(result, pathsToUpload, imagePaths, existingNames, preflight);
}

async function getCurrentTranslationTarget(processor, baseUrl) {
  const data = await processor.getCurrentTranslationTarget(baseUrl);
  if (!data) throw new Error("Get current translation target returned an empty response");
  return data;
}

function matchesRequestedTarget(current, modelId, providerId, targetKind = "provider") {
  const target = current?.target;
  if (!target || target.modelId !== modelId) return false;
  return targetKind === "local"
    ? target.kind === "local" && target.providerId == null
    : target.kind === "provider" && target.providerId === providerId;
}

async function verifyEmptyTargetResponse(processor, modelId, baseUrl, providerId, targetKind) {
  const current = await getCurrentTranslationTarget(processor, baseUrl);
  if (!matchesRequestedTarget(current, modelId, providerId, targetKind)) {
    throw new Error("Load translation target returned an empty response and current target does not match the requested target");
  }
  return {
    modelId,
    providerId: targetKind === "local" ? "local" : providerId,
    data: current,
    verifiedAfterEmptyBody: true,
  };
}

async function loadModelTarget(processor, modelId, baseUrl, providerId,
  targetKind = "provider", generationOptions = null) {
  const target = { kind: targetKind, modelId, providerId: targetKind === "local" ? null : providerId };
  const data = await processor.setTranslationTarget(target, baseUrl, generationOptions);
  if (!data) return verifyEmptyTargetResponse(processor, modelId, baseUrl, providerId, targetKind);
  return {
    modelId,
    providerId: targetKind === "local" ? "local" : providerId,
    data,
  };
}

async function loadTranslationTarget(processor, baseUrl, requestedTarget = null,
  targetLanguage = null, generationOptions = null) {
  const catalog = await processor.getTranslationCatalog(baseUrl);
  const selected = resolveTranslationTarget({
    catalog,
    requestedTarget,
    defaultTarget: config.translation?.defaultTarget,
    targetLanguage,
  });
  const effectiveOptions = selected.kind === "machine_translation" || generationOptions?.temperature == null
    ? null : { temperature: generationOptions.temperature };
  const loaded = await loadModelTarget(
    processor, selected.modelId, baseUrl, selected.providerId, selected.targetKind, effectiveOptions,
  );
  return {
    ...selected,
    data: loaded.data,
    generationOptions: effectiveOptions,
    verifiedAfterEmptyBody: loaded.verifiedAfterEmptyBody === true,
  };
}

function providerPatch(provider, proxy) {
  return {
    id: provider.id,
    baseUrl: provider.id === proxy.providerId ? proxy.baseUrl : provider.base_url || provider.baseUrl,
    apiKey: provider.api_key || provider.apiKey || "[REDACTED]",
  };
}

async function ensureTranslationProviderProxy(processor, koharuBaseUrl, proxy) {
  if (!proxy?.providerId || !proxy?.baseUrl) return null;
  const current = await processor.getConfig(koharuBaseUrl);
  const providers = Array.isArray(current.providers) ? current.providers : [];
  const target = providers.find((provider) => provider?.id === proxy.providerId);
  if (!target) throw new Error(`Koharu provider is unavailable: ${proxy.providerId}.`);
  if ((target.base_url || target.baseUrl) === proxy.baseUrl) {
    return { changed: false, providerId: proxy.providerId, baseUrl: proxy.baseUrl };
  }
  await processor.patchConfig({ providers: providers.map((provider) => providerPatch(provider, proxy)) }, koharuBaseUrl);
  return { changed: true, providerId: proxy.providerId, baseUrl: proxy.baseUrl };
}

function pickEngineFromCatalog(engineKey, catalog, excludedIds = new Set()) {
  const definition = ENGINE_ORDER.find((entry) => entry.key === engineKey);
  if (!definition) return null;
  for (const catalogKey of definition.catalogKeys) {
    const options = Array.isArray(catalog[catalogKey]) ? catalog[catalogKey] : [];
    const selected = options.find((option) => option?.id && !excludedIds.has(option.id));
    if (selected) return selected.id;
  }
  return null;
}

function catalogHasEngine(engineKey, engineId, catalog) {
  const definition = ENGINE_ORDER.find((entry) => entry.key === engineKey);
  return Boolean(
    definition &&
      engineId &&
      definition.catalogKeys.some((catalogKey) => {
        const options = Array.isArray(catalog[catalogKey]) ? catalog[catalogKey] : [];
        return options.some((option) => option?.id === engineId);
      }),
  );
}

function resolveConfiguredOcr(catalog, configuredEngines, sourceLanguage) {
  const configured = configuredEngines && typeof configuredEngines === "object" ? configuredEngines : {};
  const selected = resolveKoharuOcr({
    catalog,
    configuredEngine: configured.ocr || null,
    sourceLanguage,
  });
  return { engines: { ...configured, ocr: selected.engineId },
    ocrLanguageResolution: selected.resolution };
}

function resolveCatalogEngines(catalog, initialEngines) {
  const resolved = { ...initialEngines };
  const usedEngineIds = new Set();
  for (const definition of ENGINE_ORDER) {
    const configured = resolved[definition.key];
    if (configured && !catalogHasEngine(definition.key, configured, catalog)) {
      throw new Error(`Configured Koharu engine is unavailable: ${definition.key}=${configured}.`);
    }
    if (configured && usedEngineIds.has(configured)) {
      throw new Error(`Configured Koharu engine is duplicated: ${configured}.`);
    }
    if (configured) {
      usedEngineIds.add(configured);
      continue;
    }
    const selected = pickEngineFromCatalog(definition.key, catalog, usedEngineIds);
    if (selected) {
      resolved[definition.key] = selected;
      usedEngineIds.add(selected);
    } else if (definition.required) {
      throw new Error(`Unable to resolve required engine: ${definition.key}`);
    } else {
      delete resolved[definition.key];
    }
  }
  return resolved;
}

async function resolveEnginePlan(processor, baseUrl, configuredEngines = null, sourceLanguage = null) {
  const catalog = await processor.getEngines(baseUrl);
  const initial = resolveConfiguredOcr(catalog, configuredEngines, sourceLanguage);
  const resolved = resolveCatalogEngines(catalog, initial.engines);
  return { engines: resolved, ocrLanguageResolution: initial.ocrLanguageResolution };
}

async function resolveEngines(processor, baseUrl, configuredEngines = null, sourceLanguage = null) {
  const plan = await resolveEnginePlan(processor, baseUrl, configuredEngines, sourceLanguage);
  return plan.engines;
}

function buildPipelineSteps(engines) {
  const steps = ENGINE_ORDER.map((entry) => engines[entry.key]).filter(Boolean);
  if (steps.length === 0) throw new Error("No pipeline steps resolved from engine configuration");
  return steps;
}

async function startPipeline(
  processor, steps, targetLanguage, baseUrl, systemPrompt = null, sourceLanguage = null,
) {
  const sourceLanguages = sourceLanguageList(sourceLanguage);
  const operationId = await processor.startPipeline({
    steps, targetLanguage, systemPrompt, sourceLanguages, baseUrl,
  });
  if (!operationId) throw new Error("Start pipeline response did not include operationId");
  return { operationId };
}

async function createAndOpenProject(processor, baseUrl) {
  const projectName = createProjectName();
  const created = await processor.createProject(projectName, baseUrl);
  const projectId = created.id || created.project?.id || projectName;
  await processor.openProject(projectId, baseUrl);
  return { projectName, projectId };
}

async function prepareProject(processor, options) {
  const translationProxy = await ensureTranslationProviderProxy(processor, options.baseUrl, options.translationProxy);
  const translationTarget = await loadTranslationTarget(
    processor, options.baseUrl,
    options.translationTarget || null,
    options.targetLanguage || null,
    options.generationOptions || null,
  );
  const enginePlan = await resolveEnginePlan(
    processor, options.baseUrl, options.engines, options.sourceLanguage,
  );
  const { projectName } = await createAndOpenProject(processor, options.baseUrl);
  const upload = await uploadPages(processor, options.sourceImagePaths, options.baseUrl);
  return { projectName, upload, engines: enginePlan.engines,
    ocrLanguageResolution: enginePlan.ocrLanguageResolution, translationTarget, translationProxy };
}

async function orchestrate(processor, options) {
  const prepared = await prepareProject(processor, options);
  const { engines } = prepared;
  const steps = buildPipelineSteps(engines);
  const pipeline = await startPipeline(
    processor, steps, options.targetLanguage, options.baseUrl, options.systemPrompt, options.sourceLanguage,
  );
  return {
    ...prepared,
    operationId: pipeline.operationId,
    engines,
    steps,
  };
}

function createProjectOrchestrator(processor) {
  return {
    ensureTranslationProviderProxy: (...args) => ensureTranslationProviderProxy(processor, ...args),
    loadTranslationTarget: (...args) => loadTranslationTarget(processor, ...args),
    orchestrate: (options) => orchestrate(processor, options),
    prepareProject: (options) => prepareProject(processor, options),
    resolveEngines: (...args) => resolveEngines(processor, ...args),
    startPipeline: (...args) => startPipeline(processor, ...args),
    uploadPages: (...args) => uploadPages(processor, ...args),
  };
}

module.exports = {
  ENGINE_ORDER,
  buildPipelineSteps,
  createProjectName,
  createProjectOrchestrator,
};
