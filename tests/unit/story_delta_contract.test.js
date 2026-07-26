const {
  parseLineBasedStoryDelta,
  validateStoryDeltaResult,
} = require("../../backend/src/story_delta_contract");

const input = {
  sourceNodes: [
    { pageName: "001.png", nodeId: "n1", text: "彼は私の師匠だ", textRole: "dialogue" },
    { pageName: "001.png", nodeId: "n2", text: "必ず勝つ", textRole: "monologue" },
    { pageName: "001.png", nodeId: "n3", text: "第一話", textRole: "label_or_system" },
    { pageName: "001.png", nodeId: "n4", text: "二人の戦いが始まった", textRole: "narration" },
  ],
};

describe("story delta contract", () => {
  test("accepts grounded translation-relevant records", () => {
    const result = parseLineBasedStoryDelta(
      [
        "RELATION_DELTA|instructorOf|彼|私|n1|0.82|Resolves honorific and address choices",
        "CHARACTER_STATE|私|resolve|必ず勝つ|n2|0.70|Preserves future inner-voice intent",
      ].join("\n"),
      input
    );

    expect(result.observedRelations).toHaveLength(1);
    expect(result.characterStates).toHaveLength(1);
    expect(result.observedRelations[0].evidenceLine).toBe("彼は私の師匠だ");
    expect(result.observedRelations[0].evidences).toEqual([
      expect.objectContaining({ pageName: "001.png", nodeId: "n1" }),
    ]);
    expect(validateStoryDeltaResult(result)).toBe(result);
  });

  test("accepts records with multiple grounded evidences and participants", () => {
    const result = parseLineBasedStoryDelta(
      [
        "STORY_EVENT|n1,n4|0.84|participants=彼,私|師弟である二人の戦いが始まった|Keeps relationship and event context connected",
        "RELATION_DELTA|instructorOf|彼|私|n1,n2|0.82|Resolves address and intent",
      ].join("\n"),
      input
    );

    expect(result.observedEvents[0]).toEqual(expect.objectContaining({
      participants: ["彼", "私"],
      pageName: "001.png",
      nodeId: "n1",
    }));
    expect(result.observedEvents[0].evidences).toHaveLength(2);
    expect(result.observedRelations[0].evidences).toHaveLength(2);
    expect(validateStoryDeltaResult(result)).toBe(result);
  });

  test("rejects a record when any evidence anchor is unknown", () => {
    const result = parseLineBasedStoryDelta(
      "RELATION_DELTA|instructorOf|彼|私|n1,missing|0.82|Resolves address choices",
      input
    );

    expect(result.observedRelations).toEqual([]);
    expect(() => validateStoryDeltaResult(result)).toThrow("no accepted records");
  });

  test("rejects duplicated evidence node ids", () => {
    const result = parseLineBasedStoryDelta(
      "RELATION_DELTA|instructorOf|彼|私|n1,n1|0.82|Resolves address choices",
      input
    );

    expect(result.observedRelations).toEqual([]);
    expect(() => validateStoryDeltaResult(result)).toThrow("no accepted records");
  });

  test("rejects the removed single-evidence field layout", () => {
    expect(() => parseLineBasedStoryDelta(
      "RELATION_DELTA|instructorOf|彼|私|001.png|n1|0.82|Resolves address choices",
      input
    )).toThrow(/Story delta line 1/i);
  });

  test("rejects unsupported nodes and external events grounded only by monologue", () => {
    const result = parseLineBasedStoryDelta(
      [
        "STORY_EVENT|n2|0.90|participants=|戦争が始まった|Changes later causal interpretation",
        "RELATION_DELTA|has_role|第一話|章題|n3|0.90|Would affect a title",
        "NO_UPDATE|No grounded durable change remains",
      ].join("\n"),
      input
    );

    expect(result.observedEvents).toEqual([]);
    expect(result.observedRelations).toEqual([]);
    expect(result.noUpdate).toBe(true);
  });

  test("requires concrete translation impact", () => {
    const result = parseLineBasedStoryDelta(
      "RELATION_DELTA|instructorOf|彼|私|n1|0.82|",
      input
    );
    expect(result.observedRelations).toEqual([]);
    expect(result.noUpdate).toBe(false);
    expect(() => validateStoryDeltaResult(result)).toThrow("no accepted records");
  });

  test("quick read consumes Chapter Observation roles and caps confidence", () => {
    const result = parseLineBasedStoryDelta(
      [
        "STORY_EVENT|n1|0.95|participants=彼,私|師弟關係が明かされた|Prevents reversing the relationship",
      ].join("\n"),
      {
        analysisDepth: "quick_read",
        sourceNodes: [
          { pageName: "001.png", nodeId: "n1", text: "彼は私の師匠だ", textRole: "dialogue", styleChannel: "character_voice", roleConfidence: 0.82 },
        ],
      }
    );

    expect(result.observedEvents).toEqual([
      expect.objectContaining({
        nodeId: "n1",
        confidence: 0.75,
        textRole: "dialogue",
        styleChannel: "character_voice",
      }),
    ]);
    expect(validateStoryDeltaResult(result)).toBe(result);
  });

  test("quick read rejects output beyond the conservative record budget", () => {
    expect(() => parseLineBasedStoryDelta(
      [
        "CHARACTER_STATE|彼|state|一|n1|0.70|Keeps state one",
        "CHARACTER_STATE|彼|state|二|n2|0.70|Keeps state two",
        "OPEN_THREAD|n1|0.70|participants=彼|一つ目|Keeps thread one",
        "OPEN_THREAD|n1|0.70|participants=彼|二つ目|Keeps thread two",
      ].join("\n"),
      {
        analysisDepth: "quick_read",
        sourceNodes: [
          { pageName: "001.png", nodeId: "n1", text: "一", textRole: "dialogue", styleChannel: "character_voice", roleConfidence: 0.8 },
          { pageName: "001.png", nodeId: "n2", text: "二", textRole: "monologue", styleChannel: "inner_voice", roleConfidence: 0.8 },
        ],
      }
    )).toThrow(/CHARACTER_STATE exceeds the record budget/i);
  });

  test("quick read rejects cited evidence without a valid role annotation", () => {
    const result = parseLineBasedStoryDelta(
      "STORY_EVENT|n1|0.75|participants=彼,私|師弟關係が明かされた|Prevents reversing the relationship",
      {
        analysisDepth: "quick_read",
        sourceNodes: [
          { pageName: "001.png", nodeId: "n1", text: "彼は私の師匠だ", textRole: "unclassified" },
        ],
      }
    );

    expect(result.observedEvents).toEqual([]);
    expect(() => validateStoryDeltaResult(result)).toThrow("no accepted records");
  });

  test("deep read still rejects unclassified story evidence", () => {
    const result = parseLineBasedStoryDelta(
      "STORY_EVENT|n1|0.75|participants=彼,私|師弟關係が明かされた|Prevents reversing the relationship",
      {
        analysisDepth: "deep_read",
        sourceNodes: [
          { pageName: "001.png", nodeId: "n1", text: "彼は私の師匠だ", textRole: "unclassified" },
        ],
      }
    );

    expect(result.observedEvents).toEqual([]);
    expect(() => validateStoryDeltaResult(result)).toThrow("no accepted records");
  });

  test("rejects obsolete role records and non-numeric confidence", () => {
    expect(() => parseLineBasedStoryDelta(
      "EVIDENCE_ROLE|n1|dialogue|character_voice|0.82",
      input
    )).toThrow(/EVIDENCE_ROLE is obsolete/i);

    expect(() => parseLineBasedStoryDelta(
      "RELATION_DELTA|instructorOf|彼|私|n1|high|Resolves address choices",
      input
    )).toThrow(/confidence must be a decimal number between 0 and 1/i);
  });

  test("rejects contradictory NO_UPDATE output", () => {
    const result = parseLineBasedStoryDelta([
      "RELATION_DELTA|instructorOf|彼|私|n1|0.82|Resolves address choices",
      "NO_UPDATE|Nothing changed",
    ].join("\n"), input);
    expect(() => validateStoryDeltaResult(result)).toThrow(/cannot combine NO_UPDATE/i);
  });
});
