const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { URL } = require("url");
const { config, DATA_ROOT } = require("../../config");
const { AOClient } = require("../../integrations/ao/client/ao_client");
const { loadAoAssets } = require("../../integrations/ao/assets/ao_assets");
const { validateConfigPatch } = require("../../config_service");
const { normalizeLanguageTag } = require("../../language_codes");
const {
  loadCanonicalGlossary,
  loadCandidateTerms,
  loadStoryContext,
  loadStyleEvidence,
  loadStyleProfile,
  loadTranslationContext,
} = require("../../domains/knowledge/assets/knowledge_assets");
const { resolveKnowledgeAssetPaths } = require("../../domains/knowledge/registry/knowledge_paths");
const {
  assertTranslationMemoryReady,
  composeTranslationMemory,
} = require("../../domains/translation/memory/translation_memory");
const {
  deleteReferenceExtraction,
  deleteReferenceSet,
  importPostEditReference,
  importReferenceFolder,
  loadReferenceManifest,
  listReferenceSets,
} = require("../../domains/reference/sets/reference_sets");
const {
  clearTranslatorIngestionData,
  createChapterRecord,
  createMangaRecord,
  createTranslatorProfile,
  deleteChapterRecord,
  deleteMangaRecord,
  deleteTranslatorProfile,
  listChapterRegistry,
  listKnowledgeSeries,
  loadKnowledgeIndex,
  reconcileReferenceBindings,
  updateChapterRecord,
  reorderChapterRegistry,
} = require("../../domains/knowledge/registry/knowledge_paths");
const {
  inspectChapterObservation,
} = require("../../domains/reference/observation/reference_observation");
const { buildLearningEvidenceSnapshot } = require("../../domains/knowledge/learning/learning_evidence");
const { deleteChapterLearningData } = require("../../domains/knowledge/learning/knowledge");
const {
  assertNoActiveJobs,
  deleteBoundReferenceData,
  hydrateReferenceDisplayLabels,
  matchingReferenceJobs,
  permanentlyDeleteMatchingJobs,
  resolveMangaDisplayLabel,
} = require("../routes/reference/reference_management");
const {
  SSE_HEARTBEAT_INTERVAL_MS,
  badRequest,
  beginSseHeartbeat,
  conflict,
  notFound,
  readJsonBody,
  sendJson,
  writeJobStreamEvent,
  writeSseEvent,
} = require("./http_helpers");

function normalizeQualityPreviewTranslations(translations) {
  return (Array.isArray(translations) ? translations : []).map((entry) => ({
    nodeId:
      typeof entry?.nodeId === "string" && entry.nodeId
        ? entry.nodeId
        : typeof entry?.id === "string" && entry.id
          ? entry.id
          : null,
    pageName: typeof entry?.pageName === "string" ? entry.pageName : null,
    original: typeof entry?.original === "string" ? entry.original : null,
    currentTranslation:
      typeof entry?.currentTranslation === "string"
        ? entry.currentTranslation
        : typeof entry?.translation === "string"
          ? entry.translation
          : null,
  }));
}

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

function artifactContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".json": return "application/json";
    case ".zip": return "application/zip";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function resolveDownloadableArtifact(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const resolvedRoot = fs.realpathSync(DATA_ROOT);
  const resolvedFile = fs.realpathSync(filePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolvedFile;
}

function createApiServer({
  jobManager,
  sourcePreflightModule,
  postEditWorkspaceModule,
  extractionReviewService = null,
  configService = null,
  aoClientFactory = (options) => new AOClient(options),
  aoAssetsLoader = loadAoAssets,
  translationMemoryComposer = composeTranslationMemory,
  uploadService = null,
  translatedImageService = null,
  host,
  port,
  serverConfig = {},
}) {
  const allowedOrigins = Array.isArray(serverConfig.corsAllowedOrigins)
    ? serverConfig.corsAllowedOrigins.map(String)
    : [];
  const authToken = serverConfig.authToken || null;
  const maxJsonBodyBytes = Number(serverConfig.maxJsonBodyBytes || 1048576);
  const qualityModule = jobManager?.engine?.qualityModule || null;
  const knowledgeModule = jobManager?.engine?.knowledgeModule || null;
  const resolvedPostEditWorkspaceModule =
    postEditWorkspaceModule ||
    {
      load() {
        throw new Error("Post-edit workspace module is not configured.");
      },
      save() {
        throw new Error("Post-edit workspace module is not configured.");
      },
    };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/v1") url.pathname = "/";
    else if (url.pathname.startsWith("/api/v1/")) url.pathname = url.pathname.slice(7);
    req.maxJsonBodyBytes = maxJsonBodyBytes;
    res.setHeader("X-Request-Id", crypto.randomUUID());
    if (!applyCors(req, res, allowedOrigins)) {
      sendJson(res, 403, { error: "Origin is not allowed." });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname !== "/health" && !authorized(req, authToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/uploads") {
        if (!uploadService) throw Object.assign(new Error("Upload service is unavailable."), { statusCode: 503 });
        sendJson(res, 201, uploadService.create(await readJsonBody(req)));
        return;
      }

      const uploadFileMatch = url.pathname.match(/^\/uploads\/([^/]+)\/files\/([^/]+)$/);
      if (req.method === "PUT" && uploadFileMatch) {
        if (!uploadService) throw Object.assign(new Error("Upload service is unavailable."), { statusCode: 503 });
        const file = await uploadService.putFile(uploadFileMatch[1], uploadFileMatch[2], req);
        sendJson(res, 201, { uploadId: uploadFileMatch[1], file });
        return;
      }

      const uploadCompleteMatch = url.pathname.match(/^\/uploads\/([^/]+)\/complete$/);
      if (req.method === "POST" && uploadCompleteMatch) {
        sendJson(res, 200, uploadService.complete(uploadCompleteMatch[1]));
        return;
      }

      const uploadMatch = url.pathname.match(/^\/uploads\/([^/]+)$/);
      if (req.method === "GET" && uploadMatch) {
        sendJson(res, 200, uploadService.read(uploadMatch[1]));
        return;
      }
      if (req.method === "DELETE" && uploadMatch) {
        sendJson(res, 200, uploadService.remove(uploadMatch[1]));
        return;
      }

      if (req.method === "GET" && url.pathname === "/config") {
        sendJson(res, 200, publicConfig(jobManager.getConfig()));
        return;
      }

      if (req.method === "PATCH" && url.pathname === "/config") {
        if (!configService) throw Object.assign(new Error("Config updates are not configured."), { statusCode: 503 });
        sendJson(res, 200, publicConfig(configService.update(await readJsonBody(req))));
        return;
      }

      if (req.method === "POST" && url.pathname === "/config/reset") {
        if (!configService) throw Object.assign(new Error("Config reset is not configured."), { statusCode: 503 });
        sendJson(res, 200, publicConfig(configService.reset()));
        return;
      }

      const publicationMatch = url.pathname.match(/^\/translation-publications\/([^/]+)$/);
      if (req.method === "GET" && publicationMatch) {
        const translatorId = url.searchParams.get("translatorId");
        if (!translatorId) {
          sendJson(res, 400, { error: "translatorId is required." });
          return;
        }
        const registry = jobManager.engine.translationPublicationService.load(
          decodeURIComponent(publicationMatch[1]),
          translatorId
        );
        const chapterId = url.searchParams.get("chapterId");
        sendJson(res, 200, chapterId ? registry.chapters[chapterId] || null : registry);
        return;
      }

      if (req.method === "GET" && url.pathname === "/runtime/status") {
        sendJson(res, 200, await jobManager.getRuntimeStatus());
        return;
      }

      if (req.method === "POST" && ["/runtime/ao/connect", "/runtime/ao/providers"].includes(url.pathname)) {
        const body = await readJsonBody(req);
        const effectiveAgent = jobManager.getConfig()?.agent || {};
        const baseUrl = body.baseUrl || effectiveAgent.baseUrl;
        const apiKey = body.apiKey === undefined ? effectiveAgent.apiKey || null : body.apiKey || null;
        validateConfigPatch({ agent: { baseUrl, apiKey } });
        const aoClient = aoClientFactory({
          baseUrl,
          apiKey,
          readyPollIntervalMs: effectiveAgent.readyPollIntervalMs || 1000,
          readyTimeoutMs: effectiveAgent.readyTimeoutMs || 30000,
        });
        if (url.pathname === "/runtime/ao/connect") {
          sendJson(res, 200, await aoClient.checkAvailability({ timeoutMs: 5000 }));
          return;
        }

        let conversationId = null;
        try {
          const conversation = await aoClient.createConversation();
          conversationId = conversation.id;
          await aoClient.writeConfig(conversationId, aoAssetsLoader().opencodeConfig);
          await aoClient.startConversation(conversationId);
          await aoClient.waitUntilReady(conversationId);
          const result = await aoClient.listProviders(conversationId);
          const providers = Array.isArray(result?.providers) ? result.providers : [];
          const models = providers.flatMap((provider) => {
            if (!provider?.id) return [];
            const entries = Array.isArray(provider.models)
              ? provider.models
              : provider.models && typeof provider.models === "object" ? Object.values(provider.models) : [];
            return entries.map((entry) => {
              const modelId = typeof entry === "string" ? entry : entry?.id;
              if (!modelId) return null;
              return {
                id: `${provider.id}/${modelId}`,
                providerId: provider.id,
                providerName: provider.name || provider.id,
                modelId,
                name: typeof entry === "object" ? entry.name || modelId : modelId,
              };
            }).filter(Boolean);
          });
          sendJson(res, 200, { baseUrl, providers, models, defaults: result?.default || {} });
        } finally {
          if (conversationId) await aoClient.deleteConversation(conversationId).catch(() => {});
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/runtime/koharu/engines") {
        const client = jobManager?.engine?.projectLifecycle?.client;
        if (!client?.getEngines) throw new Error("Koharu client is not configured.");
        const baseUrlOverride = url.searchParams.get("baseUrl");
        if (!baseUrlOverride && jobManager.koharuRuntimeManager) {
          const status = await jobManager.koharuRuntimeManager.ensureRunning();
          if (status?.baseUrl) {
            jobManager.resolvedConfig.api = { ...(jobManager.resolvedConfig.api || {}), baseUrl: status.baseUrl };
            client.defaultBaseUrl = status.baseUrl;
          }
        }
        const baseUrl = baseUrlOverride || jobManager.koharuRuntimeManager?.baseUrl || jobManager.resolvedConfig?.api?.baseUrl;
        sendJson(res, 200, { engines: await client.getEngines(baseUrl) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/runtime/koharu/paths") {
        if (!jobManager.koharuRuntimeManager) throw new Error("Managed Koharu runtime is not configured.");
        const client = jobManager?.engine?.projectLifecycle?.client || null;
        const baseUrl = url.searchParams.get("baseUrl") || jobManager.koharuRuntimeManager?.baseUrl || jobManager.resolvedConfig?.api?.baseUrl;
        sendJson(res, 200, {
          koharu: await jobManager.koharuRuntimeManager.inspectPaths({ client, baseUrl }),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/runtime/koharu/install") {
        if (!jobManager.koharuRuntimeManager) throw new Error("Managed Koharu runtime is not configured.");
        sendJson(res, 200, { koharu: await jobManager.koharuRuntimeManager.ensureInstalled() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/runtime/koharu/start") {
        if (!jobManager.koharuRuntimeManager) throw new Error("Managed Koharu runtime is not configured.");
        const status = await jobManager.koharuRuntimeManager.ensureRunning();
        if (status?.baseUrl) {
          jobManager.resolvedConfig.api = { ...(jobManager.resolvedConfig.api || {}), baseUrl: status.baseUrl };
          const client = jobManager?.engine?.projectLifecycle?.client;
          if (client) client.defaultBaseUrl = status.baseUrl;
        }
        sendJson(res, 200, { koharu: status });
        return;
      }

      if (req.method === "POST" && url.pathname === "/runtime/koharu/prepare") {
        if (!jobManager.koharuRuntimeManager) throw new Error("Managed Koharu runtime is not configured.");
        sendJson(res, 200, { koharu: await jobManager.koharuRuntimeManager.prepareRuntime() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/runtime/koharu/stop") {
        if (!jobManager.koharuRuntimeManager) throw new Error("Managed Koharu runtime is not configured.");
        sendJson(res, 200, { koharu: await jobManager.koharuRuntimeManager.stopManaged() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/references") {
        sendJson(res, 200, {
          referenceSets: hydrateReferenceDisplayLabels(listReferenceSets()),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/references/import") {
        const body = await readJsonBody(req);
        const sourceFolder = body.uploadId
          ? uploadService.resolveDirectory(body.uploadId, "reference")
          : body.sourceFolder;
        const mangaId = body.mangaId || null;
        const referenceSet = importReferenceFolder({
          sourceFolder,
          label: body.label,
          language: normalizeLanguageTag(body.language),
          source: body.source || "imported_folder",
          referenceKind: body.referenceKind || "translator",
          mangaId,
          mangaLabel: resolveMangaDisplayLabel(mangaId, body.mangaLabel || null),
          translatorId: body.translatorId || null,
          translatorLabel: body.translatorLabel || body.translator || null,
          chapterId: body.chapterId || null,
          chapterTitle: body.chapterTitle || body.chapterLabel || null,
        });
        sendJson(res, 201, {
          referenceSet,
        });
        return;
      }

      const extractionReviewMatch = url.pathname.match(/^\/references\/([^/]+)\/extraction-review$/);
      if (req.method === "GET" && extractionReviewMatch) {
        if (!extractionReviewService) throw new Error("Extraction review service is not configured.");
        const review = extractionReviewService.get(extractionReviewMatch[1]);
        if (!review) {
          notFound(res);
        } else {
          sendJson(res, 200, { review });
        }
        return;
      }

      const extractionReviewSessionMatch = url.pathname.match(
        /^\/references\/([^/]+)\/extraction-review\/session$/
      );
      if (extractionReviewSessionMatch && ["POST", "DELETE"].includes(req.method)) {
        if (!extractionReviewService) throw new Error("Extraction review service is not configured.");
        const referenceSetId = extractionReviewSessionMatch[1];
        if (req.method === "POST") {
          if (jobManager.koharuRuntimeManager) {
            const status = await jobManager.koharuRuntimeManager.ensureRunning();
            if (status?.baseUrl) {
              jobManager.resolvedConfig.api = { ...(jobManager.resolvedConfig.api || {}), baseUrl: status.baseUrl };
              const client = jobManager?.engine?.projectLifecycle?.client;
              if (client) client.defaultBaseUrl = status.baseUrl;
              if (extractionReviewService) extractionReviewService.baseUrl = status.baseUrl;
            }
          }
          sendJson(res, 201, { review: await extractionReviewService.start(referenceSetId) });
        } else {
          const body = await readJsonBody(req);
          sendJson(res, 200, {
            review: await extractionReviewService.cancel(referenceSetId, body.sessionId),
          });
        }
        return;
      }

      const extractionReviewSyncMatch = url.pathname.match(
        /^\/references\/([^/]+)\/extraction-review\/session\/sync$/
      );
      if (req.method === "POST" && extractionReviewSyncMatch) {
        if (!extractionReviewService) throw new Error("Extraction review service is not configured.");
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          review: await extractionReviewService.sync(extractionReviewSyncMatch[1], body.sessionId),
        });
        return;
      }

      const extractionReviewFinishMatch = url.pathname.match(
        /^\/references\/([^/]+)\/extraction-review\/session\/finish$/
      );
      if (req.method === "POST" && extractionReviewFinishMatch) {
        if (!extractionReviewService) throw new Error("Extraction review service is not configured.");
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          review: await extractionReviewService.finish(extractionReviewFinishMatch[1], body.sessionId),
        });
        return;
      }

      const extractionReviewOrderMatch = url.pathname.match(
        /^\/references\/([^/]+)\/extraction-review\/order$/
      );
      if (req.method === "PUT" && extractionReviewOrderMatch) {
        if (!extractionReviewService) throw new Error("Extraction review service is not configured.");
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          review: extractionReviewService.saveOrder(extractionReviewOrderMatch[1], body.pages),
        });
        return;
      }

      const extractionReviewConfirmMatch = url.pathname.match(
        /^\/references\/([^/]+)\/extraction-review\/confirm$/
      );
      if (req.method === "POST" && extractionReviewConfirmMatch) {
        if (!extractionReviewService) throw new Error("Extraction review service is not configured.");
        sendJson(res, 200, {
          review: extractionReviewService.confirm(extractionReviewConfirmMatch[1]),
        });
        return;
      }

      const referenceDeleteMatch = url.pathname.match(/^\/references\/([^/]+)$/);
      if (req.method === "DELETE" && referenceDeleteMatch) {
        const referenceSetId = referenceDeleteMatch[1];
        const jobs = matchingReferenceJobs(
          jobManager,
          (job) => job.payload?.referenceSetId === referenceSetId
        );
        assertNoActiveJobs(jobs);
        const deletedJobs = permanentlyDeleteMatchingJobs(
          jobManager,
          (job) => jobs.some((candidate) => candidate.id === job.id)
        );
        const deleted = deleteReferenceSet(referenceSetId);
        sendJson(res, 200, { deleted, deletedJobs });
        return;
      }

      const referenceExtractionDeleteMatch = url.pathname.match(/^\/references\/([^/]+)\/extraction$/);
      if (req.method === "DELETE" && referenceExtractionDeleteMatch) {
        const referenceSetId = referenceExtractionDeleteMatch[1];
        const deletedExtraction = deleteReferenceExtraction(referenceSetId);
        const deletedJobs = permanentlyDeleteMatchingJobs(
          jobManager,
          (job) =>
            job.type === "reference_extraction" &&
            typeof job.payload?.referenceSetId === "string" &&
            job.payload.referenceSetId === referenceSetId
        );
        sendJson(res, 200, {
          deletedExtraction,
          deletedJobs,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/manga") {
        const referenceSets = listReferenceSets();
        sendJson(res, 200, {
          series: reconcileReferenceBindings(referenceSets),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/manga") {
        const body = await readJsonBody(req);
        const created = createMangaRecord({
          label: body.label,
          language: normalizeLanguageTag(body.language),
        });
        sendJson(res, 201, { manga: created });
        return;
      }

      const mangaDeleteMatch = url.pathname.match(/^\/manga\/([^/]+)$/);
      if (req.method === "DELETE" && mangaDeleteMatch) {
        const mangaId = mangaDeleteMatch[1];
        const referenceData = deleteBoundReferenceData(jobManager, { mangaId });
        const deletedRevisionCount = jobManager.store.deleteKnowledgeRevisions({
          mangaId,
          allTranslators: true,
        });
        sendJson(res, 200, {
          deleted: deleteMangaRecord({
            mangaId,
          }),
          deletedRevisionCount,
          ...referenceData,
        });
        return;
      }

      const createTranslatorMatch = url.pathname.match(/^\/manga\/([^/]+)\/translators$/);
      if (req.method === "POST" && createTranslatorMatch) {
        const body = await readJsonBody(req);
        const created = createTranslatorProfile({
          mangaId: createTranslatorMatch[1],
          label: body.label,
          language: normalizeLanguageTag(body.language),
          styleSourceTranslatorId: body.styleSourceTranslatorId || null,
        });
        sendJson(res, 201, { translator: created });
        return;
      }

      const deleteTranslatorMatch = url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)$/);
      if (req.method === "DELETE" && deleteTranslatorMatch) {
        const mangaId = deleteTranslatorMatch[1];
        const translatorId = deleteTranslatorMatch[2];
        const referenceData = deleteBoundReferenceData(jobManager, { mangaId, translatorId });
        const deletedRevisionCount = jobManager.store.deleteKnowledgeRevisions({
          mangaId,
          translatorId,
        });
        sendJson(res, 200, {
          deleted: deleteTranslatorProfile({
            mangaId,
            translatorId,
          }),
          deletedRevisionCount,
          ...referenceData,
        });
        return;
      }

      const chapterListMatch = url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)\/chapters$/);
      if (req.method === "GET" && chapterListMatch) {
        sendJson(res, 200, {
          chapters: listChapterRegistry({
            mangaId: chapterListMatch[1],
            translatorId: chapterListMatch[2],
          }),
        });
        return;
      }

      if (req.method === "POST" && chapterListMatch) {
        const body = await readJsonBody(req);
        const created = createChapterRecord({
          mangaId: chapterListMatch[1],
          translatorId: chapterListMatch[2],
          chapterTitle: body.chapterTitle || null,
        });
        sendJson(res, 201, { chapter: created });
        return;
      }

      const chapterReorderMatch = url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)\/chapters\/reorder$/);
      if (req.method === "POST" && chapterReorderMatch) {
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          chapters: reorderChapterRegistry({
            mangaId: chapterReorderMatch[1],
            translatorId: chapterReorderMatch[2],
            orderedChapterIds: body.orderedChapterIds,
          }),
        });
        return;
      }

      const chapterUpdateMatch = url.pathname.match(/^\/manga\/([^/]+)\/translators\/([^/]+)\/chapters\/([^/]+)$/);
      if (req.method === "POST" && chapterUpdateMatch) {
        const body = await readJsonBody(req);
        const updated = updateChapterRecord({
          mangaId: chapterUpdateMatch[1],
          translatorId: chapterUpdateMatch[2],
          chapterId: chapterUpdateMatch[3],
          chapterTitle: body.chapterTitle || null,
        });
        sendJson(res, 200, { chapter: updated });
        return;
      }
      if (req.method === "DELETE" && chapterUpdateMatch) {
        const mangaId = chapterUpdateMatch[1];
        const translatorId = chapterUpdateMatch[2];
        const chapterId = chapterUpdateMatch[3];
        const chapterExists = listChapterRegistry({ mangaId, translatorId })
          .some((chapter) => chapter.chapterId === chapterId);
        if (!chapterExists) {
          notFound(res);
          return;
        }
        const allJobs = jobManager.listJobsWithDeleted();
        const matchingJobIds = new Set(allJobs.filter((job) =>
          job.payload?.mangaId === mangaId &&
          job.payload?.translatorId === translatorId &&
          job.payload?.chapterId === chapterId
        ).map((job) => job.id));
        let foundRelatedJob = true;
        while (foundRelatedJob) {
          foundRelatedJob = false;
          for (const job of allJobs) {
            if (!matchingJobIds.has(job.id) && matchingJobIds.has(job.parentJobId)) {
              matchingJobIds.add(job.id);
              foundRelatedJob = true;
            }
          }
        }
        const matchingJobs = allJobs.filter((job) => matchingJobIds.has(job.id));
        assertNoActiveJobs(matchingJobs);
        const boundReferences = listReferenceSets().filter((entry) =>
          entry.mangaId === mangaId &&
          entry.translatorId === translatorId &&
          entry.chapterId === chapterId
        );
        const deletedPublication = jobManager.engine?.translationPublicationService?.deleteChapter(
          mangaId,
          translatorId,
          chapterId
        ) || { deleted: false, chapterId, revisionCount: 0 };
        const deletedLearningData = deleteChapterLearningData({ mangaId, translatorId, chapterId });
        const deletedRevisionCount = jobManager.store.deleteKnowledgeRevisions({
          mangaId,
          translatorId,
          chapterId,
        });
        const deletedReferences = boundReferences.map((entry) => deleteReferenceSet(entry.id));
        const deleted = deleteChapterRecord({ mangaId, translatorId, chapterId });
        const deletedJobs = permanentlyDeleteMatchingJobs(
          jobManager,
          (job) => matchingJobIds.has(job.id)
        );
        sendJson(res, 200, {
          deleted,
          deletedPublication,
          deletedLearningData,
          deletedRevisionCount,
          deletedReferences,
          deletedJobs,
        });
        return;
      }

      const observationMatch = url.pathname.match(/^\/references\/([^/]+)\/observation$/);
      if (req.method === "GET" && observationMatch) {
        sendJson(res, 200, inspectChapterObservation(observationMatch[1]));
        return;
      }

      const observationRebuildMatch = url.pathname.match(/^\/references\/([^/]+)\/observation\/rebuild$/);
      if (req.method === "POST" && observationRebuildMatch) {
        const manifest = loadReferenceManifest(observationRebuildMatch[1]);
        const job = jobManager.createReferenceObservationJob({
          referenceSetId: manifest.id,
          mangaId: manifest.mangaId || null,
          translatorId: manifest.translatorId || null,
          chapterId: manifest.chapterId,
          chapterTitle: manifest.chapterTitle || manifest.label,
          force: true,
        });
        sendJson(res, 202, job);
        return;
      }

      const deepReviewMatch = url.pathname.match(/^\/references\/([^/]+)\/deep-review$/);
      if (req.method === "POST" && deepReviewMatch) {
        const manifest = loadReferenceManifest(deepReviewMatch[1]);
        const body = await readJsonBody(req);
        const job = jobManager.createReferenceDeepReviewJob({
          referenceSetId: manifest.id,
          mangaId: manifest.mangaId || null,
          translatorId: manifest.translatorId || null,
          chapterId: manifest.chapterId,
          chapterTitle: manifest.chapterTitle || manifest.label,
          nodeKeys: Array.isArray(body.nodeKeys) ? body.nodeKeys : [],
          reviewReason: body.reviewReason || "manual_review",
        });
        sendJson(res, 202, job);
        return;
      }

      const bilingualEvidenceMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/bilingual-evidence$/);
      if (req.method === "GET" && bilingualEvidenceMatch) {
        const translatorId = url.searchParams.get("translatorId");
        if (!translatorId) {
          badRequest(res, "translatorId is required.");
          return;
        }
        sendJson(res, 200, jobManager.engine.referenceBilingualEnrichmentModule.load({
          mangaId: bilingualEvidenceMatch[1],
          translatorId,
        }));
        return;
      }

      const bilingualRunMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/bilingual-enrichment$/);
      if (req.method === "POST" && bilingualRunMatch) {
        const translatorId = url.searchParams.get("translatorId");
        if (!translatorId) {
          badRequest(res, "translatorId is required.");
          return;
        }
        const module = jobManager.engine.referenceBilingualEnrichmentModule;
        const prerequisites = module.inspectPrerequisites({
          mangaId: bilingualRunMatch[1],
          translatorId,
        });
        const job = jobManager.createReferenceBilingualEnrichmentJob({
          mangaId: bilingualRunMatch[1],
          translatorId,
          sourceFingerprint: prerequisites.source.fingerprint,
          targetFingerprint: prerequisites.target.fingerprint,
          trigger: "manual",
        });
        sendJson(res, 202, job);
        return;
      }

      const bilingualLinkMatch = url.pathname.match(
        /^\/knowledge\/([^/]+)\/bilingual-evidence\/links\/([^/]+)$/
      );
      if (req.method === "PUT" && bilingualLinkMatch) {
        const translatorId = url.searchParams.get("translatorId");
        if (!translatorId) {
          badRequest(res, "translatorId is required.");
          return;
        }
        const body = await readJsonBody(req);
        sendJson(res, 200, jobManager.engine.referenceBilingualEnrichmentModule.updateLink({
          mangaId: bilingualLinkMatch[1],
          translatorId,
          linkId: bilingualLinkMatch[2],
          action: body.action,
          sourceNodeKeys: body.sourceNodeKeys,
          targetNodeKeys: body.targetNodeKeys,
        }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/jobs") {
        const includeDeleted = url.searchParams.get("includeDeleted") === "1";
        sendJson(res, 200, {
          jobs: includeDeleted ? jobManager.listJobsWithDeleted() : jobManager.listJobs(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/jobs/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        const stopHeartbeat = beginSseHeartbeat(res);
        const useMessageEnvelope = url.searchParams.get("eventMode") === "message";
        writeJobStreamEvent(res, "jobs.snapshot", {
          kind: "snapshot",
          type: "jobs.snapshot",
          jobs: jobManager.listJobsWithDeleted(),
          createdAt: new Date().toISOString(),
        }, useMessageEnvelope);

        const unsubscribe = jobManager.subscribeAll((message) => {
          writeJobStreamEvent(res, message.type, message, useMessageEnvelope);
        });

        req.on("close", () => {
          stopHeartbeat();
          unsubscribe();
          res.end();
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/translation") {
        const body = await readJsonBody(req);
        if (!["quick", "reference_style", "local_style", "learning_style"].includes(body.translationMode)) {
          badRequest(res, "translationMode must be quick, reference_style, local_style, or learning_style.");
          return;
        }
        const obsoleteFields = ["referenceSetId", "ingestReference", "knowledgeBuilder"]
          .filter((field) => Object.prototype.hasOwnProperty.call(body, field));
        if (obsoleteFields.length > 0) {
          badRequest(res, `Obsolete translation payload fields are not supported: ${obsoleteFields.join(", ")}.`);
          return;
        }
        const missingBindings = ["mangaId", "translatorId", "chapterId"]
          .filter((field) => !body[field] || !String(body[field]).trim());
        if (missingBindings.length > 0) {
          badRequest(res, `Translation jobs require output bindings: ${missingBindings.join(", ")}.`);
          return;
        }
        if (body.mangaId && body.translatorId && body.chapterId) {
          const duplicate = jobManager.listJobs().find((job) =>
            job.type === "translation" &&
            job.payload?.mangaId === body.mangaId &&
            job.payload?.translatorId === body.translatorId &&
            job.payload?.chapterId === body.chapterId &&
            !["succeeded", "failed", "canceled", "blocked"].includes(job.status)
          );
          if (duplicate) {
            conflict(res, `Translation job ${duplicate.id} is already active for this chapter.`);
            return;
          }
        }
        await jobManager.assertAgentAvailableForTranslation?.(body);
        const job = jobManager.createTranslationJob(body);
        sendJson(res, 202, job);
        return;
      }

      const deepAuditMatch = url.pathname.match(/^\/jobs\/([^/]+)\/deep-audit$/);
      if (req.method === "POST" && deepAuditMatch) {
        const job = jobManager.createTranslationDeepAuditJob(deepAuditMatch[1]);
        sendJson(res, 202, job);
        return;
      }

      const deepAuditReviewMatch = url.pathname.match(/^\/jobs\/([^/]+)\/deep-audit\/review$/);
      if (req.method === "GET" && deepAuditReviewMatch) {
        const job = jobManager.getJob(deepAuditReviewMatch[1]);
        if (!job) { notFound(res); return; }
        const packagePath = job.result?.deepAuditReviewPackagePath;
        if (!packagePath || !fs.existsSync(packagePath)) { notFound(res); return; }
        sendJson(res, 200, JSON.parse(fs.readFileSync(packagePath, "utf8")));
        return;
      }

      const deepAuditApplyMatch = url.pathname.match(/^\/jobs\/([^/]+)\/deep-audit\/apply$/);
      if (req.method === "POST" && deepAuditApplyMatch) {
        const body = await readJsonBody(req);
        const job = jobManager.createTranslationDeepAuditApplyJob(deepAuditApplyMatch[1], body.decisions);
        sendJson(res, 202, job);
        return;
      }

      const qualityRepairMatch = url.pathname.match(/^\/jobs\/([^/]+)\/quality-repair$/);
      if (req.method === "POST" && qualityRepairMatch) {
        const sourceJob = jobManager.getJob(qualityRepairMatch[1]);
        if (!sourceJob) { notFound(res); return; }
        await jobManager.assertAgentAvailableForTranslation?.(sourceJob.payload);
        await jobManager.preflightTranslationQualityRepair(qualityRepairMatch[1]);
        const job = jobManager.createTranslationQualityRepairJob(qualityRepairMatch[1]);
        sendJson(res, 202, job);
        return;
      }

      const knowledgeRetryMatch = url.pathname.match(/^\/jobs\/([^/]+)\/knowledge-retry$/);
      if (req.method === "POST" && knowledgeRetryMatch) {
        const job = jobManager.createTranslationKnowledgeRetryJob(knowledgeRetryMatch[1]);
        sendJson(res, 202, job);
        return;
      }

      if (req.method === "POST" && url.pathname === "/translation/memory/inspect") {
        const body = await readJsonBody(req);
        const snapshot = translationMemoryComposer({
          translationMode: body.translationMode,
          qualityCheck: body.qualityCheck === true,
          mangaId: body.mangaId || null,
          translatorId: body.translatorId || null,
          referenceTranslatorId: body.referenceTranslatorId || null,
          chapterId: body.chapterId || null,
          chapterTitle: body.chapterTitle || null,
          sourceChapterId: body.sourceChapterId || null,
          glossaryMode: body.glossaryMode || "canonical",
          sourceLanguage: body.sourceLanguage || null,
          targetLanguage: body.targetLanguage || config.defaults.targetLanguage,
        });
        let blockingReason = null;
        try {
          assertTranslationMemoryReady(snapshot);
        } catch (error) {
          blockingReason = error.message;
        }
        sendJson(res, 200, {
          ready: !blockingReason,
          blockingReason,
          translationMode: snapshot.translationMode,
          policy: snapshot.policy,
          fingerprint: snapshot.fingerprint,
          chapterMapping: snapshot.chapterMapping,
          readiness: snapshot.readiness,
          usage: snapshot.usage,
          warnings: snapshot.warnings,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/source-preflight") {
        const body = await readJsonBody(req);
        const result = sourcePreflightModule.preflight({
          sourceFolder: body.uploadId
            ? uploadService.resolveDirectory(body.uploadId, "source")
            : body.sourceFolder,
        });
        sendJson(res, 200, result);
        return;
      }

      const preflightReorderMatch = url.pathname.match(/^\/source-preflight\/([^/]+)\/reorder$/);
      if (req.method === "POST" && preflightReorderMatch) {
        const body = await readJsonBody(req);
        const result = sourcePreflightModule.reorder({
          preflightId: preflightReorderMatch[1],
          orderedImageIds: body.orderedImageIds,
        });
        sendJson(res, 200, result);
        return;
      }

      const preflightMatch = url.pathname.match(/^\/source-preflight\/([^/]+)$/);
      if (req.method === "GET" && preflightMatch) {
        const result = sourcePreflightModule.get(preflightMatch[1]);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/reference-extraction") {
        const body = await readJsonBody(req);
        const job = jobManager.createReferenceExtractionJob(body);
        sendJson(res, 202, job);
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/reference-ingestion") {
        const body = await readJsonBody(req);
        if (!body.chapterId || !String(body.chapterId).trim()) {
          badRequest(res, "chapterId is required for reference ingestion jobs.");
          return;
        }
        if (body.useForTerminology === false && body.useForStyle === false) {
          badRequest(res, "Reference ingestion requires terminology or style usage to be enabled.");
          return;
        }
        const job = jobManager.createReferenceIngestionJob(body);
        sendJson(res, 202, job);
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/reference-ingestion/batch") {
        const body = await readJsonBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) {
          badRequest(res, "Reference ingestion batch requires at least one item.");
          return;
        }
        if (items.some((item) => !item.chapterId || !String(item.chapterId).trim())) {
          badRequest(res, "Every reference ingestion item requires chapterId.");
          return;
        }
        if (items.some((item) => item.useForTerminology === false && item.useForStyle === false)) {
          badRequest(res, "Every reference ingestion item requires terminology or style usage.");
          return;
        }
        const jobs = jobManager.createReferenceIngestionJobs(items);
        sendJson(res, 202, { jobs });
        return;
      }

      if (req.method === "POST" && url.pathname === "/translation/preview") {
        if (!qualityModule || !knowledgeModule) {
          sendJson(res, 503, { error: "Translation preview is not available." });
          return;
        }
        const body = await readJsonBody(req);
        const translations = Array.isArray(body.translations) ? body.translations : [];
        if (translations.length === 0) {
          badRequest(res, "translations is required.");
          return;
        }
        const translationMemory = translationMemoryComposer({
          translationMode: body.translationMode || "learning_style",
          qualityCheck: body.qualityCheck === true,
          mangaId: body.mangaId || null,
          translatorId: body.translatorId || null,
          referenceTranslatorId: body.referenceTranslatorId || null,
          chapterId: body.chapterId || null,
          chapterTitle: body.chapterTitle || null,
          sourceChapterId: body.sourceChapterId || null,
          glossaryMode: body.glossaryMode || "canonical",
          sourceLanguage: body.sourceLanguage || null,
          targetLanguage: body.targetLanguage || config.defaults.targetLanguage,
        });
        const quality = translationMemory.policy.runQuality
          ? await qualityModule.runPreview({
              mangaId: body.mangaId || null,
              translatorId: body.translatorId || null,
              chapterId: body.chapterId || null,
              glossaryMode: body.glossaryMode || "canonical",
              jobId: body.jobId || `translation_preview_${Date.now()}`,
              translations,
              translationMemory,
              sourceLanguage: body.sourceLanguage || translationMemory.languages?.sourceLanguage || null,
              targetLanguage: body.targetLanguage || config.defaults.targetLanguage,
            })
          : {
              originalTranslations: translations,
              revisedTranslations: translations,
              optimizedTranslations: [],
              skipped: true,
            };
        const previewLearningEvidence = translationMemory.policy.commitKnowledge
          ? buildLearningEvidenceSnapshot({
              sourceTranslationJobId: body.jobId || null,
              chapterId: body.chapterId || null,
              finalTranslationSnapshotPath: null,
              finalTranslations: quality.revisedTranslations,
              translationMemory,
              quality: quality.projectionPath ? {
                ...quality,
                projection: JSON.parse(fs.readFileSync(quality.projectionPath, "utf8")),
              } : quality,
            })
          : null;
        const knowledge = translationMemory.policy.commitKnowledge
          ? await knowledgeModule.preview({
              mangaId: body.mangaId || null,
              translatorId: body.translatorId || null,
              chapterId: body.chapterId || null,
              jobId: body.jobId || `translation_preview_${Date.now()}`,
              translations: [],
              learningEvidence: previewLearningEvidence,
            })
          : { persisted: false, skipped: true, delta: null };
        sendJson(res, 200, {
          translationMode: translationMemory.translationMode,
          contextUsage: {
            fingerprint: translationMemory.fingerprint,
            policy: translationMemory.policy,
            chapterMapping: translationMemory.chapterMapping,
            usage: translationMemory.usage,
          },
          originalTranslations: quality.originalTranslations,
          revisedTranslations: quality.revisedTranslations,
          qualityReport: quality,
          knowledgeDelta: knowledge,
          warnings: translationMemory.warnings,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/quality/preview") {
        if (!qualityModule || typeof qualityModule.runPreview !== "function") {
          sendJson(res, 503, { error: "Quality preview is not available." });
          return;
        }
        const body = await readJsonBody(req);
        const translations = Array.isArray(body.translations) ? body.translations : [];
        if (translations.length === 0) {
          badRequest(res, "translations is required.");
          return;
        }
        const preview = await qualityModule.runPreview({
          mangaId: body.mangaId || null,
          translatorId: body.translatorId || null,
          chapterId: body.chapterId || null,
          glossaryMode: body.glossaryMode || "canonical",
          jobId: body.jobId || null,
          translations,
        });
        sendJson(res, 200, {
          ...preview,
          inputPreview: normalizeQualityPreviewTranslations(preview.originalTranslations),
          revisedPreview: normalizeQualityPreviewTranslations(preview.revisedTranslations),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/post-edit-export") {
        const body = await readJsonBody(req);
        const job = jobManager.createPostEditExportJob(body);
        sendJson(res, 202, job);
        return;
      }

      const postEditMatch = url.pathname.match(/^\/post-edit\/([^/]+)$/);
      if (req.method === "GET" && postEditMatch) {
        const job = jobManager.getJob(postEditMatch[1]);
        if (!job) {
          notFound(res);
          return;
        }
        const document = resolvedPostEditWorkspaceModule.load(postEditMatch[1]);
        sendJson(res, 200, {
          exists: Boolean(document),
          editedScene: document,
        });
        return;
      }

      if (req.method === "POST" && postEditMatch) {
        const job = jobManager.getJob(postEditMatch[1]);
        if (!job) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          editedScene: resolvedPostEditWorkspaceModule.save(postEditMatch[1], body),
        });
        return;
      }

      const postEditReferenceMatch = url.pathname.match(/^\/post-edit\/([^/]+)\/reference-set$/);
      if (req.method === "POST" && postEditReferenceMatch) {
        const job = jobManager.getJob(postEditReferenceMatch[1]);
        if (!job) {
          notFound(res);
          return;
        }
        const editedScene = resolvedPostEditWorkspaceModule.load(postEditReferenceMatch[1]);
        if (!editedScene) {
          badRequest(res, "Post-edit document does not exist for this job.");
          return;
        }
        const body = await readJsonBody(req);
        const referenceSet = importPostEditReference({
          editedScene,
          label: body.label,
          language: body.language,
          source: "post_edit_document",
          referenceKind: body.referenceKind || "translator",
          mangaId: body.mangaId || editedScene.mangaId || null,
          mangaLabel: body.mangaLabel || null,
          translatorId: body.translatorId || null,
          translatorLabel: body.translatorLabel || null,
          chapterId: body.chapterId || editedScene.chapterId || null,
          chapterTitle: body.chapterTitle || null,
          sourceJobId: postEditReferenceMatch[1],
        });
        sendJson(res, 201, { referenceSet });
        return;
      }

      const glossaryMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/glossary$/);
      if (req.method === "GET" && glossaryMatch) {
        sendJson(res, 200, loadCanonicalGlossary(glossaryMatch[1], url.searchParams.get("translatorId")));
        return;
      }

      const styleMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/style-profile$/);
      if (req.method === "GET" && styleMatch) {
        sendJson(res, 200, loadStyleProfile(styleMatch[1], url.searchParams.get("translatorId")));
        return;
      }

      const storyMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/story-context$/);
      if (req.method === "GET" && storyMatch) {
        sendJson(res, 200, loadStoryContext(storyMatch[1], url.searchParams.get("translatorId")));
        return;
      }

      const candidateTermsMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/candidate-terms$/);
      if (req.method === "GET" && candidateTermsMatch) {
        sendJson(res, 200, loadCandidateTerms(candidateTermsMatch[1], url.searchParams.get("translatorId")));
        return;
      }

      const translationContextMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/translation-context$/);
      if (req.method === "GET" && translationContextMatch) {
        sendJson(
          res,
          200,
          loadTranslationContext(translationContextMatch[1], url.searchParams.get("translatorId"))
        );
        return;
      }

      const ingestionReportMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/ingestion-report$/);
      if (req.method === "GET" && ingestionReportMatch) {
        const mangaId = ingestionReportMatch[1];
        const translatorId = url.searchParams.get("translatorId");
        const knowledgeIndex = loadKnowledgeIndex();
        const seriesEntry = (knowledgeIndex.series || []).find((entry) => entry.mangaId === mangaId) || null;
        const translatorEntry =
          seriesEntry && translatorId
            ? (seriesEntry.translators || []).find((entry) => entry.translatorId === translatorId) || null
            : null;
        const referenceKind =
          translatorEntry && /^(原文|original|source)$/i.test(String(translatorEntry.label || "").trim())
            ? "source"
            : "translator";
        const paths = resolveKnowledgeAssetPaths({ mangaId, translatorId });
        const ingestionAssetPaths = [
          paths.glossaryPath,
          paths.candidateTermsPath,
          paths.storyContextPath,
          paths.styleEvidencePath,
          paths.styleProfilePath,
          paths.translationContextPath,
        ];
        const existingIngestionAssets = ingestionAssetPaths.filter((assetPath) => fs.existsSync(assetPath));
        const ingestionUpdatedAt = existingIngestionAssets.length > 0
          ? new Date(Math.max(...existingIngestionAssets.map((assetPath) => fs.statSync(assetPath).mtimeMs))).toISOString()
          : null;
        const reviewedReferences = listReferenceSets().filter(
          (entry) => entry.mangaId === mangaId && (!translatorId || entry.translatorId === translatorId)
        );
        const ingestionStale = Boolean(
          ingestionUpdatedAt && reviewedReferences.some(
            (entry) => {
              const extractionChangedAt = entry.reviewedAt || entry.extractionUpdatedAt;
              return extractionChangedAt && Date.parse(extractionChangedAt) > Date.parse(ingestionUpdatedAt);
            }
          )
        );
        const glossary = loadCanonicalGlossary(mangaId, translatorId);
        const candidateTerms = loadCandidateTerms(mangaId, translatorId);
        const storyContext = loadStoryContext(mangaId, translatorId);
        const styleEvidence = loadStyleEvidence(mangaId, translatorId);
        const styleProfile = loadStyleProfile(mangaId, translatorId);
        const translationContext = loadTranslationContext(mangaId, translatorId);
        const storyChapters = storyContext.chapters && typeof storyContext.chapters === "object"
          ? Object.values(storyContext.chapters)
          : [];
        const mentionCount = storyChapters.reduce((count, chapter) => {
          const items = chapter && typeof chapter === "object" && Array.isArray(chapter.mentions)
            ? chapter.mentions
            : [];
          return count + items.length;
        }, 0);
        const relationCount = storyChapters.reduce((count, chapter) => {
          const items = chapter && typeof chapter === "object" && Array.isArray(chapter.relationships)
            ? chapter.relationships
            : [];
          return count + items.length;
        }, 0);
        const eventCount = storyChapters.reduce((count, chapter) => {
          const items = chapter && typeof chapter === "object" && Array.isArray(chapter.events)
            ? chapter.events
            : [];
          return count + items.length;
        }, 0);
        const keyLineCount = storyChapters.reduce((count, chapter) => {
          const items = chapter && typeof chapter === "object" && Array.isArray(chapter.keyLines)
            ? chapter.keyLines
            : [];
          return count + items.length;
        }, 0);
        const effectiveStyleEvidence =
          referenceKind === "source"
            ? {
                metadata: styleEvidence?.metadata || {},
                chapters: {},
              }
            : styleEvidence;
        const effectiveStyleProfile =
          referenceKind === "source"
            ? {
                metadata: styleProfile?.metadata || {},
                rules: {},
                samples: {},
              }
            : styleProfile;
        sendJson(res, 200, {
          mangaId,
          translatorId: translatorId || null,
          referenceKind,
          ingestionAvailable: existingIngestionAssets.length > 0,
          ingestionUpdatedAt,
          ingestionStale,
          assets: {
            glossaryPath: paths.glossaryPath,
            candidateTermsPath: paths.candidateTermsPath,
            storyContextPath: paths.storyContextPath,
            styleEvidencePath: paths.styleEvidencePath,
            styleProfilePath: paths.styleProfilePath,
            translationContextPath: paths.translationContextPath,
          },
          summary: {
            glossaryEntries: Array.isArray(glossary.entries) ? glossary.entries.length : 0,
            acceptedTerminology: Array.isArray(glossary.entries)
              ? glossary.entries.filter((entry) => entry.category !== "character_name").length
              : 0,
            acceptedCharacters: Array.isArray(glossary.entries)
              ? glossary.entries.filter((entry) => entry.category === "character_name").length
              : 0,
            candidateTerms: Array.isArray(candidateTerms.entries)
              ? candidateTerms.entries.filter((entry) => entry.kind === "term" && entry.status === "candidate").length
              : 0,
            candidateCharacters: Array.isArray(candidateTerms.entries)
              ? candidateTerms.entries.filter((entry) => entry.kind === "character" && entry.status === "candidate").length
              : 0,
            storyChapters: storyContext.chapters ? Object.keys(storyContext.chapters).length : 0,
            storyMentions: referenceKind === "source" ? mentionCount : 0,
            storyRelations: referenceKind === "source" ? relationCount : 0,
            storyEvents: referenceKind === "source" ? eventCount : 0,
            storyKeyLines: referenceKind === "source" ? keyLineCount : 0,
            styleEvidenceChapters:
              referenceKind === "source"
                ? 0
                : effectiveStyleEvidence && effectiveStyleEvidence.chapters
                  ? Object.keys(effectiveStyleEvidence.chapters).length
                  : 0,
            styleDialogueSamples:
              referenceKind === "source"
                ? 0
                : effectiveStyleEvidence && effectiveStyleEvidence.chapters
                  ? Object.values(effectiveStyleEvidence.chapters).reduce((count, chapter) => {
                      const items =
                        chapter && typeof chapter === "object" && Array.isArray(chapter.dialogueSamples)
                          ? chapter.dialogueSamples
                          : [];
                      return count + items.filter(Boolean).length;
                    }, 0)
                  : 0,
            styleNarrationSamples:
              referenceKind === "source"
                ? 0
                : effectiveStyleEvidence && effectiveStyleEvidence.chapters
                  ? Object.values(effectiveStyleEvidence.chapters).reduce((count, chapter) => {
                      const items =
                        chapter && typeof chapter === "object" && Array.isArray(chapter.narrationSamples)
                          ? chapter.narrationSamples
                          : [];
                      return count + items.filter(Boolean).length;
                    }, 0)
                  : 0,
            styleCharacters:
              referenceKind === "source"
                ? 0
                : effectiveStyleEvidence && effectiveStyleEvidence.chapters
                ? Object.values(effectiveStyleEvidence.chapters).reduce((count, chapter) => {
                    const items =
                      chapter && typeof chapter === "object" && Array.isArray(chapter.characterSpeech)
                        ? chapter.characterSpeech
                        : [];
                    return count + items.length;
                  }, 0)
                : 0,
          },
          glossary,
          candidateTerms,
          storyContext,
          styleEvidence: effectiveStyleEvidence,
          styleProfile: effectiveStyleProfile,
          translationContext,
        });
        return;
      }

      const ingestionDeleteMatch = url.pathname.match(/^\/knowledge\/([^/]+)\/ingestion$/);
      if (req.method === "DELETE" && ingestionDeleteMatch) {
        const mangaId = ingestionDeleteMatch[1];
        const translatorId = url.searchParams.get("translatorId");
        if (!translatorId || !String(translatorId).trim()) {
          badRequest(res, "translatorId is required.");
          return;
        }
        const deletedIngestion = clearTranslatorIngestionData({ mangaId, translatorId });
        const deletedRevisionCount = jobManager.store.deleteKnowledgeRevisions({
          mangaId,
          translatorId,
        });
        const deletedJobs = permanentlyDeleteMatchingJobs(
          jobManager,
          (job) =>
            job.type === "reference_ingestion" &&
            typeof job.payload?.mangaId === "string" &&
            job.payload.mangaId === mangaId &&
            typeof job.payload?.translatorId === "string" &&
            job.payload.translatorId === translatorId
        );
        sendJson(res, 200, {
          deletedIngestion,
          deletedRevisionCount,
          deletedJobs,
        });
        return;
      }

      const streamMatch = url.pathname.match(/^\/jobs\/([^/]+)\/stream$/);
      if (req.method === "GET" && streamMatch) {
        const jobId = streamMatch[1];
        const existing = jobManager.getJob(jobId);
        if (!existing) {
          notFound(res);
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        const stopHeartbeat = beginSseHeartbeat(res);
        const useMessageEnvelope = url.searchParams.get("eventMode") === "message";

        for (const event of existing.events || []) {
          writeJobStreamEvent(res, event.type, {
            type: event.type,
            payload: event.payload,
            createdAt: event.createdAt,
          }, useMessageEnvelope);
        }

        const unsubscribe = jobManager.subscribe(jobId, (event) => {
          writeJobStreamEvent(res, event.type, event, useMessageEnvelope);
        });

        req.on("close", () => {
          stopHeartbeat();
          unsubscribe();
          res.end();
        });
        return;
      }

      const eventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        const events = jobManager.getJobEvents(eventsMatch[1]);
        if (!events) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { events });
        return;
      }

      const artifactsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/artifacts$/);
      if (req.method === "GET" && artifactsMatch) {
        const artifacts = jobManager.getJobArtifacts(artifactsMatch[1]);
        if (!artifacts) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { artifacts });
        return;
      }

      const translatedImageContentMatch = url.pathname.match(/^\/jobs\/([^/]+)\/translated-images\/([^/]+)\/content$/);
      if (req.method === "GET" && translatedImageContentMatch) {
        if (!translatedImageService) throw Object.assign(new Error("Translated image service is unavailable."), { statusCode: 503 });
        const artifacts = jobManager.getJobArtifacts(translatedImageContentMatch[1]);
        if (!artifacts) { notFound(res); return; }
        const { image } = await translatedImageService.find({
          jobId: translatedImageContentMatch[1],
          artifacts,
          imageId: translatedImageContentMatch[2],
        });
        res.writeHead(200, {
          "Content-Type": image.mediaType,
          "Content-Length": image.size,
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`,
          "Cache-Control": "private, max-age=31536000, immutable",
        });
        fs.createReadStream(image.path).pipe(res);
        return;
      }

      const translatedImageMatch = url.pathname.match(/^\/jobs\/([^/]+)\/translated-images\/([^/]+)$/);
      if (req.method === "GET" && translatedImageMatch) {
        if (!translatedImageService) throw Object.assign(new Error("Translated image service is unavailable."), { statusCode: 503 });
        const artifacts = jobManager.getJobArtifacts(translatedImageMatch[1]);
        if (!artifacts) { notFound(res); return; }
        sendJson(res, 200, await translatedImageService.encoded({
          jobId: translatedImageMatch[1],
          artifacts,
          imageId: translatedImageMatch[2],
        }));
        return;
      }

      const translatedImagesMatch = url.pathname.match(/^\/jobs\/([^/]+)\/translated-images$/);
      if (req.method === "GET" && translatedImagesMatch) {
        if (!translatedImageService) throw Object.assign(new Error("Translated image service is unavailable."), { statusCode: 503 });
        const artifacts = jobManager.getJobArtifacts(translatedImagesMatch[1]);
        if (!artifacts) { notFound(res); return; }
        sendJson(res, 200, await translatedImageService.list({
          jobId: translatedImagesMatch[1],
          artifacts,
        }));
        return;
      }

      const artifactContentMatch = url.pathname.match(/^\/jobs\/([^/]+)\/artifacts\/(\d+)\/content$/);
      if (req.method === "GET" && artifactContentMatch) {
        const artifacts = jobManager.getJobArtifacts(artifactContentMatch[1]);
        const artifact = artifacts?.find((entry) => String(entry.id) === artifactContentMatch[2]);
        if (!artifact) {
          notFound(res);
          return;
        }
        const filePath = resolveDownloadableArtifact(artifact.path);
        if (!filePath) {
          sendJson(res, 409, { error: "Artifact file is unavailable or outside the data root." });
          return;
        }
        const stat = fs.statSync(filePath);
        const fileName = path.basename(filePath);
        res.writeHead(200, {
          "Content-Type": artifactContentType(filePath),
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      const retryMatch = url.pathname.match(/^\/jobs\/([^/]+)\/retry$/);
      if (req.method === "POST" && retryMatch) {
        const sourceJob = jobManager.getJob(retryMatch[1]);
        if (!sourceJob) { notFound(res); return; }
        if (["translation", "translation_quality_repair"].includes(sourceJob.type)) {
          await jobManager.assertAgentAvailableForTranslation?.(sourceJob.payload);
        }
        const job = jobManager.retryJob(retryMatch[1]);
        if (!job) {
          notFound(res);
          return;
        }
        sendJson(res, 202, job);
        return;
      }

      const resumeMatch = url.pathname.match(/^\/jobs\/([^/]+)\/resume$/);
      if (req.method === "POST" && resumeMatch) {
        const job = jobManager.resumeJob(resumeMatch[1]);
        if (!job) {
          notFound(res);
          return;
        }
        sendJson(res, 202, job);
        return;
      }

      const cancelMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const job = jobManager.cancelJob(cancelMatch[1]);
        if (!job) {
          notFound(res);
          return;
        }
        sendJson(res, 202, job);
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/delete-batch") {
        const body = await readJsonBody(req);
        try {
          const result = jobManager.deleteJobs(body.jobIds);
          sendJson(res, 200, result);
        } catch (error) {
          conflict(res, error.message);
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/restore-batch") {
        const body = await readJsonBody(req);
        try {
          const result = jobManager.restoreJobs(body.jobIds);
          sendJson(res, 200, result);
        } catch (error) {
          conflict(res, error.message);
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/jobs/purge-batch") {
        const body = await readJsonBody(req);
        try {
          const result = jobManager.purgeJobs(body.jobIds);
          sendJson(res, 200, result);
        } catch (error) {
          conflict(res, error.message);
        }
        return;
      }

      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
      if (req.method === "GET" && jobMatch) {
        const job = jobManager.getJob(jobMatch[1]);
        if (!job) {
          notFound(res);
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      if (req.method === "DELETE" && jobMatch) {
        try {
          const job = jobManager.deleteJob(jobMatch[1]);
          if (!job) {
            notFound(res);
            return;
          }
          sendJson(res, 200, {
            deleted: {
              id: job.id,
              status: job.status,
              type: job.type,
            },
          });
        } catch (error) {
          conflict(res, error.message);
        }
        return;
      }

      const restoreMatch = url.pathname.match(/^\/jobs\/([^/]+)\/restore$/);
      if (req.method === "POST" && restoreMatch) {
        try {
          const job = jobManager.restoreJob(restoreMatch[1]);
          if (!job) {
            notFound(res);
            return;
          }
          sendJson(res, 200, {
            restored: {
              id: job.id,
              status: job.status,
              type: job.type,
            },
          });
        } catch (error) {
          conflict(res, error.message);
        }
        return;
      }

      const purgeMatch = url.pathname.match(/^\/jobs\/([^/]+)\/permanent$/);
      if (req.method === "DELETE" && purgeMatch) {
        try {
          const job = jobManager.purgeJob(purgeMatch[1]);
          if (!job) {
            notFound(res);
            return;
          }
          sendJson(res, 200, {
            purged: {
              id: job.id,
              status: job.status,
              type: job.type,
            },
          });
        } catch (error) {
          conflict(res, error.message);
        }
        return;
      }

      notFound(res);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

module.exports = {
  createApiServer,
  SSE_HEARTBEAT_INTERVAL_MS,
};
