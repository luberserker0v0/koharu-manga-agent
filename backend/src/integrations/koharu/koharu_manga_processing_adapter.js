const { assertMangaProcessingPorts } = require("../../domains/manga_processing/manga_processing_ports");
const { createProjectOrchestrator } = require("./pipeline/project_orchestrator");
const {
  buildTextRegionCorrectionOps,
  finalizeTextRegionOperationOutcome,
} = require("./scene/text_region_correction_adapter");

function translationUpdateOp(update) {
  return { updateNode: { page: update.pageId, id: update.nodeId,
    patch: { data: { text: { translation: update.translation } } } } };
}

class KoharuMangaProcessingAdapter {
  constructor(httpClient) {
    this.httpClient = httpClient;
    this.projectOrchestrator = createProjectOrchestrator(httpClient);
    assertMangaProcessingPorts(this, [
      "connection", "catalog", "project", "pipeline", "scene", "export", "configuration",
    ]);
  }

  setDefaultBaseUrl(baseUrl) { this.httpClient.defaultBaseUrl = baseUrl; }
  get defaultBaseUrl() { return this.httpClient.defaultBaseUrl; }
  getScene(baseUrl) { return this.httpClient.getScene(baseUrl); }
  getConfig(baseUrl) { return this.httpClient.getConfig(baseUrl); }
  patchConfig(patch, baseUrl) { return this.httpClient.patchConfig(patch, baseUrl); }
  getEngines(baseUrl) { return this.httpClient.getEngines(baseUrl); }
  getTranslationCatalog(baseUrl) { return this.httpClient.getTranslationCatalog(baseUrl); }
  getCurrentTranslationTarget(baseUrl) { return this.httpClient.getCurrentTranslationTarget(baseUrl); }
  setTranslationTarget(target, baseUrl, options) {
    return this.httpClient.setTranslationTarget(target, baseUrl, options);
  }
  createProject(name, baseUrl) { return this.httpClient.createProject(name, baseUrl); }
  openProject(id, baseUrl) { return this.httpClient.openProject(id, baseUrl); }
  closeCurrentProject(baseUrl) { return this.httpClient.closeCurrentProject(baseUrl); }
  listProjects(baseUrl) { return this.httpClient.listProjects(baseUrl); }
  listOperations(baseUrl) { return this.httpClient.listOperations(baseUrl); }
  stopOperation(id, baseUrl) { return this.httpClient.stopOperation(id, baseUrl); }
  openEventStream(baseUrl, signal) { return this.httpClient.openEventStream(baseUrl, signal); }
  startPipeline(options) { return this.httpClient.startPipeline(options); }
  exportCurrentProject(options) { return this.httpClient.exportCurrentProject(options); }
  applyHistoryBatch(options) { return this.httpClient.applyHistoryBatch(options); }
  async applyTextRegionCorrections({ snapshot, corrections, label, baseUrl }) {
    const scene = await this.getScene(baseUrl);
    const patch = buildTextRegionCorrectionOps(snapshot, corrections, scene);
    await this.applyHistoryBatch({ ops: patch.ops, label, baseUrl });
    return patch.outcome;
  }
  finalizeTextRegionCorrectionOutcome(outcome, snapshot) {
    return finalizeTextRegionOperationOutcome(outcome, snapshot);
  }
  applyTranslationUpdates({ updates, label, baseUrl }) {
    if (!updates.length) return Promise.resolve({ skipped: true });
    return this.applyHistoryBatch({ ops: updates.map(translationUpdateOp), label, baseUrl });
  }
  uploadPages(...args) { return this.projectOrchestrator.uploadPages(...args); }
  resolveEngines(...args) { return this.projectOrchestrator.resolveEngines(...args); }
  startResolvedPipeline(...args) { return this.projectOrchestrator.startPipeline(...args); }
  prepareProject(options) { return this.projectOrchestrator.prepareProject(options); }
  orchestrateProject(options) { return this.projectOrchestrator.orchestrate(options); }
}

module.exports = { KoharuMangaProcessingAdapter };
