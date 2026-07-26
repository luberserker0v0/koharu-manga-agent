const { validateKnowledgeEnrichmentResult } = require("../../backend/src/ao_contracts");

describe("ao contracts", () => {
  test("accepts knowledge enrichment payloads with character speech evidence", () => {
    const result = validateKnowledgeEnrichmentResult({
      enrichmentMode: "ao",
      translationPairs: 3,
      characters: 1,
      terminology: 1,
      styleExamples: 1,
      terminologyEntries: [
        {
          term: "Mana Circuit",
          translation: "Mana Circuit",
          category: "worldbuilding",
          confidence: 0.88,
        },
      ],
      characterEntries: [
        {
          name: "Alice",
          aliases: [],
          speech_style: ["polite"],
          confidence: 0.8,
        },
      ],
      styleProfile: {
        tone: "measured",
        register: "formal",
        honorific_policy: [],
        punctuation_policy: [],
        preferred_patterns: [],
        forbidden_patterns: [],
        narration: {
          tone: "literary",
          register: "written",
          preferred_patterns: ["At that moment"],
          forbidden_patterns: ["casual slang"],
          notes: ["narration stays bookish"],
        },
        notes: [],
      },
      styleExampleEntries: [
        {
          type: "dialogue",
          translation: "Please rest assured.",
          reason: "formal reassurance",
        },
        {
          type: "narration",
          translation: "At that moment, the storm closed in.",
          reason: "bookish narration cadence",
        },
      ],
      characterSpeechEvidence: [
        {
          name: "Alice",
          speech_style: ["polite"],
          sentence_ending_patterns: ["desu/masu"],
          addressing_patterns: ["Captain"],
          example_lines: [
            {
              translation: "Please rest assured.",
              pageName: "001.jpg",
              nodeId: "n1",
            },
          ],
          notes: ["Repeated formal reassurance lines."],
          confidence: 0.86,
        },
      ],
      narrationEvidence: [
        {
          tone: "literary",
          register: "written",
          preferred_patterns: ["At that moment"],
          forbidden_patterns: ["casual slang"],
          example_lines: [
            {
              translation: "At that moment, the storm closed in.",
              pageName: "002.jpg",
              nodeId: "n9",
            },
          ],
          notes: ["Narration remains bookish and descriptive."],
          confidence: 0.81,
        },
      ],
      notes: "style evidence accepted",
    });

    expect(result.characterSpeechEvidence).toHaveLength(1);
    expect(result.characterSpeechEvidence[0].name).toBe("Alice");
    expect(result.styleProfile.narration.tone).toBe("literary");
    expect(result.narrationEvidence).toHaveLength(1);
  });
});
