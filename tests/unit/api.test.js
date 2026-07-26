const path = require("path");

const {
  ENDPOINTS,
  buildUrl,
  apiFetch,
} = require(path.join(
  __dirname,
  "../../.opencode/skills/manga-translate-zhtw/lib/api"
));

describe("manga api helper", () => {
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
});
