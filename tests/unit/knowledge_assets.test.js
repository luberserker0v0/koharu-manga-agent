const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildTranslationContext,
  formatTranslationSystemPrompt,
} = require("../../backend/src/modules/knowledge_assets");

describe("knowledge assets", () => {
  test("buildTranslationContext returns null when no mangaId is provided", () => {
    expect(buildTranslationContext({ mangaId: null })).toBeNull();
  });

  test("formatTranslationSystemPrompt returns null when context is empty", () => {
    expect(formatTranslationSystemPrompt(null)).toBeNull();
  });

  test("translation context exposes identity, canonical, and style layers", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-assets-"));
    const originalCwd = process.cwd();
    process.chdir(tempRoot);

    jest.resetModules();
    jest.doMock("../../backend/src/config", () => ({
      PROJECT_ROOT: tempRoot,
      paths: {
        knowledgeBase: path.join(tempRoot, "knowledge_base", "self", "my-manga.json"),
        reports: path.join(tempRoot, "knowledge_base", "reports", "extract_report.json"),
        referenceImages: path.join(tempRoot, "references", "other_images"),
        referenceExtracted: path.join(tempRoot, "references", "extracted"),
        referenceComparisons: path.join(tempRoot, "references", "comparisons"),
        referenceManifests: path.join(tempRoot, "references", "manifests"),
      },
    }));

    const assets = require("../../backend/src/modules/knowledge_assets");
    const mangaId = "phantom_fantasy";

    const glossary = assets.defaultCanonicalGlossary(mangaId);
    glossary.entries.push({
      source_term: "Royal Knights",
      canonical_translation: "王都騎士團",
      aliases: ["皇家騎士團"],
      category: "organization",
      rendering_hints: { keepFormal: true },
    });
    assets.writeCanonicalGlossary(mangaId, glossary);

    const storyContext = assets.defaultStoryContext(mangaId);
    storyContext.chapters.ch_001 = {
      chapterId: "ch_001",
      referenceSetIds: ["ref_001"],
      characters: [{ name: "艾莉絲" }],
      terminology: [
        {
          term: "王都騎士團",
          sourceTerm: "Royal Knights",
          category: "organization",
        },
      ],
      keyLines: ["艾莉絲率領王都騎士團。"],
      events: [],
      relationships: [],
      updatedAt: new Date().toISOString(),
    };
    assets.writeStoryContext(mangaId, storyContext);

    const styleProfile = assets.defaultStyleProfile(mangaId);
    styleProfile.rules.register = "formal";
    assets.writeStyleProfile(mangaId, styleProfile);

    const context = assets.buildTranslationContext({
      mangaId,
      chapterId: "ch_001",
      glossaryMode: "canonical",
    });

    expect(context.mangaGlobal.identityLayer.terminology).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTerm: "Royal Knights",
          category: "organization",
        }),
      ])
    );
    expect(context.mangaGlobal.canonicalLayer.terminology).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalTranslation: "王都騎士團",
        }),
      ])
    );
    expect(context.mangaGlobal.styleRenderingLayer.constraints.register).toBe("formal");
    expect(context.chapterLocal.terminologyIdentityMap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTerm: "Royal Knights",
          canonicalTranslation: "王都騎士團",
        }),
      ])
    );

    const prompt = assets.formatTranslationSystemPrompt(context);
    expect(prompt).toContain("Royal Knights => 王都騎士團");
    expect(prompt).toContain("Term identity layer:");

    process.chdir(originalCwd);
    jest.dontMock("../../backend/src/config");
  });

  test("candidate terms merge accumulates evidence across chapters and sorts by confidence", () => {
    const assets = require("../../backend/src/modules/knowledge_assets");
    const mangaId = "fixture_series";
    const base = assets.defaultCandidateTerms(mangaId);

    const mergedOnce = assets.mergeCandidateTerms(
      base,
      [
        {
          kind: "term",
          status: "candidate",
          source_term: "バンフィールド家",
          canonical_translation: "バンフィールド家",
          category: "faction",
          confidence_score: 0.72,
          notes: "chapter 2 repeated family entity",
        },
        {
          kind: "term",
          status: "rejected",
          source_term: "奥義",
          canonical_translation: "奥義",
          category: "common_noun",
          confidence_score: 0.1,
          notes: "generic term",
        },
      ],
      "ch_002",
      "ref_002"
    );

    const mergedTwice = assets.mergeCandidateTerms(
      mergedOnce,
      [
        {
          kind: "term",
          status: "accepted",
          source_term: "バンフィールド家",
          canonical_translation: "バンフィールド家",
          category: "faction",
          confidence_score: 0.9,
          notes: "chapter 3 repeated family entity again",
        },
      ],
      "ch_003",
      "ref_003"
    );

    expect(mergedTwice.entries[0]).toEqual(
      expect.objectContaining({
        source_term: "バンフィールド家",
        status: "accepted",
        chapter_count: 2,
        accepted_count: 1,
        candidate_count: 1,
      })
    );
    expect(mergedTwice.entries[0].confidence_score).toBeGreaterThan(0.9);
    expect(mergedTwice.entries[0].reference_set_ids).toEqual(["ref_002", "ref_003"]);
    expect(mergedTwice.entries[1]).toEqual(
      expect.objectContaining({
        source_term: "奥義",
        status: "rejected",
      })
    );
  });

  test("style profile aggregates chapter evidence and leaves weak rules unresolved", () => {
    const assets = require("../../backend/src/modules/knowledge_assets");
    const profile = assets.buildStyleProfileFromEvidence("fixture_series", {
      metadata: { source_reference_sets: ["ref_1", "ref_2"], source_chapters: ["ch_1", "ch_2"] },
      chapters: {
        ch_1: {
          referenceKind: "translator",
          targetStyleAllowed: true,
          registerEvidence: [{ register: "formal", confidence: 0.1, sampleSize: 100 }],
          punctuationEvidence: [{ preferFullWidth: true, confidence: 0.2, sampleSize: 100 }],
          honorificEvidence: [{ preserveHonorifics: false, confidence: 0, sampleSize: 100 }],
          dialogueNarrationEvidence: [{ dialogueRatio: 0.8, narrationRatio: 0.1, monologueRatio: 0.1, sampleSize: 100 }],
          dialogueSamples: ["A"], narrationSamples: ["B"], monologueSamples: ["C"],
        },
        ch_2: {
          referenceKind: "translator",
          targetStyleAllowed: true,
          registerEvidence: [{ register: "formal", confidence: 0.05, sampleSize: 300 }],
          punctuationEvidence: [{ preferFullWidth: true, confidence: 0.25, sampleSize: 300 }],
          honorificEvidence: [{ preserveHonorifics: true, confidence: 0.02, sampleSize: 300 }],
          dialogueNarrationEvidence: [{ dialogueRatio: 0.2, narrationRatio: 0.4, monologueRatio: 0.4, sampleSize: 300 }],
          dialogueSamples: ["D"], narrationSamples: ["E"], monologueSamples: ["F"],
        },
      },
    });

    expect(profile.rules.register).toBe("unknown");
    expect(profile.rules.preserveHonorifics).toBeNull();
    expect(profile.rules.punctuation.preferFullWidth).toBeNull();
    expect(profile.rules.dialogueNarration).toEqual({
      dialogueRatio: 0.35,
      narrationRatio: 0.325,
      monologueRatio: 0.325,
    });
    expect(profile.confidence.register).toEqual(expect.objectContaining({ resolved: false, supportChapters: 2 }));
    expect(profile.confidence.dialogueNarration).toEqual(expect.objectContaining({ sampleSize: 400 }));
  });

  test("style profile promotes a rule only after repeated high-confidence support", () => {
    const assets = require("../../backend/src/modules/knowledge_assets");
    const chapter = (sampleSize) => ({
      referenceKind: "translator",
      targetStyleAllowed: true,
      registerEvidence: [{ register: "formal", confidence: 0.8, sampleSize }],
      punctuationEvidence: [{ preferFullWidth: true, confidence: 0.9, sampleSize }],
      honorificEvidence: [{ preserveHonorifics: true, confidence: 0.75, sampleSize }],
      dialogueNarrationEvidence: [{ dialogueRatio: 0.8, narrationRatio: 0.1, monologueRatio: 0.1, sampleSize }],
    });
    const profile = assets.buildStyleProfileFromEvidence("fixture_series", {
      metadata: { source_reference_sets: ["ref_1", "ref_2"], source_chapters: ["ch_1", "ch_2"] },
      chapters: { ch_1: chapter(100), ch_2: chapter(200) },
    });

    expect(profile.rules.register).toBe("formal");
    expect(profile.rules.preserveHonorifics).toBe(true);
    expect(profile.rules.punctuation.preferFullWidth).toBe(true);
    expect(profile.confidence.register).toEqual(expect.objectContaining({ resolved: true, score: 0.8 }));
  });

  test("target-only observations do not fabricate source or canonical translation fields", () => {
    const assets = require("../../backend/src/modules/knowledge_assets");
    const merged = assets.mergeCandidateTerms(
      assets.defaultCandidateTerms("fixture_series"),
      [{
        kind: "character",
        reference_kind: "translator",
        alignment_status: "target_only",
        observed_form: "天城",
        target_rendering: "天城",
        source_term: null,
        canonical_translation: null,
        confidence: 0.9,
      }],
      "ch_1",
      "ref_1"
    );

    expect(merged.entries[0]).toEqual(expect.objectContaining({
      alignment_status: "target_only",
      observed_form: "天城",
      target_rendering: "天城",
      source_term: null,
      canonical_form: null,
      canonical_translation: null,
    }));
  });
});
