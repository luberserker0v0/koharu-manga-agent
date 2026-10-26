const {
  LMStudioClient,
  summarizeModel,
} = require("../../backend/src/integrations/lmstudio/lmstudio_client");

describe("LM Studio client", () => {
  test("keeps only non-secret model capability and load metadata", () => {
    const result = summarizeModel({
      key: "gemma",
      architecture: "gemma4",
      quantization: { name: "Q4_K_M" },
      loaded_instances: [{ id: "gemma", remaining_ttl_seconds: 3000, config: {
        context_length: 131072, parallel: 4, flash_attention: true, api_key: "secret",
      } }],
      capabilities: { reasoning: { allowed_options: ["off", "on"], default: "on" } },
    });

    expect(result).toEqual(expect.objectContaining({ modelKey: "gemma", loaded: true,
      reasoning: { allowedOptions: ["off", "on"], default: "on" } }));
    expect(result.instances[0]).toEqual(expect.objectContaining({ contextLength: 131072, parallel: 4 }));
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("reads the selected model from the native v1 API", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [
      { key: "other", loaded_instances: [] },
      { key: "gemma", loaded_instances: [{ id: "gemma", config: {} }] },
    ] }) });
    const client = new LMStudioClient({ fetchImpl, timeoutMs: 1000 });

    const result = await client.inspectModel("gemma", "http://127.0.0.1:25555/");

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:25555/api/v1/models", expect.any(Object));
    expect(result).toEqual(expect.objectContaining({ modelKey: "gemma", loaded: true }));
  });
});
