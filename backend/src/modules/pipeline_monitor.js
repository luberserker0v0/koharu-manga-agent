const { config, runtime } = require("../config");
const { ENDPOINTS, buildUrl } = require("../koharu_client");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTerminalPipelineError(status) {
  const error = new Error(`Pipeline ended with status: ${status}`);
  error.pipelineTerminal = true;
  return error;
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
    let pageTextNodes = 0;
    let pageTranslatedNodes = 0;
    for (const node of Object.values(page.nodes || {})) {
      if (node.kind?.text) {
        pageTextNodes += 1;
        totalTextNodes += 1;
      }
      if (node.kind?.text?.translation) {
        translatedNodes += 1;
        pageTranslatedNodes += 1;
      }
    }
    if (pageTextNodes > 0 && pageTranslatedNodes >= pageTextNodes) {
      translatedPages += 1;
    }
  }

  return { totalPages, translatedNodes, totalTextNodes, translatedPages, pageNames };
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

function buildProgressPayloadFromSseEvent({
  operationId,
  data,
  sceneSummary,
  totalPagesHint = null,
  pipelinePlan = [],
}) {
  const normalizedPlan = normalizePipelinePlan(pipelinePlan);
  const step = typeof data?.step === "string" ? data.step : null;
  const engineIndex = step ? normalizedPlan.indexOf(step) : -1;
  const totalPages =
    typeof data?.totalPages === "number" && Number.isFinite(data.totalPages) && data.totalPages > 0
      ? data.totalPages
      : typeof totalPagesHint === "number" && totalPagesHint > 0
        ? totalPagesHint
        : sceneSummary.totalPages || null;
  const currentPageIndex = normalizeCurrentPageIndex(data?.currentPage);
  const currentPageName =
    typeof currentPageIndex === "number" &&
    currentPageIndex > 0 &&
    Array.isArray(sceneSummary.pageNames)
      ? sceneSummary.pageNames[currentPageIndex - 1] || null
      : null;

  return {
    operationId,
    status: typeof data?.status === "string" ? data.status : "running",
    progress:
      typeof data?.overallPercent === "number" && Number.isFinite(data.overallPercent)
        ? Math.max(0, Math.min(1, data.overallPercent / 100))
        : null,
    engine: step,
    engineIndex: engineIndex >= 0 ? engineIndex : null,
    engineStatus: typeof data?.status === "string" ? data.status : "running",
    completedPages: currentPageIndex,
    totalPages,
    currentPageIndex,
    currentPageName,
  };
}

