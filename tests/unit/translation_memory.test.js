const mockListKnowledgeSeries = jest.fn();
const mockResolveKnowledgeAssetPaths = jest.fn();
const mockLoadCanonicalGlossary = jest.fn();
const mockLoadKnowledgeBase = jest.fn();
const mockLoadStoryContext = jest.fn();
const mockLoadStyleEvidence = jest.fn();
const mockLoadStyleProfile = jest.fn();

jest.mock("../../backend/src/modules/knowledge_paths", () => ({
  listKnowledgeSeries: mockListKnowledgeSeries,
  resolveKnowledgeAssetPaths: mockResolveKnowledgeAssetPaths,
}));

jest.mock("../../backend/src/modules/knowledge_assets", () => ({
  loadCanonicalGlossary: mockLoadCanonicalGlossary,
  loadKnowledgeBase: mockLoadKnowledgeBase,
  loadStoryContext: mockLoadStoryContext,
  loadStyleEvidence: mockLoadStyleEvidence,
  loadStyleProfile: mockLoadStyleProfile,
}));

const {
  assertTranslationMemoryReady,
  composeTranslationMemory,
  resolveSourceChapterMapping,
} = require("../../backend/src/modules/translation_memory");

const series = {
  mangaId: "manga_1",
  translators: [
    {
      translatorId: "translator_original",
      chapters: [
        { chapterId: "source_a", chapterTitle: "第1話", sortOrder: 1 },
        { chapterId: "source_b", chapterTitle: "第2話", sortOrder: 2 },
      ],
    },
    {
      translatorId: "translator_zh",
      profileKind: "standard",
      chapters: [
        { chapterId: "target_a", chapterTitle: "01", sortOrder: 1 },
        { chapterId: "target_b", chapterTitle: "特別篇", sortOrder: 2 },
      ],
    },
    {
      translatorId: "translator_zh_clone",
      profileKind: "learning_clone",
      styleSourceTranslatorId: "translator_zh",
      chapters: [
        { chapterId: "clone_a", chapterTitle: "01", sortOrder: 1 },
        { chapterId: "clone_4", chapterTitle: "第4話", sortOrder: 2 },
      ],
    },
  ],
};

