const { buildRegionSnapshot } = require(
  "../../backend/src/domains/translation/text_regions/region_snapshot_repository",
);
const { buildTextRegionCorrectionOps } = require(
  "../../backend/src/domains/translation/text_regions/text_region_patch_ops",
);

function scene(pageId, nodeId, text, transform) {
  return { scene: { pages: { [pageId]: {
    name: "001.png", width: 1000, height: 1500,
    nodes: { [nodeId]: { transform, kind: { text: { text } } } },
  } } } };
}

describe("text-region correction Koharu patches", () => {
  test("maps rebuilt OCR nodes and emits Koharu updateNode operations", () => {
    const original = scene(
      "old_page", "old_node", "inter\ngalactic",
      { x: 10, y: 20, width: 300, height: 80, rotationDeg: 1 },
    );
    original.scene.pages.old_page.nodes.uncorrected_node = {
      transform: { x: 500, y: 600, width: 120, height: 50 },
      kind: { text: { text: "unrelated" } },
    };
    const snapshot = buildRegionSnapshot({
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "001.png" }], scene: original,
    });
    const corrections = { pages: [{
      sourceImageId: "source-1",
      regions: [{
        regionId: snapshot.pages[0].regions[0].id,
        sourceText: "intergalactic",
        geometry: { x: 12, y: 22, width: 320, height: 90, rotation: 2 },
      }],
    }] };
    const rebuilt = scene(
      "rebuilt_page", "rebuilt_node", "inter\ngalactic",
      { x: 11, y: 21, width: 300, height: 80, rotationDeg: 1 },
    );

    expect(buildTextRegionCorrectionOps(snapshot, corrections, rebuilt)).toEqual([{
      updateNode: {
        page: "rebuilt_page",
        id: "rebuilt_node",
        patch: {
          data: { text: { text: "intergalactic" } },
          transform: { x: 12, y: 22, width: 320, height: 90, rotationDeg: 2 },
        },
      },
    }]);
  });

  test("fails safely when a rebuilt scene page cannot be matched", () => {
    const original = scene(
      "old_page", "old_node", "hello", { x: 10, y: 20, width: 30, height: 40 },
    );
    const snapshot = buildRegionSnapshot({
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "001.png" }], scene: original,
    });
    const corrections = { pages: [{ sourceImageId: "source-1", regions: [{
      regionId: snapshot.pages[0].regions[0].id, sourceText: "hello!",
    }] }] };
    const rebuilt = { scene: { pages: { other_page: { name: "999.png", nodes: {} } } } };

    expect(() => buildTextRegionCorrectionOps(snapshot, corrections, rebuilt))
      .toThrow(expect.objectContaining({ code: "text_region_mapping_failed", statusCode: 409 }));
  });
});