function inferEngineProgress({ operation, pipelinePlan }) {
  const normalizedPlan = normalizePipelinePlan(pipelinePlan);
  const rawProgress =
    typeof operation?.progress === "number" && Number.isFinite(operation.progress)
      ? Math.max(0, Math.min(1, operation.progress))
      : null;

  if (normalizedPlan.length === 0) {
    return {
      engine: null,
      engineIndex: null,
      engineStatus: operation?.status || "unknown",
      progress: rawProgress,
    };
  }

  if (
    operation?.status === "completed" ||
    operation?.status === "completed_with_errors"
  ) {
    return {
      engine: normalizedPlan[normalizedPlan.length - 1],
      engineIndex: normalizedPlan.length - 1,
      engineStatus: "completed",
      progress: rawProgress,
    };
  }

  if (operation?.status === "failed" || operation?.status === "cancelled") {
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

  if (typeof rawProgress === "number") {
    const activeIndex = Math.min(
      normalizedPlan.length - 1,
      Math.floor(rawProgress * normalizedPlan.length)
    );
    return {
      engine: normalizedPlan[activeIndex] || null,
      engineIndex: activeIndex,
      engineStatus: "running",
      progress: rawProgress,
    };
  }

  return {
    engine: null,
    engineIndex: null,
    engineStatus: operation?.status || "running",
    progress: rawProgress,
  };
}

function buildProgressPayload({
  operation,
  sceneSummary,
  totalPagesHint = null,
  pipelinePlan = [],
}) {
  const engineProgress = inferEngineProgress({ operation, pipelinePlan });
  const totalPages =
    typeof totalPagesHint === "number" && totalPagesHint > 0
      ? totalPagesHint
      : sceneSummary.totalPages || null;
  const completedPages =
    sceneSummary.translatedPages > 0
      ? sceneSummary.translatedPages
      : typeof engineProgress.progress === "number" && typeof totalPages === "number"
        ? Math.max(0, Math.min(totalPages, Math.round(totalPages * engineProgress.progress)))
        : null;
  const currentPageIndex =
    typeof totalPages === "number" &&
    typeof completedPages === "number" &&
    totalPages > 0 &&
    completedPages < totalPages
      ? completedPages + 1
      : typeof totalPages === "number" && completedPages === totalPages
        ? totalPages
        : null;
  const currentPageName =
    typeof currentPageIndex === "number" &&
    currentPageIndex > 0 &&
    Array.isArray(sceneSummary.pageNames)
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

  async runWithPolling({
    operationId,
    baseUrl,
    timeoutMs,
    onProgress,
    isCanceled,
    pipelinePlan = [],
    totalPagesHint = null,
  }) {
    const startedAt = Date.now();
    const terminalStates = new Set([
      "completed",
      "failed",
      "completed_with_errors",
      "cancelled",
    ]);

    while (Date.now() - startedAt < timeoutMs) {
      if (isCanceled && isCanceled()) {
        throw new Error("Job canceled");
      }

      const operations = await this.client.listOperations(baseUrl);
      const operation = operations.find((entry) => entry.id === operationId);

      if (!operation) {
        return this.recover({
          operationId,
          baseUrl,
          reason: "listener_attached_too_late",
        });
      }

      if (typeof onProgress === "function") {
        const sceneSummary = await this.buildSceneSummary(baseUrl, totalPagesHint);

        onProgress(
          buildProgressPayload({
            operation,
            sceneSummary,
            totalPagesHint,
            pipelinePlan,
          })
        );
      }

      if (terminalStates.has(operation.status)) {
        if (
          operation.status === "completed" ||
          operation.status === "completed_with_errors"
        ) {
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

        throw new Error(`Pipeline ended with status: ${operation.status}`);
      }

      await sleep(runtime.pollIntervalMs);
    }

    return this.recover({
      operationId,
      baseUrl,
      reason: "timeout",
    });
  }

  async runWithSse({
    operationId,
    baseUrl,
    timeoutMs,
    onProgress,
    isCanceled,
    pipelinePlan = [],
    totalPagesHint = null,
  }) {
    const statusCheck = await this.client.listOperations(baseUrl);
    const currentOperation = statusCheck.find((entry) => entry.id === operationId);
    if (!currentOperation) {
      return this.recover({
        operationId,
        baseUrl,
        reason: "listener_attached_too_late",
      });
    }

    if (
      currentOperation.status === "completed" ||
      currentOperation.status === "completed_with_errors"
    ) {
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

    if (["failed", "cancelled"].includes(currentOperation.status)) {
      throw createTerminalPipelineError(currentOperation.status);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(new Error("SSE timeout")), timeoutMs);
    let sceneSummary = await this.buildSceneSummary(baseUrl, totalPagesHint);

    try {
      const response = await fetch(buildUrl(ENDPOINTS.EVENTS, baseUrl), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE listen failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";

      while (true) {
        if (isCanceled && isCanceled()) {
          controller.abort();
          throw new Error("Job canceled");
        }

        const { value, done } = await reader.read();
        if (done) {
          throw new Error("SSE disconnected before terminal event");
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) {
            eventType = "";
            continue;
          }
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith("data:")) {
            continue;
          }

          const payloadText = line.slice(5).trim();
          if (!payloadText) {
            continue;
          }

          let data;
          try {
            data = JSON.parse(payloadText);
          } catch {
            eventType = "";
            continue;
          }

          const eventOperationId = data?.id || data?.jobId;
          if (eventOperationId && eventOperationId !== operationId) {
            eventType = "";
            continue;
          }

          if ((eventType === "jobProgress" || data?.event === "jobProgress") && typeof onProgress === "function") {
            const overallPercent =
              typeof data?.overallPercent === "number" ? data.overallPercent : null;
            const currentPage = typeof data?.currentPage === "number" ? data.currentPage : null;
            const totalPages = typeof data?.totalPages === "number" ? data.totalPages : null;
            const step = typeof data?.step === "string" ? data.step : null;

            const needsSceneRefresh =
              !sceneSummary.pageNames.length ||
              (currentPage !== null && currentPage + 1 > sceneSummary.pageNames.length) ||
              (totalPages !== null && totalPages > sceneSummary.pageNames.length);

            if (needsSceneRefresh) {
              sceneSummary = await this.buildSceneSummary(baseUrl, totalPagesHint);
            }

            onProgress(
              buildProgressPayloadFromSseEvent({
                operationId,
                data: {
                  status: "running",
                  overallPercent,
                  currentPage,
                  totalPages,
                  step,
                },
                sceneSummary,
                totalPagesHint,
                pipelinePlan,
              })
            );
          }

          if (eventType === "jobFinished" || data?.event === "jobFinished") {
            const finalStatus = typeof data?.status === "string" ? data.status : "completed";
            if (["completed", "completed_with_errors"].includes(finalStatus)) {
              const scene = await this.client.getScene(baseUrl);
              const summary = summarizeScene(scene);
              return {
                summary: {
                  steps: {},
                  totalPages: summary.totalPages,
                  finalStatus,
                },
                recovered: false,
                reason: finalStatus,
              };
            }

            throw createTerminalPipelineError(finalStatus);
          }

          eventType = "";
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      controller.abort();
    }
  }

  async recover({ operationId, baseUrl, reason }) {
    const scene = await this.client.getScene(baseUrl);
    const summary = summarizeScene(scene);

    if (summary.translatedNodes > 0) {
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

    throw new Error(
      `Unable to recover operation ${operationId} after ${reason}. No translated scene state was found.`
    );
  }

  async run({
    operationId,
    baseUrl,
    timeoutMs = config.timeouts.sseListen * 1000,
    onProgress,
    isCanceled,
    pipelinePlan = [],
    totalPagesHint = null,
  }) {
    try {
      return await this.runWithSse({
        operationId,
        baseUrl,
        timeoutMs,
        onProgress,
        isCanceled,
        pipelinePlan,
        totalPagesHint,
      });
    } catch (error) {
      if (error?.pipelineTerminal || (isCanceled && isCanceled())) {
        throw error;
      }

      return this.runWithPolling({
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
}

module.exports = {
  PipelineMonitorModule,
  inferEngineProgress,
  buildProgressPayload,
  buildProgressPayloadFromSseEvent,
  summarizeScene,
};
