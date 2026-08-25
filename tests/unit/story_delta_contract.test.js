const {
  parseLineBasedStoryDelta,
  validateStoryDeltaResult,
} = require("../../backend/src/integrations/ao/contracts/story_delta_contract");

const input = {
  analysisDepth: "observation_first_pass",
  sourceNodes: [
    { pageName: "001.jpg", nodeId: "n1", text: "彼は私の師だ", textRole: "dialogue", styleChannel: "character_voice", roleConfidence: 0.9 },
    { pageName: "001.jpg", nodeId: "n2", text: "戦いが始まった", textRole: "narration", styleChannel: "narrator_voice", roleConfidence: 0.9 },
  ],
};

describe("story delta contract", () => {
  test("accepts grounded multi-evidence story updates", () => {
    const result = parseLineBasedStoryDelta([
      "RELATION_DELTA|instructorOf|彼|私|n1|0.82|Resolves address choices",
      "STORY_EVENT|n1,n2|0.8|participants=彼,私|戦いが始まる|Disambiguates later references",
      "STORY_DELTA_DONE",
    ].join("\n"), input);
    expect(() => validateStoryDeltaResult(result)).not.toThrow();
    expect(result.observedRelations).toHaveLength(1);
    expect(result.observedEvents).toHaveLength(1);
    expect(result.semanticResult.outcome).toBe("clean");
  });

  test("quarantines malformed records and commits a no-update revision", () => {
    const result = parseLineBasedStoryDelta([
      "RELATION_DELTA|instructorOf|彼|私|unknown|0.82|bad evidence",
      "EVIDENCE_ROLE|n1|dialogue|character_voice|0.82",
      "STORY_DELTA_DONE",
    ].join("\n"), input);
    expect(result.noUpdate).toBe(true);
    expect(result.observedRelations).toEqual([]);
    expect(result.semanticResult).toEqual(expect.objectContaining({ outcome: "partial", quarantinedRecordCount: 1 }));
    expect(() => validateStoryDeltaResult(result)).not.toThrow();
  });

  test("keeps valid records when another record exceeds its budget", () => {
    const result = parseLineBasedStoryDelta([
      "CHARACTER_STATE|彼|mood|calm|n1|0.8|Voice remains formal",
      "CHARACTER_STATE|私|mood|alert|n1|0.8|Voice becomes terse",
      "CHARACTER_STATE|彼|location|bridge|n2|0.8|Resolves location",
      "CHARACTER_STATE|私|location|bridge|n2|0.8|Beyond budget",
      "STORY_DELTA_DONE",
    ].join("\n"), input);
    expect(result.characterStates).toHaveLength(3);
    expect(result.semanticResult.quarantinedRecordCount).toBe(1);
  });

  test("requires the final completion marker", () => {
    expect(() => parseLineBasedStoryDelta("NO_UPDATE|Nothing durable", input)).toThrow(/missing STORY_DELTA_DONE/);
  });
});
