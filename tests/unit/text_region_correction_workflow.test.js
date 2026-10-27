jest.mock("../../backend/src/domains/post_edit/export/post_edit_export", () => {
  const actual = jest.requireActual("../../backend/src/domains/post_edit/export/post_edit_export");
  return { ...actual, startPipeline: jest.fn() };
});

const {
  startPipeline,
} = require("../../backend/src/domains/post_edit/export/post_edit_export");
const {
  buildRegionSnapshot,
} = require("../../backend/src/domains/translation/text_regions/region_snapshot_repository");
const { WorkflowEngine } = require("../../backend/src/domains/jobs/workflows/workflow_engine");

function scene(pageId, nodeId) {
  return { scene: { pages: { [pageId]: {
    name: "001.png", width: 1000, height: 1500,
    nodes: { [nodeId]: {
      transform: { x: 10, y: 20, width: 300, height: 80 },
      kind: { text: { text: "inter\ngalactic" } },
    } },
  } } } };
}

describe("text-region correction workflow", () => {
  test("runs OCR, applies corrections, then translates and renders", async () => {
    const snapshot = buildRegionSnapshot({
      jobId: "source-job", rootJobId: "source-job", sourcePreflightId: "preflight-1",
      sourceImages: [{ id: "source-1", orderIndex: 0, fileName: "001.png" }],
      scene: scene("old_page", "old_node"),
    });
    const corrections = { sourceJobId: "source-job", pages: [{
      sourceImageId: "source-1", regions: [{
        regionId: snapshot.pages[0].regions[0].id,
        sourceText: "intergalactic",
        geometry: { x: 12, y: 22, width: 320, height: 90, rotation: 2 },
      }],
    }] };
    const client = {
      getScene: jest.fn().mockResolvedValue(scene("rebuilt_page", "rebuilt_node")),
      applyHistoryBatch: jest.fn().mockResolvedValue({ epoch: 3 }),
    };
    const pipelineMonitor = { run: jest.fn()
      .mockResolvedValueOnce({ summary: { finalStatus: "completed" } })
      .mockResolvedValueOnce({ summary: { finalStatus: "completed", totalPages: 1 } }) };
    const projectSetup = { prepare: jest.fn().mockResolvedValue({
      projectName: "correction-project", operationId: null,
      engines: { detect: "detect", ocr: "ocr", translate: "translate", clean: "lama", render: "render" },
      steps: [], translationTarget: { kind: "provider", providerId: "openai", modelId: "model" },
    }) };
    const engine = new WorkflowEngine({
      projectSetup, pipelineMonitor, projectLifecycle: { client },
      jobStore: { getJob: jest.fn().mockReturnValue({ id: "source-job" }) },
      regionSnapshotRepository: { loadForJob: jest.fn().mockReturnValue(snapshot) },
    });
    const hooks = { jobId: "correction-job", setStage: jest.fn(), emit: jest.fn(), isCanceled: jest.fn() };
    const ctx = {
      hooks, payload: { regionCorrections: corrections }, baseUrl: "http://127.0.0.1:4000",
      targetLanguage: "zh-TW", sourceImagePaths: ["001.png"], requestedTranslationTarget: null,
      generationOptions: null, lmStudioBaseUrl: null, translationProxy: null, translationMode: "quick",
      machineTranslationRequested: false, machineTranslationPostEdit: false,
      systemPrompt: "translate faithfully", systemPromptSource: "translation_memory",
    };
    startPipeline
      .mockResolvedValueOnce({ operationId: "ocr-operation" })
      .mockResolvedValueOnce({ operationId: "translation-operation" });

    await engine._setupTextRegionCorrectionProjectAndPipeline(ctx);

    expect(startPipeline).toHaveBeenNthCalledWith(
      1, ["detect", "ocr"], "zh-TW", "http://127.0.0.1:4000",
    );
    expect(startPipeline).toHaveBeenNthCalledWith(
      2, ["translate", "lama", "render"], "zh-TW", "http://127.0.0.1:4000", "translate faithfully",
    );
    expect(client.applyHistoryBatch).toHaveBeenCalledWith(expect.objectContaining({
      ops: [expect.objectContaining({ updateNode: expect.objectContaining({
        page: "rebuilt_page", id: "rebuilt_node",
      }) })],
    }));
    expect(pipelineMonitor.run).toHaveBeenCalledTimes(2);
    expect(ctx.setup.operationId).toBe("translation-operation");
    expect(ctx.pipelinePlan).toEqual(["translate", "clean", "render"]);
  });
});
