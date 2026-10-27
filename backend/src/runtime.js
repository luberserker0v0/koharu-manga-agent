const { config, paths, runtime } = require("./config");
const { ConfigService } = require("./config_service");
const { KoharuClient } = require("./integrations/koharu/client/koharu_client");
const { AOClient } = require("./integrations/ao/client/ao_client");
const { AOTaskRunner } = require("./integrations/ao/tasks/ao_tasks");
const { ProjectSetupModule } = require("./integrations/koharu/pipeline/project_setup");
const { LMStudioClient } = require("./integrations/lmstudio/lmstudio_client");
const { PipelineMonitorModule } = require("./integrations/koharu/pipeline/pipeline_monitor");
const { ReferenceExtractionModule } = require("./domains/reference/extraction/reference_extraction");
const { ReferenceIngestionModule } = require("./domains/reference/ingestion/reference_ingestion");
const { ReferenceBilingualEnrichmentModule } = require("./domains/reference/bilingual/reference_bilingual_enrichment");
const { SourcePreflightModule } = require("./domains/translation/preflight/source_preflight");
const { QualityModule } = require("./domains/translation/quality/quality");
const { KnowledgeModule } = require("./domains/knowledge/learning/knowledge");
const { TranslationDeepAuditModule } = require("./domains/translation/audit/translation_deep_audit");
const { ExportModule } = require("./domains/translation/execution/export");
const { ProjectLifecycleModule } = require("./integrations/koharu/pipeline/project_lifecycle");
const { PostEditWorkspaceModule } = require("./domains/post_edit/workspace/post_edit_workspace");
const { ReferenceExtractionReviewService } = require("./domains/reference/review/reference_extraction_review_service");
const { TranslationPublicationService } = require("./domains/translation/publications/translation_publications");
const { KoharuRuntimeManager } = require("./integrations/koharu/runtime/koharu_runtime");
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
const { createApiServer } = require("./http/server/api_server");
const { startCleanupScheduler } = require("./domains/maintenance/cleanup_service");

function applyKoharuRuntimeStatus(runtime, status) {
  if (!status?.baseUrl) return status;
  config.api = { ...(config.api || {}), baseUrl: status.baseUrl };
  if (runtime?.client) runtime.client.defaultBaseUrl = status.baseUrl;
  if (runtime?.extractionReviewService) runtime.extractionReviewService.baseUrl = status.baseUrl;
  return status;
}

function createRuntimeBaseContext(overrides) {
  const client = overrides.client || new KoharuClient();
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
  return { client, aoClient, aoTaskRunner, store, host, port, overrides };
}

function createTranslationRegionServices(ctx, pageRevisionService) {
  const regionSnapshotRepository = ctx.overrides.regionSnapshotRepository || new RegionSnapshotRepository();
  const textRegionQueryService = ctx.overrides.textRegionQueryService || new TextRegionQueryService({
    store: ctx.store,
    pageRevisionService,
    snapshotRepository: regionSnapshotRepository,
  });
  const textRegionCorrectionService = ctx.overrides.textRegionCorrectionService || new TextRegionCorrectionService({
    store: ctx.store,
    snapshotRepository: regionSnapshotRepository,
  });
  return { regionSnapshotRepository, textRegionQueryService, textRegionCorrectionService };
}

function createTranslatedImageService(overrides) {
  return overrides.translatedImageService || new TranslatedImageService({
    maxFileBytes: config.server?.maxTranslatedImageBytes,
    maxFiles: config.server?.maxTranslatedImageFiles,
    maxTotalBytes: config.server?.maxTranslatedImagesTotalBytes,
  });
}

function createRevisionServices(ctx, sourcePreflightModule, translatedImageService, publicationService) {
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
  const revisionServices = createRevisionServices(
    ctx, sourcePreflightModule, translatedImageService, translationPublicationService,
  );
  const { pageRevisionService, translationRevisionPromotionService } = revisionServices;
  const regionServices = createTranslationRegionServices(ctx, pageRevisionService);
  return { sourcePreflightModule, postEditWorkspaceModule, uploadService,
    translatedImageService, translationPublicationService, pageRevisionService,
    translationRevisionPromotionService,
    ...regionServices };
}

