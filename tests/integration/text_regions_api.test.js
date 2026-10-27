const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");
const { createApiServer } = require("../../backend/src/http/server/api_server");
const { RegionSnapshotRepository } = require("../../backend/src/domains/translation/text_regions/region_snapshot_repository");
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

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "text-regions-api-"));
    store = new JobStore(path.join(root, "jobs.sqlite"));
    store.createJob({ id: "job-1", type: "translation", status: "succeeded", stage: "succeeded", payload: {} });
    registerRevision(store);
    const repository = new RegionSnapshotRepository();
    const snapshotPath = path.join(root, "text_region_snapshot.json");
    repository.persist(snapshotPath, {
      jobId: "job-1", rootJobId: "job-1", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "source.png" }], scene: createScene(),
    });
    store.addArtifact("job-1", "text_region_snapshot", snapshotPath, {});
    const textRegionQueryService = new TextRegionQueryService({
      store, snapshotRepository: repository, pageRevisionService: { synchronizeJob: jest.fn() },
    });
    jobManager = { createTextRegionCorrectionJob: jest.fn() };
    api = createApiServer({ jobManager, textRegionQueryService, host: "127.0.0.1", port: 0 });
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
    jobManager.createTextRegionCorrectionJob.mockResolvedValue({
      id: "correction-job", type: "translation", status: "queued", stage: "queued",
      parentJobId: "job-1", payload: {}, createdAt: "2026-10-27T00:00:00.000Z",
    });
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
});
