const {
  LMStudioNativeProxy,
  buildNativeRequest,
  openAiResponse,
} = require("../../backend/src/integrations/lmstudio/lmstudio_native_proxy");

describe("LM Studio native proxy", () => {
  test("converts OpenAI messages into an enforced native request", () => {
    const request = buildNativeRequest({ model: "gemma", max_tokens: 50, messages: [
      { role: "system", content: "Translate faithfully." },
      { role: "user", content: "Hello" },
    ] }, { temperature: 0.7, reasoning: "off" });
    expect(request).toEqual({ model: "gemma", input: "Hello", system_prompt: "Translate faithfully.",
      temperature: 0.7, reasoning: "off", max_output_tokens: 50, store: false });
  });

  test("maps native output and reasoning statistics to Chat Completions", () => {
    const result = openAiResponse({ model: "gemma" }, { model_instance_id: "gemma", output: [
      { type: "message", content: "OK" },
    ], stats: { input_tokens: 10, total_output_tokens: 2, reasoning_output_tokens: 0 } });
    expect(result.choices[0].message.content).toBe("OK");
    expect(result.usage).toEqual(expect.objectContaining({ total_tokens: 12,
      completion_tokens_details: { reasoning_tokens: 0 } }));
  });

  test("calls the native API with configured reasoning and temperature", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({
      model_instance_id: "gemma", output: [{ type: "message", content: "OK" }],
      stats: { reasoning_output_tokens: 0 },
    }) });
    const proxy = new LMStudioNativeProxy({ fetchImpl });
    await proxy.chat({ model: "gemma", messages: [{ role: "user", content: "Hi" }] }, {
      baseUrl: "http://lmstudio:25555", temperature: 0.7, reasoning: "off",
    });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://lmstudio:25555/api/v1/chat");
    expect(sent).toEqual(expect.objectContaining({ temperature: 0.7, reasoning: "off" }));
  });
});
