const { parseKnowledgeEnrichmentOutput } = require("../../backend/src/knowledge_line_contract");
const { validateKnowledgeEnrichmentResult } = require("../../backend/src/ao_contracts");

describe("Knowledge line contract", () => {
  const input = {
    translationPairs: [{ nodeId: "n1" }, { nodeId: "n2" }],
    learningEvidence: [{ nodeId: "n1" }, { nodeId: "n2" }],
  };

  test("builds backend-owned Knowledge JSON from fixed records", () => {
    const result = parseKnowledgeEnrichmentOutput([
      "TERM|星間国家|星間國家|worldbuilding|0.7|cross-chapter confirmation needed",
      "CHARACTER|里亞姆|chapter_04|0.8|confirmed title usage",
      "CHARACTER_ALIAS|里亞姆|リアム",
      "CHARACTER_TITLE|里亞姆|里亞姆大人",
      "STYLE_PROFILE||",
      "STYLE_RULE|global|note|insufficient repeated style evidence",
      "STYLE_EXAMPLE|啊。|dialogue|018.jpg|n1|plain acknowledgment",
      "NOTE|Incremental evidence only.",
      "KNOWLEDGE_DONE",
    ].join("\n"), input);

    expect(() => validateKnowledgeEnrichmentResult(result)).not.toThrow();
    expect(result.translationPairs).toBe(2);
    expect(result.terminologyEntries[0]).toEqual(expect.objectContaining({ confidence: 0.7 }));
    expect(result.characterEntries[0]).toEqual(expect.objectContaining({
      aliases: ["リアム"],
      title_forms: ["里亞姆大人"],
      confidence: 0.8,
    }));
    expect(result.styleProfile.notes).toEqual(["insufficient repeated style evidence"]);
    expect(result.notes).toBe("Incremental evidence only.");
  });

  test("rejects qualitative confidence labels", () => {
    expect(() => parseKnowledgeEnrichmentOutput([
      "TERM|星間国家|星間國家|worldbuilding|medium|invalid confidence",
      "KNOWLEDGE_DONE",
    ].join("\n"), input)).toThrow(/confidence must be between 0 and 1/);
  });

  test("rejects unknown evidence nodes and arbitrary records", () => {
    expect(() => parseKnowledgeEnrichmentOutput([
      "STYLE_EXAMPLE|示例|dialogue|001.jpg|unknown|reason",
      "KNOWLEDGE_DONE",
    ].join("\n"), input)).toThrow(/unknown node/);
    expect(() => parseKnowledgeEnrichmentOutput("NEW_KEY|value\nKNOWLEDGE_DONE", input))
      .toThrow(/Unknown Knowledge output record/);
  });
});
