const fs = require("fs");
const { DATA_ROOT, PROJECT_CONFIG_PATH, paths } = require("../../../config");
const { validateConfigPatch } = require("../../../config_service");
const { normalizeTranslationCatalog } = require("../../../integrations/koharu/translation/translation_targets");
const { readJsonBody, sendJson } = require("../../server/http_helpers");
const { applyManagedKoharuBaseUrl } = require("./runtime_context");

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

function requireKoharuClient(ctx, method, message) {
  const client = ctx.jobManager?.engine?.projectLifecycle?.client;
  if (!client?.[method]) throw new Error(message);
  return client;
}

async function resolveKoharuBaseUrl(ctx) {
  const override = ctx.url.searchParams.get("baseUrl");
  if (!override && ctx.jobManager.koharuRuntimeManager) {
    const status = await ctx.jobManager.koharuRuntimeManager.ensureRunning();
    applyManagedKoharuBaseUrl(ctx, status?.baseUrl);
  }
  return override || ctx.jobManager.koharuRuntimeManager?.baseUrl || ctx.jobManager.resolvedConfig?.api?.baseUrl;
}

async function handleKoharuEngines(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/runtime/koharu/engines") return false;
  const client = requireKoharuClient(ctx, "getEngines", "Koharu client is not configured.");
  const baseUrl = await resolveKoharuBaseUrl(ctx);
  sendJson(ctx.res, 200, { engines: await client.getEngines(baseUrl) });
  return true;
}

async function handleKoharuTranslationProviders(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/runtime/koharu/translation-providers") return false;
  const client = requireKoharuClient(ctx, "getTranslationCatalog", "Koharu translation catalog is not configured.");
  const baseUrl = await resolveKoharuBaseUrl(ctx);
  const catalog = normalizeTranslationCatalog(await client.getTranslationCatalog(baseUrl));
  sendJson(ctx.res, 200, {
    baseUrl,
    ...catalog,
    defaultTarget: ctx.jobManager.resolvedConfig?.translation?.defaultTarget || null,
  });
  return true;
}

function requireManagedKoharu(ctx) {
  if (!ctx.jobManager.koharuRuntimeManager) throw new Error("Managed Koharu runtime is not configured.");
  return ctx.jobManager.koharuRuntimeManager;
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

async function handleKoharuPaths(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/runtime/koharu/paths") return false;
  const runtime = requireManagedKoharu(ctx);
  const client = ctx.jobManager?.engine?.projectLifecycle?.client || null;
  const baseUrl =
    ctx.url.searchParams.get("baseUrl") || runtime.baseUrl || ctx.jobManager.resolvedConfig?.api?.baseUrl;
  sendJson(ctx.res, 200, {
    backend: backendRuntimePaths(),
    koharu: await runtime.inspectPaths({ client, baseUrl }),
  });
  return true;
}

async function handleKoharuInstall(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/runtime/koharu/install") return false;
  sendJson(ctx.res, 200, { koharu: await requireManagedKoharu(ctx).ensureInstalled() });
  return true;
}

async function handleKoharuStart(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/runtime/koharu/start") return false;
  const status = await requireManagedKoharu(ctx).ensureRunning();
  applyManagedKoharuBaseUrl(ctx, status?.baseUrl);
  sendJson(ctx.res, 200, { koharu: status });
  return true;
}

async function handleKoharuPrepare(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/runtime/koharu/prepare") return false;
  sendJson(ctx.res, 200, { koharu: await requireManagedKoharu(ctx).prepareRuntime() });
  return true;
}

async function handleKoharuStop(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/runtime/koharu/stop") return false;
  sendJson(ctx.res, 200, { koharu: await requireManagedKoharu(ctx).stopManaged() });
  return true;
}

const RUNTIME_ROUTE_HANDLERS = [
  handleAoRuntime,
  handleKoharuEngines,
  handleKoharuTranslationProviders,
  handleKoharuPaths,
  handleKoharuInstall,
  handleKoharuStart,
  handleKoharuPrepare,
  handleKoharuStop,
];

async function handleRuntimeRoutes(ctx) {
  for (const handler of RUNTIME_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handleRuntimeRoutes };
