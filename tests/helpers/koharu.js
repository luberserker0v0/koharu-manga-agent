const path = require("path");
const config = require(path.join(__dirname, "../../.opencode/skills/manga-translate-zhtw/lib/config"));
const { apiFetch, ENDPOINTS } = require(path.join(__dirname, "../../.opencode/skills/manga-translate-zhtw/lib/api"));

const BASE_URL = process.env.KOHARU_BASE_URL || config.DEFAULT_BASE_URL;

async function listProjects() {
  const res = await apiFetch(ENDPOINTS.PROJECTS, { baseUrl: BASE_URL });
  if (!res.ok) throw new Error(`列出專案失敗 (${res.status})`);
  const data = await res.json();
  return data.projects || [];
}

async function openProject(id) {
  const res = await apiFetch(ENDPOINTS.PROJECTS_CURRENT, {
    method: "PUT",
    baseUrl: BASE_URL,
    body: { id },
  });
  if (!res.ok) throw new Error(`開啟專案失敗 (${res.status})`);
  return res.json();
}

async function closeProject() {
  const res = await apiFetch(ENDPOINTS.PROJECTS_CURRENT, {
    method: "DELETE",
    baseUrl: BASE_URL,
  });
  if (!res.ok) throw new Error(`關閉專案失敗 (${res.status})`);
  return res.json();
}

async function getScene() {
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl: BASE_URL });
  if (!res.ok) throw new Error(`取得場景失敗 (${res.status})`);
  return res.json();
}

async function startPipeline(steps, targetLanguage) {
  const body = { steps, targetLanguage: targetLanguage || config.DEFAULTS.targetLanguage };
  const res = await apiFetch(ENDPOINTS.PIPELINES, {
    method: "POST",
    baseUrl: BASE_URL,
    body,
  });
  if (!res.ok) throw new Error(`啟動管線失敗 (${res.status})`);
  return res.json();
}

async function exportProject(format) {
  const res = await apiFetch(ENDPOINTS.EXPORT, {
    method: "POST",
    baseUrl: BASE_URL,
    body: { format: format || config.DEFAULTS.exportFormat },
  });
  if (!res.ok) throw new Error(`匯出失敗 (${res.status})`);
  return res;
}

async function getLLMStatus() {
  const res = await apiFetch(ENDPOINTS.LLM_CURRENT, { baseUrl: BASE_URL });
  if (!res.ok) throw new Error(`取得 LLM 狀態失敗 (${res.status})`);
  return res.json();
}

async function getEngines() {
  const res = await apiFetch(ENDPOINTS.ENGINES, { baseUrl: BASE_URL });
  if (!res.ok) throw new Error(`取得引擎失敗 (${res.status})`);
  return res.json();
}

module.exports = {
  BASE_URL,
  listProjects,
  openProject,
  closeProject,
  getScene,
  startPipeline,
  exportProject,
  getLLMStatus,
  getEngines,
};
