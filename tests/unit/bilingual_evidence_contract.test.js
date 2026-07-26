const {
  parseBilingualEvidenceWindow,
} = require("../../backend/src/bilingual_evidence_contract");
const {
  buildEvidencePlan,
  mergeEvidenceLedger,
  transientAoError,
} = require("../../backend/src/modules/reference_bilingual_enrichment");

function contractInput() {
  return {
    windowId: "term_001",
    anchors: [
      {
        anchorId: "mention_1",
        purpose: "terminology",
        sourceMentionId: "mention_1",
        sourceNodeKeys: ["source::1"],
      },
      {
        anchorId: "style:source::2",
        purpose: "style",
        sourceNodeKeys: ["source::2"],
        textRole: "narration",
        styleChannel: "narrator_voice",
      },
    ],
    sourceNodes: [
      { nodeKey: "source::1", text: "星間国家" },
      { nodeKey: "source::2", text: "一年前" },
    ],
    targetNodes: [
      { nodeKey: "target::1", text: "星際國家" },
      { nodeKey: "target::2", text: "一年前" },
    ],
  };
}

describe("bilingual evidence contracts", () => {
  test("parses one disposition per terminology and style anchor", () => {
    const result = parseBilingualEvidenceWindow([
      "TERM_LINK|term_001|mention_1|星際國家|target::1|worldbuilding|0.93|verbatim rendering",
      "STYLE_PAIR|term_001|source::2|target::2|narration|narrator_voice|0.88|same narrative line",
      "WINDOW_DONE|term_001",
    ].join("\n"), contractInput());

    expect(result.termLinks).toHaveLength(1);
    expect(result.stylePairs).toHaveLength(1);
    expect(result.termLinks[0].targetSurface).toBe("星際國家");
  });

  test("rejects invented target text, duplicate dispositions, and incomplete windows", () => {
    expect(() => parseBilingualEvidenceWindow([
      "TERM_LINK|term_001|mention_1|不存在|target::1|worldbuilding|0.93|invented",
      "NO_MATCH|term_001|style|style:source::2|not found",
      "WINDOW_DONE|term_001",
    ].join("\n"), contractInput())).toThrow(/not present/i);

    expect(() => parseBilingualEvidenceWindow([
      "NO_MATCH|term_001|terminology|mention_1|not found",
      "NO_MATCH|term_001|terminology|mention_1|duplicate",
      "NO_MATCH|term_001|style|style:source::2|not found",
      "WINDOW_DONE|term_001",
    ].join("\n"), contractInput())).toThrow(/disposed more than once/i);

    expect(() => parseBilingualEvidenceWindow([
      "NO_MATCH|term_001|terminology|mention_1|not found",
      "WINDOW_DONE|term_001",
    ].join("\n"), contractInput())).toThrow(/disposition is incomplete/i);
  });

  test("requires an exact style anchor key and valid enums", () => {
    expect(() => parseBilingualEvidenceWindow([
      "NO_MATCH|term_001|terminology|mention_1|not found",
      "STYLE_PAIR|term_001|source::1,source::2|target::2|narration|narrator_voice|0.8|ambiguous source",
      "WINDOW_DONE|term_001",
    ].join("\n"), contractInput())).toThrow(/does not identify a style anchor/i);

    expect(() => parseBilingualEvidenceWindow([
      "TERM_LINK|term_001|mention_1|星際國家|target::1|invented_category|0.9|invalid category",
      "NO_MATCH|term_001|style|style:source::2|not found",
      "WINDOW_DONE|term_001",
    ].join("\n"), contractInput())).toThrow(/Unknown terminology category/i);
  });

  test("plans bounded evidence windows instead of partitioning every node", () => {
    const makeNodes = (side, count) => Array.from({ length: count }, (_, index) => ({
      nodeKey: `${side}::${index}`,
      chapterId: "chapter_1",
      chapterIndex: 0,
      chapterNodeIndex: index,
      streamIndex: index,
      text: `${side} text ${index}`,
      textRole: index % 2 === 0 ? "dialogue" : "narration",
      styleChannel: index % 2 === 0 ? "character_voice" : "narrator_voice",
      roleConfidence: 0.9,
    }));
    const sourceNodes = makeNodes("source", 200);
    const targetNodes = makeNodes("target", 180);
    const source = {
      fingerprint: "source-fingerprint",
      nodes: sourceNodes,
      chapters: [{ chapterId: "chapter_1", chapterTitle: "1", chapterIndex: 0, nodes: sourceNodes }],
      mentions: Array.from({ length: 12 }, (_, index) => ({
        mentionId: `mention_${index}`,
        chapterId: "chapter_1",
        surfaceForm: `term ${index}`,
        entityType: "term",
        confidence: 0.9,
        evidenceNodeKeys: [`source::${index * 15}`],
      })),
    };
    const target = {
      fingerprint: "target-fingerprint",
      nodes: targetNodes,
      chapters: [{ chapterId: "chapter_1", chapterTitle: "1", chapterIndex: 0, nodes: targetNodes }],
      mentions: [],
    };

    const plan = buildEvidencePlan({ mangaId: "manga", translatorId: "translator", source, target, model: "test/model" });
    expect(plan.windows.filter((window) => window.purpose === "terminology")).toHaveLength(3);
    expect(plan.windows).toHaveLength(4);
    expect(plan.windows.every((window) => window.targetNodes.length <= 80)).toBe(true);
    expect(plan.windows.reduce((sum, window) => sum + window.anchors.length, 0)).toBeLessThan(200);
  });

  test("only retries transient AO failures", () => {
    expect(transientAoError(new Error("HTTP 503"))).toBe(true);
    expect(transientAoError(new Error("request timed out"))).toBe(true);
    expect(transientAoError(new Error("unknown node id"))).toBe(false);
  });

  test("keeps earlier chapter window fingerprints stable when a later chapter is appended", () => {
    const makeStream = (side, chapterCount) => {
      const chapters = [];
      const nodes = [];
      const mentions = [];
      for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex += 1) {
        const chapterNodes = Array.from({ length: 6 }, (_, nodeIndex) => ({
          nodeKey: `${side}:${chapterIndex}:${nodeIndex}`,
          referenceSetId: `${side}_reference_${chapterIndex}`,
          chapterId: `chapter_${chapterIndex}`,
          chapterIndex,
          chapterNodeIndex: nodeIndex,
          streamIndex: nodes.length + nodeIndex,
          text: `${side} chapter ${chapterIndex} text ${nodeIndex}`,
          textRole: "dialogue",
          styleChannel: "character_voice",
          roleConfidence: 0.9,
        }));
        nodes.push(...chapterNodes);
        chapters.push({
          chapterId: `chapter_${chapterIndex}`,
          chapterTitle: String(chapterIndex + 1),
          referenceSetId: `${side}_reference_${chapterIndex}`,
          chapterIndex,
          fingerprint: `${side}_fingerprint_${chapterIndex}`,
          nodes: chapterNodes,
        });
        if (side === "source") {
          mentions.push({
            mentionId: `mention_${chapterIndex}`,
            chapterId: `chapter_${chapterIndex}`,
            surfaceForm: `term ${chapterIndex}`,
            entityType: "term",
            confidence: 0.9,
            evidenceNodeKeys: [chapterNodes[2].nodeKey],
          });
        }
      }
      return { fingerprint: `${side}-${chapterCount}`, nodes, chapters, mentions };
    };
    const first = buildEvidencePlan({
      mangaId: "manga",
      translatorId: "translator",
      source: makeStream("source", 3),
      target: makeStream("target", 3),
      model: "test/model",
    });
    const extended = buildEvidencePlan({
      mangaId: "manga",
      translatorId: "translator",
      source: makeStream("source", 4),
      target: makeStream("target", 4),
      model: "test/model",
    });
    const earlier = first.windows.filter((window) => window.chapterId === "chapter_0");
    expect(earlier).not.toHaveLength(0);
    for (const window of earlier) {
      expect(extended.windows.find((entry) => entry.windowId === window.windowId)?.windowFingerprint)
        .toBe(window.windowFingerprint);
    }
  });

  test("deduplicates repeated evidence, accumulates across chapters, and downgrades conflicts", () => {
    const plan = (planHash) => ({
      mangaId: "manga",
      translatorId: "translator",
      planHash,
      sourceFingerprint: `source-${planHash}`,
      targetFingerprint: `target-${planHash}`,
      model: "test/model",
    });
    const link = (overrides = {}) => ({
      windowId: "term_window_1",
      windowFingerprint: "window-fingerprint-1",
      sourceMentionId: "mention_1",
      sourceSurface: "星間国家",
      entityType: "term",
      sourceNodeKeys: ["source::1"],
      targetNodeKeys: ["target::1"],
      sourceTexts: ["星間国家"],
      targetTexts: ["星際國家"],
      sourceChapterIds: ["chapter_1"],
      targetChapterIds: ["chapter_1"],
      targetSurface: "星際國家",
      category: "worldbuilding",
      confidence: 0.7,
      reason: "evidence",
      ...overrides,
    });
    const first = mergeEvidenceLedger(null, {
      plan: plan("plan-1"),
      termLinks: [link()],
      stylePairs: [],
      unmatchedAnchors: [],
      committedAt: "2026-01-01T00:00:00.000Z",
    });
    const repeated = mergeEvidenceLedger(first, {
      plan: plan("plan-2"),
      termLinks: [link()],
      stylePairs: [],
      unmatchedAnchors: [],
      committedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(repeated.termEvidence[0].observations).toHaveLength(1);
    expect(repeated.termEvidence[0].confidence).toBeCloseTo(0.7);

    const accumulated = mergeEvidenceLedger(repeated, {
      plan: plan("plan-3"),
      termLinks: [link({
        windowId: "term_window_2",
        windowFingerprint: "window-fingerprint-2",
        sourceMentionId: "mention_2",
        sourceNodeKeys: ["source::2"],
        targetNodeKeys: ["target::2"],
        sourceChapterIds: ["chapter_2"],
        targetChapterIds: ["chapter_2"],
      })],
      stylePairs: [],
      unmatchedAnchors: [],
      committedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(accumulated.termEvidence[0].confidence).toBeCloseTo(0.91);
    expect(accumulated.termEvidence[0].status).toBe("accepted");

    const conflicted = mergeEvidenceLedger(accumulated, {
      plan: plan("plan-4"),
      termLinks: [link({
        windowId: "term_window_3",
        windowFingerprint: "window-fingerprint-3",
        sourceMentionId: "mention_3",
        sourceNodeKeys: ["source::3"],
        targetNodeKeys: ["target::3"],
        sourceChapterIds: ["chapter_3"],
        targetChapterIds: ["chapter_3"],
        targetTexts: ["星間國家"],
        targetSurface: "星間國家",
        confidence: 0.75,
      })],
      stylePairs: [],
      unmatchedAnchors: [],
      committedAt: "2026-01-04T00:00:00.000Z",
    });
    expect(conflicted.conflicts).toHaveLength(1);
    expect(conflicted.termEvidence.filter((entry) => entry.sourceSurface === "星間国家")
      .every((entry) => entry.status === "review")).toBe(true);

    conflicted.termEvidence.find((entry) => entry.targetSurface === "星際國家").manualStatus = "accepted";
    const manuallyResolved = mergeEvidenceLedger(conflicted, {
      plan: plan("plan-5"),
      termLinks: [],
      stylePairs: [],
      unmatchedAnchors: [],
      committedAt: "2026-01-05T00:00:00.000Z",
    });
    expect(manuallyResolved.conflicts).toHaveLength(0);
    expect(manuallyResolved.termEvidence.find((entry) => entry.targetSurface === "星際國家").status).toBe("accepted");
    expect(manuallyResolved.termEvidence.find((entry) => entry.targetSurface === "星間國家").status).toBe("rejected");
  });
});
