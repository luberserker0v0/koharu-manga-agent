#!/usr/bin/env node

const config = require("./config");

const ENDPOINTS = {
  PROJECTS: "/api/v1/projects",
  PROJECTS_CURRENT: "/api/v1/projects/current",
  SCENE: "/api/v1/scene.json",
  PAGES: "/api/v1/pages",
  PAGES_FROM_PATHS: "/api/v1/pages/from-paths",
  LLM_CURRENT: "/api/v1/llm/current",
  LLM_CATALOG: "/api/v1/llm/catalog",
  ENGINES: "/api/v1/engines",
  PIPELINES: "/api/v1/pipelines",
  OPERATIONS: "/api/v1/operations",
  EVENTS: "/api/v1/events",
  HISTORY_APPLY: "/api/v1/history/apply",
  HISTORY_UNDO: "/api/v1/history/undo",
  HISTORY_REDO: "/api/v1/history/redo",
  EXPORT: "/api/v1/projects/current/export",
};

function buildUrl(endpoint, baseUrl) {
  const base = (baseUrl || config.DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}${endpoint}`;
}

async function apiFetch(endpoint, opts = {}) {
  const { baseUrl, body, ...fetchOpts } = opts;
  const headers = { "Content-Type": "application/json", ...fetchOpts.headers };
  const finalOpts = { ...fetchOpts, headers };

  if (body !== undefined) {
    finalOpts.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return fetch(buildUrl(endpoint, baseUrl), finalOpts);
}

module.exports = { ENDPOINTS, buildUrl, apiFetch };
