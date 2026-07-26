#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..", "..", "..");
const PROJECT_CONFIG_PATH = path.join(PROJECT_ROOT, ".opencode", "koharu.json");

function loadProjectConfig() {
  try {
    return JSON.parse(fs.readFileSync(PROJECT_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

const projectConfig = loadProjectConfig();

module.exports = {
  DEFAULT_BASE_URL: projectConfig.api?.baseUrl || "http://127.0.0.1:9999",
};
