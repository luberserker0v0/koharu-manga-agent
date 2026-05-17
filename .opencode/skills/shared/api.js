#!/usr/bin/env node

/**
 * api.js
 * Koharu HTTP API 端點常數 + fetch 封裝。
 *
 * 用法:
 *   const { ENDPOINTS, apiFetch } = require("../../shared/api");
 *   const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl: "http://..." });
 */

const config = require("./config");

// ============================================================
// API 端點常數
// ============================================================
const ENDPOINTS = {
  // 專案
  PROJECTS: "/api/v1/projects",
  PROJECTS_CURRENT: "/api/v1/projects/current",
  SCENE: "/api/v1/scene.json",

  // 頁面
  PAGES: "/api/v1/pages",
  PAGES_FROM_PATHS: "/api/v1/pages/from-paths",

  // LLM
  LLM_CURRENT: "/api/v1/llm/current",
  LLM_CATALOG: "/api/v1/llm/catalog",

  // 引擎
  ENGINES: "/api/v1/engines",

  // 管線
  PIPELINES: "/api/v1/pipelines",
  OPERATIONS: "/api/v1/operations",
  EVENTS: "/api/v1/events",

  // 歷史
  HISTORY_APPLY: "/api/v1/history/apply",
  HISTORY_UNDO: "/api/v1/history/undo",
  HISTORY_REDO: "/api/v1/history/redo",

  // 匯出
  EXPORT: "/api/v1/projects/current/export",
};

// 建構完整 URL
function buildUrl(endpoint, baseUrl) {
  const base = (baseUrl || config.DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}${endpoint}`;
}

// 封裝 fetch（自動加入 Content-Type 與 JSON body 序列化）
async function apiFetch(endpoint, opts = {}) {
  const { baseUrl, body, ...fetchOpts } = opts;
  const url = buildUrl(endpoint, baseUrl);
  const headers = { "Content-Type": "application/json", ...fetchOpts.headers };
  const mergedOpts = { ...fetchOpts, headers };
  if (body !== undefined) {
    mergedOpts.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return fetch(url, mergedOpts);
}

module.exports = { ENDPOINTS, buildUrl, apiFetch };
