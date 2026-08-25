const { parseKnowledgeEnrichmentOutput } = require("../../backend/src/integrations/ao/contracts/knowledge_line_contract");
const { validateKnowledgeEnrichmentResult } = require("../../backend/src/integrations/ao/contracts/ao_contracts");

describe("Knowledge line contract", () => {
  const input = {
    translationPairs: [{ nodeId: "n1" }, { nodeId: "n2" }],
    learningEvidence: [
      {
        nodeId: "n1",
        pageName: "018.jpg",
        original: "リアムは星間国家の領主だ",
        translation: "里爾姆是星際國家的領主",
        textRole: "dialogue",
        styleChannel: "character_voice",
        speakerRef: "リアム",
        roleConfidence: 0.95,
        speakerConfidence: 0.9,
        confidence: 0.9,
        reasons: ["style_evidence", "canonical_term"],
      },
      {
        nodeId: "n2",
        pageName: "019.jpg",
        original: "普通の台詞",
        translation: "普通的台詞",
        confidence: 0.8,
        reasons: ["quality_revision"],
      },
    ],
  };

  test("builds backend-owned Knowledge JSON from fixed records", () => {
    const result = parseKnowledgeEnrichmentOutput([
      "TERM|星間国家|星際國家|worldbuilding|n1|0.7|cross-chapter confirmation needed",
      "CHARACTER|リアム|里爾姆|n1|chapter_04|0.8|confirmed title usage",
      "CHARACTER_ALIAS|リアム|里亞姆",
      "CHARACTER_TITLE|リアム|里爾姆大人",
      "STYLE_PROFILE||",
      "STYLE_RULE|global|note|insufficient repeated style evidence",
      "STYLE_EXAMPLE|n1|0.85|stable character voice",
      "NOTE|Incremental evidence only.",
      "KNOWLEDGE_DONE",
    ].join("\n"), input);

    expect(() => validateKnowledgeEnrichmentResult(result)).not.toThrow();
    expect(result.translationPairs).toBe(2);
    expect(result.terminologyEntries[0]).toEqual(expect.objectContaining({ confidence: 0.7 }));
    expect(result.characterEntries[0]).toEqual(expect.objectContaining({
      identity_key: "リアム",
      name: "里爾姆",
      aliases: expect.arrayContaining(["リアム", "里亞姆"]),
      title_forms: ["里爾姆大人"],
      confidence: 0.8,
    }));
    expect(result.styleExampleEntries[0]).toEqual(expect.objectContaining({
      nodeId: "n1",
      textRole: "dialogue",
      styleChannel: "character_voice",
      speakerRef: "リアム",
      confidence: 0.85,
    }));
    expect(result.styleProfile.notes).toEqual(["insufficient repeated style evidence"]);
    expect(result.notes).toBe("Incremental evidence only.");
  });

  test("quarantines qualitative confidence labels", () => {
    const result = parseKnowledgeEnrichmentOutput([
      "TERM|星間国家|星際國家|worldbuilding|n1|medium|invalid confidence",
      "KNOWLEDGE_DONE",
    ].join("\n"), input);
    expect(result.terminologyEntries).toEqual([]);
    expect(result.semanticResult).toEqual(expect.objectContaining({ outcome: "partial", quarantinedRecordCount: 1 }));
  });

  test("quarantines unknown evidence nodes and arbitrary records", () => {
    const result = parseKnowledgeEnrichmentOutput([
      "STYLE_EXAMPLE|unknown|0.9|reason",
      "NEW_KEY|value",
      "KNOWLEDGE_DONE",
    ].join("\n"), input);
    expect(result.styleExampleEntries).toEqual([]);
    expect(result.semanticResult.quarantinedRecordCount).toBe(2);
  });

  test("keeps valid records while quarantining invalid terminology", () => {
    const result = parseKnowledgeEnrichmentOutput([
      "TERM|リアム|里爾姆|pronoun|n1|0.9|invalid category",
      "TERM|星間国家|不存在的譯名|worldbuilding|n1|0.9|not in evidence",
      "NOTE|valid note",
      "KNOWLEDGE_DONE",
    ].join("\n"), input);
    expect(result.terminologyEntries).toEqual([]);
    expect(result.notes).toBe("valid note");
    expect(result.semanticResult).toEqual(expect.objectContaining({ outcome: "warnings", acceptedRecordCount: 1, quarantinedRecordCount: 2 }));
  });

  test("still fails incomplete output without the completion marker", () => {
    expect(() => parseKnowledgeEnrichmentOutput("NOTE|partial", input)).toThrow(/missing KNOWLEDGE_DONE/);
  });
});
