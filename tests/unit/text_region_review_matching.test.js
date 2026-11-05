const {
  buildReviewOperations,
} = require("../../backend/src/domains/translation/text_regions/text_region_review_matching");

function current(id, x, text) {
  return { id, sourceText: text, geometry: { x, y: 20, width: 100, height: 80, rotation: 0 } };
}

describe("text-region review matching", () => {
  test("creates text-only updates without geometry operations", () => {
    const page = { regions: [current("one", 10, "old"), current("two", 300, "same")] };
    const review = { count: 2, regions: [
      { box: [10, 20, 100, 80], text: "corrected" },
      { box: [300, 20, 100, 80], text: "same" },
    ] };

    expect(buildReviewOperations(page, review)).toEqual([
      { type: "update", regionId: "one", sourceText: "corrected" },
    ]);
  });

  test("does not create operations for an unchanged result", () => {
    const page = { regions: [current("one", 10, "same")] };
    const review = { count: 1, regions: [{ box: [10, 20, 100, 80], text: "same" }] };
    expect(buildReviewOperations(page, review)).toEqual([]);
  });

  test("rejects adding, removing, or moving regions", () => {
    const page = { regions: [current("one", 10, "old")] };
    expect(() => buildReviewOperations(page, { count: 0, regions: [] }))
      .toThrow("cannot add or remove");
    expect(() => buildReviewOperations(page, {
      count: 1, regions: [{ box: [12, 20, 100, 80], text: "corrected" }],
    })).toThrow("cannot change text-region geometry");
  });
});