describe("translation memory composition", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListKnowledgeSeries.mockReturnValue([series]);
    mockResolveKnowledgeAssetPaths.mockImplementation(({ translatorId }) => ({
      glossaryPath: `missing-${translatorId}-glossary.json`,
      storyContextPath: `missing-${translatorId}-story.json`,
      styleEvidencePath: `missing-${translatorId}-style-evidence.json`,
      styleProfilePath: `missing-${translatorId}-style-profile.json`,
      bilingualEvidencePath: `missing-${translatorId}-bilingual.json`,
      knowledgeBasePath: `missing-${translatorId}-knowledge.json`,
    }));
    mockLoadCanonicalGlossary.mockImplementation((_mangaId, translatorId) =>
      translatorId === "translator_original"
        ? { entries: [{ source_term: "天城", canonical_form: "天城", category: "character", confidence: 0.95 }] }
        : { entries: [{ source_term: "星間国家", canonical_translation: "星際國家", source: "reference_bilingual_evidence", confidence: 0.9 }] }
    );
    mockLoadStoryContext.mockReturnValue({
      global: { characters: [{ name: "天城" }], terminology: [] },
      chapters: { source_a: { chapterId: "source_a", summary: "第一話事件" } },
    });
    mockLoadStyleEvidence.mockReturnValue({
      chapters: { target_a: { chapterId: "target_a", dialogueSamples: ["遵命，主人。"] } },
    });
    mockLoadStyleProfile.mockReturnValue({ rules: { register: "formal" } });
    mockLoadKnowledgeBase.mockReturnValue({
      translation_pairs: [{ original: "了解", translation: "明白了" }],
      terminology: [{ term: "案内人", translation: "引路人", status: "stable", confidence: 0.9 }],
      style_examples: [{ type: "dialogue", translation: "明白了。" }],
      characters: [],
      style_profile: {},
    });
  });

  test("chapter matching prefers explicit, then chapter number, then sort order", () => {
    expect(resolveSourceChapterMapping({
      mangaId: "manga_1", translatorId: "translator_zh", sourceChapterId: "source_b",
    }).method).toBe("explicit");
    expect(resolveSourceChapterMapping({
      mangaId: "manga_1", translatorId: "translator_zh", chapterId: "target_a",
    })).toEqual(expect.objectContaining({ sourceChapterId: "source_a", method: "chapter_number" }));
    expect(resolveSourceChapterMapping({
      mangaId: "manga_1", translatorId: "translator_zh", chapterId: "target_b",
    })).toEqual(expect.objectContaining({ sourceChapterId: "source_b", method: "sort_order" }));
  });

  test("does not map a known missing chapter number by target sort order", () => {
    expect(resolveSourceChapterMapping({
      mangaId: "manga_1",
      translatorId: "translator_zh_clone",
      chapterId: "clone_4",
      chapterTitle: "第4話",
    })).toEqual(expect.objectContaining({
      sourceChapterId: null,
      method: "global_only",
      warning: expect.stringContaining("Source chapter 4 is unavailable"),
    }));
  });

  test("quick mode does not load any memory even when manga identifiers are present", () => {
    const snapshot = composeTranslationMemory({
      translationMode: "quick",
      mangaId: "manga_1",
      translatorId: "translator_zh",
      chapterId: "target_a",
    });

    expect(snapshot.layers).toEqual({ reference: null, local: null });
    expect(snapshot.effective.glossary).toEqual([]);
    expect(mockLoadCanonicalGlossary).not.toHaveBeenCalled();
    expect(mockLoadKnowledgeBase).not.toHaveBeenCalled();
  });

  test("learning style keeps reference and local evidence in separate layers", () => {
    const snapshot = composeTranslationMemory({
      translationMode: "learning_style",
      mangaId: "manga_1",
      translatorId: "translator_zh_clone",
      referenceTranslatorId: "translator_zh",
      chapterId: "clone_a",
    });

    expect(snapshot.chapterMapping.sourceChapterId).toBe("source_a");
    expect(snapshot.effective.glossary).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_term: "星間国家", canonical_translation: "星際國家" }),
      expect.objectContaining({ source_term: "案内人", canonical_translation: "引路人", source: "self" }),
    ]));
    expect(snapshot.effective.sourceIdentity[0].sourceTerm).toBe("天城");
    expect(snapshot.effective.story.chapter.summary).toBe("第一話事件");
    expect(snapshot.effective.localKnowledge.translationPairs).toHaveLength(1);
    expect(snapshot.readiness).toEqual({ reference: true, local: true });
    expect(snapshot.layers.reference).toEqual(expect.objectContaining({
      referenceTranslatorId: "translator_zh",
      learningTranslatorId: "translator_zh_clone",
    }));
    expect(mockLoadKnowledgeBase).toHaveBeenCalledWith("manga_1", "translator_zh_clone");
    expect(() => assertTranslationMemoryReady(snapshot)).not.toThrow();
  });

  test("learning style rejects an output profile that is not a clone of the Reference translator", () => {
    expect(() => composeTranslationMemory({
      translationMode: "learning_style",
      mangaId: "manga_1",
      translatorId: "translator_zh",
      referenceTranslatorId: "translator_zh",
      chapterId: "target_a",
    })).toThrow("separate learning clone");
  });

  test("local style is blocked when no learned memory exists", () => {
    mockLoadKnowledgeBase.mockReturnValue({
      translation_pairs: [], terminology: [], style_examples: [], characters: [], style_profile: {},
    });
    const snapshot = composeTranslationMemory({
      translationMode: "local_style",
      mangaId: "manga_1",
      translatorId: "translator_zh",
      chapterId: "target_a",
    });
    expect(() => assertTranslationMemoryReady(snapshot)).toThrow("existing learned translation memory");
  });
});
