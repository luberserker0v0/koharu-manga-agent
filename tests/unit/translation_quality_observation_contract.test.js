const { parseTranslationQualityObservationOutput } = require("../../backend/src/integrations/ao/contracts/translation_quality_observation_contract");

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

  test("fills omitted nodes as unobserved", () => {
    const result = parseTranslationQualityObservationOutput([
      "NODE|quality_observation_001|n1|clean|none|0.9|ok",
      "WINDOW_DONE|quality_observation_001",
    ].join("\n"), input);
    expect(result.nodes.filter((entry) => entry.disposition === "unobserved")).toHaveLength(2);
    expect(result.semanticResult.outcome).toBe("warnings");
  });

  test("quarantines unknown IDs and duplicate dispositions", () => {
    const unknown = parseTranslationQualityObservationOutput([
      "NODE|quality_observation_001|unknown|clean|none|0.9|ok",
      "WINDOW_DONE|quality_observation_001",
    ].join("\n"), input);
    expect(unknown.semanticResult.quarantinedRecordCount).toBe(1);
    const duplicate = parseTranslationQualityObservationOutput([
      "NODE|quality_observation_001|n1|clean|none|0.9|ok",
      "NODE|quality_observation_001|n1|clean|none|0.9|ok",
      "NODE|quality_observation_001|n2|clean|none|0.9|ok",
      "NODE|quality_observation_001|n3|clean|none|0.9|ok",
      "WINDOW_DONE|quality_observation_001",
    ].join("\n"), input);
    expect(duplicate.semanticResult.quarantinedRecordCount).toBe(1);
  });

  test("rejects legacy risk aliases instead of silently rewriting them", () => {
    const result = parseTranslationQualityObservationOutput([
      "NODE|quality_observation_001|n1|suspect|mistranslation|0.9|legacy enum",
      "NODE|quality_observation_001|n2|clean|none|0.9|ok",
      "NODE|quality_observation_001|n3|clean|none|0.9|ok",
      "WINDOW_DONE|quality_observation_001",
    ].join("\n"), input);
    expect(result.nodes.find((entry) => entry.nodeId === "n1").disposition).toBe("unobserved");
    expect(result.semanticResult.quarantinedRecordCount).toBe(1);
  });
});
