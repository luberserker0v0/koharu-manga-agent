#!/usr/bin/env node

const path = require("path");
const backendConfig = require("../../../../backend/src/config");

const PROJECT_ROOT = path.join(__dirname, "..", "..", "..", "..");
const PROJECT_CONFIG_PATH = backendConfig.PROJECT_CONFIG_PATH;

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
  paths: backendConfig.config.paths,
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

const projectConfig = backendConfig.config;
const merged = deepMerge(DEFAULT_CONFIG, projectConfig);

module.exports = {
  PROJECT_ROOT,
  PROJECT_CONFIG_PATH,
  DEFAULT_BASE_URL: merged.api.baseUrl,
  LLM: merged.llm,
  TIMEOUTS: merged.timeouts,
  PATHS: {
    KNOWLEDGE_BASE: backendConfig.paths.knowledgeBase,
    REPORTS: backendConfig.paths.reports,
    TRANSLATED: backendConfig.paths.translated,
    LOGS: backendConfig.paths.logs,
    TODO_LIST: backendConfig.paths.todoList,
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
