const { config, paths, runtime } = require("./config");
const { ConfigService } = require("./config_service");
const { KoharuClient } = require("./integrations/koharu/client/koharu_client");
const {
  KoharuMangaProcessingAdapter,
} = require("./integrations/koharu/koharu_manga_processing_adapter");
const { AOClient } = require("./integrations/ao/client/ao_client");
const { AOTaskRunner } = require("./integrations/ao/tasks/ao_tasks");
const { ProjectSetupModule } = require("./integrations/koharu/pipeline/project_setup");
const { LMStudioClient } = require("./integrations/lmstudio/lmstudio_client");
const { LMStudioVisionClient } = require("./integrations/lmstudio/lmstudio_vision_client");
const { PipelineMonitorModule } = require("./integrations/koharu/pipeline/pipeline_monitor");
const { ReferenceExtractionModule } = require("./domains/reference/extraction/reference_extraction");
const { ReferenceIngestionModule } = require("./domains/reference/ingestion/reference_ingestion");
const { ReferenceBilingualEnrichmentModule } = require("./domains/reference/bilingual/reference_bilingual_enrichment");
const { SourcePreflightModule } = require("./domains/translation/preflight/source_preflight");
const { QualityModule } = require("./domains/translation/quality/quality");
const { KnowledgeModule } = require("./domains/knowledge/learning/knowledge");
const { TranslationDeepAuditModule } = require("./domains/translation/audit/translation_deep_audit");
const { ExportModule } = require("./domains/translation/execution/export");
const { PostEditWorkspaceModule } = require("./domains/post_edit/workspace/post_edit_workspace");
const { ReferenceExtractionReviewService } = require("./domains/reference/review/reference_extraction_review_service");
const { TranslationPublicationService } = require("./domains/translation/publications/translation_publications");
const { KoharuRuntimeManager } = require("./integrations/koharu/runtime/koharu_runtime");
const {
  assertMangaProcessingRuntimePort,
} = require("./domains/manga_processing/manga_processing_runtime_port");
const {
  PORT_METHODS,
  assertMangaProcessingPorts,
} = require("./domains/manga_processing/manga_processing_ports");
const { JobStore } = require("./domains/jobs/persistence/job_store");
const { WorkflowEngine } = require("./domains/jobs/workflows/workflow_engine");
const { JobManager } = require("./domains/jobs/job_manager");
const { UploadService } = require("./domains/uploads/upload_service");
const { TranslatedImageService } = require("./domains/translation/exports/translated_image_service");
const { PageRevisionService } = require("./domains/translation/revisions/page_revision_service");
const {
  TranslationRevisionPromotionService,
} = require("./domains/translation/revisions/translation_revision_promotion");
const { RegionSnapshotRepository } = require("./domains/translation/text_regions/region_snapshot_repository");
const { TextRegionQueryService } = require("./domains/translation/text_regions/text_region_query_service");
const { TextRegionCorrectionService } = require("./domains/translation/text_regions/text_region_correction_service");
const { TextRegionReviewService } = require("./domains/translation/text_regions/text_region_review_service");
const { OcrTextReviewService } = require("./domains/translation/text_regions/ocr_text_review_service");
const { createApiServer } = require("./http/server/api_server");
const { startCleanupScheduler } = require("./domains/maintenance/cleanup_service");

function applyMangaProcessingRuntimeStatus(runtime, status) {
  if (!status?.baseUrl) return status;
  config.api = { ...(config.api || {}), baseUrl: status.baseUrl };
  runtime?.mangaProcessor?.setDefaultBaseUrl?.(status.baseUrl);
  if (runtime?.extractionReviewService) runtime.extractionReviewService.baseUrl = status.baseUrl;
  return status;
}

