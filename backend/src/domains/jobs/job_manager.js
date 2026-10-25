const { EventEmitter } = require("events");

const { collectWorkspaceManifestArtifacts } = require("./artifacts/job_artifact_collection");
const { persistJobArtifacts } = require("./artifacts/job_artifact_persistence");
const { recoverInterruptedJobs } = require("./lifecycle/recovery");
const {
  cancelJob: cancelManagedJob,
  deleteJob: deleteManagedJob,
  deleteJobs: deleteManagedJobs,
  purgeJob: purgeManagedJob,
  purgeJobs: purgeManagedJobs,
  restoreJob: restoreManagedJob,
  restoreJobs: restoreManagedJobs,
} = require("./lifecycle/job_lifecycle");
const {
  createTranslationKnowledgeRetryJob: createKnowledgeRetry,
  resumeJob: resumeManagedJob,
  retryJob: retryManagedJob,
} = require("./lifecycle/job_retry");
const { runJob: runManagedJob } = require("./lifecycle/job_execution");
const {
  scheduleBilingualEnrichmentAfterCommit: scheduleBilingualEnrichment,
} = require("./lifecycle/job_completion");
const { getJobReadiness, getJobRuntimeStatus } = require("./runtime/job_runtime_status");
const {
  assertKoharuAvailableForJobType: assertKoharuAvailable,
  ensureKoharuReadyForJob: ensureKoharuReady,
  inspectKoharuReadiness: inspectKoharu,
  usesConfiguredKoharu,
} = require("./runtime/koharu_readiness");
const {
  acquireKoharuReviewLease: acquireReviewLease,
  drainQueue,
  releaseKoharuReviewLease: releaseReviewLease,
  scheduleQueueDrain,
} = require("./queue/job_queue");
const {
  blockJob: blockDependentJob,
  collectDescendantJobs,
  resolveDependencyState,
  toJobSummary,
  updateParentWorkflow,
} = require("./workflows/workflow_state");
const {
  createReferenceBilingualEnrichmentJob: createBilingualEnrichment,
} = require("./workflows/reference_bilingual_workflow");
const {
  createReferenceIngestionJob: createIngestion,
  createReferenceIngestionJobs: createIngestionBatch,
  createReferenceIngestionWorkflow: createIngestionWorkflow,
  findReferenceIngestionPredecessors: findIngestionPredecessors,
  resolveReferenceIngestionScheduling: resolveIngestionScheduling,
} = require("./workflows/reference_ingestion_workflow");
const {
  assertAgentAvailableForTranslation: assertTranslationAgentAvailable,
  createSelectiveRetranslationJob: createSelectiveRetranslation,
  createTranslationJob: createTranslation,
  normalizeLanguage: normalizeTranslationLanguage,
} = require("./workflows/translation_job_workflow");
const {
  createTranslationDeepAuditApplyJob: createDeepAuditApply,
  createTranslationDeepAuditJob: createDeepAudit,
  createTranslationQualityRepairJob: createQualityRepair,
  preflightTranslationQualityRepair: preflightQualityRepair,
} = require("./workflows/translation_review_workflow");
const { createJob: createManagedJob, createWorkflow: createManagedWorkflow } = require("./factory/job_factory");
const { runAtomicJob: runManagedAtomicJob } = require("./runtime/atomic_job_runner");
const {
  cleanupExpiredTrash: cleanupManagedTrash,
  runMaintenanceCleanup: runManagedMaintenanceCleanup,
} = require("./maintenance/job_maintenance");
const {
  getJob: getManagedJob,
  getJobArtifacts: getManagedJobArtifacts,
  getJobEvents: getManagedJobEvents,
  listJobs: listManagedJobs,
} = require("./queries/job_queries");
const {
  emitJobEvent: emitManagedJobEvent,
  emitJobListUpdate: emitManagedJobListUpdate,
  publishSystem: publishManagedSystem,
  subscribe: subscribeToJob,
  subscribeAll: subscribeToAllJobs,
} = require("./events/job_events");

class JobManager {
  constructor({
    store,
    engine,
    runtimeConfig,
    resolvedConfig,
    koharuRuntimeManager = null,
    aoClient = null,
    pageRevisionService = null,
  }) {
    this.store = store;
    this.engine = engine;
    this.runtimeConfig = runtimeConfig;
    this.resolvedConfig = resolvedConfig;
    this.koharuRuntimeManager = koharuRuntimeManager;
    this.aoClient = aoClient;
    this.pageRevisionService = pageRevisionService;
    this.events = new EventEmitter();
    this.cancellations = new Set();
    this.activeJobs = new Set();
    this.pendingQueue = [];
    this.queueDrainScheduled = false;
    this.queueRunning = false;
    this.koharuReviewLease = null;
    this.recoverInterruptedJobs();
  }

  recoverInterruptedJobs() {
    recoverInterruptedJobs(this);
  }

  createJob(type, payload, options = {}) {
    return createManagedJob(this, type, payload, options);
  }

  async runAtomicJob(job, hooks) {
    return runManagedAtomicJob(this, job, hooks);
  }

  createWorkflow(type, payload, childDefinitions) {
    return createManagedWorkflow(this, type, payload, childDefinitions);
  }

  scheduleQueueDrain() {
    scheduleQueueDrain(this);
  }

  async drainQueue() {
    return drainQueue(this);
  }

  acquireKoharuReviewLease(input) {
    return acquireReviewLease(this, input);
  }

  releaseKoharuReviewLease(sessionId) {
    return releaseReviewLease(this, sessionId);
  }

  getKoharuReviewLease() {
    return this.koharuReviewLease;
  }

  usesConfiguredKoharu(job) {
    return usesConfiguredKoharu(job);
  }

