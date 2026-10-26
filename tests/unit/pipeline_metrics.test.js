const {
  METRICS_BASIS,
  PipelineMetricsCollector,
} = require("../../backend/src/integrations/koharu/pipeline/pipeline_metrics");

describe("pipeline metrics collector", () => {
  test("attributes backend-observed gaps to the last reported page and engine", () => {
    let now = 0;
    const collector = new PipelineMetricsCollector({
      operationId: "op-metrics",
      startedAt: 0,
      clock: () => now,
      translationTarget: { providerId: "openai-compatible", modelId: "model-a" },
      generationSettings: { temperature: 0.7, thinkingEnabled: null },
    });

    now = 100;
    collector.observe({ currentPageIndex: 1, engine: "detect", status: "running", progress: 0 });
    now = 200;
    collector.observe({ currentPageIndex: 1, engine: "llmGenerate", status: "running", progress: 0.01 });
    now = 1200;
    collector.observe({ currentPageIndex: 1, engine: "render", status: "running", progress: 0.02 });
    now = 1300;
    const result = collector.complete({ status: "completed", pipeline: { finalStatus: "completed" } });

    expect(result.measurementBasis).toBe(METRICS_BASIS);
    expect(result.generationSettings).toEqual({ temperature: 0.7, thinkingEnabled: null });
    expect(result.durationMs).toBe(1300);
    expect(result.firstEventDelayMs).toBe(100);
    expect(result.eventCount).toBe(3);
    expect(result.stages[0]).toEqual(expect.objectContaining({
      engine: "llmGenerate",
      totalMs: 1000,
      p50Ms: 1000,
      maxMs: 1000,
    }));
    expect(result.pages[0]).toEqual(expect.objectContaining({ pageIndex: 1, observedMs: 1200 }));
  });

  test("deduplicates unchanged polling snapshots without losing elapsed time", () => {
    let now = 0;
    const collector = new PipelineMetricsCollector({ startedAt: 0, clock: () => now });
    const progress = { currentPageIndex: 2, engine: "translate", status: "running", progress: 0.2,
      telemetry: { source: "polling" } };

    now = 100;
    collector.observe(progress);
    now = 500;
    collector.observe(progress);
    now = 1100;
    const result = collector.complete({ status: "failed", errorCode: "timeout" });

    expect(result.eventCount).toBe(2);
    expect(result.duplicateEventCount).toBe(1);
    expect(result.sourceCounts).toEqual({ polling: 2 });
    expect(result.stages[0]).toEqual(expect.objectContaining({ engine: "translate", totalMs: 1000 }));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("timeout");
  });
});
