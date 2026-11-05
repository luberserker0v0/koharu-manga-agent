const {
  buildTextRegionReviewPrompt,
} = require("../../backend/src/domains/translation/text_regions/text_region_review_prompt");

function page() {
  return {
    coordinateSpace: { width: 1000, height: 1500 },
    regions: [{
      readingOrder: 0,
      sourceText: "WHA TDOYOU",
      geometry: { x: 10, y: 20, width: 100, height: 80 },
    }, {
      readingOrder: 1,
      sourceText: "MEAN?",
      geometry: { x: 120, y: 20, width: 100, height: 80 },
    }],
  };
}

describe("text-region semantic review prompt", () => {
  test("requires visual transcription followed by contextual semantic correction", () => {
    const prompt = buildTextRegionReviewPrompt(page(), ["en", "ja"]);

    expect(prompt).toContain("Read the visible glyphs inside each box");
    expect(prompt).toContain("neighboring boxes, reading order, dialogue flow, grammar, and sentence meaning");
    expect(prompt).toContain("restore natural word spaces");
    expect(prompt).toContain("must not retain concatenated words");
    expect(prompt).toContain("Expected source languages: en, ja");
  });

  test("forbids translation, paraphrasing, geometry changes, and invented dialogue", () => {
    const prompt = buildTextRegionReviewPrompt(page(), null);

    expect(prompt).toContain("Do not translate, paraphrase, censor, embellish, or invent dialogue");
    expect(prompt).toContain("If language is unknown, infer it from the image and context");
    expect(prompt).toContain("Never add, remove, resize, move, merge, or split them");
    expect(prompt).toContain("count and texts.length must both equal 2");
  });
});
