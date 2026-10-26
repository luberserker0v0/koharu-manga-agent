const { createApiServer } = require("../../backend/src/http/server/api_server");

describe("LM Studio proxy API", () => {
  let api;
  let baseUrl;
  const lmStudioProxy = {
    listModels: jest.fn().mockResolvedValue({ object: "list", data: [] }),
    chat: jest.fn().mockResolvedValue({ choices: [{ message: { role: "assistant", content: "OK" } }] }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    api = createApiServer({ host: "127.0.0.1", port: 0, lmStudioProxy,
      jobManager: { getConfig: () => ({ translation: { generationOptions: {
        temperature: 0.7, reasoning: "off",
      }, lmStudio: { baseUrl: "http://lmstudio:25555" } } }) } });
    await api.listen();
    baseUrl = `http://127.0.0.1:${api.server.address().port}`;
  });

  afterEach(async () => api?.close());

  test("forwards Chat Completions through enforced native settings", async () => {
    const response = await fetch(`${baseUrl}/api/v1/lmstudio-openai/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemma", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(response.status).toBe(200);
    expect(lmStudioProxy.chat).toHaveBeenCalledWith(expect.any(Object), {
      baseUrl: "http://lmstudio:25555", temperature: 0.7, reasoning: "off",
    });
  });
});
