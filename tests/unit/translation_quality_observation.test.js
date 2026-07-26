const { runTranslationQualityObservation } = require("../../backend/src/modules/translation_quality_observation");

function translations(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `node_${index + 1}`,
    pageId: "page_1",
    pageName: "001.jpg",
    original: `source ${index + 1}`,
    translation: `target ${index + 1}`,
  }));
}

function cleanResult(input) {
  return {
    windowId: input.windowId,
    nodes: input.nodes.map((node) => ({
      nodeId: node.nodeId,
      pageId: node.pageId,
      pageName: node.pageName,
      disposition: "clean",
      riskTypes: ["none"],
      confidence: 0.9,
      reason: "Aligned.",
    })),
    sequenceRisks: [],
  };
}

describe("translation quality observation execution", () => {
  test("splits a timed-out window and checkpoints the successful children", async () => {
    const events = [];
    const runner = {
      settings: { model: "provider/model" },
      runTranslationQualityObservationWindow: jest.fn(async (input) => {
        if (input.nodes.length > 10) {
          throw new Error(`AO did not produce output/${input.windowId}.txt within 240000ms.`);
        }
        return cleanResult(input);
      }),
    };

    const first = await runTranslationQualityObservation({
      aoTaskRunner: runner,
      translations: translations(20),
      translationMemory: {},
      jobId: `quality_split_${Date.now()}`,
      onProgress: (type, payload) => events.push({ type, payload }),
    });

    expect(runner.runTranslationQualityObservationWindow).toHaveBeenCalledTimes(3);
    expect(first.observation.coverage).toEqual({ observed: 20, unobserved: 0, total: 20, ratio: 1 });
    expect(first.checkpointPaths).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "quality_observation.window_split" }));

    runner.runTranslationQualityObservationWindow.mockClear();
    const second = await runTranslationQualityObservation({
      aoTaskRunner: runner,
      translations: translations(20),
      translationMemory: {},
      jobId: `quality_split_resume_${Date.now()}`,
      reusableCheckpointPaths: first.checkpointPaths,
    });

    expect(runner.runTranslationQualityObservationWindow).not.toHaveBeenCalled();
    expect(second.observation.coverage.ratio).toBe(1);
  });

  test("proactively splits a missing parent window when resuming prior checkpoints", async () => {
    const firstRunner = {
      settings: { model: "provider/model" },
      runTranslationQualityObservationWindow: jest.fn(async (input) => cleanResult(input)),
    };
    const first = await runTranslationQualityObservation({
      aoTaskRunner: firstRunner,
      translations: translations(70),
      translationMemory: {},
      jobId: `quality_partial_seed_${Date.now()}`,
    });
    const resumedCalls = [];
    const resumedRunner = {
      settings: { model: "provider/model" },
      runTranslationQualityObservationWindow: jest.fn(async (input) => {
        resumedCalls.push({ windowId: input.windowId, nodeCount: input.nodes.length });
        return cleanResult(input);
      }),
    };

    const resumed = await runTranslationQualityObservation({
      aoTaskRunner: resumedRunner,
      translations: translations(70),
      translationMemory: {},
      jobId: `quality_partial_resume_${Date.now()}`,
      reusableCheckpointPaths: [first.checkpointPaths[0]],
    });

    expect(resumedCalls).toEqual([
      { windowId: "quality_observation_002_a_a", nodeCount: 5 },
      { windowId: "quality_observation_002_a_b", nodeCount: 5 },
      { windowId: "quality_observation_002_b_a", nodeCount: 5 },
      { windowId: "quality_observation_002_b_b", nodeCount: 5 },
    ]);
    expect(resumed.observation.coverage.ratio).toBe(1);
  });

  test("degrades a leaf with no AO output instead of failing the chapter", async () => {
    const runner = {
      settings: { model: "provider/model" },
      runTranslationQualityObservationWindow: jest.fn(async () => {
        const error = new Error("AO completed without a valid output/quality_observation.txt.");
        error.code = "AO_OUTPUT_MISSING";
        throw error;
      }),
    };

    const result = await runTranslationQualityObservation({
      aoTaskRunner: runner,
      translations: translations(8),
      translationMemory: {},
      jobId: `quality_degraded_${Date.now()}`,
    });

    expect(runner.runTranslationQualityObservationWindow).toHaveBeenCalledTimes(1);
    expect(result.observation.coverage).toEqual({ observed: 0, unobserved: 8, total: 8, ratio: 0 });
    expect(result.observation.nodes.every((node) => node.disposition === "unobserved")).toBe(true);
    expect(result.checkpointPaths).toHaveLength(0);
  });

  test("does not degrade a provider-wide zero-token failure", async () => {
    const runner = {
      settings: { model: "provider/model" },
      runTranslationQualityObservationWindow: jest.fn(async () => {
        const error = new Error("AO model produced no tokens or message parts.");
        error.code = "AO_MODEL_NO_OUTPUT";
        throw error;
      }),
    };

    await expect(runTranslationQualityObservation({
      aoTaskRunner: runner,
      translations: translations(8),
      translationMemory: {},
      jobId: `quality_provider_outage_${Date.now()}`,
    })).rejects.toMatchObject({ code: "AO_MODEL_NO_OUTPUT" });
  });
});
