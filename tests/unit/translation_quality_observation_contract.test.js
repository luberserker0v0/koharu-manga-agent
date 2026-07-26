const { parseTranslationQualityObservationOutput } = require("../../backend/src/translation_quality_observation_contract");

describe("translation quality observation contract", () => {
  const input = {
    windowId: "quality_observation_001",
    nodes: [
      { nodeId: "n1", pageName: "18.jpg" },
      { nodeId: "n2", pageName: "18.jpg" },
      { nodeId: "n3", pageName: "18.jpg" },
    ],
  };

  test("requires exactly one disposition per node and accepts a bounded sequence risk", () => {
    const result = parseTranslationQualityObservationOutput([
      "NODE|quality_observation_001|n1|suspect|sequence_shift|0.95|target moved",
      "NODE|quality_observation_001|n2|suspect|sequence_shift|0.95|target moved",
      "NODE|quality_observation_001|n3|clean|none|0.9|aligned",
      "SEQUENCE_RISK|quality_observation_001|18.jpg|n1|n2|0.95|sequence_shift|consecutive shift",
      "WINDOW_DONE|quality_observation_001",
    ].join("\n"), input);
    expect(result.nodes).toHaveLength(3);
    expect(result.sequenceRisks[0].nodeIds).toEqual(["n1", "n2"]);
  });

  test("rejects omitted nodes", () => {
    expect(() => parseTranslationQualityObservationOutput([
      "NODE|quality_observation_001|n1|clean|none|0.9|ok",
      "WINDOW_DONE|quality_observation_001",
    ].join("\n"), input)).toThrow(/omitted 2 node/);
  });

  test("rejects unknown IDs and duplicate dispositions", () => {
    expect(() => parseTranslationQualityObservationOutput([
      "NODE|quality_observation_001|unknown|clean|none|0.9|ok",
      "WINDOW_DONE|quality_observation_001",
    ].join("\n"), input)).toThrow(/unknown node/);
    expect(() => parseTranslationQualityObservationOutput([
      "NODE|quality_observation_001|n1|clean|none|0.9|ok",
      "NODE|quality_observation_001|n1|clean|none|0.9|ok",
      "NODE|quality_observation_001|n2|clean|none|0.9|ok",
      "NODE|quality_observation_001|n3|clean|none|0.9|ok",
      "WINDOW_DONE|quality_observation_001",
    ].join("\n"), input)).toThrow(/Duplicate NODE/);
  });
});
