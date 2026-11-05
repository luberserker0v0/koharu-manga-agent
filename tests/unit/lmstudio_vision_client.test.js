const {
  LMStudioVisionClient,
  buildVisionRequest,
  buildOcrTextCorrectionRequest,
  safeErrorDetail,
} = require("../../backend/src/integrations/lmstudio/lmstudio_vision_client");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("LMStudioVisionClient", () => {
  test("sends a native image input and returns only assistant text", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{
        key: "vision-model", capabilities: { vision: true }, loaded_instances: [],
      }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{
        message: { content: '{"count":0,"regions":[]}' },
      }] }));
    const client = new LMStudioVisionClient({ fetchImpl });

    const result = await client.review({
      baseUrl: "http://127.0.0.1:25555", modelId: "vision-model", prompt: "inspect",
      imageBuffer: Buffer.from("png"), mediaType: "image/png", temperature: 0.7,
      reasoning: "off", maxOutputTokens: 1024, expectedRegionCount: 2,
    });

    expect(result.text).toBe('{"count":0,"regions":[]}');
    const request = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(request.messages[0].content).toEqual([
      { type: "text", text: "inspect" },
      { type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
    ]);
    expect(request.response_format.type).toBe("json_schema");
    expect(request.response_format.json_schema.schema.properties.texts).toMatchObject({
      minItems: 2, maxItems: 2,
    });
    expect(request).not.toHaveProperty("reasoning_effort");
  });

  test("rejects a model without vision capability before inference", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ models: [{
      key: "text-model", capabilities: { vision: false }, loaded_instances: [],
    }] }));
    const client = new LMStudioVisionClient({ fetchImpl });

    await expect(client.review({
      baseUrl: "http://127.0.0.1:25555", modelId: "text-model", prompt: "inspect",
      imageBuffer: Buffer.from("png"), mediaType: "image/png", temperature: 0.7,
      reasoning: "off", maxOutputTokens: 1024,
    })).rejects.toMatchObject({ code: "vision_model_required", statusCode: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("builds the minimal LM Studio native request", () => {
    const request = buildVisionRequest({
      modelId: "vision-model", prompt: "inspect", imageBuffer: Buffer.from([1]),
      mediaType: "image/webp", temperature: 0.2, reasoning: "off", maxOutputTokens: 2048,
      expectedRegionCount: 1,
    });
    expect(Object.keys(request)).toEqual([
      "model", "messages", "response_format", "temperature", "max_tokens", "stream",
    ]);
  });

  test("builds and sends one-crop OCR correction without geometry", async () => {
    const request = buildOcrTextCorrectionRequest({
      modelId: "vision-model", prompt: "correct one crop", imageBuffer: Buffer.from([1]),
      mediaType: "image/png", temperature: 0, reasoning: "off", maxOutputTokens: 256,
      systemPrompt: "Return one transcription.",
    });
    expect(request.system_prompt).toBe("Return one transcription.");
    expect(request.input).toEqual([
      { type: "text", content: "correct one crop" },
      { type: "image", data_url: "data:image/png;base64,AQ==" },
    ]);
    expect(request.reasoning).toBe("off");
    expect(request.max_output_tokens).toBe(256);
    expect(request.store).toBe(false);
    expect(JSON.stringify(request)).not.toContain("box");
    expect(JSON.stringify(request)).not.toContain("geometry");

    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({
      output: [{ type: "reasoning", content: "ignored" }, { type: "message", content: "hello" }],
      stats: { total_output_tokens: 7, reasoning_output_tokens: 0 },
    }));
    const client = new LMStudioVisionClient({ fetchImpl });
    await expect(client.correctOcrText({
      baseUrl: "http://127.0.0.1:25555", modelId: "vision-model", prompt: "correct one crop",
      imageBuffer: Buffer.from([1]), mediaType: "image/png", temperature: 0,
      reasoning: "off", maxOutputTokens: 256, skipModelInspection: true,
      systemPrompt: "Return one transcription.",
    })).resolves.toMatchObject({ text: '{"correctedText":"hello"}' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:25555/api/v1/chat");
  });

  test("preserves bounded LM Studio error details without image payloads", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{
        key: "vision-model", capabilities: { vision: true }, loaded_instances: [],
      }] }))
      .mockResolvedValueOnce(jsonResponse({ error: {
        code: "invalid_image",
        message: "Invalid data:image/png;base64,aGVsbG8= image input",
      } }, 400));
    const client = new LMStudioVisionClient({ fetchImpl });

    await expect(client.review({
      baseUrl: "http://127.0.0.1:25555", modelId: "vision-model", prompt: "inspect",
      imageBuffer: Buffer.from("png"), mediaType: "image/png", temperature: 0.7,
      reasoning: "off", maxOutputTokens: 1024,
    })).rejects.toMatchObject({
      code: "invalid_image",
      statusCode: 400,
      message: "LM Studio vision inference failed (400): Invalid [image data omitted] image input",
    });
    expect(safeErrorDetail({ error: { message: "  useful   detail " } })).toBe("useful detail");
  });

  test("reports reasoning token exhaustion when no final message is produced", () => {
    expect(() => require("../../backend/src/integrations/lmstudio/lmstudio_vision_client").assistantText({
      choices: [{ message: { content: "", reasoning_content: "analysis" }, finish_reason: "length" }],
      usage: { completion_tokens_details: { reasoning_tokens: 335 } },
    })).toThrow(expect.objectContaining({
      code: "lmstudio_output_token_limit",
      message: "LM Studio vision response did not contain a message (finish reason: length, reasoning tokens: 335).",
    }));
  });
});
