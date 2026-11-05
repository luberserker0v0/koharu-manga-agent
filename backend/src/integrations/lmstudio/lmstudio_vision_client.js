function visionError(message, statusCode = 502, code = "lmstudio_vision_error") {
  return Object.assign(new Error(message), { statusCode, code });
}

function safeErrorDetail(body) {
  const value = body?.error?.message || (typeof body?.error === "string" ? body.error : null);
  if (typeof value !== "string") return null;
  const normalized = value.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[image data omitted]")
    .replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function imageDataUrl(imageBuffer, mediaType) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw visionError("Vision inference requires a non-empty image.", 422, "vision_image_required");
  }
  return `data:${mediaType};base64,${imageBuffer.toString("base64")}`;
}

function reviewSchema(expectedRegionCount) {
  const count = Number.isInteger(expectedRegionCount) ? expectedRegionCount : 0;
  return {
    type: "object",
    additionalProperties: false,
    required: ["count", "texts"],
    properties: {
      count: { type: "integer", minimum: count, maximum: count },
      texts: {
        type: "array", minItems: count, maxItems: count,
        items: { type: "string", minLength: 1, maxLength: 10000 },
      },
    },
  };
}

function ocrTextCorrectionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["correctedText"],
    properties: {
      correctedText: { type: "string", maxLength: 10000 },
    },
  };
}

function buildVisionRequest(input) {
  return {
    model: input.modelId,
    messages: [{ role: "user", content: [
      { type: "text", text: input.prompt },
      { type: "image_url", image_url: { url: imageDataUrl(input.imageBuffer, input.mediaType) } },
    ] }],
    response_format: { type: "json_schema", json_schema: {
      name: "text_region_review", strict: true, schema: reviewSchema(input.expectedRegionCount),
    } },
    temperature: input.temperature,
    max_tokens: input.maxOutputTokens,
    stream: false,
  };
}

function buildOcrTextCorrectionRequest(input) {
  return {
    model: input.modelId,
    ...(input.systemPrompt ? { system_prompt: input.systemPrompt } : {}),
    input: [
      { type: "text", content: input.prompt },
      { type: "image", data_url: imageDataUrl(input.imageBuffer, input.mediaType) },
    ],
    temperature: input.temperature,
    reasoning: input.reasoning || "off",
    max_output_tokens: input.maxOutputTokens,
    stream: false,
    store: false,
  };
}

function assistantText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content) return content;
  const finishReason = body?.choices?.[0]?.finish_reason;
  const reasoningTokens = body?.usage?.completion_tokens_details?.reasoning_tokens;
  const detail = [
    finishReason ? `finish reason: ${finishReason}` : null,
    Number.isFinite(reasoningTokens) ? `reasoning tokens: ${reasoningTokens}` : null,
  ].filter(Boolean).join(", ");
  throw visionError(`LM Studio vision response did not contain a message${detail ? ` (${detail})` : ""}.`,
    502, finishReason === "length" ? "lmstudio_output_token_limit" : "lmstudio_vision_error");
}

function nativeAssistantText(body) {
  const content = (Array.isArray(body?.output) ? body.output : [])
    .filter((item) => item?.type === "message" && typeof item.content === "string")
    .map((item) => item.content)
    .join("\n")
    .trim();
  if (content) return content;
  const reasoningTokens = body?.stats?.reasoning_output_tokens;
  const detail = Number.isFinite(reasoningTokens) ? ` (reasoning tokens: ${reasoningTokens})` : "";
  throw visionError(`LM Studio OCR correction did not contain an assistant message${detail}.`, 502,
    "lmstudio_vision_error");
}

function findModel(body, modelId) {
  const models = Array.isArray(body?.models) ? body.models : [];
  return models.find((model) => model?.key === modelId ||
    model?.loaded_instances?.some((instance) => instance?.id === modelId));
}

class LMStudioVisionClient {
  constructor({ fetchImpl = fetch, timeoutMs = 300000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async fetchJson(url, options, label) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const error = visionError(`${label} could not reach LM Studio.`);
      error.cause = cause;
      throw error;
    }
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (cause) {
      const error = visionError(`${label} returned invalid JSON.`);
      error.cause = cause;
      throw error;
    }
    if (!response.ok) {
      const detail = safeErrorDetail(body);
      throw visionError(`${label} failed (${response.status})${detail ? `: ${detail}` : "."}`, response.status,
        body?.error?.code || "lmstudio_vision_error");
    }
    return body;
  }

  async assertVisionModel(baseUrl, modelId) {
    const root = String(baseUrl).replace(/\/+$/, "");
    const body = await this.fetchJson(`${root}/api/v1/models`, {}, "LM Studio model inspection");
    const model = findModel(body, modelId);
    if (!model) throw visionError(`LM Studio model is unavailable: ${modelId}.`, 422, "vision_model_unavailable");
    if (model.capabilities?.vision !== true) {
      throw visionError(`LM Studio model does not support image input: ${modelId}.`, 422,
        "vision_model_required");
    }
  }

  async review(input) {
    const root = String(input.baseUrl).replace(/\/+$/, "");
    await this.assertVisionModel(root, input.modelId);
    const body = await this.fetchJson(`${root}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildVisionRequest(input)),
    }, "LM Studio vision inference");
    return { text: assistantText(body), stats: body.stats || body.usage || null };
  }

  async correctOcrText(input) {
    const root = String(input.baseUrl).replace(/\/+$/, "");
    if (!input.skipModelInspection) await this.assertVisionModel(root, input.modelId);
    const body = await this.fetchJson(`${root}/api/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOcrTextCorrectionRequest(input)),
    }, "LM Studio OCR text correction");
    const correctedText = nativeAssistantText(body);
    return { text: JSON.stringify({ correctedText }), stats: body.stats || null };
  }
}

module.exports = {
  LMStudioVisionClient, assistantText, buildVisionRequest, buildOcrTextCorrectionRequest, findModel,
  nativeAssistantText, ocrTextCorrectionSchema, reviewSchema, safeErrorDetail,
};
