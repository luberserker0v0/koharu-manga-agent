#!/usr/bin/env node

const config = require("./config");

function loadWorkflowConfig() {
  return config.WORKFLOW || {};
}

function shouldRunQualityCheck(workflow = loadWorkflowConfig()) {
  return workflow.qualityCheck?.enabled !== false;
}

function shouldRunKnowledgeBuilder(workflow = loadWorkflowConfig(), explicitRequest = false) {
  return Boolean(explicitRequest || workflow.knowledgeBuilder?.enabled);
}

function shouldCloseProject({
  exportSucceeded,
  knowledgeBuilderRequested = false,
  knowledgeBuilderSucceeded = false,
} = {}) {
  if (!exportSucceeded) {
    return false;
  }

  if (!knowledgeBuilderRequested) {
    return true;
  }

  return knowledgeBuilderSucceeded;
}

module.exports = {
  loadWorkflowConfig,
  shouldRunQualityCheck,
  shouldRunKnowledgeBuilder,
  shouldCloseProject,
};
