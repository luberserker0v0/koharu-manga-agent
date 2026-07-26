#!/usr/bin/env node

/**
 * start_pipeline.js
 * 透過 Koharu HTTP API 啟動翻譯管線。
 *
 * 用法:
 *   node start_pipeline.js --steps "detect,ocr,translate,clean,render" \
 *     [--target-language "zh-TW"] [--base-url http://127.0.0.1:9999]
 *     [--pages "page-id-1,page-id-2"] [--system-prompt "..."] [--default-font "..."]
 */

const config = require("../lib/config");
const { apiFetch, ENDPOINTS } = require("../lib/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    steps: null,
    targetLanguage: config.DEFAULTS.targetLanguage,
    pages: null,
    systemPrompt: null,
    defaultFont: null,
    baseUrl: config.DEFAULT_BASE_URL,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--steps" && args[i + 1]) {
      opts.steps = args[++i].split(",").map((s) => s.trim());
    } else if (args[i] === "--target-language" && args[i + 1]) {
      opts.targetLanguage = args[++i];
    } else if (args[i] === "--pages" && args[i + 1]) {
      opts.pages = args[++i].split(",").map((s) => s.trim());
    } else if (args[i] === "--system-prompt" && args[i + 1]) {
      opts.systemPrompt = args[++i];
    } else if (args[i] === "--default-font" && args[i + 1]) {
      opts.defaultFont = args[++i];
    } else if (args[i] === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i].replace(/\/+$/, "");
    }
  }

  if (!opts.steps || opts.steps.length === 0) {
    console.error("錯誤: 缺少 --steps 參數（例如: detect,ocr,translate,clean,render）");
    process.exit(1);
  }

  return opts;
}

async function startPipeline(opts) {
  const body = { steps: opts.steps };
  if (opts.targetLanguage) body.targetLanguage = opts.targetLanguage;
  if (opts.pages && opts.pages.length > 0) body.pages = opts.pages;
  if (opts.systemPrompt) body.systemPrompt = opts.systemPrompt;
  if (opts.defaultFont) body.defaultFont = opts.defaultFont;

  try {
    const res = await apiFetch(ENDPOINTS.PIPELINES, {
      method: "POST",
      baseUrl: opts.baseUrl,
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(JSON.stringify({ success: false, error: `API 回傳錯誤 (${res.status}): ${text}` }));
      process.exit(1);
    }

    const data = await res.json();
    console.log(JSON.stringify({ success: true, operationId: data.operationId || data.id, raw: data }));
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: `連線失敗: ${err.message}` }));
    process.exit(1);
  }
}

const opts = parseArgs();
startPipeline(opts);
