#!/usr/bin/env node

/**
 * llm_control.js
 * 透過 Koharu HTTP API 控制 LLM 模型：狀態查詢、載入、卸載、列出本地模型。
 *
 * 用法:
 *   node llm_control.js --status
 *   node llm_control.js --load --model-id "model-name"
 *   node llm_control.js --load-default
 *   node llm_control.js --set-default "model-name"
 *   node llm_control.js --local-catalog
 *   node llm_control.js --unload
 */

const config = require("../../shared/config");
const { apiFetch, ENDPOINTS } = require("../../shared/api");
const fs = require("fs");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    status: false,
    load: false,
    loadDefault: false,
    setDefault: false,
    unload: false,
    catalog: false,
    localCatalog: false,
    modelId: null,
    baseUrl: config.DEFAULT_BASE_URL,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status") opts.status = true;
    else if (args[i] === "--load") opts.load = true;
    else if (args[i] === "--load-default") opts.loadDefault = true;
    else if (args[i] === "--set-default" && args[i + 1]) { opts.setDefault = true; opts.modelId = args[++i]; }
    else if (args[i] === "--unload") opts.unload = true;
    else if (args[i] === "--catalog") opts.catalog = true;
    else if (args[i] === "--local-catalog") opts.localCatalog = true;
    else if (args[i] === "--model-id" && args[i + 1]) { opts.modelId = args[++i]; }
    else if (args[i] === "--provider-id" && args[i + 1]) { opts.providerId = args[++i]; }
    else if (args[i] === "--base-url" && args[i + 1]) { opts.baseUrl = args[++i].replace(/\/+$/, ""); }
  }

  return opts;
}

function getDefaultModel() {
  try {
    return fs.readFileSync(config.SKILL_CONFIG.DEFAULT_MODEL, "utf-8").trim();
  } catch {
    return null;
  }
}

function setDefaultModel(modelId) {
  fs.writeFileSync(config.SKILL_CONFIG.DEFAULT_MODEL, modelId, "utf-8");
}

async function getStatus(opts) {
  const res = await apiFetch(ENDPOINTS.LLM_CURRENT, { baseUrl: opts.baseUrl });
  if (!res.ok) return { success: false, error: `API 錯誤 (${res.status})` };
  const data = await res.json();
  return { success: true, data };
}

async function loadModel(opts) {
  if (!opts.modelId) {
    console.error("錯誤: --load 需要 --model-id 參數");
    process.exit(1);
  }

  const body = {
    target: {
      kind: opts.providerId ? "provider" : "local",
      modelId: opts.modelId,
      providerId: opts.providerId || null,
    },
  };

  const res = await apiFetch(ENDPOINTS.LLM_CURRENT, {
    method: "PUT",
    baseUrl: opts.baseUrl,
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `載入失敗 (${res.status}): ${text}` };
  }

  return { success: true, message: "模型載入請求已送出，等待 LlmLoaded 事件" };
}

async function unloadModel(opts) {
  const res = await apiFetch(ENDPOINTS.LLM_CURRENT, {
    method: "DELETE",
    baseUrl: opts.baseUrl,
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `卸載失敗 (${res.status}): ${text}` };
  }

  return { success: true, message: "模型已卸載" };
}

async function getCatalog(opts) {
  const res = await apiFetch(ENDPOINTS.LLM_CATALOG, { baseUrl: opts.baseUrl });
  if (!res.ok) return { success: false, error: `API 錯誤 (${res.status})` };
  const data = await res.json();
  return { success: true, data };
}

async function getLocalCatalog(opts) {
  // 無窮等待直到有本地模型回傳
  while (true) {
    const result = await getCatalog(opts);
    if (!result.success) return result;

    const localModels = result.data.localModels || [];

    if (localModels.length > 0) {
      return { success: true, data: localModels };
    }

    // 等待重試
    await new Promise(resolve => setTimeout(resolve, config.TIMEOUTS.llmRetry * 1000));
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.status) {
    const result = await getStatus(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (opts.load) {
    const result = await loadModel(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (opts.loadDefault) {
    const defaultModel = getDefaultModel();
    if (!defaultModel) {
      console.error(JSON.stringify({ success: false, error: "尚未設定預設模型，嘗試取得本地模型列表..." }));
      const result = await getLocalCatalog(opts);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    }
    opts.modelId = defaultModel;

    // 優先嘗試以 provider (openai-compatible) 載入
    opts.providerId = "openai-compatible";
    const result = await loadModel(opts);
    if (result.success) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    // provider 載入失敗，嘗試以 local 載入
    console.error(JSON.stringify({ message: "provider 載入失敗，嘗試以 local 模式載入...", detail: result.error }));
    opts.providerId = null;
    const localResult = await loadModel(opts);
    if (localResult.success) {
      console.log(JSON.stringify(localResult, null, 2));
      process.exit(0);
    }

    // 兩者都失敗，列出本地模型
    console.error(JSON.stringify({ success: false, error: `預設模型載入失敗，嘗試取得本地模型列表...`, detail: localResult.error }));
    const catalogResult = await getLocalCatalog(opts);
    console.log(JSON.stringify(catalogResult, null, 2));
    process.exit(catalogResult.success ? 0 : 1);
  }

  if (opts.setDefault) {
    setDefaultModel(opts.modelId);
    console.log(JSON.stringify({ success: true, message: `預設模型已設定為: ${opts.modelId}` }));
    process.exit(0);
  }

  if (opts.unload) {
    const result = await unloadModel(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (opts.localCatalog) {
    const result = await getLocalCatalog(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (opts.catalog) {
    const result = await getCatalog(opts);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  console.error("請指定操作：--status、--load、--load-default、--set-default、--unload、--catalog、--local-catalog");
  process.exit(1);
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: `腳本執行錯誤: ${err.message}` }));
  process.exit(1);
});
