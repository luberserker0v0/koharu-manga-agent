const fs = require("fs");
const path = require("path");

const {
  confirmExtractionReview,
  getReviewDocument,
  initializeExtractionReview,
  saveOrderDraft,
  syncDraftFromScene,
} = require("../../backend/src/modules/reference_extraction_review");
const { referenceSetPaths } = require("../../backend/src/modules/reference_sets");

function textNode(text, x = 0, y = 0) {
  return {
    kind: { text: { text } },
    transform: { x, y, width: 100, height: 40 },
  };
}

function sceneWith(nodes, pageName = "001.png") {
  return {
    scene: {
      pages: {
        page_1: {
          name: pageName,
          nodes,
        },
      },
    },
  };
}

function rawTexts(referenceSetId, entries) {
  return {
    referenceSetId,
    source: "reference_extraction",
    pages: [{
      pageId: "page_1",
      pageName: "001.png",
      texts: entries.map(([nodeId, text], index) => ({
        nodeId,
        text,
        sourceText: text,
        translatedText: null,
        bbox: { x: 0, y: index * 50, width: 100, height: 40 },
      })),
    }],
  };
}

describe("reference extraction review", () => {
  const referenceSetId = `ref_review_${Date.now().toString(36)}`;
  const paths = referenceSetPaths(referenceSetId);

  beforeAll(() => {
    fs.mkdirSync(path.dirname(paths.manifestPath), { recursive: true });
    fs.mkdirSync(paths.extractedDir, { recursive: true });
    fs.mkdirSync(paths.imagesDir, { recursive: true });
    fs.writeFileSync(paths.manifestPath, JSON.stringify({
      id: referenceSetId,
      label: "Review fixture",
      source: "test",
      language: "ja-JP",
      referenceKind: "source",
      pageCount: 1,
      imageDir: paths.imagesDir,
      extractedDir: paths.extractedDir,
      enabled: true,
    }));
  });

  afterAll(() => {
    fs.rmSync(paths.extractedDir, { recursive: true, force: true });
    fs.rmSync(paths.imagesDir, { recursive: true, force: true });
    fs.rmSync(paths.manifestPath, { force: true });
  });

  test("keeps raw data immutable and promotes an explicitly ordered draft", () => {
    const rawScene = sceneWith({ first: textNode("first"), second: textNode("second", 0, 50) });
    const initialized = initializeExtractionReview({
      referenceSetId,
      projectId: "project_1",
      projectName: `reference_${referenceSetId}_test`,
      scene: rawScene,
      texts: rawTexts(referenceSetId, [["first", "first"], ["second", "second"]]),
    });
    expect(initialized.status).toBe("awaiting_review");
    expect(initialized.rawSummary.nodeCount).toBe(2);

    const editedScene = sceneWith({
      first: textNode("first edited"),
      third: textNode("third", 0, 100),
    });
    syncDraftFromScene(referenceSetId, editedScene);
    const editingMetadata = JSON.parse(fs.readFileSync(paths.reviewMetadataPath, "utf8"));
    editingMetadata.status = "awaiting_order_review";
    fs.writeFileSync(paths.reviewMetadataPath, JSON.stringify(editingMetadata));

    expect(() => saveOrderDraft(referenceSetId, [{
      pageId: "page_1",
      nodeIds: ["first", "first"],
    }])).toThrow(/every current text node exactly once|Duplicate node ID/);

    saveOrderDraft(referenceSetId, [{ pageId: "page_1", nodeIds: ["third", "first"] }]);
    const confirmed = confirmExtractionReview(referenceSetId);
    expect(confirmed.status).toBe("reviewed");
    expect(confirmed.reviewRevision).toBe(1);
    expect(confirmed.reviewDiff).toEqual({ added: 1, deleted: 1, changed: 1 });

    const canonical = JSON.parse(fs.readFileSync(paths.textsPath, "utf8"));
    expect(canonical.pages[0].texts.map((node) => node.nodeId)).toEqual(["third", "first"]);
    const rawRevision = path.join(paths.rawRevisionsDir, confirmed.rawRevisionId, "texts.json");
    expect(JSON.parse(fs.readFileSync(rawRevision, "utf8")).pages[0].texts.map((node) => node.nodeId))
      .toEqual(["first", "second"]);
    expect(fs.existsSync(path.join(paths.reviewRevisionsDir, "1", "metadata.json"))).toBe(true);
    expect(getReviewDocument(referenceSetId).status).toBe("reviewed");
  });

  test("rejects page contract changes and preserves revision numbering after re-extraction", () => {
    expect(() => syncDraftFromScene(referenceSetId, sceneWith({ first: textNode("first") }, "renamed.png")))
      .toThrow(/cannot add, delete, rename, or reorder/i);

    const nextScene = sceneWith({ next: textNode("next") });
    const next = initializeExtractionReview({
      referenceSetId,
      projectId: "project_2",
      projectName: `reference_${referenceSetId}_next`,
      scene: nextScene,
      texts: rawTexts(referenceSetId, [["next", "next"]]),
    });
    expect(next.status).toBe("awaiting_review");
    expect(next.reviewRevision).toBe(1);
    expect(fs.existsSync(path.join(paths.reviewRevisionsDir, "1", "metadata.json"))).toBe(true);
  });
});
