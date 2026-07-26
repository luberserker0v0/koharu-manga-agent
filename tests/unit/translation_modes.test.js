const {
  resolveTranslationModePolicy,
} = require("../../backend/src/modules/translation_modes");

describe("translation mode policies", () => {
  test.each([
    ["quick", true, false, false, false, false],
    ["reference_style", false, true, false, false, false],
    ["reference_style", true, true, false, true, false],
    ["local_style", false, false, true, false, true],
    ["local_style", true, false, true, true, true],
    ["learning_style", false, true, true, true, true],
  ])(
    "%s with qualityRequested=%s resolves the expected capabilities",
    (mode, qualityRequested, useReferenceMemory, useLocalMemory, runQuality, commitKnowledge) => {
      expect(resolveTranslationModePolicy(mode, qualityRequested)).toEqual(expect.objectContaining({
        translationMode: mode,
        useReferenceMemory,
        useLocalMemory,
        runQuality,
        commitKnowledge,
      }));
    }
  );

  test("missing and unknown modes are rejected", () => {
    expect(() => resolveTranslationModePolicy()).toThrow("Unknown translation mode");
    expect(() => resolveTranslationModePolicy("legacy")).toThrow("Unknown translation mode");
  });
});
