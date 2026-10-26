const { LMStudioNativeProxy } = require("../../../integrations/lmstudio/lmstudio_native_proxy");
const { readJsonBody, sendJson } = require("../../server/http_helpers");

function proxySettings(ctx) {
  const translation = ctx.jobManager?.getConfig?.()?.translation || {};
  const lmStudio = translation.lmStudio || {};
  const generation = translation.generationOptions || {};
  return {
    baseUrl: lmStudio.baseUrl,
    temperature: generation.temperature ?? 0.7,
    reasoning: generation.reasoning || "off",
  };
}

function requireProxy(ctx) {
  return ctx.lmStudioProxy || new LMStudioNativeProxy();
}

async function handleLMStudioProxyRoutes(ctx) {
  if (ctx.url.pathname === "/lmstudio-openai/v1/models" && ctx.req.method === "GET") {
    sendJson(ctx.res, 200, await requireProxy(ctx).listModels(proxySettings(ctx).baseUrl));
    return true;
  }
  if (ctx.url.pathname !== "/lmstudio-openai/v1/chat/completions" || ctx.req.method !== "POST") return false;
  const body = await readJsonBody(ctx.req);
  sendJson(ctx.res, 200, await requireProxy(ctx).chat(body, proxySettings(ctx)));
  return true;
}

module.exports = { handleLMStudioProxyRoutes, proxySettings };
