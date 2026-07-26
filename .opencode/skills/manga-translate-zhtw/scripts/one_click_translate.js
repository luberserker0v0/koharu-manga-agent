#!/usr/bin/env node

/**
 * one_click_translate.js
 * Single-file orchestrator for project creation, page upload, LLM loading,
 * engine resolution, and pipeline start.
 */

const fs = require("fs");
const path = require("path");
const config = require("../lib/config");
const { apiFetch, buildUrl, ENDPOINTS } = require("../lib/api");
const {
  preflightImagesForKoharuUpload,
} = require("../../../../backend/src/modules/reference_image_conversion");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
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

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    targetLanguage: config.DEFAULTS.targetLanguage,
    baseUrl: config.DEFAULT_BASE_URL,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--target" && argv[i + 1]) {
      opts.targetLanguage = argv[++i];
    } else if (arg.startsWith("--target=")) {
      opts.targetLanguage = arg.slice("--target=".length);
    } else if (arg === "--base-url" && argv[i + 1]) {
      opts.baseUrl = argv[++i].replace(/\/+$/, "");
    } else if (arg.startsWith("--base-url=")) {
      opts.baseUrl = arg.slice("--base-url=".length).replace(/\/+$/, "");
    }
  }

  return opts;
}

function validateSourcePages(sourceFolder) {
  if (!sourceFolder) {
    throw new Error("A sourceFolder or sourceImagePaths input is required.");
  }

  if (!fs.existsSync(sourceFolder)) {
    throw new Error(`Source folder not found: ${sourceFolder}`);
  }

  const imagePaths = fs
    .readdirSync(sourceFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(sourceFolder, name));

  if (imagePaths.length === 0) {
    throw new Error(`No images found in source folder: ${sourceFolder}`);
  }

  return imagePaths;
}

function createProjectName(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  return `translate_${timestamp}`;
}

function getDefaultModelId() {
  try {
    return fs.readFileSync(config.SKILL_CONFIG.DEFAULT_MODEL, "utf-8").trim();
  } catch {
    return "";
  }
}

