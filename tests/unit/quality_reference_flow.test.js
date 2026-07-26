const fs = require("fs");
const { QualityModule, applyProposalsToTranslations } = require("../../backend/src/modules/quality");

function memory() {
  return {
    fingerprint: "memory_fp",
    effective: {
      glossary: [{ source_term: "月晶", canonical_translation: "月之水晶", locked: true }],
      story: null,
      style: null,
      localKnowledge: { translationPairs: [] },
    },
  };
}

function observeWindow(input) {
  return Promise.resolve({
    windowId: input.windowId,
    nodes: input.nodes.map((node) => node.target === node.source || !node.target ? {
      nodeId: node.nodeId, pageId: node.pageId, pageName: node.pageName,
      disposition: "suspect", riskTypes: [!node.target ? "empty_translation" : "meaning_change"], confidence: 0.95, reason: "Needs review.",
    } : {
      nodeId: node.nodeId, pageId: node.pageId, pageName: node.pageName,
      disposition: "clean", riskTypes: ["none"], confidence: 0.95, reason: "Aligned.",
    }),
    sequenceRisks: [],
  });
}

describe("standard quality flow", () => {
  test("runs projected windows, applies revisions, and persists projection/checkpoint", async () => {
    const applyHistoryBatch = jest.fn().mockResolvedValue({ success: true });
    const runQualityReviewAndOptimization = jest.fn().mockResolvedValue({
      windowId: "quality_completeness_001",
      issues: [{ type: "glossary_consistency", severity: "high", confidence: 0.98, nodeId: "n1", pageName: "1.jpg", message: "Use canonical form." }],
      warnings: [],
      revisions: [{ nodeId: "n1", pageName: "1.jpg", original: "月晶", currentTranslation: "月晶", revisedTranslation: "月之水晶", reasonType: "glossary_consistency", confidence: 0.98, reason: "Canonical evidence." }],
      passedChecks: ["context_checked"], failedChecks: ["glossary_consistency"], notes: [], dispositions: { n1: "revise" },
    });
    const scene = (translation) => ({ scene: { pages: { p1: { name: "1.jpg", nodes: { n1: { kind: { text: { text: "月晶", translation } } } } } } } });
    const module = new QualityModule({
      getScene: jest.fn().mockResolvedValueOnce(scene("月晶")).mockResolvedValueOnce(scene("月之水晶")),
      applyHistoryBatch,
    }, { runQualityReviewAndOptimization, runTranslationQualityObservationWindow: observeWindow });

    const result = await module.run({ baseUrl: "http://koharu", jobId: `quality_test_${Date.now()}`, translationMemory: memory() });

    expect(runQualityReviewAndOptimization).toHaveBeenCalledWith(expect.objectContaining({
      windowId: "quality_completeness_001",
      purpose: "completeness",
      context: expect.objectContaining({ glossary: expect.any(Array) }),
      candidates: expect.arrayContaining([expect.objectContaining({ nodeId: "n1" })]),
    }), expect.any(Object));
    expect(applyHistoryBatch).toHaveBeenCalledTimes(1);
    expect(result.coverage).toBe(1);
    expect(result.windowCount).toBe(1);
    expect(fs.existsSync(result.projectionPath)).toBe(true);
    expect(fs.existsSync(result.checkpointPaths[0])).toBe(true);
  });

  test("preview uses the same projection without Koharu", async () => {
    const module = new QualityModule({}, { runTranslationQualityObservationWindow: observeWindow, runQualityReviewAndOptimization: jest.fn().mockResolvedValue({
      windowId: "quality_001", issues: [], warnings: [], revisions: [], passedChecks: ["good"], failedChecks: [], notes: [], dispositions: {},
    }) });
    const result = await module.runPreview({ jobId: `preview_${Date.now()}`, translationMemory: memory(), translations: [
      { nodeId: "n1", original: "月晶", translation: "月之水晶" },
    ] });
    expect(result.revisedTranslations[0].translation).toBe("月之水晶");
    expect(result.candidateReasonCounts.locked_term).toBeUndefined();
    expect(result.candidateCount).toBe(0);
  });

  test("proposal application rewrites only targeted lines", () => {
    const revised = applyProposalsToTranslations([
      { id: "n1", translation: "old" }, { id: "n2", translation: "keep" },
    ], [{ nodeId: "n1", revisedTranslation: "new" }]);
    expect(revised.map((entry) => entry.translation)).toEqual(["new", "keep"]);
  });

  test("keeps unresolved completeness issues as a blocking failed check", async () => {
    const scene = { scene: { pages: { p1: { name: "1.jpg", nodes: {
      n1: { kind: { text: { text: "領主は元気だ", translation: "領主は元気だ" } } },
    } } } } };
    const module = new QualityModule({
      getScene: jest.fn().mockResolvedValue(scene),
      applyHistoryBatch: jest.fn(),
    }, { runTranslationQualityObservationWindow: observeWindow, runQualityReviewAndOptimization: jest.fn().mockResolvedValue({
      windowId: "quality_001",
      issues: [],
      warnings: [],
      revisions: [],
      acceptedNodeIds: [],
      passedChecks: [],
      failedChecks: [],
      notes: [],
      dispositions: {},
    }) });

    const result = await module.run({
      baseUrl: "http://koharu",
      jobId: `quality_incomplete_${Date.now()}`,
      translationMemory: memory(),
      sourceLanguage: "ja-JP",
      targetLanguage: "zh-TW",
    });

    expect(result.overall).toBe("fail");
    expect(result.status).toBe("failed");
    expect(result.failedChecks).toContain("translation_completeness");
    expect(result.completeness.unresolvedCount).toBe(1);
  });

  test("publishes unresolved semantic evidence as a warning without learning it", async () => {
    const scene = { scene: { pages: { p1: { name: "1.jpg", nodes: {
      n1: { kind: { text: { text: "ニアス", translation: "尼阿斯" } } },
    } } } } };
    const observeTerminologyConflict = (input) => Promise.resolve({
      windowId: input.windowId,
      nodes: input.nodes.map((node) => ({
        nodeId: node.nodeId,
        pageId: node.pageId,
        pageName: node.pageName,
        disposition: "suspect",
        riskTypes: ["terminology"],
        confidence: 0.9,
        reason: "Conflicting transliteration evidence remains provisional.",
      })),
      sequenceRisks: [],
    });
    const translationMemory = memory();
    translationMemory.effective.glossary.push({
      source_term: "ニアス",
      canonical_translation: "尼亞斯",
      locked: false,
    });
    const module = new QualityModule({
      getScene: jest.fn().mockResolvedValue(scene),
      applyHistoryBatch: jest.fn(),
    }, {
      runTranslationQualityObservationWindow: observeTerminologyConflict,
      runQualityReviewAndOptimization: jest.fn().mockResolvedValue({
        windowId: "quality_001",
        issues: [],
        warnings: [],
        revisions: [],
        acceptedNodeIds: [],
        passedChecks: [],
        failedChecks: [],
        notes: [],
        dispositions: {},
      }),
    });

    const result = await module.run({
      baseUrl: "http://koharu",
      jobId: `quality_provisional_${Date.now()}`,
      translationMemory,
    });

    expect(result.status).toBe("passed");
    expect(result.blockingIssues).toHaveLength(0);
    expect(result.finalVerification.warnings).toHaveLength(1);
    expect(result.finalVerification.nodes[0].finalDisposition).toBe("unresolved");
  });

  test("stops before specialist quality when observer coverage shows a model outage", async () => {
    const scene = { scene: { pages: { p1: { name: "1.jpg", nodes: {
      n1: { kind: { text: { text: "こんにちは", translation: "你好" } } },
    } } } } };
    const missingRunner = jest.fn(async () => {
      const error = new Error("AO completed without a valid quality_observation output.");
      error.code = "AO_OUTPUT_MISSING";
      throw error;
    });
    const specialist = jest.fn();
    const module = new QualityModule({
      getScene: jest.fn().mockResolvedValue(scene),
      applyHistoryBatch: jest.fn(),
    }, {
      runTranslationQualityObservationWindow: missingRunner,
      runQualityReviewAndOptimization: specialist,
    });

    await expect(module.run({
      baseUrl: "http://koharu",
      jobId: `quality_model_outage_${Date.now()}`,
      translationMemory: memory(),
    })).rejects.toThrow(/configured AO model is unavailable or stalled/);
    expect(specialist).not.toHaveBeenCalled();
  });

  test("retries a transient stopped AO window once with a new task identity", async () => {
    const progress = jest.fn();
    const runQualityReviewAndOptimization = jest.fn()
      .mockRejectedValueOnce(new Error("AO conversation test stopped before producing output/result.txt"))
      .mockResolvedValueOnce({
        windowId: "quality_001", issues: [], warnings: [], revisions: [],
        passedChecks: ["good"], failedChecks: [], notes: [], dispositions: { n1: "keep" },
      });
    const module = new QualityModule({}, {
      settings: { model: "provider/model" },
      runTranslationQualityObservationWindow: observeWindow,
      runQualityReviewAndOptimization,
    });

    const result = await module.execute({
      jobId: `quality_retry_${Date.now()}`,
      translations: [{ id: "n1", original: "月晶", translation: "月石", pageName: "1.jpg" }],
      translationMemory: memory(),
      onProgress: progress,
    });

    expect(runQualityReviewAndOptimization).toHaveBeenCalledTimes(2);
    expect(runQualityReviewAndOptimization.mock.calls[1][0].jobId).toMatch(/_retry_2$/);
    expect(progress).toHaveBeenCalledWith("quality.window.retrying", expect.objectContaining({ attempt: 2 }));
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpointPaths[0], "utf8"));
    expect(checkpoint.attemptCount).toBe(2);
  });

  test("reuses a compatible completed window checkpoint without calling AO", async () => {
    const firstRunner = jest.fn().mockResolvedValue({
      windowId: "quality_001", issues: [], warnings: [], revisions: [],
      passedChecks: ["good"], failedChecks: [], notes: [], dispositions: { n1: "keep" },
    });
    const firstModule = new QualityModule({}, {
      settings: { model: "provider/model" },
      runTranslationQualityObservationWindow: observeWindow,
      runQualityReviewAndOptimization: firstRunner,
    });
    const input = {
      translations: [{ id: "n1", original: "月晶", translation: "月石", pageName: "1.jpg" }],
      translationMemory: memory(),
    };
    const first = await firstModule.execute({ ...input, jobId: `quality_checkpoint_source_${Date.now()}` });
    const secondRunner = jest.fn();
    const progress = jest.fn();
    const secondModule = new QualityModule({}, {
      settings: { model: "provider/model" },
      runTranslationQualityObservationWindow: observeWindow,
      runQualityReviewAndOptimization: secondRunner,
    });

    const second = await secondModule.execute({
      ...input,
      jobId: `quality_checkpoint_resume_${Date.now()}`,
      reusableCheckpointPaths: first.checkpointPaths,
      onProgress: progress,
    });

    expect(secondRunner).not.toHaveBeenCalled();
    expect(second.checkpointPaths).toEqual(first.checkpointPaths);
    expect(progress).toHaveBeenCalledWith("quality.window.reused", expect.objectContaining({
      windowId: "quality_terminology_001",
      purpose: "terminology",
    }));
  });
});
