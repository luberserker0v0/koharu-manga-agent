const {
  PipelineMonitorModule,
  inferEngineProgress,
  buildProgressPayload,
  buildProgressPayloadFromSseEvent,
} = require("../../backend/src/integrations/koharu/pipeline/pipeline_monitor");

describe("pipeline monitor progress inference", () => {
  test("does not pretend the current engine is detect when Koharu reports no numeric progress", () => {
    const result = inferEngineProgress({
      operation: {
        id: "op-1",
        status: "running",
        progress: null,
      },
      pipelinePlan: [
        "detect",
        "fontDetect",
        "segment",
        "bubbleSegment",
        "ocr",
        "translate",
        "clean",
        "render",
      ],
    });

    expect(result).toEqual({
      engine: null,
      engineIndex: null,
      engineStatus: "running",
      progress: null,
    });
  });

  test("uses the final engine when the pipeline completes", () => {
    const result = inferEngineProgress({
      operation: {
        id: "op-2",
        status: "completed",
        progress: null,
      },
      pipelinePlan: ["detect", "ocr", "translate", "render"],
    });

    expect(result).toEqual({
      engine: "render",
      engineIndex: 3,
      engineStatus: "completed",
      progress: null,
    });
  });

  test("page progress still exposes total pages even when engine is unknown", () => {
    const payload = buildProgressPayload({
      operation: {
        id: "op-3",
        status: "running",
        progress: null,
      },
      sceneSummary: {
        totalPages: 0,
        translatedNodes: 0,
        totalTextNodes: 0,
        translatedPages: 0,
        pageNames: [],
      },
      totalPagesHint: 44,
      pipelinePlan: ["detect", "ocr", "translate", "render"],
    });

    expect(payload.engine).toBeNull();
    expect(payload.engineIndex).toBeNull();
    expect(payload.engineStatus).toBe("running");
    expect(payload.totalPages).toBe(44);
    expect(payload.completedPages).toBeNull();
    expect(payload.currentPageIndex).toBeNull();
    expect(payload.currentPageName).toBeNull();
  });

  test("polling progress uses only fully crossed page boundaries", () => {
    const payload = buildProgressPayload({
      operation: { id: "op-polling", status: "running", progress: 0.25 },
      sceneSummary: { totalPages: 44, translatedPages: 12, pageNames: [] },
      totalPagesHint: 44,
      pipelinePlan: ["detect", "ocr", "translate", "render"],
    });

    expect(payload.completedPages).toBe(11);
    expect(payload.currentPageIndex).toBe(12);
    expect(payload.telemetry).toEqual(expect.objectContaining({ source: "polling", rawProgress: 0.25 }));
  });

  test("builds progress payload from SSE jobProgress data", () => {
    const payload = buildProgressPayloadFromSseEvent({
      operationId: "op-4",
      data: {
        step: "ocr",
        currentPage: 11,
        totalPages: 44,
        overallPercent: 25,
      },
      sceneSummary: {
        totalPages: 44,
        translatedNodes: 0,
        totalTextNodes: 0,
        translatedPages: 0,
        pageNames: Array.from({ length: 44 }, (_, index) => `${String(index + 1).padStart(3, "0")}.png`),
      },
      totalPagesHint: 44,
      pipelinePlan: ["detect", "fontDetect", "segment", "bubbleSegment", "ocr", "translate", "clean", "render"],
    });

    expect(payload).toEqual({
      operationId: "op-4",
      status: "running",
      progress: 0.25,
      engine: "ocr",
      engineIndex: 4,
      engineStatus: "running",
      completedPages: 11,
      totalPages: 44,
      currentPageIndex: 12,
      currentPageName: "012.png",
      progressSemanticsVersion: 2,
      telemetry: {
        source: "sse",
        event: "jobProgress",
        rawStatus: null,
        rawStep: "ocr",
        rawCurrentPage: 11,
        rawTotalPages: 44,
        rawOverallPercent: 25,
      },
    });
  });

  test("stops the Koharu operation when backend cancellation is requested", async () => {
    const originalFetch = global.fetch;
    let notifyFetchStarted;
    const fetchStarted = new Promise((resolve) => { notifyFetchStarted = resolve; });
    global.fetch = jest.fn((_url, options) => new Promise((_resolve, reject) => {
      notifyFetchStarted();
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const stopOperation = jest.fn().mockResolvedValue({ success: true });
    const monitor = new PipelineMonitorModule({
      stopOperation,
      listOperations: jest.fn().mockResolvedValue([{ id: "op-stop", status: "running" }]),
      getScene: jest.fn().mockResolvedValue({ scene: { pages: {} } }),
    });
    let canceled = false;
    const running = monitor.run({
      operationId: "op-stop",
      baseUrl: "http://127.0.0.1:4000",
      isCanceled: () => canceled,
    });
    await fetchStarted;
    canceled = true;
    try {
      await expect(running).rejects.toMatchObject({ code: "job_canceled" });
      expect(stopOperation).toHaveBeenCalledTimes(1);
      expect(stopOperation).toHaveBeenCalledWith("op-stop", "http://127.0.0.1:4000");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("reports a failed job when Koharu does not acknowledge cancellation", async () => {
    const monitor = new PipelineMonitorModule({
      stopOperation: jest.fn().mockRejectedValue(new Error("connection refused")),
      listOperations: jest.fn().mockResolvedValue([{ id: "op-fail", status: "running" }]),
      getScene: jest.fn().mockResolvedValue({ scene: { pages: {} } }),
    });

    await expect(monitor.run({
      operationId: "op-fail",
      baseUrl: "http://127.0.0.1:4000",
      isCanceled: () => true,
    })).rejects.toMatchObject({
      code: "koharu_cancel_failed",
      message: expect.stringContaining("connection refused"),
    });
  });
});
