const { buildLearningEvidenceSnapshot, validateLearningEvidenceSnapshot } = require("../../backend/src/domains/knowledge/learning/learning_evidence");

describe("learning evidence snapshot", () => {
  test("keeps corrections and evidence-backed samples but omits generic representatives", () => {
    const snapshot = buildLearningEvidenceSnapshot({
      sourceTranslationJobId: "job1",
      chapterId: "ch1",
      finalTranslationSnapshotPath: "final.json",
      finalTranslations: [
        { id: "n1", original: "term", translation: "fixed", pageName: "1" },
        { id: "n2", original: "chat", translation: "okay", pageName: "1" },
      ],
      translationMemory: { fingerprint: "memory" },
      quality: {
        finalVerification: { nodes: [
          { nodeId: "n1", finalDisposition: "revised_verified" },
          { nodeId: "n2", finalDisposition: "clean" },
        ] },
        optimizedTranslations: [{ nodeId: "n1", currentTranslation: "bad", revisedTranslation: "fixed", reasonType: "glossary_consistency", confidence: 0.95, reason: "canonical" }],
        projection: { candidates: [
          { nodeId: "n1", reasons: [{ type: "canonical_term" }] },
          { nodeId: "n2", reasons: [{ type: "representative_sample" }] },
        ] },
      },
    });
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.summary.correctedPairs).toBe(1);
    expect(snapshot.evidence[0].nodeId).toBe("n1");
    expect(snapshot.evidence[0].reasons).toEqual(["quality_revision", "canonical_term"]);
  });

  test("normalizes a corrected representative or story candidate to quality revision evidence", () => {
    const snapshot = buildLearningEvidenceSnapshot({
      finalTranslationSnapshotPath: "final.json",
      finalTranslations: [
        { id: "n1", original: "line one", translation: "fixed one", pageName: "1" },
        { id: "n2", original: "line two", translation: "fixed two", pageName: "1" },
      ],
      translationMemory: { fingerprint: "memory" },
      quality: {
        finalVerification: { nodes: [
          { nodeId: "n1", finalDisposition: "revised_verified" },
          { nodeId: "n2", finalDisposition: "revised_verified" },
        ] },
        optimizedTranslations: [
          { nodeId: "n1", currentTranslation: "bad one", confidence: 0.9 },
          { nodeId: "n2", currentTranslation: "bad two", confidence: 0.8 },
        ],
        projection: { candidates: [
          { nodeId: "n1", reasons: [{ type: "representative_sample" }] },
          { nodeId: "n2", reasons: [{ type: "story_entity" }] },
        ] },
      },
    });

    expect(snapshot.evidence.map((entry) => entry.reasons)).toEqual([
      ["quality_revision"],
      ["quality_revision"],
    ]);
  });
  test("rejects unknown evidence reasons", () => {
    expect(() => validateLearningEvidenceSnapshot({ schemaVersion: 2, evidence: [{
      evidenceId: "e1", nodeId: "n1", original: "a", translation: "b", reasons: ["invented"], confidence: 0.9,
    }] })).toThrow(/unknown reason/);
  });

  test("does not learn unresolved low-confidence findings", () => {
    const snapshot = buildLearningEvidenceSnapshot({
      finalTranslationSnapshotPath: "final.json",
      finalTranslations: [{ id: "n1", original: "ambiguous", translation: "暫定", pageName: "1" }],
      translationMemory: { fingerprint: "memory" },
      quality: {
        finalVerification: { nodes: [{ nodeId: "n1", finalDisposition: "unresolved" }] },
        optimizedTranslations: [],
        projection: { candidates: [{ nodeId: "n1", reasons: [{ type: "style_evidence" }] }] },
      },
    });

    expect(snapshot.evidence).toEqual([]);
  });

  test("preserves projected semantic annotations in learned evidence", () => {
    const snapshot = buildLearningEvidenceSnapshot({
      finalTranslationSnapshotPath: "final.json",
      finalTranslations: [{ id: "n1", original: "台詞", translation: "對白", pageName: "1" }],
      translationMemory: { fingerprint: "memory" },
      quality: {
        finalVerification: { nodes: [{ nodeId: "n1", finalDisposition: "clean" }] },
        optimizedTranslations: [],
        projection: { candidates: [{
          nodeId: "n1",
          textRole: "dialogue",
          styleChannel: "character_voice",
          speakerRef: "角色甲",
          roleConfidence: 0.92,
          speakerConfidence: 0.81,
          reasons: [{ type: "style_evidence" }],
        }] },
      },
    });

    expect(snapshot.evidence[0]).toEqual(expect.objectContaining({
      textRole: "dialogue",
      styleChannel: "character_voice",
      speakerRef: "角色甲",
      roleConfidence: 0.92,
      speakerConfidence: 0.81,
    }));
  });

  test("selects bounded verified style samples from semantic annotations", () => {
    const snapshot = buildLearningEvidenceSnapshot({
      chapterId: "ch1",
      finalTranslationSnapshotPath: "final.json",
      finalTranslations: [
        { id: "dialogue", original: "line", translation: "dialogue", pageName: "1" },
        { id: "narration", original: "narration", translation: "narrated", pageName: "1" },
        { id: "uncertain", original: "?", translation: "?", pageName: "1" },
      ],
      translationMemory: { fingerprint: "memory" },
      quality: {
        finalVerification: { nodes: [
          { nodeId: "dialogue", finalDisposition: "clean" },
          { nodeId: "narration", finalDisposition: "clean" },
          { nodeId: "uncertain", finalDisposition: "clean" },
        ] },
        optimizedTranslations: [],
        projection: { candidates: [], semanticAnnotations: [
          { nodeId: "dialogue", textRole: "dialogue", styleChannel: "character_voice", speakerRef: "character_a", roleConfidence: 0.95, speakerConfidence: 0.9 },
          { nodeId: "narration", textRole: "narration", styleChannel: "narrator_voice", speakerRef: "wrong", roleConfidence: 0.92 },
          { nodeId: "uncertain", textRole: "dialogue", styleChannel: "character_voice", speakerRef: "character_b", roleConfidence: 0.7, speakerConfidence: 0.6 },
        ] },
      },
    });

    expect(snapshot.summary.styleSamples).toBe(2);
    expect(snapshot.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "dialogue", reasons: ["speaker_evidence"], speakerRef: "character_a" }),
      expect.objectContaining({ nodeId: "narration", reasons: ["style_evidence"], speakerRef: null }),
    ]));
  });
});