function createRuntimeBaseContext(overrides) {
  const koharuHttpClient = overrides.koharuHttpClient || new KoharuClient();
  const mangaProcessor = overrides.mangaProcessor || new KoharuMangaProcessingAdapter(koharuHttpClient);
  assertMangaProcessingPorts(mangaProcessor, Object.keys(PORT_METHODS));
  const aoClient =
    overrides.aoClient ||
    new AOClient({
      baseUrl: config.agent.baseUrl,
      apiKey: config.agent.apiKey || null,
      readyPollIntervalMs: config.agent.readyPollIntervalMs,
      readyTimeoutMs: config.agent.readyTimeoutMs,
    });
  const aoTaskRunner = overrides.aoTaskRunner || new AOTaskRunner({ client: aoClient });
  const store = overrides.store || new JobStore(paths.database);
  const host = overrides.host ?? runtime.host;
  const port = overrides.port ?? runtime.port;
  return { mangaProcessor, aoClient, aoTaskRunner, store, host, port, overrides };
}

function createTranslationRegionServices(ctx, pageRevisionService, regionSnapshotRepository, sourcePreflightModule,
  uploadService) {
  const textRegionQueryService = ctx.overrides.textRegionQueryService || new TextRegionQueryService({
    store: ctx.store,
    pageRevisionService,
    snapshotRepository: regionSnapshotRepository,
  });
  const textRegionCorrectionService = ctx.overrides.textRegionCorrectionService || new TextRegionCorrectionService({
    store: ctx.store,
    snapshotRepository: regionSnapshotRepository,
  });
  const textRegionReviewService = ctx.overrides.textRegionReviewService || new TextRegionReviewService({
    store: ctx.store,
    snapshotRepository: regionSnapshotRepository,
    sourcePreflightModule,
    reviewer: ctx.overrides.textRegionReviewer || new LMStudioVisionClient(),
    getConfig: () => config,
  });
  const ocrTextReviewService = ctx.overrides.ocrTextReviewService || new OcrTextReviewService({
    uploadService,
    reviewer: ctx.overrides.ocrTextReviewer || new LMStudioVisionClient(),
    getConfig: () => config,
  });
  return { regionSnapshotRepository, textRegionQueryService, textRegionCorrectionService,
    textRegionReviewService, ocrTextReviewService };
}

function createTranslatedImageService(overrides) {
  return overrides.translatedImageService || new TranslatedImageService({
    maxFileBytes: config.server?.maxTranslatedImageBytes,
    maxFiles: config.server?.maxTranslatedImageFiles,
    maxTotalBytes: config.server?.maxTranslatedImagesTotalBytes,
  });
}

function createRevisionServices(ctx, sourcePreflightModule, translatedImageService, publicationService,
  regionSnapshotRepository) {
  const pageRevisionService = ctx.overrides.pageRevisionService || new PageRevisionService({
    store: ctx.store,
    translatedImageService,
    sourcePreflightModule,
  });
  const translationRevisionPromotionService = ctx.overrides.translationRevisionPromotionService
    || new TranslationRevisionPromotionService({
      store: ctx.store,
      pageRevisionService,
      translatedImageService,
      sourcePreflightModule,
      translationPublicationService: publicationService,
      regionSnapshotRepository,
    });
  return { pageRevisionService, translationRevisionPromotionService };
}

function createFileServices(ctx) {
  const { overrides } = ctx;
  const sourcePreflightModule = overrides.sourcePreflightModule || new SourcePreflightModule();
  const postEditWorkspaceModule = overrides.postEditWorkspaceModule || new PostEditWorkspaceModule();
  const uploadService = overrides.uploadService || new UploadService({
    maxFileBytes: config.server?.maxUploadFileBytes,
    maxFiles: config.server?.maxUploadFiles,
  });
  const translatedImageService = createTranslatedImageService(overrides);
  const translationPublicationService = overrides.translationPublicationService || new TranslationPublicationService();
  const regionSnapshotRepository = overrides.regionSnapshotRepository || new RegionSnapshotRepository();
  const revisionServices = createRevisionServices(
    ctx, sourcePreflightModule, translatedImageService, translationPublicationService, regionSnapshotRepository,
  );
  const { pageRevisionService, translationRevisionPromotionService } = revisionServices;
  const regionServices = createTranslationRegionServices(
    ctx, pageRevisionService, regionSnapshotRepository, sourcePreflightModule, uploadService,
  );
  return { sourcePreflightModule, postEditWorkspaceModule, uploadService,
    translatedImageService, translationPublicationService, pageRevisionService,
    translationRevisionPromotionService,
    ...regionServices };
}

