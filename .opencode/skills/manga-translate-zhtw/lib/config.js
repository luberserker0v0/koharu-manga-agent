#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..", "..", "..");
const PROJECT_CONFIG_PATH = path.join(PROJECT_ROOT, ".opencode", "koharu.json");

const DEFAULT_CONFIG = {
  api: {
    baseUrl: "http://127.0.0.1:9999",
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
    translated: "translated/",
    logs: "logs/",
    todoList: "TODO_LIST.md",
  },
  defaults: {
    targetLanguage: "zh-TW",
    exportFormat: "rendered",
    tolerance: 10,
    autoDeleteProject: false,
  },
  workflow: {
    qualityCheck: {
      enabled: true,
    },
    knowledgeBuilder: {
      enabled: false,
    },
  },
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
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], value);
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

const projectConfig = loadProjectConfig();
const merged = deepMerge(DEFAULT_CONFIG, projectConfig);

module.exports = {
  PROJECT_ROOT,
  PROJECT_CONFIG_PATH,
  DEFAULT_BASE_URL: merged.api.baseUrl,
  LLM: merged.llm,
  TIMEOUTS: merged.timeouts,
  PATHS: {
    KNOWLEDGE_BASE: resolvePath(merged.paths.knowledgeBase),
    REPORTS: resolvePath(merged.paths.reports),
    TRANSLATED: resolvePath(merged.paths.translated),
    LOGS: resolvePath(merged.paths.logs),
    TODO_LIST: resolvePath(merged.paths.todoList),
  },
  DEFAULTS: merged.defaults,
  WORKFLOW: merged.workflow,
  ENGINES: projectConfig.engines || null,
  VALID_EXPORT_FORMATS: ["khr", "psd", "rendered", "inpainted"],
  STEP_MAP: {
    detect: { key: "detectors", label: "Text detection (detect)" },
    ocr: { key: "ocr", label: "OCR (ocr)" },
    translate: { key: "translators", label: "Translation (translate)" },
    clean: { key: "inpainters", label: "Cleanup (clean)" },
    render: { key: "renderers", label: "Render (render)" },
  },
  STEP_LABELS: {
    detect: "Text detection",
    detector: "Text detection",
    fontDetect: "Font detection",
    fontDetector: "Font detection",
    segment: "Segmentation",
    segmenter: "Segmentation",
    bubbleSegment: "Bubble segmentation",
    bubbleSegmenter: "Bubble segmentation",
    ocr: "OCR",
    translate: "Translation",
    translator: "Translation",
    inpaint: "Cleanup",
    inpainter: "Cleanup",
    render: "Render",
    renderer: "Render",
  },
  KNOWN_STEPS: [
    "detect",
    "detector",
    "fontDetect",
    "fontDetector",
    "segment",
    "segmenter",
    "bubbleSegment",
    "bubbleSegmenter",
    "ocr",
    "translate",
    "translator",
    "inpaint",
    "inpainter",
    "render",
    "renderer",
  ],
  TERMINAL_STATES: [
    "completed",
    "failed",
    "completed_with_errors",
    "cancelled",
  ],
  SKILL_CONFIG: {
    DEFAULT_MODEL: path.join(__dirname, "..", ".default-model"),
    DEFAULT_ENGINES: path.join(__dirname, "..", ".default-engines"),
  },
};
