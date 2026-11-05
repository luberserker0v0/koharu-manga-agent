const PORT_METHODS = Object.freeze({
  catalog: ["getEngines", "getTranslationCatalog", "getCurrentTranslationTarget", "setTranslationTarget"],
  connection: ["setDefaultBaseUrl"],
  project: [
    "createProject", "openProject", "closeCurrentProject", "listProjects",
    "uploadPages", "prepareProject", "orchestrateProject",
  ],
  pipeline: [
    "startPipeline", "startResolvedPipeline", "resolveEngines",
    "listOperations", "stopOperation", "openEventStream",
  ],
  scene: [
    "getScene", "applyTextRegionCorrections",
    "finalizeTextRegionCorrectionOutcome", "applyTranslationUpdates",
  ],
  export: ["exportCurrentProject"],
  configuration: ["getConfig", "patchConfig"],
});

function portError(capability, method) {
  const error = new Error(`Manga processing ${capability} port requires ${method}().`);
  error.code = "invalid_manga_processing_port";
  return error;
}

function assertMangaProcessingPorts(processor, capabilities) {
  if (!processor || typeof processor !== "object") throw portError("adapter", "object");
  for (const capability of capabilities) {
    const methods = PORT_METHODS[capability];
    if (!methods) throw new Error(`Unknown manga processing capability: ${capability}.`);
    for (const method of methods) {
      if (typeof processor[method] !== "function") throw portError(capability, method);
    }
  }
  return processor;
}

module.exports = { PORT_METHODS, assertMangaProcessingPorts };