function getSavedEngines() {
  try {
    const raw = fs.readFileSync(config.SKILL_CONFIG.DEFAULT_ENGINES, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function readResponseText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function readOptionalJson(res) {
  const text = await readResponseText(res);
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

async function ensureOkJson(res, label) {
  if (!res.ok) {
    const text = await readResponseText(res);
    throw new Error(`${label} failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function createProject(projectName, baseUrl) {
  const res = await apiFetch(ENDPOINTS.PROJECTS, {
    method: "POST",
    baseUrl,
    body: { name: projectName },
  });
  return ensureOkJson(res, "Create project");
}

async function openProject(projectId, baseUrl) {
  const res = await apiFetch(ENDPOINTS.PROJECTS_CURRENT, {
    method: "PUT",
    baseUrl,
    body: { id: projectId },
  });
  return ensureOkJson(res, "Open project");
}

async function getScene(baseUrl) {
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl });
  if (!res.ok) {
    return null;
  }
  return res.json();
}

function collectExistingPageNames(scene) {
  const pages = scene && scene.scene && scene.scene.pages ? scene.scene.pages : {};
  return new Set(
    Object.values(pages)
      .map((page) => page && page.name)
      .filter(Boolean)
  );
}

async function uploadPagesWithFromPaths(pathsToUpload, baseUrl) {
  const res = await apiFetch(ENDPOINTS.PAGES_FROM_PATHS, {
    method: "POST",
    baseUrl,
    body: { paths: pathsToUpload, replace: false },
  });

  if (!res.ok) {
    return null;
  }

  return {
    method: "from-paths",
    data: await res.json(),
  };
}

async function uploadPagesWithMultipart(pathsToUpload, baseUrl) {
  const boundary = `----FormBoundary${Date.now()}`;
  const parts = [];

  for (const filePath of pathsToUpload) {
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${fileName}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n"
      )
    );
    parts.push(fileData);
    parts.push(Buffer.from("\r\n"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const res = await fetch(buildUrl(ENDPOINTS.PAGES, baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
  });

  if (!res.ok) {
    const text = await readResponseText(res);
    throw new Error(`Upload pages failed (${res.status}): ${text}`);
  }

  return {
    method: "multipart",
    data: await res.json(),
  };
}

async function uploadPages(imagePaths, baseUrl) {
  const scene = await getScene(baseUrl);
  const existingNames = collectExistingPageNames(scene);
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

  const fromPathsResult = await uploadPagesWithFromPaths(pathsToUpload, baseUrl);
  if (fromPathsResult) {
    return {
      ...fromPathsResult,
      uploaded: pathsToUpload.length,
      skipped: imagePaths
        .filter((filePath) => existingNames.has(path.basename(filePath)))
        .map((filePath) => path.basename(filePath)),
      converted: preflight.converted,
    };
  }

  const multipartResult = await uploadPagesWithMultipart(pathsToUpload, baseUrl);
  return {
    ...multipartResult,
    uploaded: pathsToUpload.length,
    skipped: imagePaths
      .filter((filePath) => existingNames.has(path.basename(filePath)))
      .map((filePath) => path.basename(filePath)),
    converted: preflight.converted,
  };
}

async function loadModelTarget(modelId, baseUrl, providerId) {
  const res = await apiFetch(ENDPOINTS.LLM_CURRENT, {
    method: "PUT",
    baseUrl,
    body: {
      target: {
        kind: providerId ? "provider" : "local",
        modelId,
        providerId: providerId || null,
      },
    },
  });

  if (!res.ok) {
    const text = await readResponseText(res);
    throw new Error(`Load LLM failed (${res.status}): ${text}`);
  }

  const data = await readOptionalJson(res);
  if (data) {
    return {
      modelId,
      providerId: providerId || null,
      data,
    };
  }

  const current = await getCurrentLlmTarget(baseUrl);
  if (!matchesRequestedTarget(current, modelId, providerId)) {
    throw new Error(
      "Load LLM returned an empty response and current target does not match the requested target"
    );
  }

  return {
    modelId,
    providerId: providerId || null,
    data: current,
    verifiedAfterEmptyBody: true,
  };
}

async function getCurrentLlmTarget(baseUrl) {
  const res = await apiFetch(ENDPOINTS.LLM_CURRENT, {
    method: "GET",
    baseUrl,
  });

  if (!res.ok) {
    const text = await readResponseText(res);
    throw new Error(`Get current LLM failed (${res.status}): ${text}`);
  }

  const data = await readOptionalJson(res);
  if (!data) {
    throw new Error("Get current LLM returned an empty response");
  }

  return data;
}

async function fetchLlmCatalog(baseUrl) {
  const res = await apiFetch(ENDPOINTS.LLM_CATALOG, {
    method: "GET",
    baseUrl,
  });

  return ensureOkJson(res, "Fetch LLM catalog");
}

function catalogHasLocalModel(catalog, modelId) {
  const localModels = Array.isArray(catalog?.localModels) ? catalog.localModels : [];
  return localModels.some((model) => model && model.id === modelId);
}

function matchesRequestedTarget(current, modelId, providerId) {
  const target = current && current.target ? current.target : null;
  if (!target || target.modelId !== modelId) {
    return false;
  }

  if (providerId) {
    return target.kind === "provider" && target.providerId === providerId;
  }

  return target.kind === "local" && (target.providerId === null || target.providerId === undefined);
}

async function loadDefaultLlm(baseUrl) {
  const modelId = getDefaultModelId();
  if (!modelId) {
    throw new Error("Default model file is missing or empty");
  }

  try {
    return await loadModelTarget(modelId, baseUrl, config.LLM.defaultProvider || "openai-compatible");
  } catch (providerError) {
    const catalog = await fetchLlmCatalog(baseUrl).catch(() => null);
    if (!catalogHasLocalModel(catalog, modelId)) {
      throw new Error(`Failed to load default LLM via provider: ${providerError.message}`);
    }

    const localResult = await loadModelTarget(modelId, baseUrl, null).catch((localError) => {
      throw new Error(
        `Failed to load default LLM. Provider error: ${providerError.message}; Local error: ${localError.message}`
      );
    });

    return {
      ...localResult,
      fallbackFromProvider: true,
    };
  }
}

async function fetchEnginesCatalog(baseUrl) {
  const res = await apiFetch(ENDPOINTS.ENGINES, { baseUrl });
  return ensureOkJson(res, "Fetch engines");
}

function pickEngineFromCatalog(engineKey, catalog) {
  const definition = ENGINE_ORDER.find((entry) => entry.key === engineKey);
  if (!definition) {
    return null;
  }

  for (const catalogKey of definition.catalogKeys) {
    const options = Array.isArray(catalog[catalogKey]) ? catalog[catalogKey] : [];
    if (options.length > 0) {
      return options[0].id;
    }
  }

  return null;
}

function catalogHasEngine(engineKey, engineId, catalog) {
  const definition = ENGINE_ORDER.find((entry) => entry.key === engineKey);
  if (!definition || !engineId) {
    return false;
  }

  return definition.catalogKeys.some((catalogKey) => {
    const options = Array.isArray(catalog[catalogKey]) ? catalog[catalogKey] : [];
    return options.some((option) => option && option.id === engineId);
  });
}

async function resolveEngines(baseUrl) {
  const preferred = config.ENGINES && typeof config.ENGINES === "object" ? { ...config.ENGINES } : {};
  const saved = getSavedEngines();
  const merged = { ...saved, ...preferred };
  const missingRequired = ENGINE_ORDER.filter((entry) => entry.required && !merged[entry.key]);
  const missingOptional = ENGINE_ORDER.filter((entry) => !entry.required && !merged[entry.key]);

  if (missingRequired.length === 0 && missingOptional.length === 0) {
    const catalog = await fetchEnginesCatalog(baseUrl);
    for (const entry of ENGINE_ORDER) {
      if (!merged[entry.key] || catalogHasEngine(entry.key, merged[entry.key], catalog)) {
        continue;
      }
      const selected = pickEngineFromCatalog(entry.key, catalog);
      if (selected) {
        merged[entry.key] = selected;
      } else if (entry.required) {
        throw new Error(`Configured engine is unavailable and no fallback exists: ${entry.key}=${merged[entry.key]}`);
      } else {
        delete merged[entry.key];
      }
    }
    return merged;
  }

  const catalog = await fetchEnginesCatalog(baseUrl);

  for (const entry of [...missingRequired, ...missingOptional]) {
    const selected = pickEngineFromCatalog(entry.key, catalog);
    if (selected) {
      merged[entry.key] = selected;
    } else if (entry.required) {
      throw new Error(`Unable to resolve required engine: ${entry.key}`);
    }
  }

  for (const entry of ENGINE_ORDER) {
    if (!merged[entry.key] || catalogHasEngine(entry.key, merged[entry.key], catalog)) {
      continue;
    }
    const selected = pickEngineFromCatalog(entry.key, catalog);
    if (selected) {
      merged[entry.key] = selected;
    } else if (entry.required) {
      throw new Error(`Configured engine is unavailable and no fallback exists: ${entry.key}=${merged[entry.key]}`);
    } else {
      delete merged[entry.key];
    }
  }

  return merged;
}

function buildPipelineSteps(engines) {
  const steps = ENGINE_ORDER.map((entry) => engines[entry.key]).filter(Boolean);
  if (steps.length === 0) {
    throw new Error("No pipeline steps resolved from engine configuration");
  }
  return steps;
}

async function startPipeline(steps, targetLanguage, baseUrl, systemPrompt = null) {
  const res = await apiFetch(ENDPOINTS.PIPELINES, {
    method: "POST",
    baseUrl,
    body: {
      steps,
      targetLanguage,
      ...(systemPrompt ? { systemPrompt } : {}),
    },
  });

  const data = await ensureOkJson(res, "Start pipeline");
  const operationId = data.operationId || data.id;
  if (!operationId) {
    throw new Error("Start pipeline response did not include operationId");
  }

  return {
    operationId,
    raw: data,
  };
}

async function orchestrate(options = {}) {
  const opts = {
    ...parseArgs([]),
    ...options,
  };
  const sourceFolder = opts.sourceFolder || config.PATHS.ORIGINAL;

  const imagePaths =
    Array.isArray(opts.sourceImagePaths) && opts.sourceImagePaths.length > 0
      ? opts.sourceImagePaths
      : validateSourcePages(sourceFolder);
  const projectName = createProjectName();
  const createdProject = await createProject(projectName, opts.baseUrl);
  const projectId = createdProject.id || (createdProject.project && createdProject.project.id) || projectName;

  await openProject(projectId, opts.baseUrl);
  const uploadResult = await uploadPages(imagePaths, opts.baseUrl);
  const llmResult = await loadDefaultLlm(opts.baseUrl);
  const engines = await resolveEngines(opts.baseUrl);
  const steps = buildPipelineSteps(engines);
  const pipelineResult = await startPipeline(
    steps,
    opts.targetLanguage,
    opts.baseUrl,
    opts.systemPrompt || null
  );

  return {
    success: true,
    projectName,
    operationId: pipelineResult.operationId,
    engines,
    steps,
    upload: {
      method: uploadResult.method,
      uploaded: uploadResult.uploaded,
      skipped: uploadResult.skipped,
      converted: uploadResult.converted || [],
    },
    llm: {
      modelId: llmResult.modelId,
      providerId: llmResult.providerId,
      fallbackFromProvider: Boolean(llmResult.fallbackFromProvider),
    },
    systemPromptApplied: Boolean(opts.systemPrompt),
    nextStep: "Monitor the started operation within the process-trigger backend workflow.",
  };
}

async function main() {
  try {
    const result = await orchestrate(parseArgs());
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      JSON.stringify({
        success: false,
        error: error.message,
      })
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ENGINE_ORDER,
  buildPipelineSteps,
  createProjectName,
  catalogHasEngine,
  getDefaultModelId,
  getSavedEngines,
  catalogHasLocalModel,
  loadDefaultLlm,
  orchestrate,
  parseArgs,
  resolveEngines,
  startPipeline,
  uploadPages,
  validateOriginalPages: validateSourcePages,
  validateSourcePages,
};
