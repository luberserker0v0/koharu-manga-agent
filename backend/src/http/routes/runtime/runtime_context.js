function applyManagedKoharuBaseUrl(ctx, baseUrl) {
  if (!baseUrl) return;
  ctx.jobManager.resolvedConfig.api = { ...(ctx.jobManager.resolvedConfig.api || {}), baseUrl };
  const client = ctx.jobManager?.engine?.projectLifecycle?.client;
  if (client) client.defaultBaseUrl = baseUrl;
}

module.exports = { applyManagedKoharuBaseUrl };
