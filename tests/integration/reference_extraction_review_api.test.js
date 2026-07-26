const { createApiServer } = require("../../backend/src/http/api_server");

describe("Extraction review API", () => {
  let api;
  let baseUrl;

  afterEach(async () => {
    if (api) await api.close();
  });

  test("exposes the complete review session, order, and confirmation contract", async () => {
    const document = {
      referenceSetId: "ref_api_review",
      status: "awaiting_review",
      pages: [],
    };
    const extractionReviewService = {
      get: jest.fn(() => document),
      start: jest.fn(async () => ({ ...document, status: "editing", sessionId: "session-1" })),
      sync: jest.fn(async () => ({ ...document, status: "editing" })),
      finish: jest.fn(async () => ({ ...document, status: "awaiting_order_review" })),
      cancel: jest.fn(async () => document),
      saveOrder: jest.fn(() => ({ ...document, status: "awaiting_order_review" })),
      confirm: jest.fn(() => ({ ...document, status: "reviewed" })),
    };
    api = createApiServer({
      jobManager: {},
      extractionReviewService,
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    baseUrl = `http://127.0.0.1:${api.server.address().port}`;
    const endpoint = `${baseUrl}/references/ref_api_review/extraction-review`;

    expect((await fetch(endpoint)).status).toBe(200);
    expect((await fetch(`${endpoint}/session`, { method: "POST" })).status).toBe(201);
    expect((await fetch(`${endpoint}/session/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    })).status).toBe(200);
    expect((await fetch(`${endpoint}/session/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    })).status).toBe(200);
    expect((await fetch(`${endpoint}/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages: [{ pageId: "p1", nodeIds: ["n1"] }] }),
    })).status).toBe(200);
    expect((await fetch(`${endpoint}/confirm`, { method: "POST" })).status).toBe(200);

    expect(extractionReviewService.sync).toHaveBeenCalledWith("ref_api_review", "session-1");
    expect(extractionReviewService.saveOrder).toHaveBeenCalledWith(
      "ref_api_review",
      [{ pageId: "p1", nodeIds: ["n1"] }]
    );
    expect(extractionReviewService.confirm).toHaveBeenCalledWith("ref_api_review");
  });

  test("passes cancellation session ownership through DELETE", async () => {
    const extractionReviewService = {
      get: jest.fn(),
      cancel: jest.fn(async () => ({ referenceSetId: "ref_api_review", status: "awaiting_review" })),
    };
    api = createApiServer({
      jobManager: {},
      extractionReviewService,
      host: "127.0.0.1",
      port: 0,
    });
    await api.listen();
    baseUrl = `http://127.0.0.1:${api.server.address().port}`;
    const response = await fetch(`${baseUrl}/references/ref_api_review/extraction-review/session`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(response.status).toBe(200);
    expect(extractionReviewService.cancel).toHaveBeenCalledWith("ref_api_review", "session-1");
  });
});
