const { readJsonBody, sendJson } = require("../../server/http_helpers");

const CLEANUP_TARGETS = ["logs", "translated", "workspaces", "postedit"];

function publicConfig(value) {
  const output = structuredClone(value || {});
  if (output.agent && Object.prototype.hasOwnProperty.call(output.agent, "apiKey")) {
    output.agent.apiKey = output.agent.apiKey ? "***" : null;
  }
  if (output.server && Object.prototype.hasOwnProperty.call(output.server, "authToken")) {
    output.server.authToken = output.server.authToken ? "***" : null;
  }
  return output;
}

function requireUploadService(ctx) {
  if (ctx.uploadService) return ctx.uploadService;
  throw Object.assign(new Error("Upload service is unavailable."), { statusCode: 503 });
}

async function handleHealthAndReadiness(ctx) {
  if (ctx.req.method === "GET" && ctx.url.pathname === "/health") {
    sendJson(ctx.res, 200, { ok: true, deploymentMode: process.env.MANGA_TRANSLATION_BACKEND_MODE || "standalone" });
    return true;
  }
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/ready") return false;
  const readiness = await ctx.jobManager.getReadiness();
  sendJson(ctx.res, readiness.ok ? 200 : 503, readiness);
  return true;
}

async function handleUploadWrite(ctx) {
  const fileMatch = ctx.url.pathname.match(/^\/uploads\/([^/]+)\/files\/([^/]+)$/);
  if (ctx.req.method === "POST" && ctx.url.pathname === "/uploads") {
    sendJson(ctx.res, 201, requireUploadService(ctx).create(await readJsonBody(ctx.req)));
    return true;
  }
  if (ctx.req.method !== "PUT" || !fileMatch) return false;
  const file = await requireUploadService(ctx).putFile(fileMatch[1], fileMatch[2], ctx.req);
  sendJson(ctx.res, 201, { uploadId: fileMatch[1], file });
  return true;
}

async function handleUploadLifecycle(ctx) {
  const completeMatch = ctx.url.pathname.match(/^\/uploads\/([^/]+)\/complete$/);
  const uploadMatch = ctx.url.pathname.match(/^\/uploads\/([^/]+)$/);
  if (ctx.req.method === "POST" && completeMatch) {
    sendJson(ctx.res, 200, requireUploadService(ctx).complete(completeMatch[1]));
    return true;
  }
  if (ctx.req.method === "GET" && uploadMatch) {
    sendJson(ctx.res, 200, requireUploadService(ctx).read(uploadMatch[1]));
    return true;
  }
  if (ctx.req.method !== "DELETE" || !uploadMatch) return false;
  sendJson(ctx.res, 200, requireUploadService(ctx).remove(uploadMatch[1]));
  return true;
}

function requireConfigService(ctx, message) {
  if (ctx.configService) return ctx.configService;
  throw Object.assign(new Error(message), { statusCode: 503 });
}

async function handleConfig(ctx) {
  if (ctx.url.pathname !== "/config") return false;
  if (ctx.req.method === "GET") {
    sendJson(ctx.res, 200, publicConfig(ctx.jobManager.getConfig()));
    return true;
  }
  if (ctx.req.method !== "PATCH") return false;
  const service = requireConfigService(ctx, "Config updates are not configured.");
  sendJson(ctx.res, 200, publicConfig(service.update(await readJsonBody(ctx.req))));
  return true;
}

async function handleConfigReset(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/config/reset") return false;
  const service = requireConfigService(ctx, "Config reset is not configured.");
  sendJson(ctx.res, 200, publicConfig(service.reset()));
  return true;
}

function validateCleanupTargets(res, targets) {
  const unsupported = targets.find((entry) => !CLEANUP_TARGETS.includes(entry));
  if (!unsupported) return true;
  sendJson(res, 400, { error: `Unsupported cleanup target: ${unsupported}.` });
  return false;
}

function normalizeCleanupTargets(body) {
  const rawTargets = Array.isArray(body.targets)
    ? body.targets
    : typeof body.targets === "string" ? [body.targets] : body.target ? [body.target] : CLEANUP_TARGETS;
  return rawTargets.includes("all") ? CLEANUP_TARGETS : rawTargets;
}

async function handleCleanupPreview(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/maintenance/cleanup/preview") return false;
  const target = ctx.url.searchParams.get("target") || "all";
  const targets = target === "all" ? CLEANUP_TARGETS : [target];
  if (!validateCleanupTargets(ctx.res, targets)) return true;
  const results = ctx.jobManager.runMaintenanceCleanup({ targets, dryRun: true });
  sendJson(ctx.res, 200, { dryRun: true, results });
  return true;
}

async function handleCleanup(ctx) {
  if (ctx.req.method !== "POST" || ctx.url.pathname !== "/maintenance/cleanup") return false;
  const body = await readJsonBody(ctx.req).catch(() => ({}));
  const targets = normalizeCleanupTargets(body);
  if (!validateCleanupTargets(ctx.res, targets)) return true;
  const dryRun = body.dryRun !== undefined ? Boolean(body.dryRun) : false;
  const results = ctx.jobManager.runMaintenanceCleanup({ targets, dryRun, overrides: body || {} });
  sendJson(ctx.res, 200, { dryRun, results });
  return true;
}

async function handleRuntimeStatus(ctx) {
  if (ctx.req.method !== "GET" || ctx.url.pathname !== "/runtime/status") return false;
  sendJson(ctx.res, 200, await ctx.jobManager.getRuntimeStatus());
  return true;
}

const SYSTEM_ROUTE_HANDLERS = [
  handleHealthAndReadiness,
  handleUploadWrite,
  handleUploadLifecycle,
  handleConfig,
  handleConfigReset,
  handleCleanupPreview,
  handleCleanup,
  handleRuntimeStatus,
];

async function handleSystemRoutes(ctx) {
  for (const handler of SYSTEM_ROUTE_HANDLERS) {
    if (await handler(ctx)) return true;
  }
  return false;
}

module.exports = { handleSystemRoutes };
