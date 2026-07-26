const {
  inferEngineProgress,
  buildProgressPayload,
  buildProgressPayloadFromSseEvent,
} = require("../../backend/src/modules/pipeline_monitor");

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
      completedPages: 12,
      totalPages: 44,
      currentPageIndex: 12,
      currentPageName: "012.png",
    });
  });
});
