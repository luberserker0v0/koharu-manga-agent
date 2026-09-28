const { config, paths, runtime } = require("./config");
const { ConfigService } = require("./config_service");
const { KoharuClient } = require("./integrations/koharu/client/koharu_client");
const { AOClient } = require("./integrations/ao/client/ao_client");
const { AOTaskRunner } = require("./integrations/ao/tasks/ao_tasks");
const { ProjectSetupModule } = require("./integrations/koharu/pipeline/project_setup");
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
const { createApiServer } = require("./http/server/api_server");

function applyKoharuRuntimeStatus(runtime, status) {
  if (!status?.baseUrl) {
    return status;
  }
  config.api = {
    ...(config.api || {}),
    baseUrl: status.baseUrl,
  };
  if (runtime?.client) {
    runtime.client.defaultBaseUrl = status.baseUrl;
  }
  if (runtime?.extractionReviewService) {
    runtime.extractionReviewService.baseUrl = status.baseUrl;
  }
  return status;
}

function createRuntime(overrides = {}) {
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
  const pipelineMonitor =
    overrides.pipelineMonitor || new PipelineMonitorModule(client);
  const sourcePreflightModule =
    overrides.sourcePreflightModule || new SourcePreflightModule();
  const postEditWorkspaceModule =
    overrides.postEditWorkspaceModule || new PostEditWorkspaceModule();
  const uploadService = overrides.uploadService || new UploadService({
    maxFileBytes: config.server?.maxUploadFileBytes,
    maxFiles: config.server?.maxUploadFiles,
  });
  const translatedImageService = overrides.translatedImageService || new TranslatedImageService({
    maxFileBytes: config.server?.maxTranslatedImageBytes,
    maxFiles: config.server?.maxTranslatedImageFiles,
    maxTotalBytes: config.server?.maxTranslatedImagesTotalBytes,
  });
  const translationPublicationService =
    overrides.translationPublicationService || new TranslationPublicationService();
  const koharuRuntimeManager =
    overrides.koharuRuntimeManager ||
    new KoharuRuntimeManager({
      config: config.koharuRuntime || {},
      installRoot: paths.koharuRuntimeInstallRoot,
    });

  const engine = overrides.engine || new WorkflowEngine({
    sourcePreflightModule,
    projectSetup: overrides.projectSetup || new ProjectSetupModule(),
    pipelineMonitor,
    referenceExtractionModule:
      overrides.referenceExtractionModule ||
      new ReferenceExtractionModule(client, pipelineMonitor),
    referenceIngestionModule:
      overrides.referenceIngestionModule || new ReferenceIngestionModule(aoTaskRunner),
    referenceBilingualEnrichmentModule:
      overrides.referenceBilingualEnrichmentModule || new ReferenceBilingualEnrichmentModule(aoTaskRunner),
    qualityModule: overrides.qualityModule || new QualityModule(client, aoTaskRunner),
    knowledgeModule: overrides.knowledgeModule || new KnowledgeModule(client, aoTaskRunner),
    translationDeepAuditModule: overrides.translationDeepAuditModule || new TranslationDeepAuditModule(aoTaskRunner),
    exportModule: overrides.exportModule || new ExportModule(client),
    projectLifecycle: overrides.projectLifecycle || new ProjectLifecycleModule(client),
    postEditWorkspaceModule,
    jobStore: store,
    translationPublicationService,
  });

  const jobManager = overrides.jobManager || new JobManager({
    store,
    engine,
    runtimeConfig: { ...runtime, host, port },
    resolvedConfig: config,
    koharuRuntimeManager,
    aoClient,
  });
  const extractionReviewService =
    overrides.extractionReviewService ||
    new ReferenceExtractionReviewService({ client, jobManager, baseUrl: config.api.baseUrl });

  const configService = overrides.configService || new ConfigService({
    effectiveConfig: config,
    onApply(nextConfig) {
      aoClient.baseUrl = String(nextConfig.agent.baseUrl || "").replace(/\/+$/, "");
      aoClient.apiKey = nextConfig.agent.apiKey || null;
      aoClient.readyPollIntervalMs = nextConfig.agent.readyPollIntervalMs;
      aoClient.readyTimeoutMs = nextConfig.agent.readyTimeoutMs;
      aoTaskRunner.settings = nextConfig.agent;
      client.defaultBaseUrl = nextConfig.api.baseUrl;
      extractionReviewService.baseUrl = nextConfig.api.baseUrl;
      jobManager.resolvedConfig = nextConfig;
    },
  });

  const api = createApiServer({
    jobManager,
    sourcePreflightModule,
    postEditWorkspaceModule,
    extractionReviewService,
    uploadService,
    translatedImageService,
    configService,
    translationPublicationService,
    host,
    port,
    serverConfig: config.server || {},
  });
  const closeApi = api.close.bind(api);
  api.close = async () => {
    try {
      if (config.koharuRuntime?.stopWithBackend !== false) {
        await koharuRuntimeManager.stopManaged();
      }
    } finally {
      await closeApi();
    }
  };

  return {
    api,
    jobManager,
    engine,
    sourcePreflightModule,
    postEditWorkspaceModule,
    extractionReviewService,
    uploadService,
    translatedImageService,
    store,
    client,
    aoClient,
    aoTaskRunner,
    configService,
    koharuRuntimeManager,
    applyKoharuRuntimeStatus(status) {
      return applyKoharuRuntimeStatus(this, status);
    },
  };
}

module.exports = {
  createRuntime,
  applyKoharuRuntimeStatus,
};
