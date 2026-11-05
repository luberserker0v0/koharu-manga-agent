const { buildRegionSnapshot } = require(
  "../../backend/src/domains/translation/text_regions/region_snapshot_repository",
);
const { buildTextRegionCorrectionOps, finalizeTextRegionOperationOutcome } = require(
  "../../backend/src/integrations/koharu/scene/text_region_correction_adapter",
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
      operations: [{
        type: "update",
        regionId: snapshot.pages[0].regions[0].id,
        sourceText: "intergalactic",
        geometry: { x: 12, y: 22, width: 320, height: 90, rotation: 2 },
      }],
    }] };
    const rebuilt = scene(
      "rebuilt_page", "rebuilt_node", "inter\ngalactic",
      { x: 11, y: 21, width: 300, height: 80, rotationDeg: 1 },
    );

    const ids = ["reconciled-1", "reconciled-2"];
    const result = buildTextRegionCorrectionOps(snapshot, corrections, rebuilt, {
      createNodeId: () => ids.shift(),
    });
    expect(result.ops[0]).toEqual(expect.objectContaining({
      removeNode: expect.objectContaining({ page: "rebuilt_page", id: "rebuilt_node" }),
    }));
    expect(result.ops.slice(1)).toEqual([
      { addNode: { page: "rebuilt_page", at: 0, node: {
        id: "reconciled-1", visible: true,
        kind: { text: { text: "intergalactic" } },
        transform: { x: 12, y: 22, width: 320, height: 90, rotationDeg: 2 },
      } } },
      { addNode: { page: "rebuilt_page", at: 1, node: {
        id: "reconciled-2", visible: true,
        kind: { text: { text: "unrelated" } },
        transform: { x: 500, y: 600, width: 120, height: 50, rotationDeg: 0 },
      } } },
    ]);
  });

  test("fails safely when a rebuilt scene page cannot be matched", () => {
    const original = scene(
      "old_page", "old_node", "hello", { x: 10, y: 20, width: 30, height: 40 },
    );
    const snapshot = buildRegionSnapshot({
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "001.png" }], scene: original,
    });
    const corrections = { pages: [{ sourceImageId: "source-1", operations: [{
      type: "update", regionId: snapshot.pages[0].regions[0].id, sourceText: "hello!",
    }] }] };
    const rebuilt = { scene: { pages: { other_page: { name: "999.png", nodes: {} } } } };

    expect(() => buildTextRegionCorrectionOps(snapshot, corrections, rebuilt))
      .toThrow(expect.objectContaining({ code: "text_region_mapping_failed", statusCode: 409 }));
  });

  test("emits removeNode and addNode operations for a mixed correction", () => {
    const original = scene("old_page", "old_node", "false positive",
      { x: 10, y: 20, width: 100, height: 40 });
    const snapshot = buildRegionSnapshot({
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "001.png" }], scene: original,
    });
    const corrections = { pages: [{ sourceImageId: "source-1", operations: [
      { type: "delete", regionId: snapshot.pages[0].regions[0].id },
      { type: "create", clientOperationId: "create-1", sourceText: "missing text",
        geometry: { x: 200, y: 300, width: 120, height: 50, rotation: 0 } },
    ] }] };
    const rebuilt = scene("rebuilt_page", "rebuilt_node", "false positive",
      { x: 10, y: 20, width: 100, height: 40 });
    const result = buildTextRegionCorrectionOps(snapshot, corrections, rebuilt, {
      createNodeId: () => "00000000-0000-0000-0000-000000000123",
    });

    expect(result.ops[0].removeNode).toEqual(expect.objectContaining({
      page: "rebuilt_page", id: "rebuilt_node", prev_index: 0,
      prev_node: expect.objectContaining({ id: "rebuilt_node", visible: true }),
    }));
    expect(result.ops[1].addNode).toEqual(expect.objectContaining({
      page: "rebuilt_page", at: 0,
      node: expect.objectContaining({
        id: "00000000-0000-0000-0000-000000000123",
        kind: { text: { text: "missing text" } },
      }),
    }));
    expect(result.outcome).toEqual(expect.objectContaining({
      created: [expect.objectContaining({ clientOperationId: "create-1" })],
      deleted: [{ sourceImageId: "source-1", regionId: snapshot.pages[0].regions[0].id }],
    }));
    expect(finalizeTextRegionOperationOutcome(result.outcome, { pages: [{
      sourceImageId: "source-1", regions: [{
        id: "text_region_created", internalNodeId: "00000000-0000-0000-0000-000000000123",
      }],
    }] }).created).toEqual([{
      sourceImageId: "source-1", clientOperationId: "create-1", regionId: "text_region_created",
    }]);
  });

  test("discards fresh OCR drift and false positives while retaining snapshot geometry", () => {
    const original = scene("old_page", "old_node", "hello",
      { x: 10, y: 20, width: 100, height: 40 });
    const snapshot = buildRegionSnapshot({
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "001.png" }], scene: original,
    });
    const corrections = { pages: [{ sourceImageId: "source-1", operations: [{
      type: "update", regionId: snapshot.pages[0].regions[0].id, sourceText: "hello corrected",
    }] }] };
    const rebuilt = scene("rebuilt_page", "drifted_node", "hello",
      { x: 700, y: 800, width: 250, height: 140 });
    rebuilt.scene.pages.rebuilt_page.nodes.false_positive = {
      transform: { x: 50, y: 60, width: 70, height: 80 },
      kind: { text: { text: "false positive" } },
    };

    const result = buildTextRegionCorrectionOps(snapshot, corrections, rebuilt, {
      createNodeId: () => "reconciled-node",
    });

    expect(result.ops.filter((operation) => operation.removeNode)).toHaveLength(2);
    expect(result.ops.filter((operation) => operation.addNode)).toEqual([{
      addNode: { page: "rebuilt_page", at: 0, node: {
        id: "reconciled-node", visible: true,
        kind: { text: { text: "hello corrected" } },
        transform: { x: 10, y: 20, width: 100, height: 40, rotationDeg: 0 },
      } },
    }]);
  });
});
