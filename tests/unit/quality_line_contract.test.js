const { parseQualityWindowOutput } = require("../../backend/src/quality_line_contract");

const input = { windowId: "quality_001", candidates: [{ nodeId: "n1", pageName: "1.jpg", original: "月晶", currentTranslation: "舊譯", reasons: [{ type: "locked_term", evidence: { canonicalTranslation: "月之水晶" } }] }] };

describe("quality line contract", () => {
  test("parses a valid revision", () => {
    const result = parseQualityWindowOutput("ISSUE|n1|glossary_consistency|high|0.98|wrong term|revise\nREVISION|n1|glossary_consistency|0.98|月之水晶|canonical\nWINDOW_DONE|quality_001", input);
    expect(result.revisions[0].revisedTranslation).toBe("月之水晶");
  });

  test("tolerates one matching defensive window header", () => {
    const headerInput = {
      ...input,
      projectionFingerprint: "projection-1",
      translationMemoryFingerprint: "memory-1",
      languages: { sourceLanguage: "ja-JP", targetLanguage: "zh-TW" },
    };
    const result = parseQualityWindowOutput(
      "WINDOW|quality_001|projection-1|memory-1|ja-JP|zh-TW\nISSUE|n1|glossary_consistency|high|0.98|wrong term|revise\nREVISION|n1|glossary_consistency|0.98|月之水晶|canonical\nWINDOW_DONE|quality_001",
      headerInput
    );
    expect(result.windowHeader).toEqual(expect.objectContaining({ targetLanguage: "zh-TW" }));
  });

  test("rejects a mismatched window header", () => {
    expect(() => parseQualityWindowOutput(
      "WINDOW|wrong_window|projection-1|memory-1|ja-JP|zh-TW\nWINDOW_DONE|quality_001",
      input
    )).toThrow(/WINDOW windowId does not match/);
  });

  test("rejects conflicting keep and revision dispositions", () => {
    expect(() => parseQualityWindowOutput(
      "WARNING|n1|translation_accuracy|medium|0.7|keep current text|keep\nREVISION|n1|translation_accuracy|0.8|月之水晶|revise it\nWINDOW_DONE|quality_001",
      input
    )).toThrow(/conflicts with existing keep disposition/);
  });

  test("rejects unsupported unicode escape text instead of corrupting it", () => {
    expect(() => parseQualityWindowOutput(
      "WARNING|n1|translation_accuracy|medium|0.7|literal \\u201c escape|keep\nWINDOW_DONE|quality_001",
      input
    )).toThrow(/Unknown line-contract escape/);
  });
  test("rejects unknown nodes and locked-term rewrites", () => {
    expect(() => parseQualityWindowOutput("REVISION|bad|translation_accuracy|0.9|x|x\nWINDOW_DONE|quality_001", input)).toThrow(/unknown node/);
    expect(() => parseQualityWindowOutput("REVISION|n1|translation_accuracy|0.9|別名|x\nWINDOW_DONE|quality_001", input)).toThrow(/breaks locked term/);
  });

  test("requires an explicit outcome for completeness candidates", () => {
    const completenessInput = {
      windowId: "quality_001",
      candidates: [{
        nodeId: "n2",
        pageName: "2.jpg",
        original: "ナダレ",
        currentTranslation: "ナダレ",
        reasons: [{ type: "translation_missing", evidence: null }],
      }],
    };
    const accepted = parseQualityWindowOutput(
      "ACCEPT|n2|translation_completeness|Japanese creator name is intentionally retained\nWINDOW_DONE|quality_001",
      completenessInput
    );
    expect(accepted.acceptedNodeIds).toEqual(["n2"]);
    expect(accepted.acceptances[0].reason).toContain("creator name");
    expect(() => parseQualityWindowOutput("WINDOW_DONE|quality_001", completenessInput)).toThrow(
      /requires REVISION or ACCEPT/
    );
    expect(() => parseQualityWindowOutput(
      "ACCEPT|n1|translation_completeness|looks fine\nWINDOW_DONE|quality_001",
      input
    )).toThrow(/non-completeness candidate/);
  });
});
