const fs = require("fs");
const path = require("path");

const { paths } = require("../../backend/src/config");
const { createZipBuffer } = require("../../backend/src/integrations/ao/assets/ao_assets");
const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");
const { TranslatedImageService } = require("../../backend/src/domains/translation/exports/translated_image_service");
const { PageRevisionService } = require("../../backend/src/domains/translation/revisions/page_revision_service");

describe("PageRevisionService", () => {
  let root;
  let store;
  let service;
  let sourceImages;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(paths.workspaceRoot, "page-revisions-"));
    store = new JobStore(path.join(root, "jobs.sqlite"));
    sourceImages = [0, 1, 2].map((orderIndex) => ({
      id: `source-${orderIndex + 1}`,
      orderIndex,
      fileName: `page-${orderIndex + 1}.png`,
    }));
    const translatedImageService = new TranslatedImageService({ root: path.join(root, "cache") });
    service = new PageRevisionService({
      store,
      translatedImageService,
      sourcePreflightModule: {
        get: jest.fn().mockReturnValue({ preflightId: "preflight-1", images: sourceImages }),
      },
    });
  });

  afterEach(() => {
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createSucceededJob({ id, payload, imageNames, createdAt, status = "succeeded" }) {
    const zipPath = path.join(root, `${id}.zip`);
    fs.writeFileSync(zipPath, createZipBuffer(imageNames.map((name) => ({
      name,
      content: Buffer.from(name),
    }))));
    store.createJob({ id, type: "translation", status, stage: status, payload });
    store.db.prepare(`UPDATE jobs SET created_at = ?, updated_at = ? WHERE id = ?`)
      .run(createdAt, createdAt, id);
    store.addArtifact(id, "export", zipPath, {});
  }

  test("preserves inactive selective revisions and supports activation and rollback", async () => {
    createSucceededJob({
      id: "root-job",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        sourcePreflightId: "preflight-1",
        translationTarget: { providerId: "openai", modelId: "gpt-5" },
        sourceLanguage: "ja",
        targetLanguage: "zh-TW",
      },
      imageNames: ["page-1.png", "page-2.png", "page-3.png"],
    });
    createSucceededJob({
      id: "selective-job",
      createdAt: "2026-01-02T00:00:00.000Z",
      payload: {
        sourcePreflightId: "preflight-1",
        sourceImageIds: ["source-2", "source-3"],
        instructions: "Keep Koharu untranslated.",
        revision: {
          rootJobId: "root-job",
          parentJobId: "root-job",
          reason: "selective_retranslation",
          sourceImageIds: ["source-2", "source-3"],
        },
      },
      imageNames: ["page-2-new.png", "page-3-new.png"],
    });

    const initial = await service.list("root-job");
    expect(initial.pages.map((page) => page.revisions.length)).toEqual([1, 2, 2]);
    expect(initial.pages[1].revisions.map((revision) => revision.revisionNumber)).toEqual([1, 2]);
    expect(initial.pages[1].revisions[1]).toEqual(expect.objectContaining({
      active: false,
      jobId: "selective-job",
      instructions: "Keep Koharu untranslated.",
    }));

    const page2New = initial.pages[1].revisions[1];
    const page3New = initial.pages[2].revisions[1];
    const activated = await service.activate("root-job", [
      { sourceImageId: "source-2", revisionId: page2New.revisionId },
      { sourceImageId: "source-3", revisionId: page3New.revisionId },
    ]);
    expect(activated.pages[1].activeRevisionId).toBe(page2New.revisionId);
    expect(activated.pages[2].activeRevisionId).toBe(page3New.revisionId);
    expect(activated.pages[0].revisions[0].active).toBe(true);

    const originalPage2 = initial.pages[1].revisions[0];
    const rolledBack = await service.activate("root-job", [
      { sourceImageId: "source-2", revisionId: originalPage2.revisionId },
    ]);
    expect(rolledBack.pages[1].activeRevisionId).toBe(originalPage2.revisionId);
    expect(rolledBack.pages[2].activeRevisionId).toBe(page3New.revisionId);
  });

  test("rejects cross-page activation atomically", async () => {
    createSucceededJob({
      id: "root-job",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { sourcePreflightId: "preflight-1" },
      imageNames: ["page-1.png", "page-2.png", "page-3.png"],
    });
    const before = await service.list("root-job");
    const page1Revision = before.pages[0].revisions[0].revisionId;
    const page2Revision = before.pages[1].revisions[0].revisionId;

    await expect(service.activate("root-job", [
      { sourceImageId: "source-1", revisionId: page1Revision },
      { sourceImageId: "source-3", revisionId: page2Revision },
    ])).rejects.toMatchObject({ statusCode: 409, code: "page_revision_mismatch" });

    const after = await service.list("root-job");
    expect(after.pages.map((page) => page.activeRevisionId))
      .toEqual(before.pages.map((page) => page.activeRevisionId));
  });

  test("does not create revisions for failed, blocked, or canceled selective Jobs", async () => {
    createSucceededJob({
      id: "root-job",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { sourcePreflightId: "preflight-1" },
      imageNames: ["page-1.png", "page-2.png", "page-3.png"],
    });
    for (const [index, status] of ["failed", "blocked", "canceled"].entries()) {
      createSucceededJob({
        id: `${status}-job`,
        status,
        createdAt: `2026-01-0${index + 2}T00:00:00.000Z`,
        payload: {
          sourcePreflightId: "preflight-1",
          sourceImageIds: ["source-2"],
          revision: {
            rootJobId: "root-job",
            parentJobId: "root-job",
            reason: "selective_retranslation",
            sourceImageIds: ["source-2"],
          },
        },
        imageNames: [`page-2-${status}.png`],
      });
    }

    const manifest = await service.list("root-job");
    expect(manifest.pages.map((page) => page.revisions.length)).toEqual([1, 1, 1]);
  });
});
