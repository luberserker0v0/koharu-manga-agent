const path = require("path");
const { ENDPOINTS, buildUrl, apiFetch } = require(path.join(__dirname, "../../.opencode/skills/shared/api"));

describe("api.js - API 端點常數與 fetch 封裝", () => {
  describe("ENDPOINTS 完整性", () => {
    test("應包含專案端點", () => {
      expect(ENDPOINTS.PROJECTS).toBe("/api/v1/projects");
      expect(ENDPOINTS.PROJECTS_CURRENT).toBe("/api/v1/projects/current");
      expect(ENDPOINTS.SCENE).toBe("/api/v1/scene.json");
    });

    test("應包含頁面端點", () => {
      expect(ENDPOINTS.PAGES).toBe("/api/v1/pages");
      expect(ENDPOINTS.PAGES_FROM_PATHS).toBe("/api/v1/pages/from-paths");
    });

    test("應包含 LLM 端點", () => {
      expect(ENDPOINTS.LLM_CURRENT).toBe("/api/v1/llm/current");
      expect(ENDPOINTS.LLM_CATALOG).toBe("/api/v1/llm/catalog");
    });

    test("應包含引擎端點", () => {
      expect(ENDPOINTS.ENGINES).toBe("/api/v1/engines");
    });

    test("應包含管線端點", () => {
      expect(ENDPOINTS.PIPELINES).toBe("/api/v1/pipelines");
      expect(ENDPOINTS.OPERATIONS).toBe("/api/v1/operations");
      expect(ENDPOINTS.EVENTS).toBe("/api/v1/events");
    });

    test("應包含歷史端點", () => {
      expect(ENDPOINTS.HISTORY_APPLY).toBe("/api/v1/history/apply");
      expect(ENDPOINTS.HISTORY_UNDO).toBe("/api/v1/history/undo");
      expect(ENDPOINTS.HISTORY_REDO).toBe("/api/v1/history/redo");
    });

    test("應包含匯出端點", () => {
      expect(ENDPOINTS.EXPORT).toBe("/api/v1/projects/current/export");
    });

    test("應有至少 15 個端點", () => {
      expect(Object.keys(ENDPOINTS).length).toBeGreaterThanOrEqual(15);
    });
  });

  describe("buildUrl", () => {
    test("應使用預設 baseUrl", () => {
      const url = buildUrl(ENDPOINTS.SCENE);
      expect(url).toBe("http://127.0.0.1:9999/api/v1/scene.json");
    });

    test("應使用自訂 baseUrl", () => {
      const url = buildUrl(ENDPOINTS.SCENE, "http://10.0.0.1:8080");
      expect(url).toBe("http://10.0.0.1:8080/api/v1/scene.json");
    });

    test("應處理 trailing slash", () => {
      const url = buildUrl(ENDPOINTS.SCENE, "http://127.0.0.1:9999/");
      expect(url).toBe("http://127.0.0.1:9999/api/v1/scene.json");
      expect(url).not.toContain("//api");
    });

    test("應處理多個 trailing slashes", () => {
      const url = buildUrl(ENDPOINTS.SCENE, "http://127.0.0.1:9999///");
      expect(url).toBe("http://127.0.0.1:9999/api/v1/scene.json");
    });
  });

  describe("apiFetch", () => {
    let originalFetch;

    beforeAll(() => {
      originalFetch = global.fetch;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    test("GET 請求應加入 Content-Type header", async () => {
      const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
      global.fetch = mockFetch;

      await apiFetch(ENDPOINTS.PROJECTS);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/projects"),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });

    test("POST 請求應序列化 JSON body", async () => {
      const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
      global.fetch = mockFetch;

      await apiFetch(ENDPOINTS.PIPELINES, {
        method: "POST",
        body: { steps: ["detect", "ocr"] },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ steps: ["detect", "ocr"] }),
        })
      );
    });

    test("應使用自訂 baseUrl", async () => {
      const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
      global.fetch = mockFetch;

      await apiFetch(ENDPOINTS.PROJECTS, { baseUrl: "http://10.0.0.1:8080" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://10.0.0.1:8080/api/v1/projects",
        expect.any(Object)
      );
    });
  });
});
