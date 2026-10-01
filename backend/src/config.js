const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const APP_DIRECTORY_NAME = "Koharu Manga Agent";
const APP_DIRECTORY_SLUG = "koharu-manga-agent";

function defaultDataRoot() {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      APP_DIRECTORY_NAME,
      "backend"
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIRECTORY_NAME, "backend");
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    APP_DIRECTORY_SLUG,
    "backend"
  );
}

function defaultConfigPath() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      APP_DIRECTORY_NAME,
      "backend",
      "koharu.json"
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIRECTORY_NAME, "backend", "koharu.json");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    APP_DIRECTORY_SLUG,
    "backend",
    "koharu.json"
  );
}

const DATA_ROOT = path.resolve(
  process.env.MANGA_TRANSLATION_DATA_ROOT || defaultDataRoot()
);
const PROJECT_CONFIG_PATH = path.resolve(
  process.env.MANGA_TRANSLATION_CONFIG_PATH || defaultConfigPath()
);
const LEGACY_PROJECT_CONFIG_PATH = path.join(PROJECT_ROOT, ".opencode", "koharu.json");

function bootstrapUserConfig() {
  if (process.env.MANGA_TRANSLATION_CONFIG_PATH || fs.existsSync(PROJECT_CONFIG_PATH)) return;
  if (!fs.existsSync(LEGACY_PROJECT_CONFIG_PATH)) return;
  fs.mkdirSync(path.dirname(PROJECT_CONFIG_PATH), { recursive: true });
  fs.copyFileSync(LEGACY_PROJECT_CONFIG_PATH, PROJECT_CONFIG_PATH, fs.constants.COPYFILE_EXCL);
}

bootstrapUserConfig();

const DEFAULT_CONFIG = {
  api: {
    baseUrl: "http://127.0.0.1:4000",
    pageUploadMode: "auto",
  },
  translation: {
    defaultTarget: {
      providerId: "openai-compatible",
      modelId: "gemma-4-e4b-uncensored-hauhaucs-aggressive",
    },
    machineTranslation: {
      referencePostEdit: true,
      learningPostEdit: true,
    },
  },
  timeouts: {
    sseListen: 600,
    llmRetry: 3,
    qualityCheck: 300,
    kbUpdate: 300,
  },
  paths: {
    knowledgeBase: "knowledge_base/self/my-manga.json",
    reports: "knowledge_base/reports/extract_report.json",
    postEditDocuments: "post_edit/",
    translated: "translated/",
    references: "references/",
    referenceImages: "references/other_images/",
    referenceExtracted: "references/extracted/",
    legacyReferenceDiagnostics: "references/comparisons/",
    referenceComparisons: "references/comparisons/",
    referenceManifests: "references/manifests/",
    sourcePreflight: "cache/source-preflight/",
    uploads: "uploads/",
    translatedImages: "cache/translated-images/",
    workspaceRoot: "cache/workspaces",
    logs: "logs/",
    todoList: "TODO_LIST.md",
    database: "cache/process-agent.sqlite",
  },
  defaults: {
    targetLanguage: "zh-TW",
    exportFormat: "rendered",
    tolerance: 10,
    autoDeleteProject: false,
    trashRetentionDays: 30,
  },
  workflow: {
    qualityCheck: {
      enabled: true,
    },
    knowledgeBuilder: {
      enabled: false,
    },
  },
  runtime: {
    host: "127.0.0.1",
    port: 4001,
    pollIntervalMs: 1000,
  },
  server: {
    authToken: null,
    corsAllowedOrigins: [],
    maxJsonBodyBytes: 1048576,
    maxUploadFileBytes: 52428800,
    maxUploadFiles: 500,
    maxTranslatedImageBytes: 104857600,
    maxTranslatedImageFiles: 500,
    maxTranslatedImagesTotalBytes: 1073741824,
  },
  koharuRuntime: {
    managed: true,
    version: "0.61.2",
    repository: "mayocream/koharu",
    installRoot: "cache/koharu-runtime",
    host: "127.0.0.1",
    port: 4000,
    portSearchRange: 50,
    headless: true,
    startup: "on_demand",
    prefetchOnInstall: false,
    stopWithBackend: true,
    startupTimeoutMs: 30000,
  },
  agent: {
    baseUrl: "http://127.0.0.1:32768",
    apiKey: null,
    model: "opencode/deepseek-v4-flash-free",
    agentName: null,
    qualityAgentName: "quality-optimizer",
    knowledgeAgentName: "knowledge-builder",
    storyContextAgentName: "story-context-builder",
    startTimeoutMs: 10000,
    readyPollIntervalMs: 1000,
    readyTimeoutMs: 30000,
    messageTimeoutMs: 600000,
    modelSilenceTimeoutMs: 600000,
  },
  engines: null,
};

function loadProjectConfig() {
  try {
    return JSON.parse(fs.readFileSync(PROJECT_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge(base, override) {
  const result = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function resolvePath(targetPath) {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.join(DATA_ROOT, targetPath);
}

const mergedConfig = deepMerge(DEFAULT_CONFIG, loadProjectConfig());

module.exports = {
  DEFAULT_CONFIG,
  DATA_ROOT,
  LEGACY_PROJECT_CONFIG_PATH,
  PROJECT_ROOT,
  PROJECT_CONFIG_PATH,
  defaultConfigPath,
  defaultDataRoot,
  deepMerge,
  config: mergedConfig,
  resolvePath,
  paths: {
    knowledgeBase: resolvePath(mergedConfig.paths.knowledgeBase),
    reports: resolvePath(mergedConfig.paths.reports),
    postEditDocuments: resolvePath(mergedConfig.paths.postEditDocuments),
    translated: resolvePath(mergedConfig.paths.translated),
    references: resolvePath(mergedConfig.paths.references),
    referenceImages: resolvePath(mergedConfig.paths.referenceImages),
    referenceExtracted: resolvePath(mergedConfig.paths.referenceExtracted),
    legacyReferenceDiagnostics: resolvePath(
      mergedConfig.paths.legacyReferenceDiagnostics ||
        mergedConfig.paths.referenceComparisons
    ),
    referenceComparisons: resolvePath(mergedConfig.paths.referenceComparisons),
    referenceManifests: resolvePath(mergedConfig.paths.referenceManifests),
    sourcePreflight: resolvePath(mergedConfig.paths.sourcePreflight),
    uploads: resolvePath(mergedConfig.paths.uploads || "uploads/"),
    translatedImages: resolvePath(mergedConfig.paths.translatedImages || "cache/translated-images/"),
    logs: resolvePath(mergedConfig.paths.logs),
    todoList: resolvePath(mergedConfig.paths.todoList),
    database: resolvePath(mergedConfig.paths.database),
    workspaceRoot: resolvePath(mergedConfig.paths.workspaceRoot || "cache/workspaces"),
    koharuRuntimeInstallRoot: resolvePath(mergedConfig.koharuRuntime?.installRoot || "cache/koharu-runtime"),
  },
  runtime: mergedConfig.runtime,
};