function createKoharuServices(ctx) {
  const { client, overrides } = ctx;
  const koharuRuntimeManager =
    overrides.koharuRuntimeManager ||
    new KoharuRuntimeManager({
      config: config.koharuRuntime || {},
      installRoot: paths.koharuRuntimeInstallRoot,
      baseUrl: config.api.baseUrl,
    });
  const pipelineMonitor = overrides.pipelineMonitor || new PipelineMonitorModule(client);
  return { koharuRuntimeManager, pipelineMonitor };
}

function createRuntimeModules(ctx) {
  Object.assign(ctx, createFileServices(ctx), createKoharuServices(ctx));
}

function workflowEngineOptions(ctx) {
  const {
    client,
    aoTaskRunner,
    pipelineMonitor,
    sourcePreflightModule,
    postEditWorkspaceModule,
    store,
    translationPublicationService,
    regionSnapshotRepository,
    overrides,
  } = ctx;
  return {
    sourcePreflightModule,
    projectSetup: overrides.projectSetup || new ProjectSetupModule({
      lmStudioClient: overrides.lmStudioClient || new LMStudioClient(),
    }),
    pipelineMonitor,
    referenceExtractionModule: overrides.referenceExtractionModule || new ReferenceExtractionModule(client, pipelineMonitor),
    referenceIngestionModule: overrides.referenceIngestionModule || new ReferenceIngestionModule(aoTaskRunner),
    referenceBilingualEnrichmentModule:
      overrides.referenceBilingualEnrichmentModule || new ReferenceBilingualEnrichmentModule(aoTaskRunner),
    qualityModule: overrides.qualityModule || new QualityModule(client, aoTaskRunner),
    knowledgeModule: overrides.knowledgeModule || new KnowledgeModule(client, aoTaskRunner),
    translationDeepAuditModule: overrides.translationDeepAuditModule || new TranslationDeepAuditModule(aoTaskRunner),
    exportModule: overrides.exportModule || new ExportModule(client),
    projectLifecycle: overrides.projectLifecycle || new ProjectLifecycleModule(client),
    postEditWorkspaceModule, regionSnapshotRepository, jobStore: store, translationPublicationService,
  };
}

function createRuntimeEngine(ctx) {
  ctx.engine = ctx.overrides.engine || new WorkflowEngine(workflowEngineOptions(ctx));
}

function createRuntimeJobManager(ctx) {
  const { store, engine, koharuRuntimeManager, aoClient, pageRevisionService,
    translationRevisionPromotionService, textRegionCorrectionService, host, port, overrides } = ctx;
  const jobManager =
    overrides.jobManager ||
    new JobManager({
      store,
      engine,
      runtimeConfig: { ...runtime, host, port },
      resolvedConfig: config,
      koharuRuntimeManager,
      aoClient,
      pageRevisionService,
      translationRevisionPromotionService,
      textRegionCorrectionService,
    });
  ctx.jobManager = jobManager;
}

function createRuntimeServices(ctx) {
  const { client, jobManager, overrides } = ctx;
  const extractionReviewService =
    overrides.extractionReviewService ||
    new ReferenceExtractionReviewService({
      client,
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
  const { aoClient, aoTaskRunner, client, extractionReviewService, jobManager, koharuRuntimeManager } = ctx;
  aoClient.baseUrl = String(nextConfig.agent.baseUrl || "").replace(/\/+$/, "");
  aoClient.apiKey = nextConfig.agent.apiKey || null;
  aoClient.readyPollIntervalMs = nextConfig.agent.readyPollIntervalMs;
  aoClient.readyTimeoutMs = nextConfig.agent.readyTimeoutMs;
  aoTaskRunner.settings = nextConfig.agent;
  client.defaultBaseUrl = nextConfig.api.baseUrl;
  extractionReviewService.baseUrl = nextConfig.api.baseUrl;
  koharuRuntimeManager?.setExternalBaseUrl?.(nextConfig.api.baseUrl);
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
      if (config.koharuRuntime?.stopWithBackend !== false) await ctx.koharuRuntimeManager.stopManaged();
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
    store: ctx.store,
    client: ctx.client,
    aoClient: ctx.aoClient,
    aoTaskRunner: ctx.aoTaskRunner,
    configService: ctx.configService,
    koharuRuntimeManager: ctx.koharuRuntimeManager,
    applyKoharuRuntimeStatus(status) {
      return applyKoharuRuntimeStatus(this, status);
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
  applyKoharuRuntimeStatus,
};
