const crypto = require("crypto");

function proxyError(message, statusCode = 502, code = "lmstudio_proxy_error") {
  return Object.assign(new Error(message), { statusCode, code });
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return part.text || part.content || "";
    return "";
  }).filter(Boolean).join("\n");
}

function splitMessages(messages) {
  const entries = (Array.isArray(messages) ? messages : [])
    .map((message) => ({ role: message?.role, content: textContent(message?.content) }))
    .filter((message) => message.content);
  const systemPrompt = entries.filter((message) => message.role === "system")
    .map((message) => message.content).join("\n\n");
  const dialogue = entries.filter((message) => message.role !== "system");
  const input = dialogue.length === 1 && dialogue[0].role === "user"
    ? dialogue[0].content
    : dialogue.map((message) => `${message.role || "user"}: ${message.content}`).join("\n\n");
  return { systemPrompt, input };
}

function buildNativeRequest(body, settings) {
  const { systemPrompt, input } = splitMessages(body.messages);
  if (!body.model || !input) throw proxyError("LM Studio proxy requires model and text messages.", 400);
  return {
    model: body.model,
    input,
    ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    temperature: settings.temperature,
    reasoning: settings.reasoning,
    ...(Number.isInteger(body.max_tokens ?? body.maxTokens)
      ? { max_output_tokens: body.max_tokens ?? body.maxTokens } : {}),
    store: false,
  };
}

function outputText(output, type) {
  return (Array.isArray(output) ? output : [])
    .filter((item) => item?.type === type && typeof item.content === "string")
    .map((item) => item.content).join("\n");
}

function openAiResponse(body, native) {
  const content = outputText(native.output, "message");
  if (!content) throw proxyError("LM Studio native response did not contain an assistant message.");
  const stats = native.stats || {};
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: native.model_instance_id || body.model,
    choices: [{ index: 0, message: { role: "assistant", content,
      reasoning_content: outputText(native.output, "reasoning") }, finish_reason: "stop" }],
    usage: { prompt_tokens: stats.input_tokens || 0, completion_tokens: stats.total_output_tokens || 0,
      total_tokens: (stats.input_tokens || 0) + (stats.total_output_tokens || 0),
      completion_tokens_details: { reasoning_tokens: stats.reasoning_output_tokens || 0 } },
    lmstudio_stats: stats,
  };
}

class LMStudioNativeProxy {
  constructor({ fetchImpl = fetch, timeoutMs = 600000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async fetchJson(url, options, label) {
    const response = await this.fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw proxyError(`${label} failed (${response.status}).`, response.status, body.error?.code);
    return body;
  }

  async listModels(baseUrl) {
    return this.fetchJson(`${String(baseUrl).replace(/\/+$/, "")}/v1/models`, {}, "LM Studio models");
  }

  async chat(body, { baseUrl, temperature, reasoning }) {
    if (body.stream === true) throw proxyError("Streaming is not supported by the LM Studio native proxy.", 422);
    const request = buildNativeRequest(body, { temperature, reasoning });
    const native = await this.fetchJson(`${String(baseUrl).replace(/\/+$/, "")}/api/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }, "LM Studio chat");
    return openAiResponse(body, native);
  }
}

module.exports = { LMStudioNativeProxy, buildNativeRequest, openAiResponse, splitMessages };
