const { createApiServer } = require("../../backend/src/http/api_server");
const { resolveTranslationModePolicy } = require("../../backend/src/modules/translation_modes");

function snapshotFor(mode) {
  return {
    schemaVersion: 2,
    translationMode: mode,
    policy: resolveTranslationModePolicy(mode, true),
    mangaId: "manga_test",
    translatorId: "translator_test",
    chapterId: "chapter_1",
    chapterMapping: {
      sourceChapterId: "source_chapter_1",
      sourceChapterTitle: "1",
      method: "chapter_number",
    },
    layers: { reference: {}, local: {} },
    effective: { glossary: [], sourceIdentity: [], story: null, style: null, localKnowledge: null },
    usage: { glossaryEntries: 2, styleChapters: 1 },
    readiness: { reference: true, local: true },
    warnings: [],
    revisions: [],
    fingerprint: "preview-memory-fingerprint",
  };
}

describe("translation preview API", () => {
  let api;
  let baseUrl;
  const qualityModule = {
    runPreview: jest.fn().mockResolvedValue({
      originalTranslations: [{ nodeId: "node_1", original: "星間国家", currentTranslation: "星際國" }],
      revisedTranslations: [{ nodeId: "node_1", original: "星間国家", translation: "星際國家" }],
      optimizedTranslations: [{ nodeId: "node_1", revisedTranslation: "星際國家" }],
      projection: { candidates: [{ nodeId: "node_1", reasons: [{ type: "canonical_term" }] }] },
      finalVerification: { nodes: [{ nodeId: "node_1", finalDisposition: "revised_verified" }] },
      appliedTranslationCount: 1,
    }),
  };
  const knowledgeModule = {
    preview: jest.fn().mockResolvedValue({
      persisted: false,
      delta: { translationPairs: 1, terminologyEntries: 1 },
    }),
  };

  beforeEach(async () => {
    qualityModule.runPreview.mockClear();
    knowledgeModule.preview.mockClear();
    api = createApiServer({
      jobManager: { engine: { qualityModule, knowledgeModule } },
      sourcePreflightModule: null,
      translationMemoryComposer: ({ translationMode = "learning_style" }) => snapshotFor(translationMode),
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    const address = api.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  test("learning style applies quality before a non-persistent knowledge preview", async () => {
    const response = await fetch(`${baseUrl}/translation/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "learning_style",
        mangaId: "manga_test",
        translatorId: "translator_test",
        chapterId: "chapter_1",
        translations: [{ nodeId: "node_1", original: "星間国家", currentTranslation: "星際國" }],
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.contextUsage.fingerprint).toBe("preview-memory-fingerprint");
    expect(payload.revisedTranslations[0].translation).toBe("星際國家");
    expect(payload.knowledgeDelta.persisted).toBe(false);
    expect(qualityModule.runPreview).toHaveBeenCalledTimes(1);
    expect(knowledgeModule.preview).toHaveBeenCalledWith(expect.objectContaining({
      learningEvidence: expect.objectContaining({
        evidence: expect.arrayContaining([
          expect.objectContaining({ translation: "星際國家" }),
        ]),
      }),
    }));
  });

  test("quick mode skips both AO stages and all memory usage", async () => {
    const response = await fetch(`${baseUrl}/translation/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translationMode: "quick",
        translations: [{ nodeId: "node_1", original: "原文", currentTranslation: "譯文" }],
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.qualityReport.skipped).toBe(true);
    expect(payload.knowledgeDelta.skipped).toBe(true);
    expect(qualityModule.runPreview).not.toHaveBeenCalled();
    expect(knowledgeModule.preview).not.toHaveBeenCalled();
  });
});