function createMangaProcessingServices(ctx) {
  const { mangaProcessor, overrides } = ctx;
  const mangaProcessingRuntime =
    overrides.mangaProcessingRuntime ||
    new KoharuRuntimeManager({
      config: config.koharuRuntime || {},
      installRoot: paths.koharuRuntimeInstallRoot,
      baseUrl: config.api.baseUrl,
    });
  const pipelineMonitor = overrides.pipelineMonitor || new PipelineMonitorModule(mangaProcessor);
  assertMangaProcessingRuntimePort(mangaProcessingRuntime);
  return { mangaProcessingRuntime, pipelineMonitor };
}

function createRuntimeModules(ctx) {
  Object.assign(ctx, createFileServices(ctx), createMangaProcessingServices(ctx));
}

function workflowEngineOptions(ctx) {
  const { mangaProcessor, aoTaskRunner, pipelineMonitor, sourcePreflightModule,
    postEditWorkspaceModule, store, translationPublicationService,
    regionSnapshotRepository, ocrTextReviewService, overrides } = ctx;
  return {
    sourcePreflightModule,
    projectSetup: overrides.projectSetup || new ProjectSetupModule({
      mangaProcessor,
      lmStudioClient: overrides.lmStudioClient || new LMStudioClient(),
    }),
    pipelineMonitor,
    referenceExtractionModule:
      overrides.referenceExtractionModule || new ReferenceExtractionModule(mangaProcessor, pipelineMonitor),
    referenceIngestionModule: overrides.referenceIngestionModule || new ReferenceIngestionModule(aoTaskRunner),
    referenceBilingualEnrichmentModule:
      overrides.referenceBilingualEnrichmentModule || new ReferenceBilingualEnrichmentModule(aoTaskRunner),
    qualityModule: overrides.qualityModule || new QualityModule(mangaProcessor, aoTaskRunner),
    knowledgeModule: overrides.knowledgeModule || new KnowledgeModule(mangaProcessor, aoTaskRunner),
    translationDeepAuditModule: overrides.translationDeepAuditModule || new TranslationDeepAuditModule(aoTaskRunner),
    exportModule: overrides.exportModule || new ExportModule(mangaProcessor),
    mangaProcessor,
    postEditWorkspaceModule, regionSnapshotRepository, jobStore: store, translationPublicationService,
    ocrTextReviewService,
  };
}

function createRuntimeEngine(ctx) {
  ctx.engine = ctx.overrides.engine || new WorkflowEngine(workflowEngineOptions(ctx));
}

function createRuntimeJobManager(ctx) {
  const { store, engine, mangaProcessingRuntime, aoClient, pageRevisionService,
    translationRevisionPromotionService, textRegionCorrectionService, host, port, overrides } = ctx;
  const jobManager =
    overrides.jobManager ||
    new JobManager({
      store,
      engine,
      runtimeConfig: { ...runtime, host, port },
      resolvedConfig: config,
      mangaProcessingRuntime,
      aoClient,
      pageRevisionService,
      translationRevisionPromotionService,
      textRegionCorrectionService,
    });
  ctx.jobManager = jobManager;
}

function createRuntimeServices(ctx) {
  const { mangaProcessor, jobManager, overrides } = ctx;
  const extractionReviewService =
    overrides.extractionReviewService ||
    new ReferenceExtractionReviewService({
      client: mangaProcessor,
      jobManager,
      baseUrl: config.api.baseUrl,
    });
  const configService =
    overrides.configService ||
    new ConfigService({
      effectiveConfig: config,
      onApply(nextConfig) {
        aoClientApply(nextConfig, ctx);
      },
    });
  ctx.extractionReviewService = extractionReviewService;
  ctx.configService = configService;
}

