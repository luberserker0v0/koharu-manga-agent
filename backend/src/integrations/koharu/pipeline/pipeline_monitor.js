const { config, runtime } = require("../../../config");
const { ENDPOINTS, buildUrl } = require("../client/koharu_client");

const COMPLETED_PIPELINE_STATUSES = new Set(["completed", "completed_with_errors"]);
const FAILED_PIPELINE_STATUSES = new Set(["failed", "canceled", "cancelled", "stopped"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCancellationSignal(isCanceled) {
  let timer = null;
  let resolveRequest;
  const promise = new Promise((resolve) => { resolveRequest = resolve; });
  if (typeof isCanceled === "function") {
    if (isCanceled()) resolveRequest();
    else {
      const intervalMs = Math.min(Math.max(runtime.pollIntervalMs || 100, 50), 250);
      timer = setInterval(() => {
        if (!isCanceled()) return;
        clearInterval(timer);
        timer = null;
        resolveRequest();
      }, intervalMs);
    }
  }
  return { promise, close: () => { if (timer) clearInterval(timer); } };
}

function createPipelineCanceledError(operationId) {
  const error = new Error(`Koharu operation ${operationId} was stopped by user request.`);
  error.code = "job_canceled";
  return error;
}

function createOperationStopError(operationId, cause) {
  const error = new Error(`Koharu operation ${operationId} could not be stopped: ${cause.message}`);
  error.code = "koharu_cancel_failed";
  error.cause = cause;
  return error;
}

function createTerminalPipelineError(status, detail = null) {
  const suffix = detail ? `: ${detail}` : "";
  const error = new Error(`Pipeline ended with status: ${status}${suffix}`);
  error.pipelineTerminal = true;
  error.pipelineStatus = status;
  error.pipelineDetail = detail;
  return error;
}

function createPipelineTimeoutError(operationId) {
  const error = new Error(`Pipeline operation ${operationId} did not reach a terminal state before timeout.`);
  error.code = "koharu_pipeline_timeout";
  error.pipelineTerminal = true;
  error.pipelineStatus = "timeout";
  return error;
}

function recoveredSceneIsComplete(summary, totalPagesHint) {
  const pagesMatch = typeof totalPagesHint !== "number" || summary.totalPages === totalPagesHint;
  return pagesMatch && summary.totalTextNodes > 0 && summary.translatedNodes >= summary.totalTextNodes;
}

function pollingProgressSignature(operation, progress) {
  return JSON.stringify([
    operation?.status,
    operation?.progress,
    progress?.completedPages,
    progress?.currentPageIndex,
    progress?.engine,
  ]);
}

function markSseActivity(data, state, onActivity) {
  const signature = JSON.stringify([data?.status, data?.overallPercent, data?.currentPage, data?.step]);
  if (signature === state.lastProgressSignature) return;
  state.lastProgressSignature = signature;
  onActivity();
}

function createIdleTimeout(operationId, timeoutMs) {
  const controller = new AbortController();
  let timeoutHandle = null;
  let timedOut = false;
  function touch() {
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  }
  function rethrow(error) {
    if (timedOut) throw createPipelineTimeoutError(operationId);
    throw error;
  }
  function close() {
    clearTimeout(timeoutHandle);
    controller.abort();
  }
  return { controller, touch, rethrow, close };
}

function attachCancellationAbort(cancelState, idle) {
  const abort = () => idle.close();
  cancelState.abort = abort;
  if (cancelState.stopPromise) abort();
  return () => { if (cancelState.abort === abort) cancelState.abort = null; };
}

function summarizePage(page) {
  let textNodes = 0;
  let translatedNodes = 0;
  for (const node of Object.values(page.nodes || {})) {
    if (node.kind?.text) textNodes += 1;
    if (node.kind?.text?.translation) translatedNodes += 1;
  }
  return { textNodes, translatedNodes, complete: textNodes > 0 && translatedNodes >= textNodes };
}

function summarizeScene(scene) {
  const pages = scene?.scene?.pages || {};
  let totalPages = 0;
  let translatedNodes = 0;
  let totalTextNodes = 0;
  let translatedPages = 0;
  const pageNames = [];

  for (const page of Object.values(pages)) {
    totalPages += 1;
    pageNames.push(page.name || null);
    const summary = summarizePage(page);
    totalTextNodes += summary.textNodes;
    translatedNodes += summary.translatedNodes;
    if (summary.complete) translatedPages += 1;
  }

  return {
    totalPages,
    translatedNodes,
    totalTextNodes,
    translatedPages,
    pageNames,
  };
}

function normalizePipelinePlan(pipelinePlan = []) {
  return Array.isArray(pipelinePlan) ? pipelinePlan.filter(Boolean) : [];
}

function normalizeCurrentPageIndex(rawCurrentPage) {
  if (typeof rawCurrentPage !== "number" || !Number.isFinite(rawCurrentPage)) {
    return null;
  }
  return rawCurrentPage + 1;
}

function resolveSseTotalPages(data, totalPagesHint, sceneSummary) {
  if (typeof data?.totalPages === "number" && Number.isFinite(data.totalPages) && data.totalPages > 0) {
    return data.totalPages;
  }
  if (typeof totalPagesHint === "number" && totalPagesHint > 0) {
    return totalPagesHint;
  }
  return sceneSummary.totalPages || null;
}

function getSsePageName(sceneSummary, currentPageIndex) {
  if (typeof currentPageIndex !== "number" || currentPageIndex <= 0 || !Array.isArray(sceneSummary.pageNames)) {
    return null;
  }
  return sceneSummary.pageNames[currentPageIndex - 1] || null;
}

function completedPagesBeforeCurrent(currentPageIndex) {
  return typeof currentPageIndex === "number" ? Math.max(0, currentPageIndex - 1) : null;
}

function buildSseTelemetry(data) {
  return {
    source: "sse",
    event: typeof data?.event === "string" ? data.event : "jobProgress",
    rawStatus: typeof data?.status === "string" ? data.status : null,
    rawStep: typeof data?.step === "string" ? data.step : null,
    rawCurrentPage: typeof data?.currentPage === "number" ? data.currentPage : null,
    rawTotalPages: typeof data?.totalPages === "number" ? data.totalPages : null,
    rawOverallPercent: typeof data?.overallPercent === "number" ? data.overallPercent : null,
  };
}

function buildProgressPayloadFromSseEvent(options) {
  const { operationId, data, sceneSummary, totalPagesHint = null, pipelinePlan = [] } = options;
  const normalizedPlan = normalizePipelinePlan(pipelinePlan);
  const step = typeof data?.step === "string" ? data.step : null;
  const engineIndex = step ? normalizedPlan.indexOf(step) : -1;
  const totalPages = resolveSseTotalPages(data, totalPagesHint, sceneSummary);
  const currentPageIndex = normalizeCurrentPageIndex(data?.currentPage);
  const currentPageName = getSsePageName(sceneSummary, currentPageIndex);
  const status = typeof data?.status === "string" ? data.status : "running";
  const progress =
    typeof data?.overallPercent === "number" && Number.isFinite(data.overallPercent)
      ? Math.max(0, Math.min(1, data.overallPercent / 100))
      : null;
  return {
    operationId,
    status,
    progress,
    engine: step,
    engineIndex: engineIndex >= 0 ? engineIndex : null,
    engineStatus: status,
    completedPages: completedPagesBeforeCurrent(currentPageIndex),
    totalPages,
    currentPageIndex,
    currentPageName,
    progressSemanticsVersion: 2,
    telemetry: buildSseTelemetry(data),
  };
}

function inferEngineProgress({ operation, pipelinePlan }) {
  const normalizedPlan = normalizePipelinePlan(pipelinePlan);
  const rawProgress = normalizeRawProgress(operation);
  if (normalizedPlan.length === 0) return noPlanProgress(operation, rawProgress);
  if (isCompletedStatus(operation?.status)) return completedProgress(normalizedPlan, rawProgress);
  if (isTerminalFailureStatus(operation?.status))
    return terminalFailureProgress(normalizedPlan, operation, rawProgress);
  if (typeof rawProgress === "number") return runningProgress(normalizedPlan, rawProgress);
  return unknownProgress(operation, rawProgress);
}

function normalizeRawProgress(operation) {
  return typeof operation?.progress === "number" && Number.isFinite(operation.progress)
    ? Math.max(0, Math.min(1, operation.progress))
    : null;
}
function noPlanProgress(operation, rawProgress) {
  return {
    engine: null,
    engineIndex: null,
    engineStatus: operation?.status || "unknown",
    progress: rawProgress,
  };
}
function isCompletedStatus(status) {
  return COMPLETED_PIPELINE_STATUSES.has(status);
}
function completedProgress(normalizedPlan, rawProgress) {
  return {
    engine: normalizedPlan[normalizedPlan.length - 1],
    engineIndex: normalizedPlan.length - 1,
    engineStatus: "completed",
    progress: rawProgress,
  };
}
function isTerminalFailureStatus(status) {
  return FAILED_PIPELINE_STATUSES.has(status);
}
function terminalFailureProgress(normalizedPlan, operation, rawProgress) {
  const fallbackIndex =
    typeof rawProgress === "number"
      ? Math.min(normalizedPlan.length - 1, Math.floor(rawProgress * normalizedPlan.length))
      : null;
  return {
    engine: typeof fallbackIndex === "number" ? normalizedPlan[fallbackIndex] || null : null,
    engineIndex: fallbackIndex,
    engineStatus: operation.status,
    progress: rawProgress,
  };
}
function runningProgress(normalizedPlan, rawProgress) {
  const activeIndex = Math.min(normalizedPlan.length - 1, Math.floor(rawProgress * normalizedPlan.length));
  return {
    engine: normalizedPlan[activeIndex] || null,
    engineIndex: activeIndex,
    engineStatus: "running",
    progress: rawProgress,
  };
}
function unknownProgress(operation, rawProgress) {
  return {
    engine: null,
    engineIndex: null,
    engineStatus: operation?.status || "running",
    progress: rawProgress,
  };
}

function buildProgressPayloadTotalPages(totalPagesHint, sceneSummary) {
  return typeof totalPagesHint === "number" && totalPagesHint > 0 ? totalPagesHint : sceneSummary.totalPages || null;
}
function buildProgressPayloadCompletedPages(sceneSummary, engineProgress, totalPages) {
  if (typeof engineProgress.progress === "number" && typeof totalPages === "number") {
    return Math.max(0, Math.min(totalPages, Math.floor(totalPages * engineProgress.progress)));
  }
  if (engineProgress.engineStatus === "completed" && typeof totalPages === "number") return totalPages;
  if (sceneSummary.translatedPages > 0) return Math.max(0, sceneSummary.translatedPages - 1);
  return null;
}
function buildProgressPayloadCurrentPageIndex(totalPages, completedPages) {
  if (typeof totalPages !== "number" || typeof completedPages !== "number" || totalPages <= 0) return null;
  if (completedPages < totalPages) return completedPages + 1;
  if (completedPages === totalPages) return totalPages;
  return null;
}

function buildProgressPayload({ operation, sceneSummary, totalPagesHint = null, pipelinePlan = [] }) {
  const engineProgress = inferEngineProgress({ operation, pipelinePlan });
  const totalPages = buildProgressPayloadTotalPages(totalPagesHint, sceneSummary);
  const completedPages = buildProgressPayloadCompletedPages(sceneSummary, engineProgress, totalPages);
  const currentPageIndex = buildProgressPayloadCurrentPageIndex(totalPages, completedPages);
  const currentPageName =
    typeof currentPageIndex === "number" && currentPageIndex > 0 && Array.isArray(sceneSummary.pageNames)
      ? sceneSummary.pageNames[currentPageIndex - 1] || null
      : null;
  return {
    operationId: operation.id,
    status: operation.status,
    progress: engineProgress.progress,
    engine: engineProgress.engine,
    engineIndex: engineProgress.engineIndex,
    engineStatus: engineProgress.engineStatus,
    completedPages,
    totalPages,
    currentPageIndex,
    currentPageName,
    progressSemanticsVersion: 2,
    telemetry: {
      source: "polling",
      rawStatus: typeof operation?.status === "string" ? operation.status : null,
      rawProgress: typeof operation?.progress === "number" ? operation.progress : null,
    },
  };
}

class PipelineMonitorModule {
  constructor(client) {
    this.client = client;
  }

  async buildSceneSummary(baseUrl, totalPagesHint = null) {
    let sceneSummary = {
      totalPages: typeof totalPagesHint === "number" ? totalPagesHint : 0,
      translatedNodes: 0,
      totalTextNodes: 0,
      translatedPages: 0,
      pageNames: [],
    };

    try {
      const scene = await this.client.getScene(baseUrl);
      sceneSummary = summarizeScene(scene);
    } catch {
      // Best-effort only; progress events should still flow if scene cannot be read.
    }

    return sceneSummary;
  }

  async runWithPolling(options) {
    const { operationId, baseUrl, timeoutMs, onProgress, isCanceled,
      pipelinePlan = [], totalPagesHint = null } = options;
    let lastActivityAt = Date.now();
    let lastSignature = null;
    while (Date.now() - lastActivityAt < timeoutMs) {
      if (isCanceled && isCanceled()) await this.stopCanceledOperation(options);
      const operation = await this.findPollingOperation(baseUrl, operationId);
      if (!operation) {
        return this.recover({ operationId, baseUrl, reason: "listener_attached_too_late", totalPagesHint });
      }
      const progress = await this.emitPollingProgress({ operation, baseUrl, totalPagesHint, pipelinePlan, onProgress });
      const signature = pollingProgressSignature(operation, progress);
      if (signature !== lastSignature) { lastSignature = signature; lastActivityAt = Date.now(); }
      if (isCompletedStatus(operation.status) || isTerminalFailureStatus(operation.status)) {
        return this.handlePollingTerminal({ operation, baseUrl });
      }
      await sleep(runtime.pollIntervalMs);
    }
    return this.finishPollingTimeout({ operationId, baseUrl, totalPagesHint });
  }

  async finishPollingTimeout({ operationId, baseUrl, totalPagesHint }) {
    const operation = await this.findPollingOperation(baseUrl, operationId);
    if (!operation) return this.recover({ operationId, baseUrl, reason: "operation_disappeared", totalPagesHint });
    if (isCompletedStatus(operation.status) || isTerminalFailureStatus(operation.status)) {
      return this.handlePollingTerminal({ operation, baseUrl });
    }
    throw createPipelineTimeoutError(operationId);
  }

  async findPollingOperation(baseUrl, operationId) {
    const operations = await this.client.listOperations(baseUrl);
    return operations.find((entry) => entry.id === operationId) || null;
  }

  async emitPollingProgress({ operation, baseUrl, totalPagesHint, pipelinePlan, onProgress }) {
    const sceneSummary = await this.buildSceneSummary(baseUrl, totalPagesHint);
    const progress = buildProgressPayload({ operation, sceneSummary, totalPagesHint, pipelinePlan });
    if (typeof onProgress === "function") onProgress(progress);
    return progress;
  }

  async handlePollingTerminal({ operation, baseUrl }) {
    if (isCompletedStatus(operation.status)) {
      const scene = await this.client.getScene(baseUrl);
      const summary = summarizeScene(scene);
      return {
        summary: {
          steps: {},
          totalPages: summary.totalPages,
          finalStatus: operation.status,
        },
        recovered: false,
        reason: operation.status,
      };
    }
    throw createTerminalPipelineError(operation.status, operation.error || null);
  }

  async readSseEvents(response, context, controller) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      if (context.isCanceled && context.isCanceled()) {
        controller.abort();
        await this.stopCanceledOperation(context);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE disconnected before terminal event");
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const result = await this.handleSseLine({ rawLine, ...context });
        if (result) return result;
      }
    }
  }

  async runWithSse(options) {
    const { operationId, baseUrl, timeoutMs, onProgress, isCanceled,
      pipelinePlan = [], totalPagesHint = null, cancelState = {} } = options;
    const initialResult = await this.resolveInitialSseOperation({
      operationId,
      baseUrl,
      totalPagesHint,
    });
    if (initialResult) return initialResult;
    const idle = createIdleTimeout(operationId, timeoutMs);
    idle.touch();
    const detachCancellationAbort = attachCancellationAbort(cancelState, idle);
    const state = {
      sceneSummary: await this.buildSceneSummary(baseUrl, totalPagesHint),
      eventType: "",
      lastProgressSignature: null,
    };
    try {
      const response = await this.fetchSseResponse(baseUrl, idle.controller);
      return await this.readSseEvents(response, {
         state, operationId, baseUrl, totalPagesHint, pipelinePlan, onProgress,
         isCanceled, cancelState, onActivity: idle.touch,
      }, idle.controller);
    } catch (error) {
      idle.rethrow(error);
    } finally {
      detachCancellationAbort();
      idle.close();
    }
  }

  async resolveInitialSseOperation({ operationId, baseUrl, totalPagesHint }) {
    const statusCheck = await this.client.listOperations(baseUrl);
    const currentOperation = statusCheck.find((entry) => entry.id === operationId);
    if (!currentOperation) {
      return this.recover({
        operationId,
        baseUrl,
        reason: "listener_attached_too_late",
        totalPagesHint,
      });
    }
    if (isCompletedStatus(currentOperation.status)) {
      const scene = await this.client.getScene(baseUrl);
      const summary = summarizeScene(scene);
      return {
        summary: {
          steps: {},
          totalPages: summary.totalPages,
          finalStatus: currentOperation.status,
        },
        recovered: false,
        reason: currentOperation.status,
      };
    }
    if (isTerminalFailureStatus(currentOperation.status)) {
      throw createTerminalPipelineError(currentOperation.status);
    }
    return null;
  }

  async fetchSseResponse(baseUrl, controller) {
    const response = await fetch(buildUrl(ENDPOINTS.EVENTS, baseUrl), {
      method: "GET",
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE listen failed (${response.status})`);
    }
    return response;
  }

  async handleSseLine({ rawLine, state, operationId, baseUrl, totalPagesHint, pipelinePlan, onProgress, onActivity }) {
    const line = rawLine.trimEnd();
    if (!line) {
      state.eventType = "";
      return null;
    }
    if (line.startsWith("event:")) {
      state.eventType = line.slice(6).trim();
      return null;
    }
    const data = await this.parseSseDataPayload(line, state, operationId);
    if (data === null) return null;
    markSseActivity(data, state, onActivity);
    if ((state.eventType === "jobProgress" || data?.event === "jobProgress") && typeof onProgress === "function") {
      await this.handleSseProgress({
        operationId,
        data,
        state,
        baseUrl,
        totalPagesHint,
        pipelinePlan,
        onProgress,
      });
    }
    if (state.eventType === "jobFinished" || data?.event === "jobFinished") {
      return this.handleSseFinished({ data, baseUrl });
    }
    state.eventType = "";
    return null;
  }

  async parseSseDataPayload(line, state, operationId) {
    if (!line.startsWith("data:")) return null;
    const payloadText = line.slice(5).trim();
    if (!payloadText) return null;
    let data;
    try {
      data = JSON.parse(payloadText);
    } catch {
      state.eventType = "";
      return null;
    }
    const eventOperationId = data?.id || data?.jobId;
    if (eventOperationId && eventOperationId !== operationId) {
      state.eventType = "";
      return null;
    }
    return data;
  }

  async handleSseProgress({ operationId, data, state, baseUrl, totalPagesHint, pipelinePlan, onProgress }) {
    const currentPage = typeof data?.currentPage === "number" ? data.currentPage : null;
    const totalPages = typeof data?.totalPages === "number" ? data.totalPages : null;
    const needsSceneRefresh =
      !state.sceneSummary.pageNames.length ||
      (currentPage !== null && currentPage + 1 > state.sceneSummary.pageNames.length) ||
      (totalPages !== null && totalPages > state.sceneSummary.pageNames.length);
    if (needsSceneRefresh) {
      state.sceneSummary = await this.buildSceneSummary(baseUrl, totalPagesHint);
    }
    onProgress(
      buildProgressPayloadFromSseEvent({
        operationId,
        data,
        sceneSummary: state.sceneSummary,
        totalPagesHint,
        pipelinePlan,
      }),
    );
  }

  async handleSseFinished({ data, baseUrl }) {
    const finalStatus = typeof data?.status === "string" ? data.status : "completed";
    if (isCompletedStatus(finalStatus)) {
      const scene = await this.client.getScene(baseUrl);
      const summary = summarizeScene(scene);
      return {
        summary: { steps: {}, totalPages: summary.totalPages, finalStatus },
        recovered: false,
        reason: finalStatus,
      };
    }
    throw createTerminalPipelineError(finalStatus, data?.error || null);
  }

  async recover({ operationId, baseUrl, reason, totalPagesHint = null }) {
    const scene = await this.client.getScene(baseUrl);
    const summary = summarizeScene(scene);

    if (recoveredSceneIsComplete(summary, totalPagesHint)) {
      return {
        summary: {
          steps: {
            translate: "COMPLETED",
          },
          totalPages: summary.totalPages,
          finalStatus: "completed_before_listener_attached",
        },
        recovered: true,
        reason,
      };
    }

    throw new Error(`Unable to recover operation ${operationId} after ${reason}. No translated scene state was found.`);
  }

  async runPreferred(options) {
    const { operationId, baseUrl, timeoutMs = config.timeouts.sseListen * 1000,
      onProgress, isCanceled, pipelinePlan = [], totalPagesHint = null } = options;
    try {
      return await this.runWithSse({
        ...options,
        operationId,
        baseUrl,
        timeoutMs,
        onProgress,
        isCanceled,
        pipelinePlan,
        totalPagesHint,
      });
    } catch (error) {
      if (isCanceled && isCanceled()) return this.stopCanceledOperation(options);
      if (error?.pipelineTerminal) throw error;
      return this.runWithPolling({
        ...options,
        operationId,
        baseUrl,
        timeoutMs,
        onProgress,
        isCanceled,
        pipelinePlan,
        totalPagesHint,
      });
    }
  }

  async requestOperationStop(operationId, baseUrl) {
    try {
      await this.client.stopOperation(operationId, baseUrl);
    } catch (cause) {
      throw createOperationStopError(operationId, cause);
    }
    throw createPipelineCanceledError(operationId);
  }

  stopCanceledOperation(options) {
    const state = options.cancelState || (options.cancelState = {});
    if (!state.stopPromise) {
      state.stopPromise = this.requestOperationStop(options.operationId, options.baseUrl);
    }
    if (typeof state.abort === "function") state.abort();
    return state.stopPromise;
  }

  async run(options) {
    const monitoredOptions = { ...options, cancelState: {} };
    const cancellation = createCancellationSignal(options.isCanceled);
    const stopTask = cancellation.promise.then(() => this.stopCanceledOperation(monitoredOptions));
    stopTask.catch(() => {});
    try {
      return await this.runPreferred(monitoredOptions);
    } finally {
      cancellation.close();
    }
  }
}

module.exports = {
  PipelineMonitorModule,
  inferEngineProgress,
  buildProgressPayload,
  buildProgressPayloadFromSseEvent,
  summarizeScene,
};
