const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  RegionSnapshotRepository,
} = require("../../backend/src/domains/translation/text_regions/region_snapshot_repository");
const {
  TextRegionCorrectionService,
} = require("../../backend/src/domains/translation/text_regions/text_region_correction_service");

function scene() {
  return { scene: { pages: { page_1: {
    name: "001.png", width: 1000, height: 1500,
    nodes: { node_1: {
      transform: { x: 10, y: 20, width: 300, height: 80, rotationDeg: 1 },
      kind: { text: { text: "inter\ngalactic", translation: "星際" } },
    } },
  } } } };
}

describe("text-region correction validation", () => {
  let root;
  let sourceJob;
  let snapshot;
  let service;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "text-region-correction-"));
    const snapshotRepository = new RegionSnapshotRepository();
    const snapshotPath = path.join(root, "snapshot.json");
    snapshot = snapshotRepository.persist(snapshotPath, {
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "001.png" }], scene: scene(),
    });
    sourceJob = { id: "job-1", result: { regionSnapshotPath: snapshotPath } };
    service = new TextRegionCorrectionService({ store: {}, snapshotRepository });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function request(overrides = {}) {
    const page = snapshot.pages[0];
    return {
      pages: [{
        sourceImageId: page.sourceImageId,
        baseRegionSetRevisionId: page.regionSetRevisionId,
        regions: [{
          regionId: page.regions[0].id,
          sourceText: "intergalactic",
          geometry: { x: 12, y: 22, width: 320, height: 90, rotation: 2 },
        }],
        ...overrides,
      }],
    };
  }

  test("builds an immutable correction plan without changing OCR text", () => {
    const result = service.prepare(sourceJob, request());

    expect(result).toEqual(expect.objectContaining({
      reason: "text_region_correction",
      sourceImageIds: ["source-1"],
    }));
    expect(result.payload.regionCorrections.pages[0].regions[0]).toEqual({
      regionId: snapshot.pages[0].regions[0].id,
      sourceText: "intergalactic",
      geometry: { x: 12, y: 22, width: 320, height: 90, rotation: 2 },
    });
  });

  test("rejects a stale region-set revision", () => {
    expect(() => service.prepare(sourceJob, request({ baseRegionSetRevisionId: "region_set_stale" })))
      .toThrow(expect.objectContaining({ code: "stale_region_set_revision", statusCode: 409 }));
  });

  test("rejects geometry outside the source-image coordinate space", () => {
    const invalid = request();
    invalid.pages[0].regions[0].geometry.x = 900;
    expect(() => service.prepare(sourceJob, invalid))
      .toThrow(expect.objectContaining({ code: "invalid_region_geometry", statusCode: 422 }));
  });

  test("rejects an unknown region ID", () => {
    const invalid = request();
    invalid.pages[0].regions[0].regionId = "text_region_unknown";
    expect(() => service.prepare(sourceJob, invalid))
      .toThrow(expect.objectContaining({ code: "unknown_text_region", statusCode: 404 }));
  });

  test("rejects geometry edits when the snapshot has no reliable coordinate space", () => {
    snapshot.pages[0].coordinateSpace.width = null;
    fs.writeFileSync(sourceJob.result.regionSnapshotPath, JSON.stringify(snapshot));

    expect(() => service.prepare(sourceJob, request()))
      .toThrow(expect.objectContaining({ code: "text_region_coordinate_space_unavailable", statusCode: 409 }));
  });
});
