const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PROJECT_CONFIG_PATH = path.join(PROJECT_ROOT, ".opencode", "koharu.json");

const DEFAULT_CONFIG = {
  api: {
    baseUrl: "http://127.0.0.1:4000",
  },
  llm: {
    defaultModel: "gemma-4-e4b-uncensored-hauhaucs-aggressive",
    defaultProvider: "openai-compatible",
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
    : path.join(PROJECT_ROOT, targetPath);
}

const mergedConfig = deepMerge(DEFAULT_CONFIG, loadProjectConfig());

module.exports = {
  PROJECT_ROOT,
  PROJECT_CONFIG_PATH,
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
    logs: resolvePath(mergedConfig.paths.logs),
    todoList: resolvePath(mergedConfig.paths.todoList),
    database: resolvePath(mergedConfig.paths.database),
    workspaceRoot: resolvePath(mergedConfig.paths.workspaceRoot || "cache/workspaces"),
    koharuRuntimeInstallRoot: resolvePath(mergedConfig.koharuRuntime?.installRoot || "cache/koharu-runtime"),
  },
  runtime: mergedConfig.runtime,
};
