const fs = require("fs");
const path = require("path");

const {
  initializeExtractionReview,
  saveReviewMetadata,
} = require("../../backend/src/modules/reference_extraction_review");
const { ReferenceExtractionReviewService } = require("../../backend/src/modules/reference_extraction_review_service");
const { referenceSetPaths } = require("../../backend/src/modules/reference_sets");

describe("ReferenceExtractionReviewService", () => {
  const referenceSetId = `ref_review_service_${Date.now().toString(36)}`;
  const paths = referenceSetPaths(referenceSetId);
  const scene = {
    scene: {
      pages: {
        p1: {
          name: "001.png",
          nodes: {
            n1: {
              kind: { text: { text: "hello" } },
              transform: { x: 1, y: 2, width: 30, height: 40 },
            },
          },
        },
      },
    },
  };
  const texts = {
    referenceSetId,
    source: "reference_extraction",
    pages: [{
      pageId: "p1",
      pageName: "001.png",
      texts: [{
        nodeId: "n1",
        text: "hello",
        sourceText: "hello",
        translatedText: null,
        bbox: { x: 1, y: 2, width: 30, height: 40 },
      }],
    }],
  };

  beforeAll(() => {
    fs.mkdirSync(path.dirname(paths.manifestPath), { recursive: true });
    fs.mkdirSync(paths.imagesDir, { recursive: true });
    fs.writeFileSync(paths.manifestPath, JSON.stringify({
      id: referenceSetId,
      label: "Review service fixture",
      source: "test",
      language: "ja-JP",
      referenceKind: "source",
      pageCount: 1,
      imageDir: paths.imagesDir,
      extractedDir: paths.extractedDir,
      enabled: true,
    }));
    initializeExtractionReview({
      referenceSetId,
      projectId: "project_1",
      projectName: `reference_${referenceSetId}_fixture`,
      scene,
      texts,
    });
  });

  afterAll(() => {
    fs.rmSync(paths.extractedDir, { recursive: true, force: true });
    fs.rmSync(paths.imagesDir, { recursive: true, force: true });
    fs.rmSync(paths.manifestPath, { force: true });
  });

  test("owns Koharu until editing finishes and returns complete review documents", async () => {
    let lease = null;
    const jobManager = {
      acquireKoharuReviewLease: jest.fn((value) => {
        if (lease) {
          const error = new Error("busy");
          error.statusCode = 409;
          throw error;
        }
        lease = value;
      }),
      releaseKoharuReviewLease: jest.fn((sessionId) => {
        if (lease?.sessionId === sessionId) lease = null;
      }),
    };
    const client = {
      listProjects: jest.fn(async () => [{
        id: "project_1",
        name: `reference_${referenceSetId}_fixture`,
      }]),
      openProject: jest.fn(async () => undefined),
      getScene: jest.fn(async () => scene),
      closeCurrentProject: jest.fn(async () => undefined),
    };
    const service = new ReferenceExtractionReviewService({
      client,
      jobManager,
      baseUrl: "http://127.0.0.1:4000",
    });

    const started = await service.start(referenceSetId);
    expect(started.status).toBe("editing");
    expect(started.pages).toHaveLength(1);
    expect(started.editorUrl).toBe("http://127.0.0.1:4000/");
    await expect(service.start(referenceSetId)).rejects.toMatchObject({ statusCode: 409 });

    const synced = await service.sync(referenceSetId, started.sessionId);
    expect(synced.pages[0].texts[0].nodeId).toBe("n1");
    const finished = await service.finish(referenceSetId, started.sessionId);
    expect(finished.status).toBe("awaiting_order_review");
    expect(jobManager.releaseKoharuReviewLease).toHaveBeenCalledWith(started.sessionId);

    const ordered = service.saveOrder(referenceSetId, [{ pageId: "p1", nodeIds: ["n1"] }]);
    expect(ordered.orderDraft).toEqual([{ pageId: "p1", nodeIds: ["n1"] }]);
    const confirmed = service.confirm(referenceSetId);
    expect(confirmed.status).toBe("reviewed");
    expect(confirmed.pages[0].texts[0].sourceText).toBe("hello");

    const reopened = await service.start(referenceSetId);
    await service.sync(referenceSetId, reopened.sessionId);
    const cancelled = await service.cancel(referenceSetId, reopened.sessionId);
    expect(cancelled.status).toBe("reviewed");
    expect(cancelled.draftSummary).toBeNull();
  });

  test("recovers the newest legacy Koharu project by reference prefix", async () => {
    const metadata = initializeExtractionReview({
      referenceSetId,
      projectId: null,
      projectName: null,
      scene,
      texts,
    });
    saveReviewMetadata(referenceSetId, { ...metadata, projectId: null, projectName: null });
    const service = new ReferenceExtractionReviewService({
      client: {
        listProjects: jest.fn(async () => [
          { id: "older", name: `reference_${referenceSetId}_old`, updatedAtMs: 1 },
          { id: "newer", name: `reference_${referenceSetId}_new`, updatedAtMs: 2 },
        ]),
      },
      jobManager: {},
      baseUrl: "http://127.0.0.1:4000",
    });
    await expect(service.resolveProject(referenceSetId, metadata)).resolves.toMatchObject({ id: "newer" });
  });
});
