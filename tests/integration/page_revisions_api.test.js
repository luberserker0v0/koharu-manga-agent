const fs = require("fs");
const path = require("path");

const { paths } = require("../../backend/src/config");
const { createZipBuffer } = require("../../backend/src/integrations/ao/assets/ao_assets");
const { JobStore } = require("../../backend/src/domains/jobs/persistence/job_store");
const { JobManager } = require("../../backend/src/domains/jobs/job_manager");
const { TranslatedImageService } = require("../../backend/src/domains/translation/exports/translated_image_service");
const { PageRevisionService } = require("../../backend/src/domains/translation/revisions/page_revision_service");
const { createApiServer } = require("../../backend/src/http/server/api_server");

describe("selective retranslation and page revision API", () => {
  let root;
  let api;
  let baseUrl;
  let manager;
  let store;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(paths.workspaceRoot, "page-revisions-api-"));
    store = new JobStore(path.join(root, "jobs.sqlite"));
    const sourceImages = [0, 1, 2, 3].map((orderIndex) => ({
      id: `source-${orderIndex + 1}`,
      orderIndex,
      fileName: `page-${orderIndex + 1}.png`,
      orderedPath: path.join(root, `source-${orderIndex + 1}.png`),
    }));
    for (const image of sourceImages) fs.writeFileSync(image.orderedPath, image.id);
    const manifest = {
      preflightId: "preflight-1",
      sourceFolder: root,
      ready: true,
      summary: { acceptedCount: 4, convertedCount: 0 },
      images: sourceImages,
    };
    const sourcePreflightModule = {
      get: jest.fn().mockReturnValue(manifest),
      resolveSourceSelection: jest.fn((preflightId, selectedIds = null) => {
        const selected = selectedIds
          ? sourceImages.filter((image) => new Set(selectedIds).has(image.id))
          : sourceImages;
        if (selectedIds && selected.length !== new Set(selectedIds).size) {
          throw Object.assign(new Error("Unknown source image."), { statusCode: 422 });
        }
        return { manifest, images: selected };
      }),
    };
    const rootZip = path.join(root, "root.zip");
    const selectiveZip = path.join(root, "selective.zip");
    fs.writeFileSync(rootZip, createZipBuffer(sourceImages.map((image) => ({
      name: image.fileName,
      content: Buffer.from(`original-${image.id}`),
    }))));
    fs.writeFileSync(selectiveZip, createZipBuffer([
      { name: "page-2-new.png", content: Buffer.from("new-source-2") },
      { name: "page-4-new.png", content: Buffer.from("new-source-4") },
    ]));

    const client = {
      getTranslationCatalog: jest.fn().mockResolvedValue({
        providers: [{
          id: "openai",
          status: "ready",
          models: [{ target: { providerId: "openai", modelId: "gpt-5" }, languages: ["zh-TW"] }],
        }],
      }),
    };
    const engine = {
      sourcePreflightModule,
      projectLifecycle: { client },
      runTranslationJob: jest.fn().mockImplementation(async (payload) => ({
        artifact: { path: selectiveZip, size: fs.statSync(selectiveZip).size, format: "rendered" },
        translationMode: payload.translationMode,
        translationTarget: payload.translationTarget,
        publication: null,
      })),
    };
    const translatedImageService = new TranslatedImageService({ root: path.join(root, "cache") });
    manager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: {
        api: { baseUrl: "http://127.0.0.1:4000" },
        defaults: { targetLanguage: "zh-TW" },
        translation: { defaultTarget: { providerId: "openai", modelId: "gpt-5" } },
        workflow: { qualityCheck: { enabled: true } },
      },
    });
    const pageRevisionService = new PageRevisionService({
      store,
      translatedImageService,
      sourcePreflightModule,
    });
    manager.pageRevisionService = pageRevisionService;

    store.createJob({
      id: "root-job",
      type: "translation",
      status: "succeeded",
      stage: "succeeded",
      payload: {
        mangaId: "manga-1",
        translatorId: "translator-1",
        chapterId: "chapter-1",
        sourcePreflightId: "preflight-1",
        translationMode: "quick",
        translationTarget: { providerId: "openai", modelId: "gpt-5" },
        sourceLanguage: "ja",
        targetLanguage: "zh-TW",
      },
    });
    store.addArtifact("root-job", "export", rootZip, {});
    await pageRevisionService.synchronizeJob("root-job");

    api = createApiServer({
      jobManager: manager,
      sourcePreflightModule,
      translatedImageService,
      pageRevisionService,
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    baseUrl = `http://127.0.0.1:${api.server.address().port}/api/v1`;
  });

  afterEach(async () => {
    await api.close();
    store.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("retranslates two selected pages and explicitly activates only their new revisions", async () => {
    const createResponse = await fetch(`${baseUrl}/jobs/root-job/retranslations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceImageIds: ["source-4", "source-2"],
        instructions: "Keep Koharu untranslated.",
      }),
    });
    expect(createResponse.status).toBe(202);
    const created = await createResponse.json();
    expect(created.status).toBe("queued");
    expect(created.revision).toEqual(expect.objectContaining({
      rootJobId: "root-job",
      parentJobId: "root-job",
      sourceImageIds: ["source-2", "source-4"],
    }));

    let completed;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await fetch(`${baseUrl}/jobs/${created.id}`);
      completed = await response.json();
      if (["succeeded", "failed"].includes(completed.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(completed.status).toBe("succeeded");

    const translated = await (await fetch(`${baseUrl}/jobs/${created.id}/translated-images`)).json();
    expect(translated.images.map((image) => image.sourceImageId)).toEqual(["source-2", "source-4"]);
    expect(translated.images.every((image) => image.active === false)).toBe(true);

    const before = await (await fetch(`${baseUrl}/jobs/root-job/page-revisions`)).json();
    expect(before.pages.map((page) => page.revisions.length)).toEqual([1, 2, 1, 2]);
    const page2New = before.pages[1].revisions[1];
    const page4New = before.pages[3].revisions[1];
    const activateResponse = await fetch(`${baseUrl}/jobs/root-job/page-revisions/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selections: [
          { sourceImageId: "source-2", revisionId: page2New.revisionId },
          { sourceImageId: "source-4", revisionId: page4New.revisionId },
        ],
      }),
    });
    expect(activateResponse.status).toBe(200);
    const activated = await activateResponse.json();
    expect(activated.pages[0].revisions[0].active).toBe(true);
    expect(activated.pages[1].activeRevisionId).toBe(page2New.revisionId);
    expect(activated.pages[2].revisions[0].active).toBe(true);
    expect(activated.pages[3].activeRevisionId).toBe(page4New.revisionId);
  });
});
