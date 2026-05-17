#!/usr/bin/env node

/**
 * config.js
 * 三層配置系統：Shared 預設 → koharu.json（專案配置） → CLI 參數
 *
 * 優先級（由高到低）：
 *   1. CLI 參數（執行時透過 --base-url 等覆蓋）
 *   2. .opencode/koharu.json（專案專屬配置）
 *   3. 本模組內建的 Shared 預設值
 */

const path = require("path");
const fs = require("fs");

// 專案根目錄（從 shared/ 往上 3 層：shared -> skills -> .opencode -> project root）
const PROJECT_ROOT = path.join(__dirname, "..", "..", "..");
const PROJECT_CONFIG_PATH = path.join(PROJECT_ROOT, ".opencode", "koharu.json");

// ============================================================
// 第 1 層：Shared 預設值（最低優先級）
// ============================================================
const SHARED_DEFAULTS = {
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
    original: "original/",
    logs: "logs/",
    todoList: "TODO_LIST.md",
  },
  defaults: {
    targetLanguage: "zh-TW",
    exportFormat: "rendered",
    tolerance: 10,
  },
};

// ============================================================
// 第 2 層：讀取專案配置（.opencode/koharu.json）
// ============================================================
function loadProjectConfig() {
  try {
    const raw = fs.readFileSync(PROJECT_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// 深層合併（僅合併物件，陣列直接覆蓋）
function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object"
    ) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// 合併配置
const projectConfig = loadProjectConfig();
const merged = deepMerge(SHARED_DEFAULTS, projectConfig);

// 解析相對路徑為絕對路徑
function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
}

// ============================================================
// Skill 內部配置路徑（相對於 skill 目錄）
// ============================================================
const SKILL_CONFIG = {
  DEFAULT_MODEL: path.join(
    __dirname,
    "..",
    "manga-translate-zhtw",
    ".default-model"
  ),
  DEFAULT_ENGINES: path.join(
    __dirname,
    "..",
    "manga-translate-zhtw",
    ".default-engines"
  ),
};

// ============================================================
// 匯出配置
// ============================================================
module.exports = {
  // API
  DEFAULT_BASE_URL: merged.api.baseUrl,

  // LLM
  LLM: merged.llm,

  // 超時（秒）
  TIMEOUTS: merged.timeouts,

  // 路徑（已解析為絕對路徑）
  PATHS: {
    KNOWLEDGE_BASE: resolvePath(merged.paths.knowledgeBase),
    REPORTS: resolvePath(merged.paths.reports),
    TRANSLATED: resolvePath(merged.paths.translated),
    ORIGINAL: resolvePath(merged.paths.original),
    LOGS: resolvePath(merged.paths.logs),
    TODO_LIST: resolvePath(merged.paths.todoList),
  },

  // 預設值
  DEFAULTS: merged.defaults,

  // 引擎配置（來自 koharu.json，若無則為 null）
  ENGINES: projectConfig.engines || null,

  // Skill 內部路徑
  SKILL_CONFIG,

  // 常數
  SUBAGENTS: ["pipeline-runner", "quality-checker", "knowledge-builder"],
  VALID_EXPORT_FORMATS: ["khr", "psd", "rendered", "inpainted"],

  // 管線步驟映射
  STEP_MAP: {
    detect: { key: "detectors", label: "文字偵測 (detect)" },
    ocr: { key: "ocr", label: "文字辨識 (ocr)" },
    translate: { key: "translators", label: "翻譯 (translate)" },
    clean: { key: "inpainters", label: "去字修復 (clean)" },
    render: { key: "renderers", label: "渲染 (render)" },
  },

  // SSE 步驟標籤
  STEP_LABELS: {
    detect: "文字偵測",
    detector: "文字偵測",
    fontDetect: "字體偵測",
    fontDetector: "字體偵測",
    segment: "分段",
    segmenter: "分段",
    bubbleSegment: "氣泡分段",
    bubbleSegmenter: "氣泡分段",
    ocr: "OCR 辨識",
    translate: "翻譯",
    translator: "翻譯",
    inpaint: "去字修復",
    inpainter: "去字修復",
    render: "渲染",
    renderer: "渲染",
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

  // 專案根目錄
  PROJECT_ROOT,
};
