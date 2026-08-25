const ATOMIC_JOB_TYPES = Object.freeze([
  "translation",
  "reference_extraction",
  "reference_observation",
  "reference_deep_review",
  "reference_story_update",
  "reference_knowledge_commit",
  "reference_style_commit",
  "reference_bilingual_evidence_window",
  "reference_bilingual_commit",
  "post_edit_export",
  "translation_knowledge_commit",
  "translation_deep_audit",
  "translation_deep_audit_apply",
  "translation_quality_repair",
]);

const WORKFLOW_JOB_TYPES = Object.freeze([
  "reference_ingestion",
  "reference_bilingual_enrichment",
]);

const JOB_STATUSES = Object.freeze([
  "queued",
  "waiting_dependency",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "canceled",
  "blocked",
]);

const atomicJobTypeSet = new Set(ATOMIC_JOB_TYPES);
const workflowJobTypeSet = new Set(WORKFLOW_JOB_TYPES);
const jobStatusSet = new Set(JOB_STATUSES);

function assertJobType(type, executionKind = "job") {
  const allowed = executionKind === "workflow" ? workflowJobTypeSet : atomicJobTypeSet;
  if (!allowed.has(type)) {
    throw new Error(`Unknown ${executionKind} type: ${type}.`);
  }
  return type;
}

function assertJobStatus(status) {
  if (!jobStatusSet.has(status)) {
    throw new Error(`Unknown job status: ${status}.`);
  }
  return status;
}

module.exports = {
  ATOMIC_JOB_TYPES,
  WORKFLOW_JOB_TYPES,
  JOB_STATUSES,
  assertJobType,
  assertJobStatus,
};
