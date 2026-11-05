function applyManagedMangaProcessorBaseUrl(ctx, baseUrl) {
  if (!baseUrl) return;
  ctx.jobManager.resolvedConfig.api = { ...(ctx.jobManager.resolvedConfig.api || {}), baseUrl };
  ctx.jobManager?.engine?.mangaProcessor?.setDefaultBaseUrl?.(baseUrl);
}

module.exports = { applyManagedMangaProcessorBaseUrl };
