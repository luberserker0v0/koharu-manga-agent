#!/usr/bin/env node

/**
 * select_engines.js
 * 透過 Koharu HTTP API 取得可用引擎，並為管線各步驟選擇 engine id。
 * 會讀取/寫入 .default-engines 檔案以記住使用者選擇。
 *
 * 用法:
 *   node select_engines.js [--base-url http://127.0.0.1:9999]
 *
 * 輸出: JSON 物件 { success, engines: { detect, ocr, translate, clean, render }, fromCache }
 */

const config = require("../../shared/config");
const { apiFetch, ENDPOINTS } = require("../../shared/api");
const path = require("path");
const fs = require("fs");

function parseArgs() {
  const args = process.argv.slice(2);
  let baseUrl = config.DEFAULT_BASE_URL;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) {
      baseUrl = args[++i].replace(/\/+$/, "");
    }
  }
  return { baseUrl };
}

function loadDefaults() {
  try {
    const raw = fs.readFileSync(config.SKILL_CONFIG.DEFAULT_ENGINES, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveDefaults(engines) {
  fs.writeFileSync(config.SKILL_CONFIG.DEFAULT_ENGINES, JSON.stringify(engines, null, 2), "utf-8");
}

async function fetchEngines(baseUrl) {
  const res = await apiFetch(ENDPOINTS.ENGINES, { baseUrl });
  if (!res.ok) throw new Error(`API 錯誤 (${res.status})`);
  return res.json();
}

async function main() {
  const { baseUrl } = parseArgs();

  // 優先使用 koharu.json 中的引擎配置
  if (config.ENGINES) {
    console.log(JSON.stringify({
      success: true,
      needsQuestion: false,
      engines: config.ENGINES,
      fromCache: true,
      source: "koharu.json",
    }));
    return;
  }

  const defaults = loadDefaults();
  const catalog = await fetchEngines(baseUrl);

  const engines = {};
  let needsQuestion = false;
  const questions = [];

  for (const [step, info] of Object.entries(config.STEP_MAP)) {
    const available = catalog[info.key] || [];
    if (available.length === 0) {
      console.error(JSON.stringify({ success: false, error: `找不到可用的 ${info.label} 引擎` }));
      process.exit(1);
    }

    const cached = defaults[step];
    if (cached && available.find((e) => e.id === cached)) {
      engines[step] = cached;
    } else {
      needsQuestion = true;
      questions.push({
        step,
        label: info.label,
        options: available.map((e) => ({ id: e.id, name: e.name })),
      });
    }
  }

  if (needsQuestion) {
    console.log(JSON.stringify({
      success: true,
      needsQuestion: true,
      engines,
      questions,
    }));
  } else {
    console.log(JSON.stringify({
      success: true,
      needsQuestion: false,
      engines,
      fromCache: true,
    }));
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: `腳本執行錯誤: ${err.message}` }));
  process.exit(1);
});
