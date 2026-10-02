#!/usr/bin/env node

const backendConfig = require("../../../../backend/src/config");

module.exports = {
  PATHS: {
    LOGS: backendConfig.paths.logs,
  },
  SUBAGENTS: ["pipeline-runner", "quality-checker", "knowledge-builder"],
};
