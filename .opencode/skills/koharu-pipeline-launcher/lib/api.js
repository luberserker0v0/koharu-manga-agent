#!/usr/bin/env node

const config = require("./config");

const ENDPOINTS = {
  PIPELINES: "/api/v1/pipelines",
  OPERATIONS: "/api/v1/operations",
  EVENTS: "/api/v1/events",
  SCENE: "/api/v1/scene.json",
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
