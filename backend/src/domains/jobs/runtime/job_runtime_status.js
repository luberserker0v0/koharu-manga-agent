function runtimeBackendStatus(manager) {
  return {
    status: "ready",
    host: manager.runtimeConfig.host,
    port: manager.runtimeConfig.port,
    deploymentMode: process.env.MANGA_TRANSLATION_BACKEND_MODE || "standalone",
  };
}

function runtimeKoharuStatus(manager, koharuStatus) {
  return {
    ...koharuStatus,
    baseUrl: koharuStatus.baseUrl || manager.resolvedConfig.api?.baseUrl || null,
  };
}

function runtimeAgentStatus(manager, agent) {
  return {
    status: agent.status,
    baseUrl: manager.resolvedConfig.agent?.baseUrl || null,
    model: manager.resolvedConfig.agent?.model || null,
    agentName: manager.resolvedConfig.agent?.agentName || null,
    lastError: agent.error,
  };
}

function runtimeQualityStatus(manager) {
  return {
    enabled: manager.resolvedConfig.workflow?.qualityCheck?.enabled !== false,
    modelId: manager.resolvedConfig.quality?.modelId || null,
    serverUrl: manager.resolvedConfig.quality?.serverUrl || null,
  };
}

async function inspectKoharuRuntimeStatus(manager) {
  if (manager.koharuRuntimeManager) return manager.koharuRuntimeManager.inspect();
  return {
    status: manager.resolvedConfig.api?.baseUrl ? "configured" : "unconfigured",
    mode: "external",
    baseUrl: manager.resolvedConfig.api?.baseUrl || null,
    version: manager.resolvedConfig.koharuRuntime?.version || null,
    installed: false,
    managedPid: null,
    lastError: null,
  };
}

async function resolveAgentRuntimeStatus(manager) {
  if (!manager.resolvedConfig.agent?.baseUrl) return { status: "unconfigured", error: null };
  if (!manager.aoClient?.checkAvailability) return { status: "configured", error: null };
  try {
    await manager.aoClient.checkAvailability({ timeoutMs: 1500 });
    return { status: "ready", error: null };
  } catch (cause) {
    return { status: "unavailable", error: cause.message };
  }
}

async function getJobRuntimeStatus(manager) {
  const koharuStatus = await inspectKoharuRuntimeStatus(manager);
  const agent = await resolveAgentRuntimeStatus(manager);
  return {
    backend: runtimeBackendStatus(manager),
    koharu: runtimeKoharuStatus(manager, koharuStatus),
    agent: runtimeAgentStatus(manager, agent),
    quality: runtimeQualityStatus(manager),
    translation: { defaultTarget: manager.resolvedConfig.translation?.defaultTarget || null },
  };
}

function readinessIssue(service, runtimeService) {
  const koharu = service === "koharu";
  return {
    service,
    code: koharu ? "koharu_unavailable" : "ao_unavailable",
    message: runtimeService.lastError ||
      `${koharu ? "Koharu is not reachable" : "AO is not ready"} at ${runtimeService.baseUrl || "the configured endpoint"}.`,
  };
}

function readinessServices(runtime, koharuReady, agentReady) {
  return {
    backend: { required: true, ready: true, status: runtime.backend.status },
    koharu: {
      required: true,
      ready: koharuReady,
      status: runtime.koharu.status,
      mode: runtime.koharu.mode,
      baseUrl: runtime.koharu.baseUrl,
    },
    ao: {
      required: false,
      ready: agentReady,
      status: runtime.agent.status,
      baseUrl: runtime.agent.baseUrl,
    },
  };
}

async function getJobReadiness(manager) {
  const runtime = await getJobRuntimeStatus(manager);
  const koharuReady = runtime.koharu.status === "running";
  const agentReady = runtime.agent.status === "ready";
  return {
    ok: koharuReady,
    status: !koharuReady ? "blocked" : agentReady ? "ready" : "degraded",
    checkedAt: new Date().toISOString(),
    deploymentMode: runtime.backend.deploymentMode,
    services: readinessServices(runtime, koharuReady, agentReady),
    capabilities: { koharuJobs: koharuReady, aoJobs: agentReady },
    blockers: koharuReady ? [] : [readinessIssue("koharu", runtime.koharu)],
    warnings: agentReady ? [] : [readinessIssue("ao", runtime.agent)],
  };
}

module.exports = { getJobReadiness, getJobRuntimeStatus };
