const fs = require("fs");
const path = require("path");
const { config } = require("../../../config");
const {
  apiFetch,
  buildUrl,
  ENDPOINTS,
} = require("../client/koharu_client");
const {
  preflightImagesForKoharuUpload,
} = require("../../../domains/reference/extraction/reference_image_conversion");
const {
  resolveTranslationTarget,
} = require("../translation/translation_targets");

const ENGINE_ORDER = [
  { key: "detect", catalogKeys: ["detectors"], required: true },
  { key: "fontDetect", catalogKeys: ["fontDetectors", "detectors"], required: false },
  { key: "segment", catalogKeys: ["segmenters", "detectors"], required: false },
  { key: "bubbleSegment", catalogKeys: ["bubbleSegmenters", "detectors"], required: false },
  { key: "ocr", catalogKeys: ["ocr"], required: true },
  { key: "translate", catalogKeys: ["translators"], required: true },
  { key: "clean", catalogKeys: ["inpainters"], required: true },
  { key: "render", catalogKeys: ["renderers"], required: true },
];

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function readOptionalJson(response) {
  const text = await readResponseText(response);
  return text ? JSON.parse(text) : null;
}

async function ensureOkJson(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${await readResponseText(response)}`);
  }
  return response.json();
}

function createProjectName(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  return `translate_${timestamp}`;
}

async function getScene(baseUrl) {
  const response = await apiFetch(ENDPOINTS.SCENE, { baseUrl });
  return response.ok ? response.json() : null;
}

function collectExistingPageNames(scene) {
  const pages = scene?.scene?.pages || {};
  return new Set(Object.values(pages).map((page) => page?.name).filter(Boolean));
}

async function uploadPagesWithFromPaths(pathsToUpload, baseUrl) {
  const response = await apiFetch(ENDPOINTS.PAGES_FROM_PATHS, {
    method: "POST",
    baseUrl,
    body: { paths: pathsToUpload, replace: false },
  });
  if (!response.ok) return null;
  return { method: "from-paths", data: await response.json() };
}

async function uploadPagesWithMultipart(pathsToUpload, baseUrl) {
  const form = new FormData();
  for (const filePath of pathsToUpload) {
    const bytes = fs.readFileSync(filePath);
    form.append("files", new Blob([bytes]), path.basename(filePath));
  }
  const response = await fetch(buildUrl(ENDPOINTS.PAGES, baseUrl), {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Upload pages failed (${response.status}): ${await readResponseText(response)}`);
  }
  return { method: "multipart", data: await response.json() };
}

async function uploadPages(imagePaths, baseUrl, { mode = config.api?.pageUploadMode || "auto" } = {}) {
  const existingNames = collectExistingPageNames(await getScene(baseUrl));
  const pendingPaths = imagePaths.filter(
    (filePath) => !existingNames.has(path.basename(filePath))
  );
  const preflight = preflightImagesForKoharuUpload(pendingPaths);
  const pathsToUpload = preflight.uploadPaths;

  if (pathsToUpload.length === 0) {
    return {
      method: "skipped",
      uploaded: 0,
      skipped: imagePaths.map((filePath) => path.basename(filePath)),
      data: null,
      converted: [],
    };
  }

  if (!["auto", "multipart", "from-paths"].includes(mode)) {
    throw new Error(`Unsupported Koharu page upload mode: ${mode}`);
  }
  const result = mode === "multipart"
    ? await uploadPagesWithMultipart(pathsToUpload, baseUrl)
    : mode === "from-paths"
      ? await uploadPagesWithFromPaths(pathsToUpload, baseUrl)
      : (await uploadPagesWithFromPaths(pathsToUpload, baseUrl)) ||
        (await uploadPagesWithMultipart(pathsToUpload, baseUrl));
  if (!result) {
    throw new Error(`Koharu page upload failed in ${mode} mode.`);
  }
  return {
    ...result,
    uploaded: pathsToUpload.length,
    skipped: imagePaths
      .filter((filePath) => existingNames.has(path.basename(filePath)))
      .map((filePath) => path.basename(filePath)),
    converted: preflight.converted,
  };
}

