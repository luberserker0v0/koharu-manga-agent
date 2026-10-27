const { buildRegionSnapshot } = require("../../backend/src/domains/translation/text_regions/region_snapshot_repository");

function scene() {
  return {
    scene: {
      pages: {
        koharu_page_1: {
          name: "001.png",
          width: 1600,
          height: 2400,
          nodes: {
            koharu_node_1: {
              transform: { x: 618, y: 391, width: 244, height: 96, rotationDeg: 3 },
              kind: { text: { text: "inter\ngalactic", translation: "星際", confidence: 0.81 } },
            },
          },
        },
      },
    },
  };
}

describe("region snapshot repository", () => {
  test("builds an immutable, source-image-bound snapshot without normalizing OCR whitespace", () => {
    const snapshot = buildRegionSnapshot({
      jobId: "translation-job-1",
      rootJobId: "translation-job-1",
      sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-image-1", orderIndex: 0, fileName: "page.png" }],
      scene: scene(),
    });

    expect(snapshot.pages[0]).toEqual(expect.objectContaining({
      sourceImageId: "source-image-1",
      sourceOrderIndex: 0,
      internalPageId: "koharu_page_1",
      coordinateSpace: expect.objectContaining({ width: 1600, height: 2400, origin: "top_left" }),
    }));
    expect(snapshot.pages[0].regionSetRevisionId).toMatch(/^region_set_/);
    expect(snapshot.pages[0].regions[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^text_region_/),
      internalNodeId: "koharu_node_1",
      sourceText: "inter\ngalactic",
      translatedText: "星際",
      ocrConfidence: 0.81,
      geometry: { x: 618, y: 391, width: 244, height: 96, rotation: 3 },
    }));
  });

  test("rejects ambiguous scene-to-source page mappings", () => {
    expect(() => buildRegionSnapshot({
      jobId: "translation-job-1",
      rootJobId: "translation-job-1",
      sourcePreflightId: "preflight-1",
      sourceImages: [],
      scene: scene(),
    })).toThrow(expect.objectContaining({ code: "text_region_page_mapping_mismatch" }));
  });

  test("maps reordered Koharu pages by their uploaded preflight names", () => {
    const twoPages = scene();
    twoPages.scene.pages.koharu_page_2 = {
      name: "002.png", width: 1600, height: 2400, nodes: {},
    };
    twoPages.scene.pages = {
      koharu_page_2: twoPages.scene.pages.koharu_page_2,
      koharu_page_1: twoPages.scene.pages.koharu_page_1,
    };

    const snapshot = buildRegionSnapshot({
      jobId: "translation-job-1", rootJobId: "translation-job-1", sourcePreflightId: "preflight-1",
      sourceImages: [
        { id: "source-image-1", orderIndex: 0, fileName: "original-a.png", orderedName: "001.png" },
        { id: "source-image-2", orderIndex: 1, fileName: "original-b.png", orderedName: "002.png" },
      ],
      scene: twoPages,
    });

    expect(snapshot.pages.map((page) => [page.sourceImageId, page.pageName])).toEqual([
      ["source-image-1", "001.png"],
      ["source-image-2", "002.png"],
    ]);
  });
});
