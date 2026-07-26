#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..", "..", "..");
const PROJECT_CONFIG_PATH = path.join(PROJECT_ROOT, ".opencode", "koharu.json");

const DEFAULT_CONFIG = {
  api: { baseUrl: "http://127.0.0.1:9999" },
  timeouts: { sseListen: 600 },
  defaults: { targetLanguage: "zh-TW" },
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

const merged = deepMerge(DEFAULT_CONFIG, loadProjectConfig());

module.exports = {
  DEFAULT_BASE_URL: merged.api.baseUrl,
  TIMEOUTS: merged.timeouts,
  DEFAULTS: merged.defaults,
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
};
