const {
  ENDPOINTS,
  KoharuClient,
  buildUrl,
  apiFetch,
} = require("../../backend/src/integrations/koharu/client/koharu_client");

describe("Koharu HTTP client helpers", () => {
  test("exports expected endpoints", () => {
    expect(ENDPOINTS.PROJECTS).toBe("/api/v1/projects");
    expect(ENDPOINTS.PROJECTS_CURRENT).toBe("/api/v1/projects/current");
    expect(ENDPOINTS.SCENE).toBe("/api/v1/scene.json");
    expect(ENDPOINTS.PAGES).toBe("/api/v1/pages");
    expect(ENDPOINTS.PAGES_FROM_PATHS).toBe("/api/v1/pages/from-paths");
    expect(ENDPOINTS.LLM_CURRENT).toBe("/api/v1/llm/current");
    expect(ENDPOINTS.ENGINES).toBe("/api/v1/engines");
    expect(ENDPOINTS.PIPELINES).toBe("/api/v1/pipelines");
    expect(ENDPOINTS.EXPORT).toBe("/api/v1/projects/current/export");
  });

  test("buildUrl uses default and custom base URLs", () => {
    expect(buildUrl(ENDPOINTS.SCENE)).toBe(
      "http://127.0.0.1:4000/api/v1/scene.json"
    );
    expect(buildUrl(ENDPOINTS.SCENE, "http://10.0.0.1:8080/")).toBe(
      "http://10.0.0.1:8080/api/v1/scene.json"
    );
  });

  test("apiFetch sends JSON requests", async () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    global.fetch = mockFetch;

    await apiFetch(ENDPOINTS.PIPELINES, {
      method: "POST",
      body: { steps: ["detect", "ocr"] },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/v1/pipelines",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ steps: ["detect", "ocr"] }),
      })
    );

    global.fetch = originalFetch;
  });

  test("stopOperation sends the Koharu operation DELETE request", async () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = mockFetch;
    try {
      const client = new KoharuClient("http://127.0.0.1:4000");
      await expect(client.stopOperation("op/id")).resolves.toEqual({
        success: true,
        operationId: "op/id",
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:4000/api/v1/operations/op%2Fid",
        expect.objectContaining({ method: "DELETE" }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
