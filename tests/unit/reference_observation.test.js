const fs = require("fs");
const os = require("os");
const path = require("path");

describe("reference chapter observation", () => {
  test("caches one full chapter observation by extraction and contract fingerprint", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chapter-observation-"));
    const manifestsDir = path.join(tempRoot, "references", "manifests");
    const extractedDir = path.join(tempRoot, "references", "extracted", "ref_1");
    fs.mkdirSync(manifestsDir, { recursive: true });
    fs.mkdirSync(extractedDir, { recursive: true });
    fs.writeFileSync(path.join(manifestsDir, "ref_1.json"), JSON.stringify({
      id: "ref_1",
      label: "第1話",
      source: "fixture",
      referenceKind: "source",
      language: "ja-JP",
      pageCount: 1,
      imageDir: "references/images/ref_1",
      extractedDir: "references/extracted/ref_1",
      enabled: true,
    }));
    fs.writeFileSync(path.join(extractedDir, "texts.json"), JSON.stringify({
      pages: [{ pageName: "001.jpg", texts: [{ nodeId: "n1", text: "天城" }] }],
    }));

    jest.resetModules();
    jest.doMock("../../backend/src/config", () => ({
      PROJECT_ROOT: tempRoot,
      paths: {
        referenceImages: path.join(tempRoot, "references", "images"),
        referenceExtracted: path.join(tempRoot, "references", "extracted"),
        referenceComparisons: path.join(tempRoot, "references", "comparisons"),
        referenceManifests: manifestsDir,
      },
    }));
    jest.doMock("../../backend/src/modules/knowledge_paths", () => ({
      listKnowledgeSeries: () => [],
    }));
    const runChapterObservation = jest.fn(async (input) => ({
      nodes: input.pages.flatMap((page) => page.nodes.map((node) => ({
        pageName: page.pageName,
        pageId: page.pageName,
        nodeId: node.nodeId,
        readingOrder: node.readingOrder,
        textFingerprint: "fingerprint",
        textRole: "dialogue",
        speakerType: "uncertain",
        speakerRef: null,
        styleChannel: "character_voice",
        roleConfidence: 0.9,
        speakerConfidence: 0.2,
        reason: "fixture",
      }))),
      mentions: [{
        mentionId: "m1",
        evidenceNodeKeys: ["001.jpg::n1"],
        surfaceForm: "天城",
        entityType: "character",
        confidence: 0.95,
        reason: "fixture",
      }],
      storyCues: [],
      notes: [],
      coverage: { expected: 1, observed: 1, uncertain: 0, invalid: 0 },
    }));
    const runner = { settings: { model: "test/model" }, runChapterObservation };
    const { ensureChapterObservation } = require("../../backend/src/modules/reference_observation");
    const first = await ensureChapterObservation({
      aoTaskRunner: runner,
      referenceSetId: "ref_1",
      chapterId: "chapter_1",
      chapterTitle: "第1話",
    });
    const second = await ensureChapterObservation({
      aoTaskRunner: runner,
      referenceSetId: "ref_1",
      chapterId: "chapter_1",
      chapterTitle: "第1話",
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(runChapterObservation).toHaveBeenCalledTimes(1);
    expect(second.observation.mentions[0].surfaceForm).toBe("天城");
    jest.dontMock("../../backend/src/config");
    jest.dontMock("../../backend/src/modules/knowledge_paths");
  });
});
