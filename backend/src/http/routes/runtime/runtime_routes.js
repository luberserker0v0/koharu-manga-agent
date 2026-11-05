const fs = require("fs");
const { DATA_ROOT, PROJECT_CONFIG_PATH, paths } = require("../../../config");
const { validateConfigPatch } = require("../../../config_service");
const { normalizeTranslationCatalog } = require("../../../domains/manga_processing/translation_targets");
const { readJsonBody, sendJson } = require("../../server/http_helpers");
const { applyManagedMangaProcessorBaseUrl } = require("./runtime_context");

function createRuntimeAoClient(ctx, body) {
  const agent = ctx.jobManager.getConfig()?.agent || {};
  const baseUrl = body.baseUrl || agent.baseUrl;
  const apiKey = body.apiKey === undefined ? agent.apiKey || null : body.apiKey || null;
  validateConfigPatch({ agent: { baseUrl, apiKey } });
  return {
    baseUrl,
    client: ctx.aoClientFactory({
      baseUrl,
      apiKey,
      readyPollIntervalMs: agent.readyPollIntervalMs || 1000,
      readyTimeoutMs: agent.readyTimeoutMs || 30000,
    }),
  };
}

function flattenAoProviderModels(providers) {
  return providers.flatMap((provider) => {
    if (!provider?.id) return [];
    const entries = Array.isArray(provider.models)
      ? provider.models
      : provider.models && typeof provider.models === "object" ? Object.values(provider.models) : [];
    return entries.map((entry) => {
      const modelId = typeof entry === "string" ? entry : entry?.id;
      return modelId ? {
        id: `${provider.id}/${modelId}`, providerId: provider.id,
        providerName: provider.name || provider.id, modelId,
        name: typeof entry === "object" ? entry.name || modelId : modelId,
      } : null;
    }).filter(Boolean);
  });
}

async function loadAoProviderCatalog(ctx, client, baseUrl) {
  let conversationId = null;
  try {
    const conversation = await client.createConversation();
    conversationId = conversation.id;
    await client.writeConfig(conversationId, ctx.aoAssetsLoader().opencodeConfig);
    await client.startConversation(conversationId);
    await client.waitUntilReady(conversationId);
    const result = await client.listProviders(conversationId);
    const providers = Array.isArray(result?.providers) ? result.providers : [];
    return { baseUrl, providers, models: flattenAoProviderModels(providers), defaults: result?.default || {} };
  } finally {
    if (conversationId) await client.deleteConversation(conversationId).catch(() => {});
  }
}

async function handleAoRuntime(ctx) {
  const allowed = ["/runtime/ao/connect", "/runtime/ao/providers"];
  if (ctx.req.method !== "POST" || !allowed.includes(ctx.url.pathname)) return false;
  const body = await readJsonBody(ctx.req);
  const { baseUrl, client } = createRuntimeAoClient(ctx, body);
  if (ctx.url.pathname === "/runtime/ao/connect") {
    sendJson(ctx.res, 200, await client.checkAvailability({ timeoutMs: 5000 }));
    return true;
  }
  sendJson(ctx.res, 200, await loadAoProviderCatalog(ctx, client, baseUrl));
  return true;
}

function requireMangaProcessor(ctx, method, message) {
  const processor = ctx.jobManager?.engine?.mangaProcessor;
  if (!processor?.[method]) throw new Error(message);
  return processor;
}

async function resolveMangaProcessorBaseUrl(ctx) {
  const override = ctx.url.searchParams.get("baseUrl");
  if (!override && ctx.jobManager.mangaProcessingRuntime) {
    const status = await ctx.jobManager.mangaProcessingRuntime.ensureRunning();
    applyManagedMangaProcessorBaseUrl(ctx, status?.baseUrl);
  }
  return override || ctx.jobManager.mangaProcessingRuntime?.baseUrl || ctx.jobManager.resolvedConfig?.api?.baseUrl;
}

async function handleMangaProcessorEngines(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/runtime/manga-processor/engines") return false;
  const client = requireMangaProcessor(ctx, "getEngines", "Manga processor is not configured.");
  const baseUrl = await resolveMangaProcessorBaseUrl(ctx);
  sendJson(ctx.res, 200, { engines: await client.getEngines(baseUrl) });
  return true;
}

async function handleMangaProcessorTranslationProviders(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/runtime/manga-processor/translation-providers") return false;
  const client = requireMangaProcessor(ctx, "getTranslationCatalog", "Translation catalog is not configured.");
  const baseUrl = await resolveMangaProcessorBaseUrl(ctx);
  const catalog = normalizeTranslationCatalog(await client.getTranslationCatalog(baseUrl));
  sendJson(ctx.res, 200, {
    baseUrl,
    ...catalog,
    defaultTarget: ctx.jobManager.resolvedConfig?.translation?.defaultTarget || null,
  });
  return true;
}

function requireMangaProcessingRuntime(ctx) {
  if (!ctx.jobManager.mangaProcessingRuntime) throw new Error("Manga processing runtime is not configured.");
  return ctx.jobManager.mangaProcessingRuntime;
}

function backendRuntimePaths() {
  return {
    dataRoot: DATA_ROOT,
    configPath: PROJECT_CONFIG_PATH,
    databasePath: paths.database,
    translatedRoot: paths.translated,
    referencesRoot: paths.references,
    hostAccessible: !fs.existsSync("/.dockerenv"),
  };
}

async function handleMangaProcessorPaths(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/runtime/manga-processor/paths") return false;
  const runtime = requireMangaProcessingRuntime(ctx);
  const client = ctx.jobManager?.engine?.mangaProcessor || null;
  const baseUrl =
    ctx.url.searchParams.get("baseUrl") || runtime.baseUrl || ctx.jobManager.resolvedConfig?.api?.baseUrl;
  sendJson(ctx.res, 200, {
    backend: backendRuntimePaths(),
    mangaProcessor: await runtime.inspectPaths({ client, baseUrl }),
  });
  return true;
}

async function handleMangaProcessorInstall(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/runtime/manga-processor/install") return false;
  sendJson(ctx.res, 200, { mangaProcessor: await requireMangaProcessingRuntime(ctx).ensureInstalled() });
  return true;
}

async function handleMangaProcessorStart(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/runtime/manga-processor/start") return false;
  const status = await requireMangaProcessingRuntime(ctx).ensureRunning();
  applyManagedMangaProcessorBaseUrl(ctx, status?.baseUrl);
  sendJson(ctx.res, 200, { mangaProcessor: status });
  return true;
}

async function handleMangaProcessorPrepare(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/runtime/manga-processor/prepare") return false;
  sendJson(ctx.res, 200, { mangaProcessor: await requireMangaProcessingRuntime(ctx).prepareRuntime() });
  return true;
}

async function handleMangaProcessorStop(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/runtime/manga-processor/stop") return false;
  sendJson(ctx.res, 200, { mangaProcessor: await requireMangaProcessingRuntime(ctx).stopManaged() });
  return true;
}

const RUNTIME_ROUTE_HANDLERS = [
  handleAoRuntime,
  handleMangaProcessorEngines,
  handleMangaProcessorTranslationProviders,
  handleMangaProcessorPaths,
  handleMangaProcessorInstall,
  handleMangaProcessorStart,
  handleMangaProcessorPrepare,
  handleMangaProcessorStop,
];

async function handleRuntimeRoutes(ctx) {
  for (const handler of RUNTIME_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handleRuntimeRoutes };