async function getCurrentTranslationTarget(baseUrl) {
  const response = await apiFetch(ENDPOINTS.LLM_CURRENT, { baseUrl });
  if (!response.ok) {
    throw new Error(`Get current translation target failed (${response.status}): ${await readResponseText(response)}`);
  }
  const data = await readOptionalJson(response);
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

async function loadModelTarget(modelId, baseUrl, providerId, targetKind = "provider") {
  const response = await apiFetch(ENDPOINTS.LLM_CURRENT, {
    method: "PUT",
    baseUrl,
    body: {
      target: {
        kind: targetKind,
        modelId,
        providerId: targetKind === "local" ? null : providerId,
      },
    },
  });
  if (!response.ok) {
    throw new Error(`Load translation target failed (${response.status}): ${await readResponseText(response)}`);
  }
  const data = await readOptionalJson(response);
  if (!data) {
    const current = await getCurrentTranslationTarget(baseUrl);
    if (!matchesRequestedTarget(current, modelId, providerId, targetKind)) {
      throw new Error(
        "Load translation target returned an empty response and current target does not match the requested target"
      );
    }
    return { modelId, providerId: targetKind === "local" ? "local" : providerId, data: current, verifiedAfterEmptyBody: true };
  }
  return { modelId, providerId: targetKind === "local" ? "local" : providerId, data };
}

async function fetchTranslationCatalog(baseUrl) {
  return ensureOkJson(
    await apiFetch(ENDPOINTS.LLM_CATALOG, { baseUrl }),
    "Fetch translation catalog"
  );
}

async function loadTranslationTarget(baseUrl, requestedTarget = null, targetLanguage = null) {
  const catalog = await fetchTranslationCatalog(baseUrl);
  const selected = resolveTranslationTarget({
    catalog,
    requestedTarget,
    defaultTarget: config.translation?.defaultTarget,
    targetLanguage,
  });
  const loaded = await loadModelTarget(
    selected.modelId,
    baseUrl,
    selected.providerId,
    selected.targetKind
  );
  return {
    ...selected,
    data: loaded.data,
    verifiedAfterEmptyBody: loaded.verifiedAfterEmptyBody === true,
  };
}

async function fetchEnginesCatalog(baseUrl) {
  return ensureOkJson(
    await apiFetch(ENDPOINTS.ENGINES, { baseUrl }),
    "Fetch engines"
  );
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
  return Boolean(definition && engineId && definition.catalogKeys.some((catalogKey) => {
    const options = Array.isArray(catalog[catalogKey]) ? catalog[catalogKey] : [];
    return options.some((option) => option?.id === engineId);
  }));
}

async function resolveEngines(baseUrl, configuredEngines = null) {
  const resolved = configuredEngines && typeof configuredEngines === "object"
    ? { ...configuredEngines }
    : {};
  const catalog = await fetchEnginesCatalog(baseUrl);
  const usedEngineIds = new Set();

  for (const definition of ENGINE_ORDER) {
    if (
      resolved[definition.key] &&
      !usedEngineIds.has(resolved[definition.key]) &&
      catalogHasEngine(definition.key, resolved[definition.key], catalog)
    ) {
      usedEngineIds.add(resolved[definition.key]);
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

function buildPipelineSteps(engines) {
  const steps = ENGINE_ORDER.map((entry) => engines[entry.key]).filter(Boolean);
  if (steps.length === 0) throw new Error("No pipeline steps resolved from engine configuration");
  return steps;
}

async function startPipeline(steps, targetLanguage, baseUrl, systemPrompt = null) {
  const data = await ensureOkJson(
    await apiFetch(ENDPOINTS.PIPELINES, {
      method: "POST",
      baseUrl,
      body: { steps, targetLanguage, ...(systemPrompt ? { systemPrompt } : {}) },
    }),
    "Start pipeline"
  );
  const operationId = data.operationId || data.id;
  if (!operationId) throw new Error("Start pipeline response did not include operationId");
  return { operationId, raw: data };
}

async function orchestrate(options) {
  const translationTarget = await loadTranslationTarget(
    options.baseUrl,
    options.translationTarget || null,
    options.targetLanguage || null
  );
  const projectName = createProjectName();
  const created = await ensureOkJson(
    await apiFetch(ENDPOINTS.PROJECTS, {
      method: "POST",
      baseUrl: options.baseUrl,
      body: { name: projectName },
    }),
    "Create project"
  );
  const projectId = created.id || created.project?.id || projectName;
  await ensureOkJson(
    await apiFetch(ENDPOINTS.PROJECTS_CURRENT, {
      method: "PUT",
      baseUrl: options.baseUrl,
      body: { id: projectId },
    }),
    "Open project"
  );
  const upload = await uploadPages(options.sourceImagePaths, options.baseUrl);
  const engines = await resolveEngines(options.baseUrl, options.engines);
  const steps = buildPipelineSteps(engines);
  const pipeline = await startPipeline(
    steps,
    options.targetLanguage,
    options.baseUrl,
    options.systemPrompt
  );
  return {
    projectName,
    operationId: pipeline.operationId,
    engines,
    steps,
    upload,
    translationTarget,
  };
}

module.exports = {
  ENGINE_ORDER,
  buildPipelineSteps,
  createProjectName,
  loadTranslationTarget,
  orchestrate,
  resolveEngines,
  startPipeline,
  uploadPages,
};
