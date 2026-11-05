const {
  parseReviewOutput,
  validateReviewResult,
} = require("../../backend/src/domains/translation/text_regions/text_region_review_contract");

const SPACE = { width: 1000, height: 1500 };
const PAGE = { coordinateSpace: SPACE, regions: [{
  id: "region-1", readingOrder: 0, sourceText: "old",
  geometry: { x: 10, y: 20, width: 30, height: 40, rotation: 0 },
}] };

describe("text-region review contract", () => {
  test("maps model text to authoritative boxes and preserves OCR whitespace", () => {
    const result = parseReviewOutput('```json\n{"count":1,"texts":["a\\nb"]}\n```', PAGE);
    expect(result).toEqual({ count: 1, regions: [{ box: [10, 20, 30, 40], text: "a\nb" }] });
  });

  test("normalizes the redundant count from regions.length", () => {
    expect(validateReviewResult({ count: 2, regions: [] }, SPACE)).toEqual({ count: 0, regions: [] });
  });

  test("rejects boxes outside the source image", () => {
    expect(() => validateReviewResult({
      count: 1, regions: [{ box: [900, 20, 200, 40], text: "text" }],
    }, SPACE)).toThrow("inside the source image");
  });

  test("requires exactly one model text for every authoritative region", () => {
    expect(() => parseReviewOutput('{"count":0,"texts":[]}', PAGE))
      .toThrow("exactly 1 OCR text values");
  });

  test("reports malformed model output as an upstream failure", () => {
    expect(() => parseReviewOutput("not json", PAGE)).toThrow(expect.objectContaining({
      code: "invalid_text_region_review_output", statusCode: 502,
      message: "LM Studio returned an invalid text-region review: Vision model output does not contain a JSON object.",
    }));
  });
});
