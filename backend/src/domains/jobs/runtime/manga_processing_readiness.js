const { MANGA_PROCESSING_JOB_TYPES } = require("./manga_processing_job_types");

function usesConfiguredMangaProcessor(job) {
  return MANGA_PROCESSING_JOB_TYPES.has(job?.type) && !job.payload?.baseUrl;
}

function applyMangaProcessorBaseUrl(manager, baseUrl) {
  if (!baseUrl) return;
  manager.resolvedConfig.api = { ...(manager.resolvedConfig.api || {}), baseUrl };
  manager.engine?.mangaProcessor?.setDefaultBaseUrl?.(baseUrl);
}

async function ensureMangaProcessorReadyForJob(manager, job, hooks = null) {
  if (!usesConfiguredMangaProcessor(job) || !manager.mangaProcessingRuntime) return null;
  hooks?.setStage?.("running", "manga_processor_runtime");
  const inspected = await manager.mangaProcessingRuntime.inspect?.();
  const status = inspected?.status === "running"
    ? inspected
    : await manager.mangaProcessingRuntime.ensureRunning();
  applyMangaProcessorBaseUrl(manager, status?.baseUrl);
  hooks?.emit?.("manga_processor_runtime.ready", status);
  return status;
}

function fallbackRuntimeStatus(manager) {
  return {
    status: manager.resolvedConfig.api?.baseUrl ? "configured" : "unconfigured",
    mode: "external",
    baseUrl: manager.resolvedConfig.api?.baseUrl || null,
    providerId: null,
    providerName: null,
    lastError: null,
  };
}

async function inspectMangaProcessorReadiness(manager) {
  const status = manager.mangaProcessingRuntime
    ? await manager.mangaProcessingRuntime.inspect()
    : fallbackRuntimeStatus(manager);
  const ready = status.status === "running";
  const baseUrl = status.baseUrl || manager.resolvedConfig.api?.baseUrl || null;
  return {
    ready,
    status: status.status,
    mode: status.mode || "external",
    baseUrl,
    providerId: status.providerId || null,
    providerName: status.providerName || null,
    error: ready ? null : status.lastError || `Manga processor is not reachable at ${baseUrl || "the configured endpoint"}.`,
  };
}

async function assertReachableByBaseUrl(manager, baseUrl) {
  if (!manager.mangaProcessingRuntime.isReachable) return null;
  const ready = await manager.mangaProcessingRuntime.isReachable(baseUrl);
  if (ready) return { ready: true, status: "running", mode: "external", baseUrl, error: null };
  throw new Error(`Manga processor is not reachable at ${baseUrl}.`);
}

async function assertRuntimeRunning(manager) {
  const status = await manager.mangaProcessingRuntime.ensureRunning();
  const readiness = {
    ready: status?.status === "running",
    status: status?.status || "running",
    mode: status?.mode || "external",
    baseUrl: status?.baseUrl || manager.resolvedConfig.api?.baseUrl || null,
    error: null,
  };
  if (!readiness.ready) throw new Error(`Manga processor did not report a running state (${readiness.status}).`);
  return readiness;
}

async function throwMangaProcessorUnavailable(manager, type, payload, cause) {
  const readiness = await inspectMangaProcessorReadiness(manager).catch(() => ({
    ready: false,
    status: "unavailable",
    mode: "external",
    baseUrl: payload.baseUrl || manager.resolvedConfig.api?.baseUrl || null,
    error: cause.message,
  }));
  const error = new Error(cause.message || readiness.error || "Manga processor is unavailable.");
  error.statusCode = 503;
  error.code = "manga_processor_unavailable";
  error.details = {
    service: "manga_processor",
    jobType: type,
    status: readiness.status,
    mode: readiness.mode,
    baseUrl: payload.baseUrl || readiness.baseUrl,
    retrySafe: true,
  };
  throw error;
}

async function assertMangaProcessorAvailableForJobType(manager, type, payload = {}) {
  if (!MANGA_PROCESSING_JOB_TYPES.has(type) || !manager.mangaProcessingRuntime) return null;
  try {
    if (payload.baseUrl) return await assertReachableByBaseUrl(manager, payload.baseUrl);
    if (manager.mangaProcessingRuntime.ensureRunning) return await assertRuntimeRunning(manager);
    const readiness = await inspectMangaProcessorReadiness(manager);
    if (readiness.ready) return readiness;
    throw new Error(readiness.error);
  } catch (cause) {
    return throwMangaProcessorUnavailable(manager, type, payload, cause);
  }
}

module.exports = {
  assertMangaProcessorAvailableForJobType,
  ensureMangaProcessorReadyForJob,
  inspectMangaProcessorReadiness,
  usesConfiguredMangaProcessor,
};
