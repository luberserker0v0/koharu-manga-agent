const { KOHARU_JOB_TYPES } = require("./koharu_job_types");

function usesConfiguredKoharu(job) {
  return KOHARU_JOB_TYPES.has(job?.type) && !job.payload?.baseUrl;
}

function applyKoharuBaseUrl(manager, baseUrl) {
  if (!baseUrl) return;
  manager.resolvedConfig.api = { ...(manager.resolvedConfig.api || {}), baseUrl };
  if (manager.engine?.projectLifecycle?.client) {
    manager.engine.projectLifecycle.client.defaultBaseUrl = baseUrl;
  }
}

async function ensureKoharuReadyForJob(manager, job, hooks = null) {
  if (!usesConfiguredKoharu(job) || !manager.koharuRuntimeManager) return null;
  hooks?.setStage?.("running", "koharu_runtime");
  const inspected = await manager.koharuRuntimeManager.inspect?.();
  const status = inspected?.status === "running" ? inspected : await manager.koharuRuntimeManager.ensureRunning();
  applyKoharuBaseUrl(manager, status?.baseUrl);
  hooks?.emit?.("koharu_runtime.ready", status);
  return status;
}

async function inspectKoharuReadiness(manager) {
  const status = manager.koharuRuntimeManager
    ? await manager.koharuRuntimeManager.inspect()
    : {
        status: manager.resolvedConfig.api?.baseUrl ? "configured" : "unconfigured",
        mode: "external",
        baseUrl: manager.resolvedConfig.api?.baseUrl || null,
        lastError: null,
      };
  const ready = status.status === "running";
  return {
    ready,
    status: status.status,
    mode: status.mode || "external",
    baseUrl: status.baseUrl || manager.resolvedConfig.api?.baseUrl || null,
    error: ready
      ? null
      : status.lastError ||
        `Koharu is not reachable at ${status.baseUrl || manager.resolvedConfig.api?.baseUrl || "the configured endpoint"}.`,
  };
}

async function assertKoharuReachableByBaseUrl(manager, baseUrl) {
  if (!manager.koharuRuntimeManager.isReachable) return null;
  const ready = await manager.koharuRuntimeManager.isReachable(baseUrl);
  if (ready) return { ready: true, status: "running", mode: "external", baseUrl, error: null };
  throw new Error(`Koharu is not reachable at ${baseUrl}.`);
}

async function assertKoharuEnsureRunning(manager) {
  const status = await manager.koharuRuntimeManager.ensureRunning();
  const readiness = {
    ready: status?.status === "running",
    status: status?.status || "running",
    mode: status?.mode || "external",
    baseUrl: status?.baseUrl || manager.resolvedConfig.api?.baseUrl || null,
    error: null,
  };
  if (!readiness.ready) throw new Error(`Koharu did not report a running state (${readiness.status}).`);
  return readiness;
}

async function throwKoharuUnavailable(manager, type, payload, cause) {
  const readiness = await inspectKoharuReadiness(manager).catch(() => ({
    ready: false,
    status: "unavailable",
    mode: "external",
    baseUrl: payload.baseUrl || manager.resolvedConfig.api?.baseUrl || null,
    error: cause.message,
  }));
  const error = new Error(cause.message || readiness.error || "Koharu is unavailable.");
  error.statusCode = 503;
  error.code = "koharu_unavailable";
  error.details = {
    service: "koharu",
    jobType: type,
    status: readiness.status,
    mode: readiness.mode,
    baseUrl: payload.baseUrl || readiness.baseUrl,
    retrySafe: true,
  };
  throw error;
}

async function assertKoharuAvailableForJobType(manager, type, payload = {}) {
  if (!KOHARU_JOB_TYPES.has(type) || !manager.koharuRuntimeManager) return null;
  try {
    if (payload.baseUrl) return await assertKoharuReachableByBaseUrl(manager, payload.baseUrl);
    if (manager.koharuRuntimeManager.ensureRunning) return await assertKoharuEnsureRunning(manager);
    const readiness = await inspectKoharuReadiness(manager);
    if (readiness.ready) return readiness;
    throw new Error(readiness.error);
  } catch (cause) {
    return throwKoharuUnavailable(manager, type, payload, cause);
  }
}

module.exports = {
  assertKoharuAvailableForJobType,
  ensureKoharuReadyForJob,
  inspectKoharuReadiness,
  usesConfiguredKoharu,
};
