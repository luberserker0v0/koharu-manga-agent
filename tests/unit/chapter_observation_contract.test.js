const {
  parseLineBasedChapterObservation: parseRawChapterObservation,
} = require("../../backend/src/integrations/ao/contracts/chapter_observation_contract");

const parseLineBasedChapterObservation = (content, taskInput) =>
  parseRawChapterObservation(`${content}\nOBSERVATION_DONE`, taskInput);

const input = {
  chapterId: "chapter_1",
  pages: [{
    pageName: "001.jpg",
    nodes: [
      { nodeId: "n1", text: "天城", readingOrder: 0 },
      { nodeId: "n2", text: "お帰りなさい", readingOrder: 1 },
    ],
  }],
};

describe("chapter observation line contract", () => {
  test("requires the final completion record", () => {
    expect(() => parseRawChapterObservation(
      "NODE|001.jpg|n1|dialogue|character|天城|character_voice|0.9|0.9|partial",
      input
    )).toThrow("missing OBSERVATION_DONE");
  });
  test("parses complete node, mention, and story cue evidence", () => {
    const result = parseLineBasedChapterObservation([
      "NODE|001.jpg|n1|dialogue|character|天城|character_voice|0.96|0.91|名前を伴う発話",
      "NODE|001.jpg|n2|dialogue|character|天城|character_voice|0.94|0.88|応答",
      "MENTION|m1|001.jpg::n1|天城|character|0.97|明示的な人物名",
      "STORY_CUE|c1|001.jpg::n1,001.jpg::n2|relationship|0.82|関係性を示す応答",
      "NOTES|画像なしのため話者推定は保守的",
    ].join("\n"), input);

    expect(result.coverage).toEqual({ expected: 2, observed: 2, uncertain: 0, invalid: 0 });
    expect(result.mentions[0].surfaceForm).toBe("天城");
    expect(result.storyCues[0].evidenceNodeKeys).toEqual(["001.jpg::n1", "001.jpg::n2"]);
  });

  test("fills missing nodes and quarantines invalid records", () => {
    const missing = parseLineBasedChapterObservation(
      "NODE|001.jpg|n1|dialogue|none||character_voice|0.9|0.9|only one",
      input
    );
    expect(missing.nodes.find((entry) => entry.nodeId === "n2").textRole).toBe("uncertain");
    const invalid = parseLineBasedChapterObservation([
      "NODE|001.jpg|n1|wrong|none||unknown|0.9|0.9|bad",
      "NODE|001.jpg|n2|dialogue|none||character_voice|0.9|0.9|ok",
    ].join("\n"), input);
    expect(invalid.semanticResult.quarantinedRecordCount).toBe(1);
    expect(invalid.nodes.find((entry) => entry.nodeId === "n1").textRole).toBe("uncertain");
  });

  test("quarantines qualitative and percentage confidence values", () => {
    const qualitative = parseLineBasedChapterObservation([
      "NODE|001.jpg|n1|dialogue|character|天城|character_voice|high|0.9|bad confidence",
      "NODE|001.jpg|n2|dialogue|character|天城|character_voice|0.9|0.9|ok",
    ].join("\n"), input);
    expect(qualitative.semanticResult.quarantinedRecordCount).toBe(1);

    const percentage = parseLineBasedChapterObservation([
      "NODE|001.jpg|n1|dialogue|character|天城|character_voice|80%|0.9|bad confidence",
      "NODE|001.jpg|n2|dialogue|character|天城|character_voice|0.9|0.9|ok",
    ].join("\n"), input);
    expect(percentage.semanticResult.quarantinedRecordCount).toBe(1);

    const empty = parseLineBasedChapterObservation([
      "NODE|001.jpg|n1|dialogue|character|天城|character_voice||0.9|empty confidence",
      "NODE|001.jpg|n2|dialogue|character|天城|character_voice|0.9|0.9|ok",
    ].join("\n"), input);
    expect(empty.semanticResult.quarantinedRecordCount).toBe(1);
  });

  test("accepts grounded worldbuilding story cues", () => {
    const result = parseLineBasedChapterObservation([
      "NODE|001.jpg|n1|narration|narrator||narrator_voice|0.95|0.95|世界設定の説明",
      "NODE|001.jpg|n2|dialogue|character|天城|character_voice|0.9|0.9|応答",
      "STORY_CUE|c1|001.jpg::n1|worldbuilding|0.85|星間国家の制度を示す",
    ].join("\n"), input);

    expect(result.storyCues[0].cueType).toBe("worldbuilding");
  });
});
