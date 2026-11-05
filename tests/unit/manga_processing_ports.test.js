const {
  assertMangaProcessingPorts,
} = require("../../backend/src/domains/manga_processing/manga_processing_ports");
const {
  KoharuMangaProcessingAdapter,
} = require("../../backend/src/integrations/koharu/koharu_manga_processing_adapter");
const {
  assertMangaProcessingRuntimePort,
} = require("../../backend/src/domains/manga_processing/manga_processing_runtime_port");

describe("manga processing ports", () => {
  test("rejects an adapter that lacks a requested capability", () => {
    expect(() => assertMangaProcessingPorts({}, ["scene"])).toThrow("requires getScene");
  });

  test("rejects a runtime implementation that lacks lifecycle operations", () => {
    expect(() => assertMangaProcessingRuntimePort({ inspect() {} })).toThrow("requires inspectPaths");
  });

  test("maps neutral translation updates only inside the Koharu adapter", async () => {
    const applyHistoryBatch = jest.fn().mockResolvedValue({ epoch: 2 });
    const adapter = new KoharuMangaProcessingAdapter({ applyHistoryBatch });
    await adapter.applyTranslationUpdates({
      updates: [{ pageId: "page-1", nodeId: "node-1", translation: "譯文" }],
      label: "quality", baseUrl: "http://koharu:4000",
    });
    expect(applyHistoryBatch).toHaveBeenCalledWith({
      ops: [{ updateNode: { page: "page-1", id: "node-1",
        patch: { data: { text: { translation: "譯文" } } } } }],
      label: "quality", baseUrl: "http://koharu:4000",
    });
  });
});
