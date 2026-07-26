const {
  applyQualitySemanticAnnotations,
  buildQualityContextProjection,
} = require("../../backend/src/modules/quality_projection");
const crypto = require("crypto");

describe("quality context projection", () => {
  test("selects explicit evidence and does not use language regex heuristics", () => {
    const translations = Array.from({ length: 20 }, (_, index) => ({
      id: `n${index}`, pageName: `${index}.jpg`, original: index === 3 ? "帝国の月晶" : `普通の会話${index}`, translation: `譯文${index}`,
    }));
    const projection = buildQualityContextProjection({ translations, representativeLimit: 2, translationMemory: {
      fingerprint: "fp", effective: { glossary: [{ source_term: "月晶", canonical_translation: "月之水晶", locked: true }], story: null, style: null, localKnowledge: null },
    } });
    expect(projection.candidates.find((entry) => entry.nodeId === "n3").reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "locked_term" }),
    ]));
    expect(projection.candidateCount).toBeLessThan(20);
  });

  test("splits terminology into bounded atomic windows without dropping candidates", () => {
    const translations = Array.from({ length: 85 }, (_, index) => ({ id: `n${index}`, original: "固定詞", translation: `譯${index}`, pageName: "1" }));
    const projection = buildQualityContextProjection({ translations, translationMemory: {
      fingerprint: "fp", effective: { glossary: [{ source_term: "固定詞", canonical_translation: "固定譯名", locked: true }], story: null, style: null, localKnowledge: null },
    } });
    expect(projection.windows.length).toBeLessThan(9);
    expect(projection.windows.flatMap((entry) => entry.candidates)).toHaveLength(85);
    expect(projection.windows.every((entry) => entry.purpose === "terminology")).toBe(true);
    expect(projection.windows.every((entry) => entry.candidates.length <= 20)).toBe(true);
    expect(projection.windows.every((entry) => entry.inputBytes <= 20000)).toBe(true);
  });

  test("does not deep-review clean memory matches after full-chapter observation", () => {
    const translations = [
      { id: "clean", original: "帝国の領主", translation: "帝國領主", pageName: "1.jpg", textRole: "dialogue" },
      { id: "suspect", original: "月晶", translation: "月石", pageName: "1.jpg", textRole: "dialogue" },
    ];
    const projection = buildQualityContextProjection({
      translations,
      representativeLimit: 12,
      qualityObservation: {
        fingerprint: "observation",
        nodes: [
          { nodeId: "clean", disposition: "clean", riskTypes: ["none"] },
          { nodeId: "suspect", disposition: "suspect", riskTypes: ["terminology"], confidence: 0.9, reason: "rendering drift" },
        ],
      },
      translationMemory: {
        fingerprint: "fp",
        effective: {
          glossary: [
            { source_term: "領主", canonical_translation: "領主" },
            { source_term: "月晶", canonical_translation: "月之水晶" },
          ],
          story: { global: { characters: [{ name: "領主" }] } },
          style: { chapters: [{ dialogueSamples: [{ original: "帝国の領主", translation: "帝國領主" }] }] },
          localKnowledge: null,
        },
      },
    });

    expect(projection.candidates.map((entry) => entry.nodeId)).toEqual(["suspect"]);
    expect(projection.candidateReasonCounts.representative_sample).toBeUndefined();
    expect(projection.candidateReasonCounts.style_evidence).toBeUndefined();
    expect(projection.candidateReasonCounts.story_entity).toBeUndefined();
  });

  test("uses only evidence-backed local pairs for conflict selection", () => {
    const translations = [{ id: "n1", original: "same", translation: "current", pageName: "1" }];
    const projection = buildQualityContextProjection({ translations, representativeLimit: 0, translationMemory: {
      fingerprint: "fp", effective: { glossary: [], story: null, style: null, localKnowledge: { translationPairs: [
        { original: "same", translation: "legacy", confidence: null },
        { original: "same", translation: "stable", confidence: 0.9 },
      ] } },
    } });
    expect(projection.candidates[0].reasons.filter((entry) => entry.type === "local_pair_conflict")).toEqual([
      expect.objectContaining({ evidence: { preferredTranslation: "stable" } }),
    ]);
  });

  test("always selects normalized source-target identity without language heuristics", () => {
    const translations = [
      { id: "n1", original: "  same\ntext ", translation: "same text", pageName: "1" },
      { id: "n2", original: "source", translation: "target", pageName: "1" },
    ];
    const projection = buildQualityContextProjection({
      translations,
      representativeLimit: 0,
      translationMemory: {
        fingerprint: "fp",
        effective: { glossary: [], story: null, style: null, localKnowledge: null },
      },
    });

    expect(projection.candidates).toHaveLength(1);
    expect(projection.candidates[0]).toEqual(expect.objectContaining({ nodeId: "n1" }));
    expect(projection.candidates[0].reasons).toEqual([
      expect.objectContaining({ type: "source_target_identity" }),
    ]);
    expect(projection.candidateReasonCounts.source_target_identity).toBe(1);
  });

  test("selects missing text without guessing semantic errors from target scripts", () => {
    const projection = buildQualityContextProjection({
      translations: [
        { id: "n1", original: "未翻訳", translation: "", pageName: "1.jpg" },
        { id: "n2", original: "領主は元気だ", translation: "領主は很有精神", pageName: "1.jpg" },
        { id: "n3", original: "正常", translation: "正常譯文", pageName: "1.jpg" },
      ],
      representativeLimit: 0,
      sourceLanguage: "ja-JP",
      targetLanguage: "zh-TW",
      translationMemory: {
        fingerprint: "fp",
        effective: { glossary: [], story: null, style: null, localKnowledge: null },
      },
    });

    expect(projection.candidates.map((entry) => entry.nodeId)).toEqual(["n1"]);
    expect(projection.candidateReasonCounts.translation_missing).toBe(1);
    expect(projection.candidateReasonCounts.target_script_mismatch).toBeUndefined();
    expect(projection.languages).toEqual({ sourceLanguage: "ja-JP", targetLanguage: "zh-TW" });
  });

  test("uses unanimous high-confidence Observation role evidence by text fingerprint", () => {
    const original = "これは地の文です";
    const projection = buildQualityContextProjection({
      translations: [{ id: "n1", original, translation: "這是旁白", pageName: "1" }],
      representativeLimit: 0,
      translationMemory: { fingerprint: "fp", effective: {
        glossary: [], story: null, style: null, localKnowledge: null,
        sourceRoleEvidence: [{
          textFingerprint: crypto.createHash("sha256").update(original).digest("hex"),
          textRole: "narration", styleChannel: "narrator_voice", roleConfidence: 0.9, storyCueTypes: ["event"],
        }],
      } },
    });
    expect(projection.candidates[0]).toEqual(expect.objectContaining({ textRole: "narration", styleChannel: "narrator_voice" }));
    expect(projection.candidates[0].reasons).toEqual(expect.arrayContaining([expect.objectContaining({ type: "style_evidence" })]));
    expect(projection.candidates[0].reasons).toEqual(expect.arrayContaining([expect.objectContaining({ type: "story_cue" })]));
    expect(projection.semanticCoverage).toEqual({ annotated: 1, total: 1, ratio: 1 });
    expect(applyQualitySemanticAnnotations([
      { id: "n1", original, translation: "這是旁白" },
    ], projection)[0]).toEqual(expect.objectContaining({
      textRole: "narration",
      styleChannel: "narrator_voice",
    }));
  });

  test("reuses semantic annotations from stable local translation pairs", () => {
    const projection = buildQualityContextProjection({
      translations: [{ id: "n1", original: "繰り返す台詞", translation: "重複台詞", pageName: "1" }],
      representativeLimit: 0,
      translationMemory: { fingerprint: "fp", effective: {
        glossary: [], story: null, style: null, sourceRoleEvidence: [],
        localKnowledge: { translationPairs: [{
          original: "繰り返す台詞",
          translation: "重複台詞",
          confidence: 0.9,
          textRole: "dialogue",
          styleChannel: "character_voice",
          speakerRef: "角色甲",
        }] },
      } },
    });

    expect(projection.semanticAnnotations).toEqual([expect.objectContaining({
      nodeId: "n1",
      textRole: "dialogue",
      styleChannel: "character_voice",
      speakerRef: "角色甲",
    })]);
    expect(projection.candidateReasonCounts.style_evidence).toBe(1);
    expect(projection.candidateReasonCounts.speaker_evidence).toBe(1);
  });

  test("accepts translation-time chapter observation evidence", () => {
    const original = "新章の独白";
    const projection = buildQualityContextProjection({
      translations: [{ id: "n1", original, translation: "新章的獨白", pageName: "1" }],
      representativeLimit: 0,
      semanticEvidenceFingerprint: "observation-fp",
      semanticRoleEvidence: [{
        textFingerprint: crypto.createHash("sha256").update(original).digest("hex"),
        textRole: "monologue",
        styleChannel: "inner_voice",
        roleConfidence: 0.94,
      }],
      translationMemory: { fingerprint: "memory-fp", effective: {
        glossary: [], story: null, style: null, localKnowledge: null, sourceRoleEvidence: [],
      } },
    });

    expect(projection.semanticEvidenceFingerprint).toBe("observation-fp");
    expect(projection.semanticCoverage).toEqual({ annotated: 1, total: 1, ratio: 1 });
    expect(projection.candidateReasonCounts.style_evidence).toBe(1);
  });

  test("keeps a 300-node role-observed chapter within bounded Standard Quality windows", () => {
    const translations = Array.from({ length: 300 }, (_, index) => ({
      id: `n${index}`, original: `source ${index}`, translation: `target ${index}`, pageName: `${Math.floor(index / 10)}.jpg`,
    }));
    const sourceRoleEvidence = translations.map((entry, index) => ({
      textFingerprint: crypto.createHash("sha256").update(entry.original).digest("hex"),
      textRole: ["dialogue", "narration", "monologue"][index % 3],
      styleChannel: ["character_voice", "narrator_voice", "inner_voice"][index % 3],
      roleConfidence: 0.9,
    }));
    const projection = buildQualityContextProjection({ translations, translationMemory: {
      fingerprint: "fp", effective: { glossary: [], story: null, style: null, localKnowledge: null, sourceRoleEvidence },
    } });
    expect(projection.candidateCount).toBeLessThanOrEqual(21);
    expect(projection.windows.map((entry) => entry.purpose)).toEqual(["style", "representative"]);
    expect(projection.windows.every((entry) => entry.candidates.length <= 10)).toBe(true);
    expect(projection.windows.every((entry) => entry.inputBytes <= 20000)).toBe(true);
  });
});
