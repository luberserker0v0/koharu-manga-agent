const { buildObservationTaskInput } = require("../../backend/src/modules/reference_observation");

describe("chapter observation input", () => {
  test("uses translated text for translator references even when source text is absent", () => {
    const input = buildObservationTaskInput({
      referenceSetId: "target_ref",
      chapterId: "chapter_1",
      chapterTitle: "Chapter 1",
      contentLanguage: "zh-CN",
      referenceKind: "translator",
      extractedTexts: {
        pages: [{
          pageName: "001.jpg",
          texts: [{ nodeId: "n1", sourceText: "", translatedText: "天城大人" }],
        }],
      },
      scene: null,
      glossary: null,
      storyContext: null,
    });

    expect(input.pages[0].nodes).toEqual([
      expect.objectContaining({ nodeId: "n1", text: "天城大人" }),
    ]);
  });
});
