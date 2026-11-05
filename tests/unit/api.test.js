const { KoharuClient } = require("../../backend/src/integrations/koharu/client/koharu_client");

describe("Koharu HTTP client", () => {
  let originalFetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("startPipeline owns URL and JSON serialization", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ operationId: "operation-1" }),
    });
    const client = new KoharuClient("http://127.0.0.1:4000/");

    await expect(client.startPipeline({
      steps: ["detect", "ocr"], sourceLanguages: ["en", "ja"],
    })).resolves.toBe("operation-1");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/v1/pipelines",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ steps: ["detect", "ocr"] }),
      }),
    );
  });

  test("setTranslationTarget forwards generation options", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ status: "ready" })),
    });
    const client = new KoharuClient("http://127.0.0.1:4000");
    await client.setTranslationTarget({ kind: "local", modelId: "model", providerId: null }, null,
      { temperature: 0.7 });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/v1/llm/current",
      expect.objectContaining({ body: expect.stringContaining('"temperature":0.7') }),
    );
  });

  test("openEventStream owns the upstream SSE request", async () => {
    const body = { getReader: jest.fn() };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, body });
    const client = new KoharuClient("http://127.0.0.1:4000");
    const signal = new AbortController().signal;
    await expect(client.openEventStream(null, signal)).resolves.toEqual(expect.objectContaining({ body }));
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/v1/events",
      expect.objectContaining({ signal, headers: expect.objectContaining({ Accept: "text/event-stream" }) }),
    );
  });

  test("stopOperation escapes the operation ID", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    const client = new KoharuClient("http://127.0.0.1:4000");
    await expect(client.stopOperation("op/id")).resolves.toEqual({ success: true, operationId: "op/id" });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/v1/operations/op%2Fid",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
