const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");
const { createApiServer } = require("../../backend/src/http/server/api_server");
const { RegionSnapshotRepository } = require("../../backend/src/domains/translation/text_regions/region_snapshot_repository");
const { TextRegionCorrectionService } = require(
  "../../backend/src/domains/translation/text_regions/text_region_correction_service",
);
const { TextRegionQueryService } = require("../../backend/src/domains/translation/text_regions/text_region_query_service");

function createScene() {
  return { scene: { pages: { internal_page: {
    name: "001.png", width: 1000, height: 1500,
    nodes: { internal_node: {
      transform: { x: 10, y: 20, width: 30, height: 40 },
      kind: { text: { text: "wrapped\nword", translation: "換行詞" } },
    } },
  } } } };
}

function registerRevision(store) {
  store.registerTranslationPageRevisions([{
    revisionId: "page_revision_1", rootJobId: "job-1", parentJobId: null,
    jobId: "job-1", sourcePreflightId: "preflight-1", sourceImageId: "source-1",
    sourceOrderIndex: 0, jobImageId: "output-1", jobImageIndex: 0,
    fileName: "001.png", mediaType: "image/png", size: 10, revisionNumber: 1,
  }], { initializeActive: true });
}

describe("text-region inspection API", () => {
  let root;
  let store;
  let api;
  let baseUrl;
  let jobManager;
  let textRegionReviewService;
  let ocrTextReviewService;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "text-regions-api-"));
    store = new JobStore(path.join(root, "jobs.sqlite"));
    store.createJob({ id: "job-1", type: "translation", status: "succeeded", stage: "succeeded", payload: {} });
    registerRevision(store);
    const repository = new RegionSnapshotRepository();
    const snapshotPath = path.join(root, "text_region_snapshot.json");
    const snapshot = repository.persist(snapshotPath, {
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "source.png" }], scene: createScene(),
    });
    store.addArtifact("job-1", "text_region_snapshot", snapshotPath, {});
    const textRegionQueryService = new TextRegionQueryService({
      store, snapshotRepository: repository, pageRevisionService: { synchronizeJob: jest.fn() },
    });
    const correctionService = new TextRegionCorrectionService({ store, snapshotRepository: repository });
    textRegionReviewService = {
      review: jest.fn(async () => ({ count: 1, regions: [{ box: [10, 20, 30, 40], text: "reviewed" }] })),
      prepareCorrection: jest.fn(() => ({ pages: [{
        sourceImageId: "source-1", baseRegionSetRevisionId: snapshot.pages[0].regionSetRevisionId,
        operations: [{ type: "delete", regionId: snapshot.pages[0].regions[0].id }],
      }] })),
    };
    ocrTextReviewService = {
      prepare: jest.fn((request) => ({ ...request, sourceLanguages: request.sourceLanguages || [] })),
    };
    jobManager = { createTextRegionCorrectionJob: jest.fn(async (sourceJobId, request) => {
      const prepared = correctionService.prepare(store.getJob(sourceJobId), request);
      return { id: "correction-job", type: "translation", status: "queued", stage: "queued",
        parentJobId: sourceJobId, payload: prepared.payload, createdAt: "2026-10-27T00:00:00.000Z" };
    }), createOcrTextReviewJob: jest.fn((payload) => ({
      id: "ocr-review-job", type: "ocr_text_review", status: "queued", stage: "queued",
      payload, result: null, error: null, createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    })) };
    api = createApiServer({
      jobManager, textRegionQueryService, textRegionReviewService, ocrTextReviewService,
      host: "127.0.0.1", port: 0,
    });
    await api.listen();
    baseUrl = `http://127.0.0.1:${api.server.address().port}/api/v1`;
  });

  afterEach(async () => {
    await api.close();
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("returns sanitized regions bound to source and page revisions", async () => {
    const response = await fetch(`${baseUrl}/jobs/job-1/text-regions`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pages[0]).toEqual(expect.objectContaining({
      sourceImageId: "source-1", pageRevisionId: "page_revision_1",
      coordinateSpace: expect.objectContaining({ width: 1000, height: 1500 }),
    }));
    expect(body.pages[0].regions[0]).toEqual(expect.objectContaining({
      sourceText: "wrapped\nword", translatedText: "換行詞",
      geometry: { x: 10, y: 20, width: 30, height: 40, rotation: 0 },
    }));
    expect(JSON.stringify(body)).not.toContain("internal_page");
    expect(JSON.stringify(body)).not.toContain("internal_node");
    expect(JSON.stringify(body)).not.toContain(root);
  });

  test("returns an actionable error when a legacy Job has no snapshot", async () => {
    store.createJob({ id: "legacy-job", type: "translation", status: "succeeded", stage: "succeeded", payload: {} });
    const response = await fetch(`${baseUrl}/jobs/legacy-job/text-regions`);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      code: "text_region_snapshot_unavailable",
    }));
  });

  test("creates a queued correction Job through the backend boundary", async () => {
    const page = (await (await fetch(`${baseUrl}/jobs/job-1/text-regions`)).json()).pages[0];
    const request = { pages: [{
      sourceImageId: page.sourceImageId,
      baseRegionSetRevisionId: page.regionSetRevisionId,
      regions: [{ regionId: page.regions[0].id, sourceText: "wrapped word" }],
    }] };

    const response = await fetch(`${baseUrl}/jobs/job-1/text-region-corrections`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      id: "correction-job", parentJobId: "job-1", status: "queued",
    }));
    expect(jobManager.createTextRegionCorrectionJob).toHaveBeenCalledWith("job-1", request);
  });

  test("accepts a mixed create and delete batch through the REST boundary", async () => {
    const page = (await (await fetch(`${baseUrl}/jobs/job-1/text-regions`)).json()).pages[0];
    const request = { pages: [{
      sourceImageId: page.sourceImageId,
      baseRegionSetRevisionId: page.regionSetRevisionId,
      operations: [
        { type: "delete", regionId: page.regions[0].id },
        { type: "create", clientOperationId: "create-1", sourceText: "missing text",
          geometry: { x: 100, y: 200, width: 300, height: 80, rotation: 0 } },
      ],
    }] };

    const response = await fetch(`${baseUrl}/jobs/job-1/text-region-corrections`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.payload.regionCorrections.pages[0].operations).toEqual(request.pages[0].operations);
  });

  test("returns the minimal AI review result", async () => {
    const request = { sourceImageId: "source-1", baseRegionSetRevisionId: "region-set" };
    const response = await fetch(`${baseUrl}/jobs/job-1/text-region-reviews`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      count: 1, regions: [{ box: [10, 20, 30, 40], text: "reviewed" }],
    });
    expect(textRegionReviewService.review).toHaveBeenCalledWith("job-1", request);
  });

  test("queues crop-based OCR text review without accepting geometry", async () => {
    const request = {
      uploadId: "upload-1", sourceLanguages: ["en"],
      items: [{ clientItemId: "region-1", fileName: "ocr_001.png", ocrText: "inter galactic" }],
    };
    const response = await fetch(`${baseUrl}/jobs/ocr-text-review`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      id: "ocr-review-job", type: "ocr_text_review", status: "queued",
    }));
    expect(ocrTextReviewService.prepare).toHaveBeenCalledWith(request);
    expect(jobManager.createOcrTextReviewJob).toHaveBeenCalledWith({ ...request, sourceLanguages: ["en"] });
  });

  test("applies a reviewed result through the existing correction Job", async () => {
    const request = { sourceImageId: "source-1", baseRegionSetRevisionId: "region-set",
      count: 0, regions: [] };
    const response = await fetch(`${baseUrl}/jobs/job-1/text-region-reviews/apply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });

    expect(response.status).toBe(202);
    expect(textRegionReviewService.prepareCorrection).toHaveBeenCalledWith("job-1", request);
    expect(jobManager.createTextRegionCorrectionJob).toHaveBeenCalledWith("job-1",
      textRegionReviewService.prepareCorrection.mock.results[0].value);
  });
});
