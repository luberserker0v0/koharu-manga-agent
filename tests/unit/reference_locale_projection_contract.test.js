const { parseReferenceLocaleProjectionOutput } = require("../../backend/src/reference_locale_projection_contract");

describe("reference locale projection contract", () => {
  const input = {
    projectionId: "projection_1",
    terms: [{ entryId: "term_001" }],
    styleExamples: [{ exampleId: "style_0_dialogue_0" }],
  };

  test("requires exactly one rendering for every supplied entry", () => {
    expect(parseReferenceLocaleProjectionOutput([
      "TERM|term_001|布萊恩|0.98|Traditional Chinese rendering",
      "STYLE|style_0_dialogue_0|你在做什麼？|0.95|Locale-adapted punctuation",
      "PROJECTION_DONE|projection_1",
    ].join("\n"), input)).toEqual({
      projectedTerms: [{ entryId: "term_001", targetRendering: "布萊恩", confidence: 0.98, reason: "Traditional Chinese rendering" }],
      projectedStyleExamples: [{ exampleId: "style_0_dialogue_0", targetText: "你在做什麼？", confidence: 0.95, reason: "Locale-adapted punctuation" }],
    });
  });

  test("rejects missing, duplicate, and unknown entries", () => {
    expect(() => parseReferenceLocaleProjectionOutput("TERM|term_001|布萊恩|0.9|ok\nPROJECTION_DONE|projection_1", input)).toThrow(/cover every/);
    expect(() => parseReferenceLocaleProjectionOutput([
      "TERM|unknown|布萊恩|0.9|ok",
      "PROJECTION_DONE|projection_1",
    ].join("\n"), input)).toThrow(/Invalid locale TERM/);
  });
});
