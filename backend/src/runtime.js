const { config, paths, runtime } = require("./config");
const { KoharuClient } = require("./koharu_client");
const { AOClient } = require("./ao_client");
const { AOTaskRunner } = require("./ao_tasks");
const { ProjectSetupModule } = require("./modules/project_setup");
const { PipelineMonitorModule } = require("./modules/pipeline_monitor");
const { ReferenceExtractionModule } = require("./modules/reference_extraction");
const { ReferenceIngestionModule } = require("./modules/reference_ingestion");
const { ReferenceBilingualEnrichmentModule } = require("./modules/reference_bilingual_enrichment");
const { SourcePreflightModule } = require("./modules/source_preflight");
const { QualityModule } = require("./modules/quality");
const { KnowledgeModule } = require("./modules/knowledge");
const { TranslationDeepAuditModule } = require("./modules/translation_deep_audit");
const { ExportModule } = require("./modules/export");
const { ProjectLifecycleModule } = require("./modules/project_lifecycle");
const { PostEditWorkspaceModule } = require("./modules/post_edit_workspace");
const { ReferenceExtractionReviewService } = require("./modules/reference_extraction_review_service");
const { TranslationPublicationService } = require("./modules/translation_publications");
const { KoharuRuntimeManager } = require("./modules/koharu_runtime");
const { JobStore } = require("./storage/job_store");
const { WorkflowEngine } = require("./workflow_engine");
const { JobManager } = require("./job_manager");
const { createApiServer } = require("./http/api_server");

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
  });
  const extractionReviewService =
    overrides.extractionReviewService ||
    new ReferenceExtractionReviewService({ client, jobManager, baseUrl: config.api.baseUrl });

  const api = createApiServer({
    jobManager,
    sourcePreflightModule,
    postEditWorkspaceModule,
    extractionReviewService,
    translationPublicationService,
    host,
    port,
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
    store,
    client,
    aoClient,
    aoTaskRunner,
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