function aoClientApply(nextConfig, ctx) {
  const { aoClient, aoTaskRunner, mangaProcessor, extractionReviewService,
    jobManager, mangaProcessingRuntime } = ctx;
  aoClient.baseUrl = String(nextConfig.agent.baseUrl || "").replace(/\/+$/, "");
  aoClient.apiKey = nextConfig.agent.apiKey || null;
  aoClient.readyPollIntervalMs = nextConfig.agent.readyPollIntervalMs;
  aoClient.readyTimeoutMs = nextConfig.agent.readyTimeoutMs;
  aoTaskRunner.settings = nextConfig.agent;
  mangaProcessor.setDefaultBaseUrl(nextConfig.api.baseUrl);
  extractionReviewService.baseUrl = nextConfig.api.baseUrl;
  mangaProcessingRuntime?.setExternalBaseUrl?.(nextConfig.api.baseUrl);
  jobManager.resolvedConfig = nextConfig;
}

function apiServerOptions(ctx) {
  return {
    jobManager: ctx.jobManager,
    sourcePreflightModule: ctx.sourcePreflightModule,
    postEditWorkspaceModule: ctx.postEditWorkspaceModule,
    extractionReviewService: ctx.extractionReviewService,
    uploadService: ctx.uploadService,
    translatedImageService: ctx.translatedImageService,
    pageRevisionService: ctx.pageRevisionService,
    translationRevisionPromotionService: ctx.translationRevisionPromotionService,
    textRegionQueryService: ctx.textRegionQueryService,
    textRegionReviewService: ctx.textRegionReviewService,
    ocrTextReviewService: ctx.ocrTextReviewService,
    configService: ctx.configService,
    translationPublicationService: ctx.translationPublicationService,
    host: ctx.host,
    port: ctx.port,
    serverConfig: config.server || {},
  };
}

function attachApiShutdown(api, ctx, cleanupTimer) {
  const closeApi = api.close.bind(api);
  api.close = async () => {
    try {
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (config.koharuRuntime?.stopWithBackend !== false) await ctx.mangaProcessingRuntime.stopManaged();
    } finally {
      await closeApi();
    }
  };
  return closeApi;
}

function createRuntimeApi(ctx) {
  const api = createApiServer(apiServerOptions(ctx));
  const cleanupTimer = startCleanupScheduler({ jobManager: ctx.jobManager, getConfig: () => config });
  const closeApi = attachApiShutdown(api, ctx, cleanupTimer);
  ctx.api = api;
  ctx.closeApi = closeApi;
  ctx.cleanupTimer = cleanupTimer;
}

function finalizeRuntime(ctx) {
  return {
    api: ctx.api,
    jobManager: ctx.jobManager,
    engine: ctx.engine,
    sourcePreflightModule: ctx.sourcePreflightModule,
    postEditWorkspaceModule: ctx.postEditWorkspaceModule,
    extractionReviewService: ctx.extractionReviewService,
    uploadService: ctx.uploadService,
    translatedImageService: ctx.translatedImageService,
    pageRevisionService: ctx.pageRevisionService,
    textRegionQueryService: ctx.textRegionQueryService,
    textRegionReviewService: ctx.textRegionReviewService,
    ocrTextReviewService: ctx.ocrTextReviewService,
    store: ctx.store,
    mangaProcessor: ctx.mangaProcessor,
    aoClient: ctx.aoClient,
    aoTaskRunner: ctx.aoTaskRunner,
    configService: ctx.configService,
    mangaProcessingRuntime: ctx.mangaProcessingRuntime,
    applyMangaProcessingRuntimeStatus(status) {
      return applyMangaProcessingRuntimeStatus(this, status);
    },
  };
}

function createRuntime(overrides = {}) {
  const ctx = createRuntimeBaseContext(overrides);
  createRuntimeModules(ctx);
  createRuntimeEngine(ctx);
  createRuntimeJobManager(ctx);
  createRuntimeServices(ctx);
  createRuntimeApi(ctx);
  return finalizeRuntime(ctx);
}

module.exports = {
  createRuntime,
  applyMangaProcessingRuntimeStatus,
};
