const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");
const { RegionSnapshotRepository } = require(
  "../../backend/src/domains/translation/text_regions/region_snapshot_repository",
);
const { TextRegionReviewService } = require(
  "../../backend/src/domains/translation/text_regions/text_region_review_service",
);
const { prepareVisionImage, reviewOutputTokenLimit } = require(
  "../../backend/src/domains/translation/text_regions/text_region_review_service",
);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function scene() {
  return { scene: { pages: { page: {
    name: "001.png", width: 1000, height: 1500,
    nodes: { node: { transform: { x: 10, y: 20, width: 100, height: 80 },
      kind: { text: { text: "old", translation: "舊" } } } },
  } } } };
}

function registerActiveRevision(store) {
  store.registerTranslationPageRevisions([{
    revisionId: "revision-1", rootJobId: "job-1", parentJobId: null, jobId: "job-1",
    sourcePreflightId: "preflight-1", sourceImageId: "source-1", sourceOrderIndex: 0,
    jobImageId: "output-1", jobImageIndex: 0, fileName: "001.png", mediaType: "image/png",
    size: 1, revisionNumber: 1,
  }], { initializeActive: true });
}

describe("TextRegionReviewService", () => {
  let root;
  let store;
  let repository;
  let reviewer;
  let service;
  let page;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "text-region-review-"));
    const imagePath = path.join(root, "source.png");
    fs.writeFileSync(imagePath, Buffer.from(PNG, "base64"));
    store = new JobStore(path.join(root, "jobs.sqlite"));
    store.createJob({ id: "job-1", type: "translation", status: "succeeded", stage: "succeeded",
      payload: { sourceLanguage: ["ja"] } });
    registerActiveRevision(store);
    repository = new RegionSnapshotRepository();
    const snapshotPath = path.join(root, "snapshot.json");
    const snapshot = repository.persist(snapshotPath, {
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "source.png" }], scene: scene(),
    });
    page = snapshot.pages[0];
    store.addArtifact("job-1", "text_region_snapshot", snapshotPath, {});
    reviewer = { review: jest.fn(async () => ({
      text: '{"count":1,"texts":["corrected"]}',
    })) };
    service = new TextRegionReviewService({
      store, snapshotRepository: repository,
      sourcePreflightModule: { resolvePreviewImage: jest.fn(() => ({ path: imagePath })) },
      reviewer, getConfig: () => ({ translation: {
        defaultTarget: { modelId: "vision-model" },
        lmStudio: { baseUrl: "http://127.0.0.1:25555" },
        generationOptions: { temperature: 0.7, reasoning: "off" },
      } }),
    });
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("reviews the retained source image using the minimal model contract", async () => {
    const request = { sourceImageId: "source-1", baseRegionSetRevisionId: page.regionSetRevisionId };
    await expect(service.review("job-1", request)).resolves.toEqual({
      count: 1, regions: [{ box: [10, 20, 100, 80], text: "corrected" }],
    });
    expect(reviewer.review).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "vision-model", mediaType: "image/png", temperature: 0, reasoning: "off",
      expectedRegionCount: 1,
    }));
  });

  test("converts retained WebP images to PNG before vision inference", async () => {
    const webp = Buffer.from("RIFF0000WEBP");
    const png = Buffer.from(PNG, "base64");
    const convertWebp = jest.fn(() => png);

    await expect(prepareVisionImage(webp, "webp", convertWebp)).resolves.toEqual({
      imageBuffer: png,
      mediaType: "image/png",
    });
    expect(convertWebp).toHaveBeenCalledWith(webp);
  });

  test("bounds semantic review output tokens to the current OCR size", () => {
    expect(reviewOutputTokenLimit({ regions: [{ sourceText: "short" }] })).toBe(512);
    expect(reviewOutputTokenLimit({ regions: [{ sourceText: "x".repeat(5000) }] })).toBe(4096);
  });

  test("converts a reviewed list into the existing correction request", () => {
    const request = {
      sourceImageId: "source-1", baseRegionSetRevisionId: page.regionSetRevisionId,
      count: 1, regions: [{ box: [10, 20, 100, 80], text: "corrected" }],
    };
    expect(service.prepareCorrection("job-1", request).pages[0].operations).toEqual([
      { type: "update", regionId: page.regions[0].id, sourceText: "corrected" },
    ]);
  });

  test("rejects AI review attempts to change region geometry", () => {
    expect(() => service.prepareCorrection("job-1", {
      sourceImageId: "source-1", baseRegionSetRevisionId: page.regionSetRevisionId,
      count: 1, regions: [{ box: [12, 22, 100, 80], text: "corrected" }],
    })).toThrow(expect.objectContaining({ code: "text_region_review_shape_mismatch" }));
  });

  test("rejects a stale region snapshot before calling the model", async () => {
    await expect(service.review("job-1", {
      sourceImageId: "source-1", baseRegionSetRevisionId: "stale",
    })).rejects.toMatchObject({ code: "stale_region_set_revision", statusCode: 409 });
    expect(reviewer.review).not.toHaveBeenCalled();
  });
});
