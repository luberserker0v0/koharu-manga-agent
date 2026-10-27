const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { AOClient } = require("../../integrations/ao/client/ao_client");
const { loadAoAssets } = require("../../integrations/ao/assets/ao_assets");
const { composeTranslationMemory } = require("../../domains/translation/memory/translation_memory");
const { handleJobRoutes } = require("../routes/jobs/job_routes");
const { handleTranslationRoutes } = require("../routes/translation/translation_routes");
const { handleTextRegionRoutes } = require("../routes/translation/text_region_routes");
const { handlePostEditRoutes } = require("../routes/post_edit/post_edit_routes");
const { handleKnowledgeRoutes } = require("../routes/knowledge/knowledge_routes");
const { handleSystemRoutes } = require("../routes/system/system_routes");
const { handleRuntimeRoutes } = require("../routes/runtime/runtime_routes");
const { handleLMStudioProxyRoutes } = require("../routes/lmstudio/lmstudio_proxy_routes");
const { handleMangaRoutes } = require("../routes/manga/manga_routes");
const { handleReferenceRoutes } = require("../routes/reference/reference_routes");
const {
  SSE_HEARTBEAT_INTERVAL_MS,
  notFound,
  sendJson,
} = require("./http_helpers");

function originAllowed(origin, allowedOrigins) {
  return allowedOrigins.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) return origin.startsWith(pattern.slice(0, -1));
    return origin === pattern;
  });
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.length === 0) return true;
  if (!originAllowed(origin, allowedOrigins)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Last-Event-ID");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function authorized(req, authToken) {
  if (!authToken) return true;
  const value = String(req.headers.authorization || "");
  if (!value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(String(authToken));
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

const REQUEST_CHUNKS = [
  handleSystemRoutes,
  handleRuntimeRoutes,
  handleLMStudioProxyRoutes,
  handleReferenceRoutes,
  handleMangaRoutes,
  handleJobRoutes,
  handleTextRegionRoutes,
  handleTranslationRoutes,
  handlePostEditRoutes,
  handleKnowledgeRoutes,
];

function missingPostEditWorkspace() {
  const fail = () => {
    throw new Error("Post-edit workspace module is not configured.");
  };
  return { load: fail, save: fail };
}

function defaultWhenUndefined(value, fallback) {
  return value === undefined ? fallback : value;
}

function createApiServerContext({ host, port, serverConfig = {}, ...dependencies }) {
  const jobManager = dependencies.jobManager;
  const allowedOrigins = Array.isArray(serverConfig.corsAllowedOrigins)
    ? serverConfig.corsAllowedOrigins.map(String)
    : [];
  return {
    ...dependencies,
    jobManager,
    extractionReviewService: defaultWhenUndefined(dependencies.extractionReviewService, null),
    configService: defaultWhenUndefined(dependencies.configService, null),
    aoClientFactory: defaultWhenUndefined(dependencies.aoClientFactory, (options) => new AOClient(options)),
    aoAssetsLoader: defaultWhenUndefined(dependencies.aoAssetsLoader, loadAoAssets),
    translationMemoryComposer: defaultWhenUndefined(dependencies.translationMemoryComposer, composeTranslationMemory),
    uploadService: defaultWhenUndefined(dependencies.uploadService, null),
    translatedImageService: defaultWhenUndefined(dependencies.translatedImageService, null),
    pageRevisionService: defaultWhenUndefined(dependencies.pageRevisionService, null),
    textRegionQueryService: defaultWhenUndefined(dependencies.textRegionQueryService, null),
    allowedOrigins,
    authToken: serverConfig.authToken || null,
    maxJsonBodyBytes: Number(serverConfig.maxJsonBodyBytes || 1048576),
    qualityModule: jobManager?.engine?.qualityModule || null,
    knowledgeModule: jobManager?.engine?.knowledgeModule || null,
    resolvedPostEditWorkspaceModule: dependencies.postEditWorkspaceModule || missingPostEditWorkspace(),
    host,
    port,
    serverConfig,
  };
}

function normalizeApiUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/v1") url.pathname = "/";
  else if (url.pathname.startsWith("/api/v1/")) url.pathname = url.pathname.slice(7);
  return url;
}

function prepareApiRequest(req, res, baseCtx) {
  const url = normalizeApiUrl(req);
  req.maxJsonBodyBytes = baseCtx.maxJsonBodyBytes;
  res.setHeader("X-Request-Id", crypto.randomUUID());
  if (!applyCors(req, res, baseCtx.allowedOrigins)) {
    sendJson(res, 403, { error: "Origin is not allowed." });
    return null;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return null;
  }
  const publicService = ["/health", "/ready"].includes(url.pathname) ||
    url.pathname.startsWith("/lmstudio-openai/");
  if (!publicService && !authorized(req, baseCtx.authToken)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    sendJson(res, 401, { error: "Unauthorized" });
    return null;
  }
  return url;
}

function sendApiError(res, error) {
  sendJson(res, error.statusCode || 500, {
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.details ? { details: error.details } : {}),
  });
}

async function dispatchApiRequest(ctx) {
  try {
    for (const chunk of REQUEST_CHUNKS) {
      if (await chunk(ctx)) return;
    }
    notFound(ctx.res);
  } catch (error) {
    sendApiError(ctx.res, error);
  }
}

function createApiRequestHandler(baseCtx) {
  return async (req, res) => {
    const url = prepareApiRequest(req, res, baseCtx);
    if (url) await dispatchApiRequest({ ...baseCtx, req, res, url });
  };
}

function createServerControls(server, host, port) {
  return {
    server,
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createApiServer(options) {
  const baseCtx = createApiServerContext(options);
  const server = http.createServer(createApiRequestHandler(baseCtx));
  return createServerControls(server, baseCtx.host, baseCtx.port);
}

module.exports = {
  createApiServer,
  SSE_HEARTBEAT_INTERVAL_MS,
};
