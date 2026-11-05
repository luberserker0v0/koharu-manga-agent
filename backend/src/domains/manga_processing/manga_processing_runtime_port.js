const RUNTIME_METHODS = Object.freeze([
  "inspect",
  "inspectPaths",
  "ensureInstalled",
  "ensureRunning",
  "prepareRuntime",
  "stopManaged",
  "isReachable",
  "setExternalBaseUrl",
]);

function runtimePortError(method) {
  const error = new Error(`Manga processing runtime port requires ${method}().`);
  error.code = "invalid_manga_processing_runtime_port";
  return error;
}

function assertMangaProcessingRuntimePort(runtime) {
  if (!runtime || typeof runtime !== "object") throw runtimePortError("object");
  for (const method of RUNTIME_METHODS) {
    if (typeof runtime[method] !== "function") throw runtimePortError(method);
  }
  return runtime;
}

module.exports = { RUNTIME_METHODS, assertMangaProcessingRuntimePort };
