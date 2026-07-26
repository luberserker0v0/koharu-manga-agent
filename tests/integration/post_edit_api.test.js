const fs = require("fs");
const os = require("os");
const path = require("path");

const { JobStore } = require("../../backend/src/storage/job_store");
const { JobManager } = require("../../backend/src/job_manager");
const { createApiServer } = require("../../backend/src/http/api_server");
const { PostEditWorkspaceModule } = require("../../backend/src/modules/post_edit_workspace");

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-api-"));
  return path.join(dir, "jobs.sqlite");
}

function createTempOutputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-api-output-"));
}

function createScene() {
  return {
    scene: {
      pages: {
        page_001: {
          name: "001.png",
          nodes: {
            node_001: {
              transform: { x: 5, y: 10, width: 20, height: 8 },
              kind: {
                text: {
                  text: "hello",
                  translation: "translated hello",
                },
              },
            },
          },
        },
      },
    },
  };
}

describe("post edit api", () => {
  let api = null;

  afterEach(async () => {
    if (api) {
      await api.close();
      api = null;
    }
  });

  test("GET /post-edit returns an empty state when no document exists", async () => {
    const store = new JobStore(createTempDbPath());
    store.createJob({
      id: "translation-job-empty",
      type: "translation",
      status: "succeeded",
      stage: "succeeded",
      payload: {},
    });

    const jobManager = new JobManager({
      store,
      engine: {
        runTranslationJob: jest.fn(),
        runPostEditExportJob: jest.fn(),
      },
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });

    api = createApiServer({
      jobManager,
      postEditWorkspaceModule: new PostEditWorkspaceModule({
        root: fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-empty-")),
      }),
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    const address = api.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const loadRes = await fetch(`${baseUrl}/post-edit/translation-job-empty`);
    expect(loadRes.status).toBe(200);
    const loaded = await loadRes.json();
    expect(loaded).toEqual({
      exists: false,
      editedScene: null,
    });
  });

  test("GET/POST /post-edit and POST /jobs/post-edit-export work with completed translation jobs", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "post-edit-workspaces-"));
    const postEditWorkspaceModule = new PostEditWorkspaceModule({ root: workspaceRoot });
    const documentPath = postEditWorkspaceModule.createDocumentFromScene({
      jobId: "translation-job-001",
      sourcePreflightId: "preflight-001",
      mangaId: "manga_001",
      translatorId: "translator_001",
      chapterId: "chapter_001",
      scene: createScene(),
    });

    const store = new JobStore(createTempDbPath());
    store.createJob({
      id: "translation-job-001",
      type: "translation",
      status: "succeeded",
      stage: "succeeded",
      payload: {
        mangaId: "manga_001",
        mangaLabel: "Demo Manga",
        sourcePreflightId: "preflight-001",
      },
    });
    store.updateJob({
      id: "translation-job-001",
      status: "succeeded",
      stage: "succeeded",
      result: {
        projectName: "translate_demo",
        postEditDocumentPath: documentPath,
        artifact: { path: "C:\\translated\\demo.zip", format: "rendered", size: 3 },
      },
      error: null,
    });

    const engine = {
      runTranslationJob: jest.fn(),
      runPostEditExportJob: jest.fn().mockResolvedValue({
        sourceJobId: "translation-job-001",
        editedScenePath: documentPath,
        artifact: { path: "C:\\translated\\post-edit-demo.zip", format: "rendered", size: 5 },
      }),
    };

    const jobManager = new JobManager({
      store,
      engine,
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      resolvedConfig: { workflow: { qualityCheck: { enabled: true } } },
    });

    api = createApiServer({
      jobManager,
      postEditWorkspaceModule,
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    const address = api.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const loadRes = await fetch(`${baseUrl}/post-edit/translation-job-001`);
    expect(loadRes.status).toBe(200);
    const loaded = await loadRes.json();
    expect(loaded.exists).toBe(true);
    expect(loaded.editedScene.pageOrder).toEqual(["page_001"]);
    expect(loaded.editedScene.sourcePreflightId).toBe("preflight-001");

    loaded.editedScene.pages.page_001.nodes.node_001.editedTranslation = "edited hello";
    const saveRes = await fetch(`${baseUrl}/post-edit/translation-job-001`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(loaded.editedScene),
    });
    expect(saveRes.status).toBe(200);
    const saved = await saveRes.json();
    expect(saved.editedScene.pages.page_001.nodes.node_001.editedTranslation).toBe("edited hello");

    const exportRes = await fetch(`${baseUrl}/jobs/post-edit-export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceJobId: "translation-job-001",
        outputDir: createTempOutputDir(),
      }),
    });
    expect(exportRes.status).toBe(202);
    const created = await exportRes.json();
    expect(created.type).toBe("post_edit_export");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engine.runPostEditExportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJobId: "translation-job-001",
        outputDir: expect.any(String),
      }),
      expect.objectContaining({
        jobId: created.id,
      })
    );
  });
});