  async ensureKoharuReadyForJob(job, hooks = null) {
    return ensureKoharuReady(this, job, hooks);
  }

  async inspectKoharuReadiness() {
    return inspectKoharu(this);
  }

  async assertKoharuAvailableForJobType(type, payload = {}) {
    return assertKoharuAvailable(this, type, payload);
  }

  resolveDependencyState(job) {
    return resolveDependencyState(this.store, job);
  }

  blockJob(job, reason) {
    return blockDependentJob(this, job, reason);
  }

  updateParentWorkflow(parentJobId) {
    return updateParentWorkflow(this, parentJobId);
  }

  collectDescendantJobs(parentJobId) {
    return collectDescendantJobs(this.store, parentJobId);
  }

  toJobSummary(job) {
    return toJobSummary(job);
  }

  createTranslationJob(payload) {
    return createTranslation(this, payload);
  }

  normalizeLanguage(value, fieldName) {
    return normalizeTranslationLanguage(value, fieldName);
  }

  async createSelectiveRetranslationJob(sourceJobId, request = {}) {
    return createSelectiveRetranslation(this, sourceJobId, request);
  }

  async assertAgentAvailableForTranslation(payload) {
    return assertTranslationAgentAvailable(this, payload);
  }

  createTranslationDeepAuditJob(sourceTranslationJobId) {
    return createDeepAudit(this, sourceTranslationJobId);
  }

  createTranslationDeepAuditApplyJob(deepAuditJobId, decisions) {
    return createDeepAuditApply(this, deepAuditJobId, decisions);
  }

  createTranslationQualityRepairJob(sourceTranslationJobId) {
    return createQualityRepair(this, sourceTranslationJobId);
  }

  async preflightTranslationQualityRepair(sourceTranslationJobId) {
    return preflightQualityRepair(this, sourceTranslationJobId);
  }

  createReferenceExtractionJob(payload) {
    return this.createJob("reference_extraction", payload);
  }

  createReferenceObservationJob(payload) {
    return this.createJob("reference_observation", payload);
  }

  createReferenceDeepReviewJob(payload) {
    return this.createJob("reference_deep_review", payload);
  }

  createReferenceIngestionJob(payload) {
    return createIngestion(this, payload);
  }

  createReferenceBilingualEnrichmentJob(payload) {
    return createBilingualEnrichment(this, payload);
  }

  createReferenceIngestionWorkflow(payload, scheduling) {
    return createIngestionWorkflow(this, payload, scheduling);
  }

  createReferenceIngestionJobs(payloads) {
    return createIngestionBatch(this, payloads);
  }

  resolveReferenceIngestionScheduling(payload, { findPredecessor = true } = {}) {
    return resolveIngestionScheduling(this, payload, { findPredecessor });
  }

  findReferenceIngestionPredecessors(payload, scheduling) {
    return findIngestionPredecessors(this, payload, scheduling);
  }

  createPostEditExportJob(payload) {
    return this.createJob("post_edit_export", payload);
  }

  cleanupExpiredTrash() {
    return cleanupManagedTrash(this);
  }

  runMaintenanceCleanup(options = {}) {
    return runManagedMaintenanceCleanup(this, options);
  }

  async runJob(jobId) {
    return runManagedJob(this, jobId);
  }

  scheduleBilingualEnrichmentAfterCommit(payload) {
    return scheduleBilingualEnrichment(this, payload);
  }

  persistArtifacts(jobId, result) {
    persistJobArtifacts(this.store, jobId, result);
  }

  cancelJob(jobId) {
    return cancelManagedJob(this, jobId);
  }

  deleteJob(jobId) {
    return deleteManagedJob(this, jobId);
  }

  deleteJobs(jobIds) {
    return deleteManagedJobs(this, jobIds);
  }

  restoreJob(jobId) {
    return restoreManagedJob(this, jobId);
  }

  restoreJobs(jobIds) {
    return restoreManagedJobs(this, jobIds);
  }

  purgeJob(jobId) {
    return purgeManagedJob(this, jobId);
  }

  purgeJobs(jobIds) {
    return purgeManagedJobs(this, jobIds);
  }

  retryJob(jobId) {
    return retryManagedJob(this, jobId);
  }

  resumeJob(jobId) {
    return resumeManagedJob(this, jobId);
  }

  getJob(jobId) {
    return getManagedJob(this, jobId);
  }

  listJobs() {
    return listManagedJobs(this);
  }

  listJobsWithDeleted() {
    return listManagedJobs(this, true);
  }

  getJobEvents(jobId) {
    return getManagedJobEvents(this, jobId);
  }

  getJobArtifacts(jobId) {
    return getManagedJobArtifacts(this, jobId);
  }

  getConfig() {
    return this.resolvedConfig;
  }

  async getRuntimeStatus() {
    return getJobRuntimeStatus(this);
  }

  async getReadiness() {
    return getJobReadiness(this);
  }

  subscribe(jobId, listener) {
    return subscribeToJob(this, jobId, listener);
  }

  subscribeAll(listener) {
    return subscribeToAllJobs(this, listener);
  }

  emitJobEvent(jobId, type, payload) {
    emitManagedJobEvent(this, jobId, type, payload);
  }

  createTranslationKnowledgeRetryJob(sourceJobId) {
    return createKnowledgeRetry(this, sourceJobId);
  }

  emitJobListUpdate(type, payload, job) {
    emitManagedJobListUpdate(this, type, payload, job);
  }

  publish(jobId, type, payload) {
    this.emitJobEvent(jobId, type, payload);
  }

  publishSystem(type, payload) {
    publishManagedSystem(this, type, payload);
  }
}

module.exports = {
  JobManager,
  collectWorkspaceManifestArtifacts,
};
