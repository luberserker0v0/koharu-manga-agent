const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ensureTranslationChapterObservation,
  observationPages,
  sourceFingerprint,
} = require("../../backend/src/modules/translation_chapter_observation");

describe("translation chapter observation", () => {
  test("builds ordered pages from Koharu translations", () => {
    expect(observationPages([
      { id: "n1", pageId: "p1", pageName: "001.png", original: "一" },
      { id: "n2", pageId: "p1", pageName: "001.png", original: "二" },
      { id: "n3", pageId: "p2", pageName: "002.png", original: "三" },
    ])).toEqual([
      { pageId: "p1", pageName: "001.png", nodes: [
        { nodeId: "n1", readingOrder: 0, text: "一" },
        { nodeId: "n2", readingOrder: 1, text: "二" },
      ] },
      { pageId: "p2", pageName: "002.png", nodes: [
        { nodeId: "n3", readingOrder: 0, text: "三" },
      ] },
    ]);
  });

  test("persists and reuses an immutable observation cache", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "translation-observation-"));
    const translations = [
      { id: "n1", pageId: "p1", pageName: "001.png", original: "これは台詞です" },
      { id: "n2", pageId: "p1", pageName: "001.png", original: "地の文です" },
    ];
    const runChapterObservation = jest.fn(async (input) => ({
      nodes: input.pages.flatMap((page) => page.nodes.map((node, index) => ({
        pageName: page.pageName,
        nodeId: node.nodeId,
        textFingerprint: require("crypto").createHash("sha256").update(node.text).digest("hex"),
        textRole: index === 0 ? "dialogue" : "narration",
        speakerType: index === 0 ? "character" : "narrator",
        speakerRef: null,
        styleChannel: index === 0 ? "character_voice" : "narrator_voice",
        roleConfidence: 0.9,
        speakerConfidence: 0.8,
      }))),
      mentions: [],
      storyCues: [],
      notes: null,
      coverage: { expected: 2, observed: 2, missing: 0 },
      warnings: [],
    }));
    const aoTaskRunner = { settings: { model: "provider/model" }, runChapterObservation };

    const first = await ensureTranslationChapterObservation({
      aoTaskRunner,
      translations,
      mangaId: "manga_1",
      chapterId: "chapter_6",
      contentLanguage: "ja-JP",
      cacheRoot,
    });
    const second = await ensureTranslationChapterObservation({
      aoTaskRunner,
      translations: translations.map((entry, index) => ({
        ...entry,
        id: `rebuilt_${index + 1}`,
        pageId: `rebuilt_page_${index + 1}`,
      })),
      mangaId: "manga_1",
      chapterId: "chapter_6",
      contentLanguage: "ja-JP",
      cacheRoot,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.observation.fingerprint).toBe(first.observation.fingerprint);
    expect(second.observation.extractionFingerprint).toBe(sourceFingerprint(translations));
    expect(second.observation.nodes).toHaveLength(2);
    expect(runChapterObservation).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(first.observationPath)).toBe(true);
  });
});
