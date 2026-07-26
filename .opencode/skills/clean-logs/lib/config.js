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

function resolvePath(targetPath) {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.join(PROJECT_ROOT, targetPath);
}

const projectConfig = loadProjectConfig();

module.exports = {
  PATHS: {
    LOGS: resolvePath(projectConfig.paths?.logs || "logs/"),
  },
  SUBAGENTS: ["pipeline-runner", "quality-checker", "knowledge-builder"],
};
