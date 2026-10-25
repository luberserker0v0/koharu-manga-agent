const { config } = require("../../backend/src/config");
const { KoharuClient } = require("../../backend/src/integrations/koharu/client/koharu_client");

const BASE_URL = process.env.KOHARU_BASE_URL || config.api.baseUrl;
const client = new KoharuClient(BASE_URL);

async function listProjects() {
  return client.listProjects(BASE_URL);
}

async function openProject(id) {
  return client.openProject(id, BASE_URL);
}

async function getScene() {
  return client.getScene(BASE_URL);
}

async function getLLMStatus() {
  return client.getCurrentTranslationTarget(BASE_URL);
}

async function getEngines() {
  return client.getEngines(BASE_URL);
}

module.exports = {
  BASE_URL,
  listProjects,
  openProject,
  getScene,
  getLLMStatus,
  getEngines,
};
