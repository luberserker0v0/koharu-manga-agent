const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  KnowledgeModule,
  removeChapterLearningEvidence,
  mergeCharacterSpeechEvidence,
  mergeNarrationEvidence,
  mergeStyleExampleEntries,
  mergeStyleProfile,
  normalizeExistingKnowledgeBase,
  translationPairsFromList,
} = require("../../backend/src/modules/knowledge");
const { knowledgeIndexPath } = require("../../backend/src/modules/knowledge_paths");

function createTempFilePath(fileName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-kb-"));
  return path.join(dir, fileName);
}

test("translation pairs retain semantic role metadata", () => {
  expect(translationPairsFromList([{
    original: "台詞",
    translation: "對白",
    textRole: "dialogue",
    styleChannel: "character_voice",
    speakerRef: "角色甲",
    roleConfidence: 0.91,
    speakerConfidence: 0.82,
  }], "chapter_1")[0]).toEqual(expect.objectContaining({
    textRole: "dialogue",
    styleChannel: "character_voice",
    speakerRef: "角色甲",
    roleConfidence: 0.91,
    speakerConfidence: 0.82,
  }));
});

function createLearningEvidencePath(chapterId, entries) {
  const filePath = createTempFilePath(`learning_${chapterId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 2,
    sourceTranslationJobId: `job_${chapterId}`,
    evidence: entries.map((entry, index) => ({
      ...entry,
      evidenceId: entry.evidenceId || `evidence_${index}`,
      reasons: entry.reasons || ["quality_revision"],
      confidence: entry.confidence ?? 0.9,
    })),
  }));
  return filePath;
}

describe("knowledge module", () => {
  let originalIndex = null;

  beforeEach(() => {
    const indexPath = knowledgeIndexPath();
    originalIndex = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, "utf-8")
      : null;
  });

  afterEach(() => {
    const indexPath = knowledgeIndexPath();
    if (originalIndex === null) {
      if (fs.existsSync(indexPath)) {
        fs.unlinkSync(indexPath);
      }
      return;
    }
    fs.writeFileSync(indexPath, originalIndex);
  });

  test("normalizes legacy knowledge base into v2-compatible shape", () => {
    const normalized = normalizeExistingKnowledgeBase({
      project_name: "legacy-project",
      source: "self",
      created_at: "2026-05-20T00:00:00.000Z",
      updated_at: "2026-05-20T01:00:00.000Z",
      translation_pairs: [
        {
          original: "old-original",
          translation: "old-translation",
          pageName: "001.jpg",
        },
      ],
      terminology: {
        a: { term: "Mana Circuit", translation: "Mana Circuit" },
      },
      characters: {
        c1: { name: "Alice" },
      },
      style_profile: {},
      style_examples: [],
    });

    expect(normalized.metadata.schema_version).toBe("2.0");
    expect(normalized.translation_pairs[0]).toHaveProperty("id");
    expect(Array.isArray(normalized.terminology)).toBe(true);
    expect(Array.isArray(normalized.characters)).toBe(true);
  });

  test("style profile merge keeps existing rules and adds evidence-backed notes", () => {
    const merged = mergeStyleProfile(
      {
        tone: "measured",
        register: "formal",
        honorific_policy: ["keep-sama"],
        punctuation_policy: ["full-width"],
        preferred_patterns: ["Please rest assured"],
        forbidden_patterns: [],
        notes: ["existing"],
      },
      {
        tone: "dramatic",
        register: "formal",
        honorific_policy: ["keep-dono"],
        punctuation_policy: ["full-width"],
        preferred_patterns: ["I will handle it"],
        forbidden_patterns: ["slang"],
        narration: {
          tone: "literary",
          register: "written",
          preferred_patterns: ["At that moment"],
          forbidden_patterns: ["casual slang"],
          notes: ["narration stays bookish"],
        },
        notes: ["new evidence"],
      },
      {
        metadata: {
          source_chapters: ["ch_001", "ch_002"],
        },
        chapters: {
          ch_001: { referenceKind: "translator" },
          ch_002: { referenceKind: "translator" },
        },
      }
    );

    expect(merged.tone).toBe("dramatic");
    expect(merged.register).toBe("formal");
    expect(merged.honorific_policy).toEqual(expect.arrayContaining(["keep-sama", "keep-dono"]));
    expect(merged.preferred_patterns).toEqual(
      expect.arrayContaining(["Please rest assured", "I will handle it"])
    );
    expect(merged.narration).toEqual(
      expect.objectContaining({
        tone: "literary",
        register: "written",
      })
    );
    expect(merged.narration.preferred_patterns).toEqual(
      expect.arrayContaining(["At that moment"])
    );
    expect(merged.forbidden_patterns).toEqual(expect.arrayContaining(["slang"]));
    expect(merged.notes).toEqual(
      expect.arrayContaining([
        "existing",
        "new evidence",
        "chapter_coverage:2",
        "reference_kind_support:{\"translator\":2}",
      ])
    );
  });

  test("style example merge de-duplicates repeated examples", () => {
    const merged = mergeStyleExampleEntries(
      [
        {
          type: "dialogue",
          pageName: "001.jpg",
          nodeId: "n1",
          chapterId: "ch_001",
          translation: "Please rest assured.",
          reason: "formal reassurance",
        },
      ],
      [
        {
          type: "dialogue",
          pageName: "001.jpg",
          nodeId: "n1",
          chapterId: "ch_001",
          translation: "Please rest assured.",
          reason: "duplicate",
        },
        {
          type: "dialogue",
          pageName: "002.jpg",
          nodeId: "n4",
          chapterId: "ch_002",
          translation: "I will handle it.",
          reason: "decisive line",
        },
      ]
    );

    expect(merged).toHaveLength(2);
    expect(merged[0].type).toBe("dialogue");
    expect(merged[0].translation).toBe("Please rest assured.");
    expect(merged[1].translation).toBe("I will handle it.");
  });

  test("narration evidence merges into narration style memory", () => {
    const merged = mergeNarrationEvidence(
      {
        tone: "measured",
        register: "formal",
        honorific_policy: [],
        punctuation_policy: [],
        preferred_patterns: [],
        forbidden_patterns: [],
        narration: {
          tone: "neutral",
          register: "written",
          preferred_patterns: ["In the distance"],
          forbidden_patterns: [],
          notes: ["existing narration note"],
        },
        notes: [],
      },
      [
        {
          tone: "literary",
          register: "written",
          preferred_patterns: ["At that moment"],
          forbidden_patterns: ["casual slang"],
          notes: ["Narration remains bookish."],
          confidence: 0.81,
        },
      ],
      "ch_001"
    );

    expect(merged.narration.tone).toBe("neutral");
    expect(merged.narration.register).toBe("written");
    expect(merged.narration.preferred_patterns).toEqual(
      expect.arrayContaining(["In the distance", "At that moment"])
    );
    expect(merged.narration.forbidden_patterns).toEqual(
      expect.arrayContaining(["casual slang"])
    );
    expect(merged.narration.notes).toEqual(
      expect.arrayContaining([
        "existing narration note",
        "Narration remains bookish.",
        "narration_evidence_chapter:ch_001",
      ])
    );
  });

  test("character speech evidence merges into character memory", () => {
    const merged = mergeCharacterSpeechEvidence(
      [
        {
          name: "Alice",
          aliases: [],
          title_forms: [],
          speech_style: ["polite"],
          sentence_ending_patterns: ["desu"],
          addressing_patterns: [],
          example_lines: [],
          notes: ["existing"],
          confidence: 0.7,
        },
      ],
      [
        {
          name: "Alice",
          speech_style: ["reassuring"],
          sentence_ending_patterns: ["desu/masu"],
          addressing_patterns: ["Captain"],
          example_lines: [
            {
              pageName: "001.jpg",
              nodeId: "n1",
              translation: "Please rest assured.",
            },
          ],
          notes: ["repeated reassurance line"],
          confidence: 0.86,
        },
      ],
      "ch_001"
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].speech_style).toEqual(expect.arrayContaining(["polite", "reassuring"]));
    expect(merged[0].sentence_ending_patterns).toEqual(
      expect.arrayContaining(["desu", "desu/masu"])
    );
    expect(merged[0].addressing_patterns).toEqual(expect.arrayContaining(["Captain"]));
    expect(merged[0].example_lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          translation: "Please rest assured.",
        }),
      ])
    );
    expect(merged[0].notes).toEqual(
      expect.arrayContaining(["existing", "repeated reassurance line"])
    );
  });

  test("writes a v2 knowledge base file with AO enrichment", async () => {
    const knowledgeBasePath = createTempFilePath("knowledge.json");
    const reportPath = createTempFilePath("extract_report.json");

    const module = new KnowledgeModule(
      {
        getScene: jest.fn().mockResolvedValue({
          scene: {
            project: { name: "translate_20260521" },
            pages: {
              page1: {
                name: "001.jpg",
                nodes: {
                  n1: {
                    kind: {
                      text: {
                        text: "alice",
                        translation: "Alice activates Mana Circuit",
                      },
                    },
                  },
                  n2: {
                    kind: {
                      text: {
                        text: "alice_2",
                        translation: "Alice guards Mana Circuit",
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      },
      {
        runKnowledgeEnrichment: jest.fn().mockResolvedValue({
          enrichmentMode: "ao",
          translationPairs: 2,
          characters: 1,
          terminology: 1,
          styleExamples: 0,
          terminologyEntries: [
            {
              term: "Mana Circuit",
              translation: "Mana Circuit",
              category: "worldbuilding",
              notes: "AO candidate",
              confidence: 0.91,
              examples: [],
            },
          ],
          characterEntries: [
            {
              name: "Alice",
              aliases: [],
              speech_style: ["polite"],
              first_seen_chapter: "ch_001",
              example_lines: [],
              confidence: 0.88,
            },
          ],
          styleExampleEntries: [
            {
              type: "dialogue",
              pageName: "001.jpg",
              nodeId: "n1",
              chapterId: "ch_001",
              translation: "Please rest assured.",
              reason: "formal reassurance",
            },
            {
              type: "narration",
              pageName: "002.jpg",
              nodeId: "n9",
              chapterId: "ch_001",
              translation: "At that moment, the storm closed in.",
              reason: "bookish narration cadence",
            },
          ],
          characterSpeechEvidence: [
            {
              name: "Alice",
              speech_style: ["reassuring"],
              sentence_ending_patterns: ["desu/masu"],
              addressing_patterns: ["Captain"],
              example_lines: [
                {
                  pageName: "001.jpg",
                  nodeId: "n1",
                  translation: "Please rest assured.",
                },
              ],
              notes: ["repeated reassurance line"],
              confidence: 0.86,
            },
          ],
          narrationEvidence: [
            {
              tone: "literary",
              register: "written",
              preferred_patterns: ["At that moment"],
              forbidden_patterns: ["casual slang"],
              example_lines: [
                {
                  pageName: "002.jpg",
                  nodeId: "n9",
                  translation: "At that moment, the storm closed in.",
                },
              ],
              notes: ["Narration remains bookish and descriptive."],
              confidence: 0.81,
            },
          ],
          styleProfile: {
            tone: "dramatic",
            register: "formal",
            honorific_policy: [],
            punctuation_policy: [],
            preferred_patterns: [],
            forbidden_patterns: [],
            narration: {
              tone: "literary",
              register: "written",
              preferred_patterns: ["At that moment"],
              forbidden_patterns: ["casual slang"],
              notes: ["narration stays bookish"],
            },
            notes: [],
          },
          notes: "AO enrichment complete",
        }),
      }
    );

    const result = await module.run({
      baseUrl: "http://127.0.0.1:9999",
      mangaId: "phantom_fantasy",
      mangaLabel: "Phantom Fantasy",
      chapterId: "ch_001",
      knowledgeBasePath,
      reportPath,
      learningEvidenceSnapshotPath: createLearningEvidencePath("ch_001", [
        { id: "n1", nodeId: "n1", pageName: "001.jpg", original: "alice", translation: "Alice activates Mana Circuit" },
        { id: "n2", nodeId: "n2", pageName: "001.jpg", original: "alice_2", translation: "Alice guards Mana Circuit" },
      ]),
    });

    const knowledgeBase = JSON.parse(fs.readFileSync(knowledgeBasePath, "utf-8"));
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    expect(knowledgeBase.metadata.schema_version).toBe("2.0");
    expect(knowledgeBase.metadata.manga_id).toBe("phantom_fantasy");
    expect(knowledgeBase.metadata.chapter_ids).toContain("ch_001");
    expect(knowledgeBase.translation_pairs).toHaveLength(2);
    expect(knowledgeBase.terminology).toEqual(
      expect.arrayContaining([expect.objectContaining({ term: "Mana Circuit" })])
    );
    expect(knowledgeBase.characters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Alice" })])
    );
    expect(knowledgeBase.characters[0].speech_style).toEqual(
      expect.arrayContaining(["polite", "reassuring"])
    );
    expect(knowledgeBase.characters[0].sentence_ending_patterns).toEqual(
      expect.arrayContaining(["desu/masu"])
    );
    expect(knowledgeBase.style_profile.narration).toEqual(
      expect.objectContaining({
        tone: "literary",
        register: "written",
      })
    );
    expect(knowledgeBase.style_examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dialogue" }),
        expect.objectContaining({ type: "narration" }),
      ])
    );
    expect(knowledgeBase.style_profile.narration.notes).toEqual(
      expect.arrayContaining([
        "Narration remains bookish and descriptive.",
        "narration_evidence_chapter:ch_001",
      ])
    );
    expect(knowledgeBase.terminology[0].evidence).toEqual(
      expect.objectContaining({
        mention_count: expect.any(Number),
        score: expect.any(Number),
      })
    );
    expect(knowledgeBase.characters[0].status).toBeTruthy();
    expect(report.enrichmentMode).toBe("ao");
    expect(result.mangaId).toBe("phantom_fantasy");
    expect(result.output).toBe(knowledgeBasePath);
  });

  test("removes the prior self-learning contribution before relearning a chapter", () => {
    const knowledge = normalizeExistingKnowledgeBase({
      metadata: { chapter_ids: ["ch_001", "ch_002"] },
      translation_pairs: [
        { original: "a", translation: "old", chapterId: "ch_001", pageName: "1", nodeId: "1" },
        { original: "b", translation: "keep", chapterId: "ch_002", pageName: "2", nodeId: "2" },
      ],
      terminology: [{
        term: "a",
        translation: "old",
        source: "self",
        examples: [{ translation: "old", chapterId: "ch_001" }],
        evidence: { mention_count: 1, chapter_ids: ["ch_001"], source_counts: { self: 1, reference: 0 } },
      }],
      characters: [],
      style_examples: [
        { type: "dialogue", translation: "old", chapterId: "ch_001" },
        { type: "dialogue", translation: "keep", chapterId: "ch_002" },
      ],
    });

    removeChapterLearningEvidence(knowledge, "ch_001");

    expect(knowledge.translation_pairs).toHaveLength(1);
    expect(knowledge.translation_pairs[0].chapterId).toBe("ch_002");
    expect(knowledge.style_examples).toHaveLength(1);
    expect(knowledge.terminology).toHaveLength(0);
  });

  test("preserves protected chapter evidence during self-learning replacement", () => {
    const protectedEntry = {
      term: "a",
      translation: "locked",
      source: "manual",
      locked: true,
      examples: [{ translation: "locked", chapterId: "ch_001" }],
      evidence: { mention_count: 1, chapter_ids: ["ch_001"], source_counts: { self: 0, reference: 1 } },
    };
    const knowledge = normalizeExistingKnowledgeBase({
      metadata: { chapter_ids: ["ch_001"] },
      terminology: [protectedEntry],
    });

    removeChapterLearningEvidence(knowledge, "ch_001");

    expect(knowledge.terminology).toHaveLength(1);
    expect(knowledge.terminology[0].evidence.chapter_ids).toEqual(["ch_001"]);
    expect(knowledge.terminology[0].translation).toBe("locked");
  });

  test("terminology evidence score grows as more chapters confirm the same canonical term", async () => {
    const knowledgeBasePath = createTempFilePath("knowledge_growth.json");
    const reportPath = createTempFilePath("extract_growth_report.json");

    const client = {
      getScene: jest
        .fn()
        .mockResolvedValueOnce({
          scene: {
            project: { name: "translate_growth" },
            pages: {
              page1: {
                name: "001.jpg",
                nodes: {
                  n1: {
                    kind: {
                      text: {
                        text: "a",
                        translation: "Mana Circuit is unstable",
                      },
                    },
                  },
                },
              },
            },
          },
        })
        .mockResolvedValueOnce({
          scene: {
            project: { name: "translate_growth" },
            pages: {
              page2: {
                name: "002.jpg",
                nodes: {
                  n2: {
                    kind: {
                      text: {
                        text: "b",
                        translation: "Protect the Mana Circuit now",
                      },
                    },
                  },
                },
              },
            },
          },
        }),
    };

    const aoTaskRunner = {
      runKnowledgeEnrichment: jest
        .fn()
        .mockResolvedValueOnce({
          enrichmentMode: "ao",
          translationPairs: 1,
          characters: 0,
          terminology: 1,
          styleExamples: 0,
          terminologyEntries: [
            {
              term: "Mana Circuit",
              translation: "Mana Circuit",
              category: "worldbuilding",
              confidence: 0.71,
              examples: [
                {
                  pageName: "001.jpg",
                  nodeId: "n1",
                  translation: "Mana Circuit is unstable",
                  chapterId: "ch_001",
                },
              ],
            },
          ],
          characterEntries: [],
          styleProfile: null,
          styleExampleEntries: [],
          notes: "chapter one",
        })
        .mockResolvedValueOnce({
          enrichmentMode: "ao",
          translationPairs: 2,
          characters: 0,
          terminology: 1,
          styleExamples: 0,
          terminologyEntries: [
            {
              term: "Mana Circuit",
              translation: "Mana Circuit",
              category: "worldbuilding",
              confidence: 0.83,
              examples: [
                {
                  pageName: "002.jpg",
                  nodeId: "n2",
                  translation: "Protect the Mana Circuit now",
                  chapterId: "ch_002",
                },
              ],
            },
          ],
          characterEntries: [],
          styleProfile: null,
          styleExampleEntries: [],
          notes: "chapter two",
        }),
    };

    const module = new KnowledgeModule(client, aoTaskRunner);

    await module.run({
      baseUrl: "http://127.0.0.1:9999",
      mangaId: "phantom_fantasy",
      chapterId: "ch_001",
      knowledgeBasePath,
      reportPath,
      learningEvidenceSnapshotPath: createLearningEvidencePath("ch_001", [
        { id: "n1", nodeId: "n1", pageName: "001.jpg", original: "a", translation: "Mana Circuit is unstable" },
      ]),
    });
    const firstKnowledge = JSON.parse(fs.readFileSync(knowledgeBasePath, "utf-8"));
    const firstTerm = firstKnowledge.terminology.find((entry) => entry.translation === "Mana Circuit");

    await module.run({
      baseUrl: "http://127.0.0.1:9999",
      mangaId: "phantom_fantasy",
      chapterId: "ch_002",
      knowledgeBasePath,
      reportPath,
      learningEvidenceSnapshotPath: createLearningEvidencePath("ch_002", [
        { id: "n2", nodeId: "n2", pageName: "002.jpg", original: "b", translation: "Protect the Mana Circuit now" },
      ]),
    });
    const secondKnowledge = JSON.parse(fs.readFileSync(knowledgeBasePath, "utf-8"));
    const secondTerm = secondKnowledge.terminology.find((entry) => entry.translation === "Mana Circuit");

    expect(secondTerm.evidence.score).toBeGreaterThan(firstTerm.evidence.score);
    expect(secondTerm.evidence.chapter_ids).toEqual(
      expect.arrayContaining(["ch_001", "ch_002"])
    );
    expect(secondTerm.confidence).toBeGreaterThan(firstTerm.confidence);
    expect(secondTerm.status).toBe("stable");
  });
});
