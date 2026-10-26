function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeInstance(instance) {
  if (!instance || typeof instance !== "object") return null;
  const config = instance.config || {};
  return {
    id: typeof instance.id === "string" ? instance.id : null,
    remainingTtlSeconds: finiteNumber(instance.remaining_ttl_seconds),
    contextLength: finiteNumber(config.context_length),
    evalBatchSize: finiteNumber(config.eval_batch_size),
    physicalBatchSize: finiteNumber(config.physical_batch_size),
    parallel: finiteNumber(config.parallel),
    flashAttention: typeof config.flash_attention === "boolean" ? config.flash_attention : null,
    offloadKvCacheToGpu:
      typeof config.offload_kv_cache_to_gpu === "boolean" ? config.offload_kv_cache_to_gpu : null,
  };
}

function summarizeReasoning(model) {
  const reasoning = model?.capabilities?.reasoning;
  if (!reasoning || typeof reasoning !== "object") return null;
  return {
    allowedOptions: Array.isArray(reasoning.allowed_options) ? reasoning.allowed_options : [],
    default: typeof reasoning.default === "string" ? reasoning.default : null,
  };
}

function summarizeModel(model) {
  const instances = (Array.isArray(model?.loaded_instances) ? model.loaded_instances : [])
    .map(summarizeInstance).filter(Boolean);
  return {
    available: true,
    modelKey: model.key,
    architecture: model.architecture || null,
    quantization: model.quantization?.name || null,
    loaded: instances.length > 0,
    instances,
    reasoning: summarizeReasoning(model),
  };
}

class LMStudioClient {
  constructor({ timeoutMs = 5000, fetchImpl = fetch } = {}) {
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async inspectModel(modelId, baseUrl) {
    const url = `${String(baseUrl).replace(/\/+$/, "")}/api/v1/models`;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`LM Studio model inspection failed (${response.status}).`);
    const body = await response.json();
    const models = Array.isArray(body?.models) ? body.models : [];
    const model = models.find((entry) => entry?.key === modelId ||
      entry?.loaded_instances?.some((instance) => instance?.id === modelId));
    if (!model) throw new Error(`LM Studio model is not available: ${modelId}.`);
    return summarizeModel(model);
  }
}

module.exports = { LMStudioClient, summarizeModel };
